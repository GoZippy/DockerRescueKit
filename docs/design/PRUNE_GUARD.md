# PG-1 — Prune Guard (Design Spec)

**Sprint:** v1.4-B (Traction)
**Priority:** P0 — designated hero feature
**Owner (backend):** TBD (WS5 follow-on)
**Owner (UI):** TBD (toast + settings)
**Status:** Design (not yet implemented). This doc settles the architecture,
MVP cut, snapshot mechanics, UX, and limits so implementation and UI can
proceed in parallel. **No code yet** — design only.

---

## 1. Why this matters (one-paragraph framing)

Every backup tool in DRK's competitive set — and Docker's own April–May 2026
AI-governance response (Sandboxes, MCP elicitation prompts, denylists) — is
*prevention*: it tries to stop the destructive command from running. The April
2026 **PocketOS incident** (an AI coding agent ran a `prune`/drop sequence and
wiped a production database **and its backups** in ~9 seconds) proved the
prevention model fails the moment a guard is bypassed — and Backslash Security
showed denylist guards are routinely bypassable by reasoning agents. DRK's angle
is the one nobody ships: **recoverability**. Prune Guard automatically snapshots
the Docker volumes (and, where cheap, containers) that a destructive operation is
about to destroy — `docker system prune`, `volume prune`, `volume rm`,
`container rm -v`, `compose down -v` — *before* the data is gone, so the answer
to "the agent just nuked my data" is a one-click **undo** instead of a postmortem.
"Prompts and denylists get bypassed; backups don't." This is positioned **FREE**
(per strategy §6 of the comprehensive review) because gating *safety* would
trigger a homelab-forum backlash and because free recoverability is the viral
hook that lands the category.

DRK already has every primitive this needs:
[`DockerService.exportVolume`](../../packages/backend/src/services/DockerService.ts)
(alpine `tar czf` helper → gzipped tarball) and `importVolume` (extract back),
[`PolicyManager.runBackup`/`protectStack`](../../packages/backend/src/services/PolicyManager.ts),
the label-driven orphan-reaper + SSE `subscribe` pattern from
[`RehearsalService`](../../packages/backend/src/services/RehearsalService.ts),
`AuditService.record`, and `NotificationDispatcher`. Prune Guard **reuses** this
machinery; it does **not** invent a parallel backup engine.

## 2. Goals & non-goals

### Goals
1. When a destructive Docker operation is about to run, snapshot the volumes it
   would destroy **first**, then let the operation proceed.
2. Cover the operations that actually cause AI-agent data loss: `volume rm`,
   `volume prune`, `container rm -v` (anonymous-volume reaping), `system prune
   [--volumes]`, and `compose down -v`.
3. **Zero-config for the vibe-coder.** The default protection path must require
   *no* proxy setup, no `DOCKER_HOST` change, no CLI alias. (Setup friction is
   the single most important constraint — see §4.)
4. One-click **undo**: a toast/banner "We saved your work before that prune —
   restore?" that calls the existing restore path.
5. A disk-bounded local "guard cache" with aggressive TTL and eviction so the
   safety net never fills the host disk.
6. Honest about what it cannot catch (§7). Never silently claim coverage it
   doesn't have.
7. FREE tier feature. No `requireFeature` gate on the guard itself.

### Non-goals (defer)
- Blocking / vetoing the destructive operation (prevention). DRK is
  recoverability; we do not become a policy engine. (Discussed in §7.)
- Snapshotting **bind mounts** / host directories. Out of scope — DRK backs up
  named volumes and containers, not arbitrary host paths. We *detect* and warn.
- Snapshotting databases with quiesce/consistency hooks at prune time. Guard
  snapshots are crash-consistent tarballs (see §3.6); logical DB-consistent dumps
  remain the job of scheduled policies with `hooks.databases`.
- Cross-host / fleet prune protection — F-series.
- Recovering already-deleted data when Prune Guard was off (no time machine).
- Guarding non-Docker destructive ops (`rm -rf` on the host) — out of product.

## 3. Conceptual lifecycle

```
   AI agent / human runs a destructive docker op
                       │
        ┌──────────────┴───────────────────────────────────┐
        │  INTERCEPT  (one of the §4 mechanisms)            │
        │  - resolve which named volumes the op destroys    │
        │  - filter to "in-scope" volumes (§3.5)            │
        └──────────────┬───────────────────────────────────┘
                       │  (if nothing in-scope → forward immediately, no-op)
   (1) plan            ▼
   ───────────────► PruneGuardService.guard(op, targets)
                    Build a GuardEvent: kind, resolved volume list,
                    estimated total size, dedup check (§3.6).
                       │
   (2) snapshot        ▼
   ───────────────► For each in-scope volume → DockerService.exportVolume
                    into the guard cache: data/guard-cache/<event-id>/
                    <vol>.tar.gz. Label any helper containers
                    `com.gozippy.drk.guard=<event-id>` for crash reaping.
                    Enforce per-event size cap + global disk budget (§3.4).
                       │
   (3) record          ▼
   ───────────────► Persist GuardEvent to `guard_events`, write
                    `guard.snapshot` audit event, emit `guard:snapshot`
                    over the live event bus (toast trigger).
                       │
   (4) forward         ▼
   ───────────────► Allow the original destructive op to proceed
                    (forward to the real docker socket / return control).
                    Snapshot failure handling: see §7 decision.
                       │
   (5) offer undo      ▼
   ───────────────► UI toast: "We saved N volumes before that prune —
                    Undo?" → POST /api/guard/:id/restore re-imports the
                    tarballs via DockerService.importVolume.
                       │
   (6) expire          ▼
   ───────────────► TTL sweep (default 72h) + LRU eviction under the disk
                    budget delete guard tarballs and mark the event
                    'expired'. The undo window closes; audit records it.
```

## 4. Interception architecture — options & honest tradeoffs

The hard constraint: **the Docker events API
(`/events`, `dockerode.getEvents()`) is after-the-fact.** By the time you see a
`volume destroy` or `container die` event, the bytes are already gone for `volume
rm`/`prune`. So true *pre-op* protection requires intercepting **before** the
destructive call reaches the daemon. We have four mechanisms; only some give true
pre-op coverage.

### 4a. Docker CLI shim / plugin (pre-exec wrapper)
A `docker` wrapper earlier on `PATH`, or a real Docker CLI plugin
(`docker-prune-guard`), that inspects argv, snapshots, then `exec`s the real
`docker`. True pre-op. **But:** only catches the *CLI*; an agent calling the
Docker API/SDK directly (most AI agents do — Docker MCP, dockerode, docker-py)
bypasses it entirely. Per-developer PATH surgery is exactly the "configure
something" friction the vibe-coder won't do, and it's fragile on Windows
(`docker.exe` resolution, Git Bash vs PowerShell) and Docker Desktop (the `docker`
binary is managed by DD). Coverage is narrow and bypass is trivial. **Rejected as
primary.**

### 4b. Socket-proxy gating (à la Tecnativa `docker-socket-proxy`)
DRK runs a proxy that speaks the Docker Engine API. Clients (agents, the CLI via
`DOCKER_HOST`, MCP servers) are pointed at the DRK proxy socket. The proxy
inspects each request: on `DELETE /volumes/{name}`, `POST /volumes/prune`,
`DELETE /containers/{id}?v=1`, `POST /containers/prune`, `POST /images/prune` with
volumes, **it resolves the target volumes, snapshots them, then forwards the
original request** to the real `/var/run/docker.sock`. This is the **only
mechanism with full coverage** — it catches CLI, SDK, and MCP clients uniformly,
because they all funnel through the one socket. DRK already mounts
`/var/run/docker.sock` read-write (see `docker-compose.extension.yml:27`), so the
proxy is a natural extension of the existing daemon connection. **But:** it
requires the user (or their tooling) to repoint at the proxy socket
(`DOCKER_HOST=unix:///path/drk-guard.sock` or mount the proxy socket into the
agent container instead of the real one). That's real setup friction for a
vibe-coder, though it's a *one-time* "point your agent here" step, and for the
**agent-in-a-container** case it's just swapping one bind-mount line — which is
the exact place the PocketOS-class incidents happen. **Phase-2 opt-in.**

### 4c. MCP server (`drk-mcp`) — safe tools agents call
A Model Context Protocol server exposing safe tools: `snapshot_before(targets)`,
`safe_prune(scope)`, `undo_last()`, `list_protected`. Distributed via the **Docker
MCP Catalog** (zero-install for Docker Desktop users — it's a registry entry).
Agents that support MCP (Claude, Cursor, etc.) call `safe_prune` instead of raw
`docker system prune`, and the tool snapshots then prunes. This is **the lowest
friction for the AI-agent persona specifically** (the whole point is agents, and
agents speak MCP) and rides the same distribution channel Docker is pushing. It is
*also* prevention-adjacent in the sense that it only helps if the agent chooses
the safe tool — a misbehaving or jailbroken agent can still call raw `docker`. So
MCP is **high-value, partial-coverage**: it converts cooperative agents but
doesn't catch a rogue one. Pairs perfectly with a non-cooperative safety floor.

### 4d. Event-reactive fallback + periodic "last-known-good" floor
Subscribe to `dockerode.getEvents()`. On `container die`/`destroy` we can often
still snapshot the *volumes* (the container dies before its anonymous volumes are
reaped in the `rm -v` path — a few-hundred-ms race, see §7). **For `volume
rm`/`prune` this is genuinely too late** — by the time the `volume destroy` event
fires the data is unrecoverable. We say so honestly. The *real* value of the
event stream is detection + a **last-known-good periodic snapshot** of protected
stacks (reuse `SchedulerEngine` cron) as the **safety floor**: even when nothing
intercepted the prune, the user can recover to the most recent periodic guard
snapshot (minutes-to-hours stale, but not zero). This is the **zero-config default
that ships in the MVP** — it requires nothing from the user and degrades
gracefully.

### Tradeoff table

| Mechanism | Coverage (which ops it catches *in time*) | Setup friction (vibe-coder) | DD Win/macOS compat | Perf overhead | Bypassability |
|---|---|---|---|---|---|
| **4a CLI shim/plugin** | CLI only; **no** SDK/MCP/API | High (PATH surgery, per-dev) | Poor (DD-managed `docker`, Win path issues) | Negligible | Trivial (call API directly) |
| **4b Socket proxy** | **All** (CLI+SDK+MCP+API) for `volume rm/prune`, `container rm -v`, `system prune` | Medium (repoint `DOCKER_HOST` / swap one mount line) — one-time | Good (unix socket on Linux/DD VM; named-pipe shim on Win needs work) | Low (proxy hop per request) | Low if the agent only has the proxy socket; high if it also has the real one |
| **4c MCP server** | Cooperative agents only (any op they route through the tool) | **Low** (MCP Catalog = registry click) | Good (DD MCP Toolkit) | Negligible | High (rogue agent ignores the tool) |
| **4d Event + periodic floor** | `container die` volumes (racey); **NOT** `volume rm/prune` in time; periodic = stale floor for everything | **Zero** (on by default) | Good (events stream already used) | Low (idle stream + cron tar) | N/A — it's a floor, not a gate |

**Key honesty:** there is no single zero-friction mechanism with full in-time
coverage. The proxy (4b) is the only full-coverage option and it costs setup; the
floor (4d) is the only zero-setup option and it's stale/partial. The MVP therefore
**combines** the cheapest high-value pieces and offers the proxy as an opt-in
upgrade.

## 5. Recommended MVP for v1.4-B

**Ship a phased combo. MVP = (4d safety floor) + (4c MCP server). Phase 2 = (4b
socket proxy opt-in).** Drop (4a) entirely.

### MVP (v1.4-B) — two parts, both FREE
1. **Event-reactive floor (4d) — the default, zero-config.**
   - A `PruneGuardService` subscribes to the Docker events stream on boot.
   - **Periodic last-known-good guard snapshots** of *protected* volumes (volumes
     belonging to any DRK policy / protected stack, plus optionally all named
     volumes — see §3.5) on a cron (default every 6h, configurable), reusing
     `SchedulerEngine`. This is the safety net that needs *nothing* from the user.
   - On `container die`/`destroy` we opportunistically snapshot the container's
     still-present named volumes (best-effort; honest about the race).
   - On `volume destroy` we **cannot** snapshot (data already gone) but we **do**
     record a `guard.too_late` event and surface "this volume was deleted — your
     most recent guard snapshot is N hours old, restore it?" pointing at the
     periodic floor. This converts an unrecoverable event into a recoverable-ish
     one and is the honest UX.
2. **`drk-mcp` MCP server (4c) — the agent-facing front door.**
   - Tools: `snapshot_volumes(names[])`, `safe_prune(scope)`,
     `safe_compose_down(project, removeVolumes)`, `undo_last()`,
     `list_guard_snapshots()`.
   - Talks to the DRK backend over the existing local API (`x-api-key` /
     socket transport). Snapshot-then-act semantics: `safe_prune` calls the guard
     to snapshot in-scope volumes, then performs the prune via the daemon.
   - Distributed via the **Docker MCP Catalog** entry (per snipe-list #6). Zero
     install for DD users; the agent simply prefers `safe_prune` over raw prune.

**Why this cut:** it maximizes coverage-to-friction. The floor gives *every* user
non-zero recoverability with **zero setup** (essential for the persona). The MCP
server gives *cooperative agents* — the exact actors in the PocketOS story, and
the ones DRK is marketed at — true pre-op protection through the channel they
already speak, distributed through a click-to-install catalog. Together they cover
"the user did nothing" and "the agent cooperated." Neither requires the user to
stand up a proxy.

### Phase 2 (post-v1.4-B) — socket proxy opt-in (4b)
For users who want **full, non-cooperative** coverage (catch even a rogue agent or
raw-`docker` script): a `drk-guard-proxy` socket they point `DOCKER_HOST` at, or
mount into their agent container instead of the real socket. This is the
defense-in-depth tier. Opt-in because of its friction; documented as "lock the
agent down" for the security-conscious. Reuses the same `PruneGuardService.guard()`
core — the proxy is just another interception front-end feeding the same snapshot
engine.

**Effort gate:** if Phase-2 proxy slips, the MVP still ships a complete, shippable
feature. The floor + MCP are independently valuable.

## 6. Snapshot mechanics

### 6.1 Reuse vs lightweight "guard snapshots"
Two options for *where* snapshots live:
- **(A) Full PolicyManager backup path** — runs the whole pipeline (manifest,
  storage adapter upload, retention). Heavy: cloud egress, manifest writes,
  policy coupling. Wrong for a hot-path interception that must be **fast** and
  **local**.
- **(B) Lightweight local-only "guard snapshots"** — call
  `DockerService.exportVolume(vol, guardCachePath)` directly into a local guard
  cache, no storage adapter, no cloud, aggressive TTL. Fast, self-contained,
  evictable.

**Decision: (B) for the hot path.** Guard snapshots are a *local safety cache*,
not durable backups. They reuse the **same `exportVolume` primitive** (one helper
`alpine:3.19` `tar czf` container per volume) but skip the policy/storage/manifest
machinery. We label helper containers `com.gozippy.drk.guard=<event-id>` so the
boot-time reaper (mirror `RehearsalService.reapOrphans`) cleans crash debris.
The **undo/restore** path reuses `DockerService.importVolume` verbatim.

> Bridge to durable backups: a guard snapshot is explicitly ephemeral. The undo
> toast offers a secondary "Keep this as a real backup" action that *promotes* the
> guard tarball into a one-off policy backup via `PolicyManager` (re-tar already
> done; just register + optionally upload). This is the upsell seam to paid
> durable/cloud retention without gating the safety net.

### 6.2 Guard cache layout
```
data/guard-cache/
  <event-id>/
    manifest.json          # GuardEvent: op kind, volumes, sizes, sha256, createdAt, ttlAt
    <volume-a>.tar.gz
    <volume-b>.tar.gz
```
`data/` is already the persisted volume (`drk-data:/data`), so guard snapshots
survive a backend restart — critical, because the undo may come minutes later.

### 6.3 Disk budget & eviction
- **Global budget:** `DRK_GUARD_DISK_BUDGET_MB` (default **2048 MB**). Settable
  in the UI.
- **Per-event cap:** `DRK_GUARD_EVENT_CAP_MB` (default **1024 MB**). A single
  prune of a huge volume won't blow the whole budget.
- **Per-volume cap:** `DRK_GUARD_VOLUME_CAP_MB` (default **512 MB**). Volumes over
  cap are **skipped with a recorded warning** ("too large to auto-snapshot —
  protect it with a scheduled policy instead") rather than silently truncated.
  This is the honest failure (§7).
- **Eviction:** LRU by `createdAt`. Before each snapshot, if `budget - used <
  estimated`, evict oldest non-pinned events until it fits or nothing remains. A
  guard snapshot the user explicitly "kept" is pinned and counts against budget
  but is never auto-evicted (it becomes a real backup instead — §6.1 bridge).
- **TTL:** `DRK_GUARD_TTL_HOURS` (default **72h**). A daily sweep
  (`setInterval(...).unref()`, mirroring the log/notification TTL sweeps at
  `index.ts:255-293`) deletes expired tarballs and marks events `expired`.

### 6.4 What gets snapshotted (scope)
Tiered by §3.5 scope setting:
- **`protected` (default):** only volumes belonging to a DRK policy or a
  protected compose stack. Smallest footprint, matches "the user already told us
  this matters."
- **`named`:** all named Docker volumes (excludes anonymous/bind). Broader net for
  the "I haven't set up policies yet" vibe-coder — the common case.
- **`all-named-under-cap`:** `named` but each volume must be under the per-volume
  cap; over-cap volumes are listed as "unguarded — too big."
- Anonymous volumes reaped by `container rm -v`: snapshot only if the parent
  container is in a protected stack (we can map them via container inspect before
  the die race closes); otherwise record `guard.skipped`.

### 6.5 Dedup / skip-unchanged
- Before snapshotting, compute a cheap **fingerprint** of the volume: the tar of
  `find /data -printf '%s %T@ %p\n' | sha256` run in the same alpine helper (size
  + mtime + path manifest, *not* full content hash — content hashing a large
  volume on the hot path is too slow). If the fingerprint matches the most recent
  guard snapshot of that volume, **hard-link / reference** the existing tarball
  instead of re-taring (`skipped-unchanged`). This makes periodic floor snapshots
  cheap for idle volumes (most of them).
- Periodic floor keeps **one** last-known-good per volume (overwrite), so the
  floor footprint is bounded by Σ(volume sizes under cap), not by time.

## 7. Failure modes, race windows & honest limits

### 7.1 The "snapshot failed — do we block?" decision
**Decision: do NOT block the destructive operation when a guard snapshot fails (in
MVP). Default to fail-open, but make it configurable.**

Rationale: Prune Guard is a *safety net*, not a *gate*. The product promise is
recoverability, not prevention; users (and agents) expect `docker system prune` to
work. If snapshotting fails (disk full, volume locked, daemon hiccup) and we
*blocked* the op, we'd convert "your data might not be recoverable" into "your
tooling is broken / your CI hangs" — a worse, more surprising failure that erodes
trust in a free safety feature. So:
- **MVP (floor + MCP):** snapshot best-effort; on failure, record
  `guard.snapshot_failed` with the reason, fire a *warning* toast ("Couldn't
  snapshot `vol-x` before the prune — it was too large / disk was full"), and let
  the op proceed. The MCP `safe_prune` tool returns the warning to the agent so it
  can decide.
- **Phase-2 proxy:** expose `DRK_GUARD_FAIL_CLOSED=1` (default off). When set, the
  proxy returns a 5xx for the destructive request if the snapshot failed —
  turning DRK into a true gate for users who explicitly opt into prevention. This
  is the only place blocking is appropriate, because the proxy user has
  *deliberately* routed their agent through DRK for protection.

### 7.2 Ops it cannot catch
| Limitation | Why | Mitigation |
|---|---|---|
| `docker volume rm` / `volume prune` via **raw socket** in MVP | No proxy in MVP; event arrives after deletion | Periodic floor (stale recovery); Phase-2 proxy closes it fully |
| **Bind mounts** / host directory deletion | DRK snapshots named volumes, not host paths | Detect + warn; out of scope |
| Volumes **over the per-volume cap** | Hot-path tar of a 50 GB volume is infeasible | Skip + warn; recommend a scheduled policy |
| `rm -rf` **inside** a running container / on the host | Not a Docker op | Out of product scope; document |
| Data written **after** the last periodic floor snapshot, when nothing intercepted | Floor is stale by design | Narrow the cron interval; the proxy/MCP cover the in-time case |
| Volume **in use** (can't mount `:ro` cleanly) at snapshot time | Helper container bind may contend | exportVolume mounts `:ro`; tar reads are crash-consistent; record partial-read warnings |

### 7.3 Race windows
- **`container rm -v`:** the container's `die`/`destroy` event and the
  anonymous-volume reaping are near-simultaneous (~hundreds of ms). We attempt the
  snapshot on `die` but **must assume we sometimes lose the race** and record
  `guard.too_late`. Honest copy in the UI; this is precisely why the proxy
  (pre-op) exists for Phase 2.
- **`volume prune`:** prune resolves the set and deletes in a tight loop. Event
  stream gives us each `volume destroy` *after* deletion → unrecoverable in MVP.
  Floor covers it stale; proxy covers it in-time.

### 7.4 Agent bypass scenarios
- Agent calls the **raw socket** (not the MCP tool): MVP cannot intercept in time;
  floor is the only recovery. Phase-2 proxy (if the agent only has the proxy
  socket) catches it.
- Agent runs `docker` via a shell the shim doesn't cover: irrelevant — we dropped
  the shim.
- **Rogue/jailbroken agent that has the real socket and ignores MCP:** explicitly
  uncatchable in time. We document this and recommend the Phase-2 proxy + giving
  the agent container *only* the DRK proxy socket. This is the honest security
  boundary: DRK improves the odds and shrinks the blast radius; it is not a
  sandbox.

## 8. Data model

### 8.1 New shared types (`packages/shared/src/types.ts`)
```typescript
export type GuardOpKind =
  | 'volume_rm'
  | 'volume_prune'
  | 'container_rm_v'        // container rm -v (anonymous volume reaping)
  | 'system_prune'
  | 'image_prune'          // only when it cascades to volumes
  | 'compose_down_v'
  | 'container_die'        // event-reactive opportunistic
  | 'periodic_floor'       // scheduled last-known-good

export type GuardSnapshotStatus =
  | 'snapshotting'
  | 'saved'
  | 'skipped_too_large'
  | 'skipped_unchanged'
  | 'failed'
  | 'too_late'            // op already destroyed the data before we could snapshot

export interface GuardVolumeSnapshot {
  volume: string
  status: GuardSnapshotStatus
  sizeBytes: number
  sha256?: string
  fingerprint?: string     // size+mtime+path manifest hash for dedup (§6.5)
  tarPath?: string         // relative to guard-cache/<eventId>/
  detail?: string
}

export interface GuardEvent {
  id: string                       // uuid v4 — also the helper-container label seed
  kind: GuardOpKind
  trigger: 'mcp' | 'proxy' | 'event' | 'periodic'
  scope: GuardScope                // resolved scope at capture time
  volumes: GuardVolumeSnapshot[]
  totalBytes: number
  createdAt: string                // ISO
  ttlAt: string                    // ISO — when the daily sweep will evict
  pinned: boolean                  // promoted to "keep"; never auto-evicted
  restoredAt?: string              // set when the user clicked Undo
  status: 'saved' | 'partial' | 'failed' | 'expired' | 'restored'
}

export type GuardScope = 'protected' | 'named' | 'all-named-under-cap' | 'off'

export interface GuardSettings {
  enabled: boolean                 // default true
  scope: GuardScope                // default 'named'
  diskBudgetMb: number             // default 2048
  perVolumeCapMb: number           // default 512
  ttlHours: number                 // default 72
  periodicCron: string             // default '0 */6 * * *'
  failClosed: boolean              // default false (proxy only)
}
```

### 8.2 Database schema
New table `guard_events`, mirroring the `rehearsals`/`backups` pattern:
```sql
CREATE TABLE IF NOT EXISTS guard_events (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  trigger     TEXT NOT NULL,
  scope       TEXT NOT NULL,
  event       TEXT NOT NULL,        -- full GuardEvent JSON
  totalBytes  INTEGER NOT NULL,
  status      TEXT NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0,
  createdAt   TEXT NOT NULL,
  ttlAt       TEXT NOT NULL,
  restoredAt  TEXT
);

CREATE INDEX IF NOT EXISTS idx_guard_created ON guard_events(createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_guard_ttl     ON guard_events(ttlAt);
CREATE INDEX IF NOT EXISTS idx_guard_status  ON guard_events(status);
```
Settings persist via the existing `SettingsService` (same place export cron lives),
keyed `guard.*`, so the periodic cron and budget are editable without a restart of
the snapshot path (the cron itself follows the same restart-to-reload caveat the
ExportService cron already documents in `SchedulerEngine.ts:54-60`).

## 9. REST API

```
GET    /api/guard/settings
       Returns: GuardSettings

PUT    /api/guard/settings
       Body: Partial<GuardSettings>
       Returns: GuardSettings (validated; cron validated via node-cron)

GET    /api/guard/events
       Query: ?limit=20&status=saved&before=<ISO>
       Returns: [GuardEvent summary, …]  (volume detail per-id)

GET    /api/guard/events/:id
       Returns: full GuardEvent

POST   /api/guard/events/:id/restore
       Body: { volumes?: string[] }   // omit = restore all in the event
       Returns: 202 + { restored: string[] }   (reuses DockerService.importVolume)

POST   /api/guard/events/:id/pin
       Promotes the event to a kept backup (PolicyManager one-off). 'keep my work'.

DELETE /api/guard/events/:id
       Drops record + tarballs immediately (user reclaims disk).

GET    /api/guard/stream
       Server-Sent Events (mirrors rehearsals/:id/stream pattern):
         event: snapshot    data: { id, kind, volumes:[{volume,status,sizeBytes}] }
         event: too_late    data: { id, volume, floorSnapshotAgeHours }
         event: warning     data: { id, volume, reason }
       The extension subscribes once globally to drive the undo toast.

POST   /api/guard/test            (dev/E2E only, behind DRK_GUARD_TEST=1)
       Body: { kind, volumes:[…] } — simulate a guard event end-to-end.
```
Auth: standard `x-api-key` (or socket-transport bypass, per `index.ts:402`). The
MCP server calls these same endpoints. **Routes mount via a `mountGuardRoutes(app,
deps)` module** (mirroring `mountRehearsalRoutes`) so WS5 lands without editing
`index.ts`'s inline route block — one registration line, no merge conflict.

## 10. UX

### 10.1 The undo toast (the whole game)
On a `guard:snapshot` SSE frame, the extension shows a **non-blocking toast/banner**
(reuse the existing notification surface):

> **We saved your work before that cleanup.**
> Docker just removed 3 volumes (`pocketos-db`, `pocketos-uploads`, `redis-data`).
> DRK snapshotted them first. **[Undo — restore now]   [Keep as backup]   [Dismiss]**

- **Undo** → `POST /api/guard/events/:id/restore` → success toast "Restored 3
  volumes. Re-create the containers to use them." (We restore *data*; we don't
  auto-recreate containers in MVP — honest about scope.)
- **Keep as backup** → `POST .../pin` (promote to durable; upsell seam).
- The banner persists in a **"Recently saved"** strip on the Dashboard for the TTL
  window so the undo isn't lost if the toast is missed.

On a `too_late` frame (volume already gone, only the periodic floor remains):

> **`pocketos-db` was deleted.** DRK couldn't snapshot it in time, but your last
> automatic snapshot is **4 hours old**. **[Restore that snapshot]**

This is the honest-but-still-helpful path and is itself a selling point: even the
worst case has a recovery option.

### 10.2 Settings (Dashboard → Prune Guard card)
- **Prune Guard: On/Off** (default **On**) — big, obvious, free.
- **Scope:** Protected volumes only · All named volumes (default) · All under size
  cap.
- **Disk budget:** slider, default 2 GB, shows current usage bar.
- **Snapshot stale-volumes every:** 6h (cron presets via existing `CronPicker`,
  rendered with its human-readable `desc` per the WS4 humanization work).
- **Advanced (collapsed):** per-volume cap, TTL, fail-closed (greyed unless proxy
  configured), "Set up agent proxy" link → Phase-2 docs.

### 10.3 Copy guidelines for novices
- Never say "prune", "anonymous volume", or "tarball" in the primary toast — say
  "cleanup", "your data", "saved a copy".
- Always name the concrete volumes ("`pocketos-db`") — specificity builds trust.
- Lead with the reassurance ("We saved your work"), then the action.
- One primary button (**Undo**), everything else secondary.
- Free-tier framing in the empty/onboarding state: *"Prune Guard is on and free.
  If an AI agent (or you) ever runs a destructive `prune` or `down -v`, DRK keeps
  a copy so you can undo it. Prompts and denylists get bypassed — backups don't."*

### 10.4 Free-tier positioning
Prune Guard, undo/restore, the periodic floor, and the MCP server are **all FREE**
and **ungated** — no `requireFeature` on the guard. The paid seam is *durability*
and *depth*: promoting guard snapshots to cloud/long-retention backups, multi-host
guard, WORM/append-only canary so an agent can't delete the *backups* too (the full
PocketOS failure). Land the safety net free; sell the vault.

## 11. Concurrency, perf, lock model

- `PruneGuardService` holds an in-process **semaphore** (default 2,
  `DRK_GUARD_CONCURRENCY`) so a `system prune` touching 20 volumes doesn't spawn 20
  simultaneous alpine helpers and saturate disk I/O — same pattern as
  `RehearsalService`'s semaphore.
- Snapshots run sequentially-bounded; the MCP `safe_prune` awaits completion before
  forwarding the prune (it *must* — that's the point). The event-reactive path is
  best-effort and never blocks the daemon.
- Per-volume fingerprint check (§6.5) short-circuits unchanged volumes so periodic
  floor sweeps are cheap (the common steady-state cost is ~one `find` per volume).
- Helper containers are labelled `com.gozippy.drk.guard=<event-id>`; a boot-time
  reaper (clone `RehearsalService.reapOrphans`) removes any left by a crash.

## 12. Security & isolation guarantees

| # | Guarantee | How |
|---|---|---|
| 1 | Guard helper containers can't reach the network/host | alpine helper, no `--network host`, no publish, `:ro` mount of the source volume |
| 2 | Guard cache isn't world-readable beyond the existing data dir | lives under `data/` (same posture as backups); best-effort perms (no-op on Windows, as elsewhere) |
| 3 | Snapshotting never escalates the destructive op | We only *read* (tar `:ro`) before the op; we never add capabilities |
| 4 | The guard can't be tricked into snapshotting arbitrary host paths | Only named volumes resolved from the daemon; bind mounts explicitly excluded |
| 5 | Fail-open by default can't be silently abused to disable protection | Every skip/failure is an audited `guard.*` event + a UI warning; "off" is an explicit user setting |
| 6 | Proxy (Phase 2) forwards only what it inspected | Allowlist of forwarded endpoints; destructive endpoints always snapshot-first |
| 7 | Audit trail of every guard action | `guard.snapshot`, `guard.restore`, `guard.skipped`, `guard.too_late`, `guard.snapshot_failed`, `guard.expired` |

## 13. Audit log events
```
{ "type": "guard.snapshot",        "eventId": "<uuid>", "kind": "system_prune", "trigger": "event", "volumeCount": 3, "totalBytes": 48211000 }
{ "type": "guard.restore",         "eventId": "<uuid>", "volumes": ["pocketos-db"], "actorKeyHash": "<sha256-prefix>" }
{ "type": "guard.too_late",        "eventId": "<uuid>", "volume": "pocketos-db", "floorSnapshotAgeHours": 4 }
{ "type": "guard.snapshot_failed", "eventId": "<uuid>", "volume": "redis-data", "reason": "over per-volume cap (640MB > 512MB)" }
{ "type": "guard.expired",         "eventId": "<uuid>", "reclaimedBytes": 48211000 }
```

## 14. Testing strategy

### 14.1 Unit (jest, `npx jest --runInBand` in packages/backend)
- **Scope resolution:** `protected` vs `named` vs `all-named-under-cap` against a
  fixture volume/policy set; anonymous-volume mapping from a container inspect.
- **Disk budget / eviction:** synthetic GuardEvents, assert LRU eviction order,
  per-event and per-volume caps, pinned events never evicted.
- **Dedup fingerprint:** same fingerprint → `skipped_unchanged` (no new tar);
  changed mtime → re-snapshot.
- **TTL sweep:** events past `ttlAt` marked `expired`, tarballs deleted, bytes
  reclaimed; pinned events survive.
- **Fail-open decision:** `failClosed=false` → op proceeds + warning recorded;
  `failClosed=true` (proxy) → destructive request returns 5xx on snapshot failure.
- **Op→volume resolution:** parse `system prune --volumes`, `volume prune`,
  `compose down -v` into the correct target volume set (table-driven).
- **GuardSettings validation:** invalid cron rejected (node-cron), budgets > 0.

### 14.2 Integration (gated `CI_INTEGRATION=1`, mirrors rehearsal real-test)
- Create a named volume, write a sentinel file, register it as protected.
- Fire `POST /api/guard/test { kind: 'volume_rm', volumes:['v'] }` then actually
  `docker volume rm` it.
- `POST /api/guard/events/:id/restore`; assert the sentinel file is back via a
  fresh helper container reading the restored volume.
- Assert no `com.gozippy.drk.guard=*` helper containers/networks linger after.

### 14.3 E2E staged-disaster scenario ("the PocketOS drill")
Scripted end-to-end, the headline acceptance test:
1. Bring up a tiny stack: `postgres:16` (`pg-data` volume, seed a row) + `redis`
   (`redis-data`). Mark the stack protected; let one periodic floor snapshot run.
2. Simulate the agent: run `docker compose down -v` (destroys both volumes).
3. **Assert:** a `guard.snapshot` (or `too_late`+floor) event exists, the toast
   SSE frame fired, and both volumes are listed.
4. `POST .../restore`; recreate the stack; **assert the seeded Postgres row is
   back** and the redis key is back — i.e. recovery is *real*, not just file
   presence.
5. Run it again with `enabled=false` → assert no snapshot, data unrecoverable
   (proves the feature is doing the work).

### 14.4 Crash-recovery test
Kill the backend mid-snapshot (SIGKILL with a helper container running); restart;
assert the boot reaper removes the orphaned `com.gozippy.drk.guard=*` helper and
the partial guard event is marked `failed`/cleaned.

## 15. Implementation phases & effort estimate

Split into reviewable commits on a feature branch. **Sizes: S ≤ 4h, M ≈ 4–12h,
L ≈ 12–24h.**

| Phase | Scope | Size | Hours |
|---|---|---|---|
| PG-1.1 | Shared types + `guard_events` migration + `GuardSettings` (SettingsService) + audit event constants. No behavior. | S | 3–4 |
| PG-1.2 | `PruneGuardService` core: guard-cache I/O (reuse `exportVolume`/`importVolume`), disk budget + LRU eviction + per-volume cap, dedup fingerprint, TTL sweep, semaphore, boot reaper. Unit tests. | L | 14–18 |
| PG-1.3 | Event-reactive floor: `dockerode.getEvents()` subscription, `container die` opportunistic snapshot, `volume destroy` → `too_late`, periodic floor cron via `SchedulerEngine`. | M | 8–10 |
| PG-1.4 | `mountGuardRoutes` REST surface + global SSE `/api/guard/stream` + settings endpoints. Route-module pattern (no `index.ts` edit beyond one mount line). | M | 6–8 |
| PG-1.5 | UI: undo toast + "Recently saved" Dashboard strip + Prune Guard settings card. Reuse notification/toast + `CronPicker`. | M | 8–10 |
| PG-1.6 | `drk-mcp` server (tools + DD MCP Catalog manifest) calling the guard API. | M | 8–12 |
| PG-1.7 | E2E staged-disaster + integration + crash-recovery tests; marketplace copy tie-in. | M | 6–8 |
| **MVP total (1.1–1.7)** | floor + MCP + UX + tests | **M–L** | **53–70** |
| PG-2.1 | **Phase 2** socket proxy (`drk-guard-proxy`): Engine-API inspection, snapshot-first forwarding, `failClosed`, Windows named-pipe handling, docs. | L | 18–24 |

MVP is shippable without PG-2.1. PG-1.6 (MCP) and PG-1.5 (UI) can proceed in
parallel against PG-1.1 types + mocked endpoints, same as R-1/R-2.

## 16. Rollout

- **Feature flag:** `DRK_PRUNE_GUARD=1` to enable in v1.4-B (default **on** for the
  floor once stable; ships **off** in the first internal build). `GuardSettings.enabled`
  is the user-facing switch; the env flag is the kill-switch.
- **Docs:** new `docs/PRUNE_GUARD_GUIDE.md` (user-facing, mirrors
  `docs/REHEARSAL_GUIDE.md`); a "Protect your AI agent" page; Phase-2 proxy
  setup doc; MCP Catalog listing.
- **Marketplace copy tie-in:** move the listing hero from "scheduled backup" to
  **"Never lose work to a runaway command — free."** (review §6, positioning angle
  #1). Add to `docs/MARKETPLACE_LISTING_DRAFT.md` features and the
  `BACKUP_TOOLS_COMPARISON.md` "nobody ships recoverability" row. CHANGELOG `Added`.
- **Cross-doc sync on land:** `docs/ROADMAP.md` (flip PG-1 shipped), `CHANGELOG.md`,
  `docs/MARKETPLACE_LISTING_DRAFT.md`, `.autoclaw/internal/marketplace-submission.md`,
  `ARCHITECTURE.md` (add Prune Guard to live features).

## 17. Open questions for operator — RESOLVED 2026-06-11

> Operator accepted all recommendations ("proceed with recommended", 2026-06-11):
> **(1)** default scope = `named`; **(2)** fail-open in MVP confirmed; **(3)** fixed
> 2 GB disk budget (%-based deferred to Phase 2); **(4)** `drk-mcp` in-repo at
> `packages/mcp`, published as a thin image for the Catalog; **(5)** periodic floor
> default 6h; **(6)** container recreation on undo deferred — MVP restores data only.
> Original questions kept below for the record.

1. **Default scope** — `named` (all named volumes) vs `protected` (policy-backed
   only)? Recommendation: **`named`** — the vibe-coder hasn't made policies yet, so
   `protected` would protect *nothing* for the exact persona we target. Footprint is
   bounded by the disk budget + per-volume cap. *Decision needed.*
2. **Default fail-open vs fail-closed** — confirmed **fail-open** in MVP (§7.1).
   Operator sign-off requested since it's a safety-vs-availability call.
3. **Default disk budget** — 2 GB reasonable for a homelab? Could auto-scale to a
   % of free disk instead of a fixed MB. Recommendation: fixed 2 GB MVP, %-based in
   Phase 2.
4. **MCP server packaging** — ship `drk-mcp` in-repo (`packages/mcp`) vs a separate
   published image for the Catalog? Recommendation: in-repo package, published as a
   thin image for the Catalog entry.
5. **Periodic floor default cadence** — 6h vs hourly. Hourly tightens the stale
   window but costs more fingerprint sweeps. Recommendation: **6h** default,
   user-tunable; the dedup short-circuit makes idle sweeps cheap.
6. **Container recreation on undo** — MVP restores *data only*. Do we want a "and
   restart the stack" convenience in MVP, or defer? Recommendation: **defer**; data
   recovery is the promise, container lifecycle is a follow-up.

---

*Spec authored 2026-06-11 for the v1.4-B sprint (WS5). Opinionated, ready for
sprint planning. MVP = event-reactive floor + MCP server (both FREE, zero-to-low
friction); socket proxy is the Phase-2 defense-in-depth opt-in. Implementation
gated on resolutions to §17.*
