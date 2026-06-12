# Frequently Asked Questions

## What is DockerRescueKit?

DockerRescueKit (DRK) is a self-hosted backup and restore service for
Docker containers, volumes, and images. It runs as a single container,
exposes a web dashboard plus REST API, and ships scheduled backups
to pluggable storage adapters (local, S3, SMB, SFTP, rclone, restic,
Proxmox Backup Server).

## How is this different from Velero / Duplicati / restic standalone?

- **Velero** is Kubernetes-native; DRK targets plain Docker / Compose
  hosts where Velero is overkill.
- **Duplicati** is a generic file backup tool — it has no knowledge
  of Docker. You'd have to script `docker stop / dump / start` around
  it. DRK does that orchestration for you and stores the manifest
  needed to reconstruct the runtime.
- **restic** is a building block. DRK can *use* restic as a storage
  adapter, but adds the policy, scheduler, retention, verify, and
  restore UX on top.

## Where are backups stored?

Pluggable. The adapters shipped in v1.0:

- `local://` — bind-mounted directory on the host or a NAS mount
- `s3://` — any S3-compatible endpoint (AWS, Backblaze B2, MinIO,
  Wasabi, Garage, …)
- `smb://` — Windows / Samba shares
- `sftp://` — any SSH host
- `rclone://` — anything rclone supports (Google Drive, Dropbox,
  Mega, OneDrive, …)
- `restic://` — restic-managed repositories (deduped, encrypted)
- `pbs://` — Proxmox Backup Server

You can attach multiple destinations to a single policy for redundancy.

## Does it back up running containers safely?

Yes, with the usual caveats. DRK uses Docker's snapshot semantics:
the container is paused (`docker pause`) for the volume copy, then
resumed. For databases that don't tolerate fsync gaps, attach a
`pre_backup` hook to run `pg_dump` / `mongodump` / etc. into a
sidecar volume, and a `post_backup` hook to clean it up.

For containers using a copy-on-write filesystem (overlay2 default),
the pause is millisecond-scale. Network-attached storage backends
may be slower.

## Can I restore to a different host?

Yes. The backup manifest is portable — it captures container
metadata (image tag, env, volumes, networks, restart policy) along
with the volume bytes. To restore on a new host:

1. Install DRK on the new host.
2. Mount the same storage adapter (or copy the backup files locally).
3. Use the dashboard's "Restore" action or `drk restore <backup-id>`.

The only requirement is that the destination host can pull the
referenced images and reach the storage adapter.

## How do I rotate the API key?

Hit the `POST /api/settings/regenerate-api-key` endpoint with the
current key, or use the CLI shortcut from the repo root:

```bash
make key
```

The old key is invalidated immediately. The new key is written to
`/data/secrets.json` inside the container and echoed once to stdout.

## Is there a paid tier?

Yes. DockerRescueKit is source-available under the Zippy Technologies
Source-Available Commercial License. Personal and educational use is free
within the documented limits (5 policies, 14-day audit log). Pro and
Enterprise tiers unlock unlimited policies, longer audit retention,
notifications, and additional features. See
[docs/ROADMAP.md](ROADMAP.md) for the current tier table.

## Can DRK protect me from an AI agent running docker system prune?

Partially — and honestly, it depends on how the agent is wired up.

**What Prune Guard does (experimental, `DRK_PRUNE_GUARD=1`):**

- **Periodic safety floor (default, zero-config):** DRK snapshots your named
  volumes on a cron (default every 6 hours). If a prune destroys them, the
  undo toast points you at the most recent floor snapshot. The floor is
  always stale by up to one cron interval, but it's non-zero recoverability
  with nothing to configure.
- **MCP server (`drk-mcp`):** For AI agents that support MCP (Claude, Cursor,
  etc.), the `drk-mcp` server exposes a `safe_prune` tool that snapshots
  target volumes *before* pruning them. A cooperative agent calling
  `safe_prune` instead of raw `docker system prune` gets a genuine pre-prune
  snapshot and a one-click undo.

**What it cannot do (§7 of the Prune Guard spec — read this):**

- **A rogue or jailbroken agent calling the Docker socket directly** bypasses
  MCP entirely. The periodic floor is the only recovery in that scenario.
- **`docker volume rm` / `volume prune` via the raw API** cannot be intercepted
  in the v1.4 MVP — by the time the `volume destroy` event fires, the data is
  already gone. The floor snapshot may be hours old.
- **Volumes over the per-volume cap** (default 512 MB) are skipped with a
  warning; very large volumes should be protected by a scheduled DRK backup
  policy instead.
- **Bind mounts and host directories** are out of scope — DRK snapshots named
  Docker volumes only.

**Phase 2 (planned post-v1.4):** a socket proxy (`drk-guard-proxy`) that agents
and CLI tools are pointed at instead of the real Docker socket, giving genuine
pre-op intercept for all clients — including raw-API callers. See
`docs/PRUNE_GUARD_GUIDE.md` for the full picture.

## Is there a Docker Desktop extension?

Yes, and it is live on Docker Hub. Install it from the Docker Desktop
Marketplace or via:

```bash
docker extension install gozippy/dockerrescuekit:latest
```

The extension uses the socket transport to communicate with the DRK
backend container and gives you the full dashboard, policy editor,
restore wizard, rehearsals, and (in v1.4+, with `DRK_PRUNE_GUARD=1`)
the Prune Guard panel.

## How do I contribute?

See [`CONTRIBUTING.md`](../CONTRIBUTING.md). The short version:
issues and PRs welcome, run `npm test -ws` before opening a PR,
and keep storage adapters self-contained (one file under
`packages/backend/src/services/storage/adapters/`).

## I found a security bug — what now?

Please **do not** open a public issue. See
[`SECURITY.md`](../SECURITY.md) for the disclosure process and the
contact address. We acknowledge within 48 hours and aim for a
patched release within 7 days for any pre-auth or RCE-class report.
