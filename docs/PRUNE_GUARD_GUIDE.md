# Prune Guard Guide

**How DRK keeps your Docker volumes recoverable when an AI agent — or you — runs a
destructive cleanup command.**

Prune Guard ships in v1.4.0 as an **experimental feature** behind an environment
flag. It is **free** — there is no Pro gate on the guard itself. The proxy opt-in
(Phase 2, planned post-v1.4) is also free when it ships.

---

## What Prune Guard is for

When `docker system prune`, `volume prune`, `volume rm`, `container rm -v`, or
`compose down -v` destroys a named Docker volume, that data is gone — unless DRK
saved a copy first. Prune Guard does that automatically, then shows you a
one-click **Undo** toast so you can get it back.

The DRK approach is **recoverability**, not prevention: we let the operation
proceed but make sure you can reverse it. "Prompts and denylists get bypassed —
backups don't."

---

## Enabling Prune Guard

Prune Guard is off by default in v1.4.0 (it is experimental and subject to change).
Enable it by setting the `DRK_PRUNE_GUARD` environment variable to `1`.

**Docker Compose (`docker-compose.yml` or `docker-compose.extension.yml`):**

```yaml
services:
  drk-backend:
    environment:
      - DRK_PRUNE_GUARD=1
```

Restart the backend after adding the variable:

```bash
docker compose down && docker compose up -d
```

Once enabled, the Prune Guard card appears on the DRK Dashboard. You can toggle it
on or off from there without restarting.

---

## What it protects — and what it cannot

### What Prune Guard covers

| Scenario | Coverage |
|---|---|
| AI agent calls `safe_prune` via the `drk-mcp` MCP server | Pre-op snapshot; full undo available |
| `docker compose down -v` or `container rm -v` (container die event, named volumes) | Best-effort opportunistic snapshot on `container die`; race window exists |
| Periodic floor: volumes in scope on the last 6-hour cron | Stale-but-non-zero recovery for everything including raw `volume rm/prune` |

### What Prune Guard cannot cover (§7 limits — read these)

| Limitation | Why |
|---|---|
| `docker volume rm` / `volume prune` via raw Docker API or CLI (non-MCP) in v1.4 MVP | Event fires *after* the data is deleted — too late to snapshot. Floor is the fallback. |
| Volumes over the per-volume cap (default 512 MB) | A synchronous tar of a 10 GB volume on the hot path is not feasible. Skipped with a warning. Use a scheduled DRK backup policy for large volumes. |
| Bind mounts and host-directory paths | DRK works with named Docker volumes only. |
| Data written after the last periodic floor snapshot | The floor is stale by up to the cron interval (default 6 h). Narrow the interval if needed. |
| A rogue agent with direct socket access that ignores the MCP tools | No intercept in MVP. Phase-2 proxy closes this for opted-in setups. |
| `rm -rf` inside a container or on the host filesystem | Out of scope for any Docker backup tool. |

Prune Guard records every skipped or missed event in the audit log and in the UI,
so you always know what is and is not covered.

---

## Settings explained

Open **Dashboard → Prune Guard** to reach the settings card.

### Guard: On / Off

Master switch. Defaults to On once `DRK_PRUNE_GUARD=1` is set. Turning it off
stops all snapshotting and event recording without requiring a restart.

### Scope

Controls which volumes are included in the periodic floor snapshot and in
event-reactive snapshots.

| Option | What it snapshots |
|---|---|
| **All named volumes** (default) | Every named Docker volume on the host, subject to the per-volume cap. Best for the "I haven't set up policies yet" case. |
| **Protected volumes only** | Only volumes belonging to a DRK backup policy or a protected Compose stack. Smaller footprint; requires policies to be configured first. |
| **All under size cap** | Same as "all named" but automatically excludes volumes over the per-volume cap rather than warning about them. |

### Disk budget

Total disk space Prune Guard may use for guard snapshots under `data/guard-cache/`.
Default: **2 GB**. The bar shows current usage. When a new snapshot would exceed the
budget, the oldest non-pinned snapshots are evicted first (LRU).

The guard cache lives under the same `drk-data` volume as your backups
(`data/guard-cache/`), so snapshots survive a backend restart.

### Snapshot stale volumes every

The periodic floor cron (default `0 */6 * * *` — every 6 hours). Hover over the
cron expression to see the plain-English description. You can type a custom cron or
pick a preset from the drop-down. Changes take effect on the next restart
(same behaviour as the export cron).

### Advanced (collapsed)

- **Per-volume cap** — Maximum size for a single volume snapshot. Default: 512 MB.
  Volumes over this cap are skipped with a `guard.snapshot_failed` audit event.
- **Snapshot TTL** — How long guard snapshots are kept before the daily sweep
  deletes them. Default: 72 hours. Pinned snapshots ("Keep as backup") are exempt.
- **Fail-closed** — Greyed out in v1.4; only relevant once the Phase-2 socket proxy
  is configured. When the proxy is active and `failClosed=true`, a snapshot failure
  blocks the destructive operation instead of warning and proceeding.

---

## The undo flow

When a destructive operation triggers a guard snapshot, DRK shows a toast:

> **We saved your work before that cleanup.**
> Docker just removed 3 volumes (`myapp-db`, `myapp-uploads`, `redis-data`).
> DRK snapshotted them first. **[Undo — restore now]   [Keep as backup]   [Dismiss]**

Click **Undo — restore now** to restore the volume data immediately.
DRK re-creates the volumes from the snapshots; you then re-create the containers
that use them (container recreation is not automatic in v1.4 — data is restored,
runtime is not).

If you missed the toast, the "Recently saved" strip on the Dashboard lists all
active guard snapshots within the TTL window. Click any row to see the detail and
restore from there.

**Promoting to a durable backup:** Click **Keep as backup** to pin the snapshot and
promote it to a one-off DRK backup entry (with optional upload to your configured
storage destination). Pinned snapshots are never auto-evicted.

---

## MCP setup for AI agents (Claude, Cursor, and others)

The `drk-mcp` package is an MCP server that exposes safe Docker tools to AI coding
agents. It connects to your DRK backend over the local API and provides:

- `snapshot_volumes(names[])` — snapshot specific volumes on demand
- `safe_prune(scope)` — snapshot in-scope volumes, then prune
- `safe_compose_down(project, removeVolumes)` — snapshot stack volumes, then `down -v`
- `undo_last()` — restore the most recent guard snapshot
- `list_guard_snapshots()` — list available snapshots

For setup instructions, package versions, and the Docker MCP Catalog entry, see
[`packages/mcp/README.md`](../packages/mcp/README.md).

The MCP server only works if `DRK_PRUNE_GUARD=1` is set in the backend.

---

## Lock your agent down: the guard proxy

The floor and the MCP server cover two cases: "you did nothing" and "the agent
cooperated." Neither catches a **rogue or jailbroken agent** that has the real
Docker socket and ignores the safe tools — it can call `DELETE /volumes/{name}`
or `POST /volumes/prune` on the raw socket and the data is gone before any event
fires. The **guard proxy** closes that gap. It is the opt-in, defense-in-depth
tier (design spec §4b / §5 Phase 2).

### How it works

The proxy is a small reverse proxy that speaks the Docker Engine API. You point
your agent (or tooling) at the **proxy socket** instead of `/var/run/docker.sock`.
Every request flows through DRK:

- Non-destructive calls (list, inspect, logs, build, `exec`) pass straight
  through, unchanged.
- Destructive calls — `volume rm`, `volume prune`, `container rm -v`,
  `container prune` — are intercepted: DRK resolves the volumes the call would
  destroy, **snapshots them first**, and only then forwards the original request
  to the real daemon. This is the only mechanism with full, non-cooperative
  coverage: it catches the CLI, the SDK, MCP, and raw-socket calls uniformly,
  because they all funnel through the one socket.

Because the proxy sees the request *before* the daemon, it gives true pre-op
protection even for `volume rm`/`prune`, which the zero-config floor cannot
catch in time.

### Enable it

The proxy is gated behind a second flag on top of the guard kill-switch. Both
must be set:

```
DRK_PRUNE_GUARD=1          # the guard core (also enables the floor + MCP)
DRK_GUARD_PROXY=1          # turn the proxy listener on
```

Optional configuration:

| Env var | Default | Purpose |
|---|---|---|
| `DRK_GUARD_PROXY_SOCKET` | `<dataDir>/drk-guard.sock` | Unix socket the proxy listens on |
| `DRK_GUARD_PROXY_PORT` | _(off)_ | If set, also listen on this TCP port — **bound to `127.0.0.1` only** |
| `DRK_GUARD_PROXY_UPSTREAM` | the real docker socket | Override the upstream daemon (`tcp://host:port` or `unix:///path`) |

### Point your agent at the proxy

The primary path is the **agent-in-a-container** case — the exact place the
runaway-prune incidents happen. Instead of bind-mounting the real socket into
your agent container:

```yaml
# don't:  - /var/run/docker.sock:/var/run/docker.sock
# do:
    volumes:
      - /path/to/drk-data/drk-guard.sock:/var/run/docker.sock
```

The agent talks to what it thinks is `/var/run/docker.sock`; it is really the
DRK proxy, which snapshots before every destroy. Give the agent container
*only* the proxy socket (not the real one) so it cannot bypass DRK.

For a host CLI/SDK, point `DOCKER_HOST` at the proxy:

```
export DOCKER_HOST=unix:///path/to/drk-data/drk-guard.sock
```

### Fail-closed: turn the safety net into a gate

By default the proxy is **fail-open** (design spec §7.1): if a snapshot fails
(disk full, volume locked), the destructive request is still forwarded and you
get a warning — DRK never breaks your tooling. If you would rather DRK **block**
a destroy it could not protect, set `failClosed` in Prune Guard settings
(Settings → Prune Guard → Advanced). With fail-closed on, a destructive request
whose snapshot did not fully succeed gets a **503** and the daemon never sees it
— the only place DRK acts as a true preventer, and only because you deliberately
routed your agent through it. Every block is audited as `guard.proxy_blocked`.

### Windows

Listening on a unix socket is the supported path on Linux and the Docker Desktop
Linux VM. **On Windows, the proxy does not listen on a host named pipe** — Node's
support for binding an arbitrary unix-socket path on Windows is unreliable. The
supported Windows story is exactly the agent-in-a-container case above: Docker
Desktop runs containers in a Linux VM, so bind-mounting the proxy's unix socket
into your agent container works there. If you need a host listener on Windows for
testing, set `DRK_GUARD_PROXY_PORT` to use the `127.0.0.1` TCP listener instead.

---

## Troubleshooting

### Guard card does not appear in the Dashboard

`DRK_PRUNE_GUARD=1` is not set in the backend environment. Add it to your compose
file and restart. The card appears after a page reload once the backend reports
`guard.enabled: true` in its status.

### "Snapshot skipped — volume too large"

The volume exceeds the per-volume cap (default 512 MB). Either:
- Raise the cap in Settings → Advanced → Per-volume cap.
- Add the volume to a scheduled DRK backup policy (recommended for volumes over a
  few hundred MB — the guard cache is for hot-path safety, not durable backups).

### "Couldn't snapshot before the prune — data already deleted"

The operation reached the Docker daemon before the guard could snapshot (raw API /
CLI call, not routed through the MCP server). Your recovery options:
1. Check the "Recently saved" strip — if a periodic floor snapshot exists it is
   listed there, stale by up to the cron interval.
2. If you have a scheduled DRK backup policy covering the volumes, restore from the
   most recent backup in Backup History.
3. If neither exists, the data is unrecoverable. This is the honest limit of the
   v1.4 event-reactive floor; the Phase-2 proxy closes the gap for users who route
   their agents through DRK.

### "Undo restored the data but my containers are gone"

Prune Guard restores volume *data* only in v1.4 — it does not auto-recreate
containers. Re-run `docker compose up -d` (or recreate containers manually) against
the restored volumes.

### Guard snapshots not being evicted / disk filling up

Check Settings → Prune Guard → Disk budget. If the bar is full and old snapshots
are not evicting, you may have pinned snapshots counting against the budget. Pinned
snapshots are never auto-evicted; delete them manually from the "Recently saved"
strip or from Backup History if you no longer need them.

### MCP server connects but tools return errors

Ensure the DRK backend is reachable at the URL configured in `packages/mcp/README.md`
and that the API key is correct. Tools check `DRK_PRUNE_GUARD=1` on the backend —
if the guard is disabled, `safe_prune` and `snapshot_volumes` return an error
explaining that the guard is off.

---

## See also

- **Design spec:** [`docs/design/PRUNE_GUARD.md`](design/PRUNE_GUARD.md) — full
  architecture, failure modes (§7), and Phase-2 proxy design
- **MCP server:** [`packages/mcp/README.md`](../packages/mcp/README.md) — setup
  and tool reference
- **FAQ entry:** [`docs/FAQ.md`](FAQ.md#can-drk-protect-me-from-an-ai-agent-running-docker-system-prune)
- **Rehearsal Guide:** [`docs/REHEARSAL_GUIDE.md`](REHEARSAL_GUIDE.md) — the
  complementary feature that proves your backups are actually restorable

*Last updated: 2026-06-11*
