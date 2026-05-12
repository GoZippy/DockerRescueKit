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

No. DockerRescueKit is open source under the MIT license. There is
no paid tier today and no upsell. If a sustainable hosted offering
ever makes sense, it will be additive — the self-hosted product
will keep all current features.

## Will there be a Docker Desktop extension?

Yes, planned for v1.1. The `packages/extension` directory in the
monorepo already contains a working React UI that mounts inside the
Docker Desktop extension shell; we're waiting on Docker Desktop's
extension marketplace review before shipping it as a one-click
install. In the meantime you can side-load it via
`docker extension install dockerrescuekit/extension:next`.

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
