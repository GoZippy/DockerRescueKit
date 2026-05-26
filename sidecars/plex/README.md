# `gozippy/drk-plex` — Plex backup side-car

**One container. Pre-configured for Plex Media Server. Walks away.**

This side-car backs up your Plex `/config` directory on a cron schedule,
to either a local tarball or any restic/rclone-supported remote. It
quiesces Plex safely before each backup (clears the transcoder cache,
optionally stops the container) so the SQLite databases inside the
backup are consistent.

**It does NOT back up your media library.** That's intentional — media
files belong on a separate, much larger, file-level backup. Point your
own `restic` or `rclone` at `/data/media` for that. This side-car only
handles the `/config` directory (Plex's settings, watch state, metadata,
posters, and SQLite databases — the stuff you cannot rebuild from
scratch).

---

## Quick start (Docker Compose)

```yaml
services:
  plex:
    image: linuxserver/plex
    container_name: plex
    volumes:
      - plex-config:/config
      - ./media:/data/media:ro
    # ... your usual env / ports ...

  drk-plex:
    image: gozippy/drk-plex:0.1.0
    container_name: drk-plex
    depends_on: [plex]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock    # to stop Plex pre-backup
      - plex-config:/source/config:ro                # what we back up
      - drk-plex-backups:/backups                    # where local backups go
    environment:
      PLEX_CONTAINER: plex
      BACKUP_SCHEDULE: "0 4 * * *"   # 4 AM daily
      BACKUP_TYPE: local
      RETENTION_KEEP_COUNT: "14"

volumes:
  plex-config:
  drk-plex-backups:
```

That's the whole setup. Tomorrow morning at 04:00 you'll have a tarball
at `drk-plex-backups/plex-config-<timestamp>.tar.gz`.

## Quick start (`docker run`)

```bash
docker run -d --name drk-plex \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v plex-config:/source/config:ro \
  -v drk-plex-backups:/backups \
  -e PLEX_CONTAINER=plex \
  -e BACKUP_SCHEDULE='0 4 * * *' \
  gozippy/drk-plex:0.1.0
```

---

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PLEX_CONTAINER` | `plex` | Name of the Plex container (used for `docker stop`/`start`) |
| `PLEX_CONFIG_SOURCE` | `/source/config` | Mountpoint inside this side-car for Plex's `/config` (mount **read-only**) |
| `BACKUP_DIR` | `/backups` | Where local backups are written |
| `BACKUP_SCHEDULE` | `0 4 * * *` | Standard 5-field cron expression. Honors `TZ`. |
| `BACKUP_TYPE` | `local` | One of `local`, `s3`, `sftp`, `b2`, `azure`, `rclone` |
| `BACKUP_ON_START` | `false` | Run one backup immediately on container start (skip the schedule wait) |
| `STOP_PLEX_BEFORE_BACKUP` | `true` | `docker stop` Plex pre-backup for consistency; restart after. Requires Docker socket mount. |
| `CLEAR_TRANSCODE_CACHE` | `true` | Delete `Cache/Transcode/*` pre-backup to keep archives small |
| `RESTIC_CACHE_DIR` | `/restic-cache` | Persistent restic cache mount (optional — dedup metadata) |
| `TZ` | `UTC` | Timezone for the schedule (e.g. `America/Chicago`) |
| **Local-specific** | | |
| `RETENTION_KEEP_COUNT` | _(unset → keep all)_ | When set, keep only the N most recent tarballs |
| **Restic-specific** (`s3`/`sftp`/`b2`/`azure`)** | | |
| `RESTIC_REPOSITORY` | _(required)_ | e.g. `s3:s3.amazonaws.com/mybucket/plex` |
| `RESTIC_PASSWORD` | _(required)_ | Encryption password — save this somewhere safe! |
| `RETENTION_KEEP_DAILY` | `7` | Tiered retention via `restic forget --keep-daily` |
| `RETENTION_KEEP_WEEKLY` | `4` | |
| `RETENTION_KEEP_MONTHLY` | `6` | |
| **S3-specific** | | |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | — | Standard S3 credentials |
| **B2-specific** | | |
| `B2_ACCOUNT_ID` / `B2_ACCOUNT_KEY` | — | Backblaze application key |
| **Azure-specific** | | |
| `AZURE_ACCOUNT_NAME` / `AZURE_ACCOUNT_KEY` | — | Azure Blob credentials |
| **Rclone-specific** | | |
| `RCLONE_REMOTE` | _(required)_ | Remote name from `rclone.conf` (e.g. `gdrive`) |
| `RCLONE_PATH` | _(required)_ | Path inside the remote (e.g. `Backups/plex`) |
| `RETENTION_KEEP_COUNT` | _(unset → keep all)_ | Count-based prune of remote tarballs |

For `rclone`, mount your existing config at
`/home/drk/.config/rclone/rclone.conf` read-only.

---

## How to restore

### From a local tarball

```bash
# Stop Plex
docker stop plex

# Wipe and restore the config volume
docker run --rm \
  -v plex-config:/restore \
  -v /path/to/drk-plex-backups:/backups:ro \
  alpine:3.19 \
  sh -c 'rm -rf /restore/* && tar -xzf /backups/plex-config-<timestamp>.tar.gz -C /restore'

# Bring Plex back
docker start plex
```

### From a restic repo

```bash
# List snapshots
docker run --rm \
  -e RESTIC_REPOSITORY -e RESTIC_PASSWORD \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
  restic/restic:latest snapshots --tag plex-config

# Restore the latest into a host directory, then copy into the volume
docker run --rm \
  -e RESTIC_REPOSITORY -e RESTIC_PASSWORD \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
  -v /tmp/plex-restore:/restore \
  restic/restic:latest restore latest --tag plex-config --target /restore

docker stop plex
docker run --rm -v plex-config:/dst -v /tmp/plex-restore:/src alpine:3.19 \
  sh -c 'rm -rf /dst/* && cp -a /src/* /dst/'
docker start plex
```

---

## Security notes

| Concern | Mitigation |
|---|---|
| **Docker socket mount** | Required only when `STOP_PLEX_BEFORE_BACKUP=true`. Set it to `false` if you'd rather accept a slightly inconsistent SQLite snapshot than expose the socket. |
| **Restic password leak** | `RESTIC_PASSWORD` is read once at startup. Use Docker secrets or env-file mounts; don't bake it into compose. |
| **S3/Azure key leak** | Same. Use the cloud provider's least-privilege IAM scoped to *this bucket only*. |
| **Plex config contains your token** | The `/config` directory includes your Plex auth token, server claim, and library DB. Treat the backup like a credential — encrypt with restic (default for non-local) or store local tarballs on encrypted volumes. |
| **Container runs as uid 1100** | Non-root by design. Make sure `/source/config` is readable by that uid, or use `:ro` mount (recommended). |

---

## Logs

Logs are emitted as one-line JSON for trivial ingestion:

```json
{"ts":"2026-05-25T04:00:00Z","level":"info","sidecar":"drk-plex","msg":"schedule matched at 2026-05-25T04:00 — running backup"}
{"ts":"2026-05-25T04:00:00Z","level":"info","sidecar":"drk-plex","phase":"pre","msg":"clearing transcoder cache at /source/config/Library/Application Support/Plex Media Server/Cache/Transcode"}
{"ts":"2026-05-25T04:00:01Z","level":"info","sidecar":"drk-plex","phase":"pre","msg":"stopping plex before backup"}
{"ts":"2026-05-25T04:02:18Z","level":"info","sidecar":"drk-plex","phase":"backup","msg":"backup complete (started=2026-05-25T04:00:01Z finished=2026-05-25T04:02:18Z)"}
```

Pipe to `jq` for human reading: `docker logs drk-plex | jq -c .`

If you also run the full DockerRescueKit backend, its audit-log scraper
will pick these up automatically in a future release (planned).

---

## Compared to running full DRK

| Need | Pick |
|---|---|
| "I just want my Plex backed up" | **`gozippy/drk-plex`** |
| "I run 8 stacks and want one UI for all of them" | **Full DRK** (and use the [Plex stack recipe](../../docs/STACK_RECIPES.md#plex--jellyfin)) |
| "I want restore rehearsal, partial restore browser, Prometheus metrics" | **Full DRK** |
| "I want to manage policies from Docker Desktop" | **Full DRK** (Extension Marketplace) |

---

## License

Source-available under the
[Zippy Technologies Source-Available Commercial License](../../LICENSE).
The contents of `sidecars/` are designated **Open Material** — you may
fork, adapt, and rebuild for personal or commercial use within the
terms of the LICENSE.

Bundled third-party binaries (`restic`, `rclone`, `docker-cli`, `tini`,
busybox/alpine base) retain their upstream licenses and are not affected
by the above.
