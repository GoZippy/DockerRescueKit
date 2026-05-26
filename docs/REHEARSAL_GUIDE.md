# Restore-Rehearsal Guide

**A 5-minute walkthrough of the feature nobody else ships.**

Every other Docker backup tool stops at integrity checks — "does the
archive parse, do the hashes match?" Restore-rehearsal goes further:
DRK actually **restores your backup into a sandboxed network, brings up
stand-in containers, runs smoke checks, and tears it all down** —
proving the backup is recoverable *before* you need it at 2 AM.

This page is how to use it.

---

## What a rehearsal does, in order

```
1. PLAN       Resolve the backup set (one policy's latest, OR explicit IDs)
2. PREPARE    Create an isolated bridge network — no host routing
3. RESTORE    Pull each volume backup into a temp volume named drk-reh-<id>-<vol>
4. LAUNCH     Start stand-in containers on the sandbox with the original
              image + scrubbed env + remapped volumes
5. PROBE      Run your smoke checks in declared order
6. TEARDOWN   Always runs — stop/remove containers, remove temp volumes,
              delete the sandbox network
7. FINALIZE   Persist the full RehearsalReport to the audit log + DB
```

**Nothing the rehearsal does ever reaches your production network or
mounts your production volumes.** See the security guarantees below.

---

## Quick start (UI)

1. Open the DRK web UI or Docker Desktop extension.
2. Click **Rehearsals** in the sidebar.
3. Click **New rehearsal**.
4. Step 1 — pick a policy (uses its latest successful backup) OR pick
   explicit backups from history.
5. Step 2 — pick or add smoke checks (use a template for common stacks).
6. Step 3 — click **Run rehearsal**. Watch the live SSE stream.
7. When it finishes, expand the row to see the full report.

Rehearsals are independent — you can run them on demand without
disrupting your scheduled backups.

---

## Quick start (CLI)

```bash
# Tail the latest backups of a policy through one TCP probe
drk rehearsal:start \
  --policy 9a8b... \
  --check tcp:nginx:port=80

# Run an HTTP probe + a Postgres SELECT 1 against specific backups
drk rehearsal:start \
  --backup abc123 --backup def456 \
  --check http:web:port=8080,path=/healthz,expectStatus=200 \
  --check sql_select_1:db:driver=postgres,user=postgres,passwordEnv=POSTGRES_PASSWORD \
  --allow-env POSTGRES_PASSWORD \
  --subnet 172.31.250.0/24 \
  --timeout-ms 1800000

# Check progress
drk rehearsal:list
drk rehearsal:show <id>

# Cancel a running rehearsal (teardown still runs)
drk rehearsal:abort <id>
```

The CLI exits with non-zero status when `rehearsal:show` reports
`ok=false`, so you can drop it directly into a CI pipeline.

---

## Quick start (REST API)

```bash
KEY=$(docker exec drk cat /data/secrets.json | jq -r .apiKey)

# Enqueue
ID=$(curl -s -X POST http://localhost:42880/api/rehearsals \
  -H "x-api-key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "policyId": "9a8b...",
    "smokeChecks": [
      { "kind": "tcp", "container": "nginx", "port": 80 },
      { "kind": "sql_select_1", "container": "db", "driver": "postgres",
        "user": "postgres", "passwordEnv": "POSTGRES_PASSWORD" }
    ],
    "options": { "allowEnvVars": ["POSTGRES_PASSWORD"] }
  }' | jq -r .id)

# Follow live (Server-Sent Events)
curl -N -H "x-api-key: $KEY" http://localhost:42880/api/rehearsals/$ID/stream

# Fetch the final report
curl -s -H "x-api-key: $KEY" http://localhost:42880/api/rehearsals/$ID | jq .
```

---

## The 5 smoke-check kinds

Each check identifies a container by its **logical name from the
policy** (DRK remaps it to the actual stand-in container inside the
sandbox network).

### `http`
```json
{
  "kind": "http",
  "container": "web",
  "port": 8080,
  "path": "/health",
  "method": "GET",
  "expectStatus": 200,
  "bodyContains": "ok",
  "timeoutMs": 10000
}
```
`expectStatus` accepts a literal number, `"any_2xx"`, or `"any_3xx"`.
`bodyContains` is a substring assertion on the response body. Runs
inside the stand-in container via `curl`, so no ports are exposed to
the host.

### `exec`
```json
{
  "kind": "exec",
  "container": "app",
  "command": ["sh", "-c", "test -f /run/app.pid"],
  "expectExitCode": 0,
  "stdoutContains": "running",
  "timeoutMs": 30000
}
```
Generic `docker exec` probe. Exit code defaults to 0.

### `tcp`
```json
{
  "kind": "tcp",
  "container": "redis",
  "port": 6379,
  "timeoutMs": 5000
}
```
Tries `nc -z` first, falls back to bash's `/dev/tcp` pseudo-device.

### `file_exists`
```json
{
  "kind": "file_exists",
  "container": "vaultwarden",
  "path": "/data/db.sqlite3",
  "minBytes": 1024
}
```
Asserts a file exists at `path` with at least `minBytes` bytes. Useful
for catching the case where a volume restored but the database file
inside it is empty or truncated.

### `sql_select_1`
```json
{
  "kind": "sql_select_1",
  "container": "postgres",
  "driver": "postgres",
  "user": "postgres",
  "passwordEnv": "POSTGRES_PASSWORD",
  "db": "myapp",
  "timeoutMs": 15000
}
```
Runs `SELECT 1` against a PostgreSQL, MySQL, or MSSQL driver. The
password is read from an env var named in `passwordEnv` (which must be
allowlisted via `options.allowEnvVars` to survive the env scrub —
see below). `passwordEnv` is strictly validated as a POSIX env-var
name; values that could break out of shell context are rejected
before any command runs.

---

## Pre-made smoke-check templates

DRK ships with templated check sets for the 6 stacks in
[STACK_RECIPES.md](STACK_RECIPES.md). Import them by name from the
shared package, or pick them in the wizard's step 2.

| Stack | Templates included |
|---|---|
| `homeassistant` | HTTP `/api/` (401 challenge) + sqlite file exists |
| `plex` | HTTP `/identity` + library DB file exists |
| `immich` | HTTP `/api/server-info/ping` + Postgres SELECT 1 |
| `nextcloud` | HTTP `/status.php` body-contains + `php occ status` exec |
| `vaultwarden` | HTTP `/alive` + sqlite DB file exists |
| `n8n` | HTTP `/healthz` + sqlite DB file exists |

Programmatic:
```typescript
import { SMOKE_CHECK_TEMPLATES } from '@docker-rescue-kit/shared'

const checks = SMOKE_CHECK_TEMPLATES.vaultwarden
```

---

## Options reference

```typescript
options?: {
  stopOnFirstCheckFailure?: boolean    // default: true
  networkSubnet?: string               // default: '172.31.255.0/24'
  timeoutMs?: number                   // default: 30 minutes (1_800_000)
  allowEnvVars?: string[]              // case-insensitive whitelist
}
```

### `allowEnvVars` — what gets scrubbed by default

To protect against leaking production secrets into your sandbox,
DRK strips these env-var patterns from the source container before
launching the stand-in:

- `*_TOKEN`, `*_SECRET`, `*_KEY`, `*_PASSWORD` (suffix match)
- `AWS_*`, `STRIPE_*`, `LICENSE_*`, `OAUTH_*` (prefix match)
- `DATABASE_URL` (exact match)

**To re-enable a specific var** for a smoke check that needs it
(e.g., `POSTGRES_PASSWORD` for `sql_select_1`), list it in
`options.allowEnvVars`:

```json
"options": { "allowEnvVars": ["POSTGRES_PASSWORD"] }
```

Names are case-insensitive. The exhaustive default list is exported as
`SCRUB_ENV_DEFAULT_PATTERNS` from `@docker-rescue-kit/shared` if you
need it in your tooling.

### `networkSubnet` — collision avoidance

The default `172.31.255.0/24` sits in the high end of the standard
private 172.16/12 block where most homelabs and Compose stacks don't
allocate. If your host *does* have a bridge network on that subnet,
override it per-request:

```json
"options": { "networkSubnet": "10.99.250.0/24" }
```

---

## Security guarantees (the non-negotiables)

Every rehearsal is bounded by these, regardless of what the source
containers had:

| # | Guarantee |
|---|---|
| 1 | Sandbox network created with `Internal: true` — **no route to the host or production network** |
| 2 | Stand-in containers receive **no published ports** — no `--publish`, no `--network host` |
| 3 | The Docker socket is **never mounted** into stand-ins (even if the source container had it) |
| 4 | Volumes are **always temp** (`drk-reh-*`) — production volume names are never bind-mounted |
| 5 | Secrets do not leak — env-var scrub applies before the stand-in starts |
| 6 | Concurrency is bounded (default 2 — `DRK_REHEARSAL_CONCURRENCY` env) |
| 7 | Teardown **always runs** — even on probe failure, crash, or operator abort |
| 8 | Resources are labelled `com.gozippy.drk.rehearsal=<run-id>` so an orphan reaper on startup cleans anything a previous crash left behind |
| 9 | Every run emits `rehearsal.start` and `rehearsal.complete` audit events |

If a rehearsal crashes in a way that prevents teardown, the next DRK
startup scans for labelled orphans and reaps them — you don't end up
with stale sandbox networks accumulating over time.

---

## Reading the report

```jsonc
{
  "id": "9a8b...",
  "policyId": "abc...",
  "requestedBackupIds": ["bk-1", "bk-2"],
  "status": "success",             // 'success' | 'failed' | 'aborted'
  "ok": true,                      // shorthand for status === 'success'
  "steps": [
    { "label": "plan", "ok": true, "detail": "2 backup(s) resolved", ... },
    { "label": "prepare-network", "ok": true, "detail": "drk-rehearsal-9a8b (172.31.255.0/24)", ... },
    { "label": "restore-volume:appdata", "ok": true, "detail": "drk-reh-9a8b-appdata", ... },
    { "label": "launch:web", "ok": true, "detail": "drk-reh-9a8b-web", ... }
  ],
  "smokeCheckResults": [
    {
      "check": { "kind": "tcp", "container": "web", "port": 80 },
      "ok": true,
      "detail": "port 80 open",
      "attempt": 1,
      "durationMs": 142
    }
  ],
  "durationMs": 47831,
  "resources": {
    "network": "drk-rehearsal-9a8b",
    "containers": ["drk-reh-9a8b-web"],
    "volumes": ["drk-reh-9a8b-appdata"]
  }
}
```

**`steps`** are the lifecycle phases — what the rehearsal *did*.
**`smokeCheckResults`** are what your probes *found*. A rehearsal can
have `status: success` only if every step AND every smoke check
passes.

---

## Scheduling rehearsals (coming in v1.2.1)

For v1.2.0 GA, rehearsals are **operator-triggered only**. Cron-based
scheduling lands in v1.2.1 — you'll be able to declare
`rehearsalSchedule: '0 5 * * 0'` on a policy and the scheduler will
fire weekly rehearsals automatically.

In the meantime, the CLI is the obvious workaround:

```bash
# crontab: every Sunday at 05:00 UTC, rehearse the prod stack
0 5 * * 0  /usr/local/bin/drk rehearsal:start \
             --policy prod-stack \
             --check http:web:port=80,path=/health \
             --check sql_select_1:db:driver=postgres,user=postgres,passwordEnv=POSTGRES_PASSWORD \
             --allow-env POSTGRES_PASSWORD \
             > /var/log/drk-rehearsal.log 2>&1
```

---

## Troubleshooting

### "smoke check failed: container X not in rehearsal map"
The smoke check references a `container:` name that wasn't included
in the rehearsal. The current MVP launches stand-ins for every
container referenced by your smoke checks; make sure the name matches
your policy's container target.

### "container X not found via docker inspect"
DRK looks up the source container's image + env + mounts via
`docker inspect` against the host. If your source container has been
renamed or removed, the rehearsal can't reconstruct its spec. Either
restore the source container, or build the stand-in spec by hand in a
follow-up release (drift detection — F-1 — will catch this proactively).

### "network already exists" / subnet collision
Override `options.networkSubnet` with an unused range. The default
`172.31.255.0/24` covers most homelabs but is not universal.

### "passwordEnv must be a POSIX env-var name"
Validation rejected your `passwordEnv` value because it contained
characters that could break shell escaping (spaces, quotes, `$()`,
`;`, etc.). Use a plain `^[A-Z_][A-Z0-9_]*$` name and set the value
via your container's env, not via this field.

### Teardown left resources behind
Reported via the `rehearsal.teardown_failed` audit event with the
list of lingering resources. The next DRK startup will sweep them
via the orphan reaper. If you can't restart, manually remove:
`docker rm -f $(docker ps -aq --filter label=com.gozippy.drk.rehearsal=<id>)`
then `docker volume prune` filtered by the same label.

---

## See also

- **Design spec:** [docs/design/R-1_RESTORE_REHEARSAL.md](design/R-1_RESTORE_REHEARSAL.md) — architecture, decisions, deferred items
- **Stack recipes:** [docs/STACK_RECIPES.md](STACK_RECIPES.md) — pair each recipe with the matching `SMOKE_CHECK_TEMPLATES` key
- **Comparison:** [docs/BACKUP_TOOLS_COMPARISON.md](BACKUP_TOOLS_COMPARISON.md#what-restore-rehearsal-actually-means-and-why-nobody-else-ships-it) — why this feature is DRK's wedge

*Last updated: 2026-05-26*
