# R-1 — Restore-Rehearsal Workflow (Design Spec)

**Sprint:** v1.2-competitive-response
**Priority:** P1
**Owner (backend):** claude-code
**Owner (UI):** kilocode (R-2, depends on this spec)
**Status:** Design (not yet implemented). Goal of this doc is to settle the
contract end-to-end so implementation and UI can proceed in parallel.

---

## 1. Why this matters (one-paragraph framing)

Every OSS backup tool in DRK's competitive set (restic, kopia, borg,
offen, tiredofit) stops at *integrity checks*: "does the archive parse,
do the hashes match?" None of them answer the only question that matters
at 2 AM: "if I restore this right now, will my Postgres actually come
back up, will Nextcloud's data directory align with the SQL dump,
does my Plex library mount where Plex expects it?" R-1 is the feature
that lets DRK answer that question on a schedule, without humans, before
the disaster — and write a report. It's the single highest-leverage
differentiator in the v1.2 plan because it's both *valuable* and
*unshipped by anyone else in the category*.

DRK already does this **per archive** today via
[`VerifyService.ts`](../../packages/backend/src/services/VerifyService.ts).
R-1 extends that to **stack-level**: many archives, real container
images, a sandbox network, configurable smoke checks, full teardown.

## 2. Goals & non-goals

### Goals
1. Operator can request a rehearsal of a backup *set* (one policy's
   latest backups, or an explicit list of backup IDs).
2. Rehearsal runs in an isolated Docker bridge network with no route
   to the production network or the host's published ports.
3. Each restored container runs the same image+env+cmd as the original,
   but with restored volumes mounted into temp volumes (never
   production names).
4. After mount, run an ordered list of **smoke checks** (HTTP probe,
   `docker exec` command, TCP ping, file-exists, SQL `SELECT 1`).
5. Every rehearsal produces a `RehearsalReport` persisted to the DB
   and emitted to the audit log.
6. Teardown is guaranteed (containers stopped, temp volumes removed,
   sandbox network deleted) even on smoke-check failure or crash.
7. `POST /api/rehearsals` to start; `GET /api/rehearsals` to list;
   `GET /api/rehearsals/:id` for status/report; SSE stream for live
   log following.

### Non-goals (defer to future iterations)
- Restoring across hosts (cross-machine rehearsal) — wait for F-2.
- Comparing restored data to a "known good" baseline (drift
  detection) — wait for F-1.
- Side-effect quiescing in production (we don't touch live
  containers — rehearsals are sandboxed).
- Performance benchmarking of restore-rate — out of scope for v1.2.
- Per-volume re-encryption with rehearsal-only keys — out of scope.

## 3. Conceptual lifecycle

```
                  ┌─────────────────────────────────────────────────┐
                  │  RehearsalService.run(request)                  │
                  └────┬────────────────────────────────────────────┘
                       │
   (1) plan            ▼
   ───────────────► Resolve the backups, look up source policies,
                    build a per-target restore plan. Quote cost
                    (storage backend egress estimate). Reject if
                    DOCKER_REHEARSAL_DISABLED=1 or running rehearsals
                    are at the concurrency cap.
                       │
   (2) prepare         ▼
   ───────────────► Create sandbox network `drk-rehearsal-<short-id>`,
                    label all resources with
                    `com.gozippy.drk.rehearsal=<run-id>` so cleanup is
                    label-driven and crash-safe.
                       │
   (3) restore         ▼
   ───────────────► For each volume backup → restore into
                    `drk-reh-<run-id>-<vol-name>` using the storage
                    adapter. Stream per-target progress events.
                       │
   (4) launch          ▼
   ───────────────► For each container in the original policy → start
                    a stand-in container on the sandbox network with
                    the original image, the original env (minus any
                    env-var name in `SCRUB_ENV` — see §6), and the
                    rehearsal-volume mounts. Names: `drk-reh-<run-id>-<container>`.
                       │
   (5) probe           ▼
   ───────────────► Run each smoke check in declared order. First
                    failure stops further checks (configurable) and
                    flags the run as failed. Each check writes a
                    structured step into the report.
                       │
   (6) teardown        ▼
   ───────────────► Stop + remove containers, remove temp volumes,
                    delete sandbox network. ALWAYS runs (defer-block).
                       │
   (7) finalize        ▼
   ───────────────► Persist `RehearsalReport`, write
                    `rehearsal.complete` audit event, emit final SSE
                    frame, optionally fire notification (when N-1
                    lands).
```

## 4. Data model

### 4.1 New shared types (`packages/shared/src/types.ts`)

```typescript
export type SmokeCheckKind = 'http' | 'exec' | 'tcp' | 'file_exists' | 'sql_select_1'

export type SmokeCheck =
  | {
      kind: 'http'
      container: string         // logical container name from the policy
      port: number              // internal container port (sandbox network)
      path?: string             // default '/'
      method?: 'GET' | 'HEAD' | 'POST'
      expectStatus?: number     // default 200; or 'any_2xx' / 'any_3xx'
      bodyContains?: string     // optional substring assertion
      timeoutMs?: number        // default 10_000
    }
  | {
      kind: 'exec'
      container: string
      command: string[]         // argv, run via docker exec
      expectExitCode?: number   // default 0
      stdoutContains?: string
      timeoutMs?: number        // default 30_000
    }
  | {
      kind: 'tcp'
      container: string
      port: number
      timeoutMs?: number        // default 5_000
    }
  | {
      kind: 'file_exists'
      container: string
      path: string              // absolute path inside the container
      minBytes?: number         // default 1
    }
  | {
      kind: 'sql_select_1'
      container: string
      driver: 'postgres' | 'mysql' | 'mssql'
      user?: string             // defaults per driver
      passwordEnv?: string      // name of env var holding password
      db?: string               // optional database to USE/connect to
      timeoutMs?: number        // default 15_000
    }

export interface RehearsalRequest {
  policyId?: string             // resolves to "latest successful backup per target"
  backupIds?: string[]          // OR explicit set (mutually exclusive with policyId)
  smokeChecks: SmokeCheck[]
  options?: {
    stopOnFirstCheckFailure?: boolean   // default true
    networkSubnet?: string              // default 172.31.255.0/24 (configurable to avoid collisions)
    timeoutMs?: number                  // wall-clock cap for the whole rehearsal (default 30 minutes)
    scrubEnvVars?: string[]             // additional env vars to strip from stand-in containers
  }
}

export type RehearsalStatus = 'pending' | 'preparing' | 'restoring' | 'launching' | 'probing' | 'tearing_down' | 'success' | 'failed' | 'aborted'

export interface RehearsalStep {
  label: string
  ok: boolean
  detail?: string
  startedAt: string             // ISO
  finishedAt: string            // ISO
  durationMs: number
}

export interface RehearsalReport {
  id: string                    // uuid v4 — also the network short-id seed
  policyId?: string
  requestedBackupIds: string[]  // resolved final list
  status: RehearsalStatus
  ok: boolean                   // shorthand for status === 'success'
  steps: RehearsalStep[]
  smokeCheckResults: Array<{
    check: SmokeCheck
    ok: boolean
    detail?: string
    attempt: number             // for future retry support
    startedAt: string
    finishedAt: string
    durationMs: number
  }>
  startedAt: string
  finishedAt: string
  durationMs: number
  /** Resources created during the run, used both for teardown and for
   *  post-mortem inspection if --no-teardown is set. */
  resources: {
    network?: string
    containers: string[]
    volumes: string[]
  }
}
```

### 4.2 Database schema

New table `rehearsals` mirroring the `backups`/`verifies` pattern:

```sql
CREATE TABLE IF NOT EXISTS rehearsals (
  id            TEXT PRIMARY KEY,
  policyId      TEXT,
  requestedBackupIds TEXT NOT NULL,   -- JSON array
  status        TEXT NOT NULL,
  ok            INTEGER NOT NULL,
  report        TEXT NOT NULL,         -- full RehearsalReport JSON
  startedAt     TEXT NOT NULL,
  finishedAt    TEXT,
  durationMs    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_rehearsals_policy ON rehearsals(policyId);
CREATE INDEX IF NOT EXISTS idx_rehearsals_started ON rehearsals(startedAt DESC);
```

## 5. REST API

```
POST   /api/rehearsals
       Body: RehearsalRequest
       Returns: 202 Accepted + { id }
       (the run goes async; client polls or subscribes to SSE)

GET    /api/rehearsals
       Query: ?policyId=…&limit=20&before=<ISO>
       Returns: [RehearsalReport summary, …]   (steps omitted, full
       reports fetched per-id)

GET    /api/rehearsals/:id
       Returns: full RehearsalReport

GET    /api/rehearsals/:id/stream
       Server-Sent Events:
         event: status   data: { status: 'restoring' }
         event: step     data: { label, ok, detail, durationMs }
         event: check    data: { kind, container, ok, detail }
         event: done     data: { ok, durationMs }

DELETE /api/rehearsals/:id
       Returns: 204
       (drops the record; does NOT teardown — teardown is guaranteed
       inside the run lifecycle)

POST   /api/rehearsals/:id/abort
       Returns: 202
       Best-effort: signals the run loop to teardown and finalize as
       'aborted'.
```

Auth: standard `x-api-key`. Rate-limit per default policy.

## 6. Security & isolation guarantees

These are the non-negotiables. Reviewer should refuse merge if any are missing.

| # | Guarantee | How |
|---|---|---|
| 1 | Stand-in containers cannot reach the production network | New bridge network per run, no `--network host`, no shared networks |
| 2 | Stand-in containers cannot reach the host | No `--publish` flags, no `--network host`, no `--cap-add NET_ADMIN` |
| 3 | Stand-in containers cannot access the Docker socket | `/var/run/docker.sock` never mounted into stand-ins, even if the original had it |
| 4 | Stand-in containers run with restored data, not production data | Volumes always temp (`drk-reh-*`); original volume names never bind-mounted |
| 5 | Secrets do not leak into stand-in containers | `SCRUB_ENV` default list strips: `*_TOKEN`, `*_SECRET`, `*_KEY`, `*_PASSWORD`, `AWS_*`, `STRIPE_*`, `LICENSE_*`, `OAUTH_*` (pattern-based, case-insensitive). Configurable additions via `scrubEnvVars`. |
| 6 | Sandbox network does not collide with user's networks | Default subnet `172.31.255.0/24` (high in 172.16/12, unusual for homelabs); override via request option |
| 7 | Resources outlive the process only briefly | All resources labelled `com.gozippy.drk.rehearsal=<run-id>`. On process start, scan for orphan labels and reap. |
| 8 | Concurrent rehearsals are bounded | Default cap of **2 concurrent rehearsals**. Configurable via `DRK_REHEARSAL_CONCURRENCY` env. Higher numbers may saturate restore I/O. |
| 9 | Audit log records every run | `rehearsal.start`, `rehearsal.complete`, `rehearsal.abort`, `rehearsal.teardown_failed` |
| 10 | Failures during restore do not leak partial data | If restore fails mid-way, teardown runs, partial volumes removed |

## 7. Smoke-check plugin pattern

`SmokeCheckRunner` interface for extension:

```typescript
export interface SmokeCheckRunner<K extends SmokeCheck['kind']> {
  readonly kind: K
  run(check: Extract<SmokeCheck, { kind: K }>, ctx: SmokeCheckContext): Promise<SmokeCheckResult>
}

export interface SmokeCheckContext {
  network: string
  containerNameMap: Record<string, string>  // logical → actual stand-in name
  docker: DockerService
  signal: AbortSignal                        // wired to overall rehearsal timeout
}
```

Initial implementations: `http`, `exec`, `tcp`, `file_exists`, `sql_select_1`.
Registry pattern lets us add `grpc`, `kafka_topic`, `redis_ping`, etc.
without touching `RehearsalService`.

## 8. Concurrency, lock model, scheduling

- A `RehearsalService` singleton holds an in-process semaphore sized
  by `DRK_REHEARSAL_CONCURRENCY` (default 2).
- `POST /api/rehearsals` returns 202 immediately; the run is enqueued
  and the API responds with `{ id, status: 'pending' }`.
- If the semaphore is full, the run waits in `pending`. There is no
  cross-process queue (we are single-process by design).
- Rehearsals also have a **cron trigger** later — once R-1 is stable,
  policies can declare `rehearsalSchedule: '0 5 * * 0'` and
  `SchedulerEngine` triggers them. This is intentionally **out of
  scope for R-1** so the MVP can ship; track as R-1-followup.

## 9. Failure modes & retry

| Failure | Behavior |
|---|---|
| Storage adapter restore error mid-volume | Mark step failed; abort restore phase; proceed to teardown |
| Stand-in container fails to start | Mark step failed; continue probe phase only for the containers that did start; report partial |
| Smoke check times out | Mark that check failed; if `stopOnFirstCheckFailure` (default true), skip remaining checks; teardown |
| Teardown fails (e.g., volume still in use) | Retry once after 5s; if still failing, log a `rehearsal.teardown_failed` audit event with the resource list; return success of run but flag in report |
| Process crash mid-run | On next start, scan for `com.gozippy.drk.rehearsal=*` labels; reap any without a matching rehearsal record in `status='running'` (orphan cleanup) |
| Smoke check needs a secret we scrubbed | Operator must declare `scrubEnvVars: []` (opt-out) for that run, or supply a `passwordEnv` smoke-check field that we read from rehearsal-only secret storage (deferred) |

## 10. Audit log events

```
{
  "type": "rehearsal.start",
  "rehearsalId": "<uuid>",
  "policyId": "<id-or-null>",
  "backupCount": 4,
  "smokeCheckCount": 3,
  "actorKeyHash": "<sha256-of-api-key-prefix>"
}

{
  "type": "rehearsal.complete",
  "rehearsalId": "<uuid>",
  "ok": true,
  "durationMs": 187_432,
  "smokeFailures": []
}

{
  "type": "rehearsal.teardown_failed",
  "rehearsalId": "<uuid>",
  "lingeringResources": { "containers": [...], "volumes": [...], "network": "..." }
}
```

## 11. UI surface (for R-2 wizard)

R-2 needs to render:

1. **List page `/rehearsals`** — table of past runs, columns:
   policy, started, duration, ok/failed, smoke-check fail count,
   link to detail.
2. **New-rehearsal wizard** (3-step modal mirroring PolicyWizard):
   - Step 1: Pick scope (`Policy → latest backups` OR explicit
     `Select backups…`)
   - Step 2: Pick smoke checks (preset templates per common stack —
     "Postgres alive", "HTTP responds 200", "config file exists" —
     plus custom)
   - Step 3: Review + Run
3. **Run detail page `/rehearsals/:id`** — live-following log stream
   (SSE), per-step pass/fail timeline, downloadable report (JSON +
   pretty markdown).

Pre-made smoke-check templates that should ship with v1.2 (the same
six stacks as `docs/STACK_RECIPES.md`):

| Stack | Smoke checks |
|---|---|
| Home Assistant | `http :8123/api/` expectStatus=401 (auth challenge), `exec ha-cli core check` |
| Plex | `http :32400/identity` expectStatus=200, `file_exists /config/Library` minBytes=10485760 |
| Immich | `http immich-server:3001/api/server-info/ping` expectStatus=200, `sql_select_1 immich-postgres` |
| Nextcloud | `http :80/status.php` bodyContains=`"installed":true`, `exec nextcloud php occ status` |
| Vaultwarden | `http :80/alive`, `file_exists /data/db.sqlite3` minBytes=1024 |
| n8n | `http :5678/healthz`, `file_exists /home/node/.n8n/database.sqlite` |

These ship as a `SMOKE_CHECK_TEMPLATES` constant in `packages/shared/`
so backend and UI agree.

## 12. Testing strategy

### 12.1 Unit
- `SmokeCheckRunner` implementations — pure functions, easy.
- `RehearsalRequest` validation — Zod schema; cover invalid `kind`,
  missing `db` on `sql_select_1`, both `policyId` and `backupIds` set.
- `SCRUB_ENV` regex coverage — confirm `STRIPE_SECRET_KEY`, `oauth_token`,
  `AWS_SECRET_ACCESS_KEY` all stripped; `NODE_ENV`, `LOG_LEVEL`,
  `DATABASE_URL` (sensitive! — note) preserved unless added.
  *Open question:* should `DATABASE_URL` be scrubbed by default?

### 12.2 Integration (gated by `CI_INTEGRATION=1`, mirrors S3 adapter pattern)
- Spin up a stack: `postgres:16` + a tiny `nginx` container.
- Take a backup via the LocalStorageAdapter.
- Run a rehearsal with: http smoke check on nginx, sql_select_1 on
  postgres.
- Assert: rehearsal record persists, report ok, network/containers/volumes
  cleaned up after.

### 12.3 Crash-recovery test
- Launch a rehearsal in a child process.
- Kill it mid-restore (SIGKILL).
- Restart `BackupService`.
- Assert: orphan cleanup runs, the labeled volumes/containers/network
  are gone within 30s.

## 13. Implementation phases

To keep the PR reviewable, split R-1 into three commits on a feature branch:

1. **R-1.1 — Types + DB migration + audit events** (no behavior)
2. **R-1.2 — RehearsalService + SmokeCheckRunner registry + 5 runners
   + REST endpoints + unit tests** (the meat)
3. **R-1.3 — Integration test + crash-recovery test + the
   SMOKE_CHECK_TEMPLATES constant** (closes acceptance)

R-2 (UI wizard) can begin against R-1.1 (types) without waiting for
R-1.2 — kilocode mocks the API responses until R-1.2 lands.

## 14. Open questions for operator

These need a call before implementation begins:

1. **Default scrub-env list** — should `DATABASE_URL` be in the default
   scrub list? Many apps need it to start, but it often carries
   production creds. Recommendation: **scrub by default**; operator
   opts out per-rehearsal with `scrubEnvVars: ['DATABASE_URL']` (no,
   that's backwards — need an `allowEnvVars` field).
   *Decision needed before implementation.*
2. **Network subnet collision strategy** — if `172.31.255.0/24` is
   taken on the host, do we (a) error out, (b) randomly pick another,
   or (c) read from a configurable range? Recommendation: (c).
3. **Cron scheduling for rehearsals** — defer to R-1-followup, or
   bundle into R-1? Recommendation: **defer**. MVP is operator-triggered.
4. **Notification on rehearsal failure** — depends on N-1. Wire-up
   skeleton in R-1 even if N-1 is stubs.
5. **Pro-tier gating** — is rehearsal Free or Pro? My read: Free up to
   1 concurrent rehearsal and 30-day history, Pro for higher
   concurrency + longer history + cron triggers. Needs LICENSE update
   to Schedule A if so. *Decision needed before implementation.*

## 15. Cross-doc sync

When R-1 lands, the following files need updates:

- `docs/ROADMAP.md` — flip R-1 from queued to shipped, update version
  number for the release
- `CHANGELOG.md` — Added section
- `docs/BACKUP_TOOLS_COMPARISON.md` — the "What 'restore rehearsal'
  actually means" section is currently aspirational; update to
  reference the actual feature
- `docs/MARKETPLACE_LISTING_DRAFT.md` — add restore-rehearsal to the
  features bullet list; reframe the "Why DRK" section to lead with it
- `.autoclaw/internal/marketplace-submission.md` — update detailed
  description; add to "What's new" if not yet tagged

---

*Spec authored 2026-05-25 while waiting on Kilo Code's backend test run.
Ready for operator review. Implementation gated on resolutions to §14.*
