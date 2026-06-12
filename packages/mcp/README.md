# drk-mcp — Docker Rescue Kit Prune Guard MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI
coding agents **snapshot-before-prune** safety tools. Instead of running raw
`docker system prune` or `docker compose down -v`, an agent calls `safe_prune` /
`safe_compose_down`, which ask Docker Rescue Kit (DRK) to snapshot the affected
named volumes **first**, then perform the destructive op. When the agent (or a
human) deletes the wrong thing, `undo_last` restores it in one call.

> **The PocketOS pitch.** In April 2026 an AI coding agent ran a
> `prune`/drop sequence and wiped a production database *and its backups* in
> ~9 seconds. Every other tool tries to *prevent* the bad command — and
> reasoning agents routinely bypass prompts and denylists. DRK's angle is the
> one nobody ships: **recoverability**. Prune Guard snapshots the Docker volumes
> a destructive op is about to destroy *before* the data is gone, so "the agent
> just nuked my data" becomes a one-click **undo** instead of a postmortem.
> Prompts and denylists get bypassed; backups don't. This MCP server is the
> agent-facing front door to that safety net — and it's **free**.

## How it works

The server is a thin client. It is **stdio**-based (the standard for MCP Catalog
distribution): the agent launches it and speaks JSON-RPC over stdin/stdout.

- **Snapshots** are owned by the DRK backend (it holds the local guard cache and
  the snapshot engine). The server calls the DRK guard REST API to snapshot.
- **Destructive ops** are performed by the server directly against the Docker
  daemon via [`dockerode`](https://github.com/apocas/dockerode) (prune) or the
  `docker compose` CLI (compose down — no daemon API exists for compose).
- Ordering is strict: **snapshot completes, then prune runs.** That's the point.

## Install & configure

### Claude Desktop / Claude Code

Add to your MCP config (`claude_desktop_config.json` or `.mcp.json`):

```jsonc
{
  "mcpServers": {
    "drk": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "DRK_URL=http://host.docker.internal:42880",
        "-e", "DRK_API_KEY",
        "-v", "/var/run/docker.sock:/var/run/docker.sock",
        "gozippy/drk-mcp:latest"
      ],
      "env": { "DRK_API_KEY": "<your-drk-api-key>" }
    }
  }
}
```

Or run the package directly (no container) once built:

```jsonc
{
  "mcpServers": {
    "drk": {
      "command": "node",
      "args": ["/path/to/packages/mcp/dist/index.js"],
      "env": { "DRK_URL": "http://localhost:42880", "DRK_API_KEY": "<key>" }
    }
  }
}
```

### Cursor

Cursor uses the same shape under `Settings → MCP → Add` (`command` + `args` +
`env`). Point it at the `docker run …` command or `node …/dist/index.js` above.

### Configuration (environment)

| Var | Default | Purpose |
|---|---|---|
| `DRK_URL` | `http://localhost:42880` | DRK backend base URL (the guard API lives under `/api/guard`). |
| `DRK_API_KEY` | — (required) | `x-api-key` for the DRK backend. Find it in the backend logs on first run or `$DRK_DATA_DIR/secrets.json`. |
| `DOCKER_HOST` | platform default | Optional. Passed to dockerode. Unset → `/var/run/docker.sock` (Linux/Docker Desktop) or `//./pipe/docker_engine` (Windows). Supports `unix://`, `npipe://`, `tcp://host:port`. |

The server needs access to **both** the DRK backend (for snapshots) and the
Docker socket / `DOCKER_HOST` (for the prune). In a container, mount
`/var/run/docker.sock` (Linux) and reach the backend via
`host.docker.internal`.

## Tools (agent reference)

| Tool | What it does | When the agent should use it |
|---|---|---|
| `list_guard_snapshots()` | Lists the 20 most recent guard snapshot events. Read-only. | To find an event to restore, or confirm a volume was protected. |
| `snapshot_volumes({ volumes })` | Snapshots the named volumes **now**, awaiting completion. | **Before** any risky op you're about to run yourself against those volumes. |
| `safe_prune({ scope, volumes? })` | Snapshots in-scope named volumes, **then** prunes via the daemon. Returns `{ snapshotted, skipped, warnings, pruned }`. | **Instead of** `docker system/volume/image prune`. Pass `volumes` for `scope` `system`/`volumes`. |
| `safe_compose_down({ project, removeVolumes })` | Resolves the project's named volumes (compose label), snapshots them (when `-v`), **then** `docker compose down [-v]`. | **Instead of** `docker compose down -v`. |
| `undo_last()` | Restores data from the most recent **saved** guard snapshot. | Immediately when the user says data was just deleted. |

`safe_prune` scopes: only `system` and `volumes` can destroy volume data and
trigger a snapshot; `images` and `containers` don't touch volume data.

**Fail-open:** if a snapshot fails (disk full, volume locked), the destructive
op still proceeds, but the tool result carries a prominent `WARNING` so *you*
(the agent) can decide whether to continue or stop. This matches DRK's
recoverability-not-prevention posture (Prune Guard spec §7.1).

## Honest limits (spec §7.4)

This server protects **cooperative** agents — the ones that choose the safe
tool. It does **not** sandbox a rogue one:

- A jailbroken or non-cooperative agent that has the real Docker socket can
  still call raw `docker volume rm` / `prune` / `compose down -v` and bypass
  these tools entirely. For non-cooperative coverage, use DRK's Phase-2 socket
  proxy and give the agent container **only** the proxy socket.
- **Named volumes only.** Bind mounts / host directories and anonymous volumes
  are not snapshotted (DRK backs up named volumes, not arbitrary host paths).
- **Volumes over the per-volume cap** (default 512 MB) are skipped with a
  warning — protect them with a scheduled DRK policy instead.
- `safe_compose_down` requires the **`docker compose` CLI** on `PATH`; it
  degrades with a clear error if absent.
- Guard snapshots are an **evictable local safety cache** (default 72 h TTL),
  not durable backups. Use DRK's "Keep as backup" / policies for durability.

## Required contract addition (PG-1.4)

`snapshot_volumes` and the snapshot step of `safe_prune` / `safe_compose_down`
call **`POST /api/guard/snapshot`** (`{ kind, trigger: 'mcp', volumes }` →
`GuardEvent`). This endpoint is **not yet in the §9 REST contract** — the only
"snapshot now" path there is the dev-only `POST /api/guard/test` (gated behind
`DRK_GUARD_TEST=1`), which is unsuitable for production agent traffic. PG-1.4
must add `POST /api/guard/snapshot` as a thin wrapper over the existing
`PruneGuardService.guard(kind, 'mcp', volumes)` core. Until it lands, the
snapshot tools will 404 against the backend.

## Development

```bash
cd packages/mcp
npm install        # uses file:../shared; build shared first if its dist is stale
npm run build      # tsc → dist/
npm test           # jest (mocks the HTTP layer + dockerode)
npx tsc --noEmit   # strict type-check
```
