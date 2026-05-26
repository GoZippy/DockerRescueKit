# `gozippy/drk-vaultwarden` — Vaultwarden backup side-car

**One container. Pre-configured for Vaultwarden. Backs up hourly.
Treats your password vault like the critical credential it is.**

This side-car backs up your Vaultwarden `/data` directory hourly,
using SQLite's atomic `.backup` command so it never needs to stop the
server. Captures the db, attachments, sends, icon cache, RSA keys,
and config. Defaults to local tarballs; flip one env var for restic
on S3, Backblaze, Azure, SFTP, or rclone to any of 40+ cloud
providers.

**The whole point: a password vault should survive a house fire.**
Run two of these side-cars — one local, one off-site — and you've got
that.

---

## Quick start (Docker Compose, local + cloud)

```yaml
services:
  vaultwarden:
    image: vaultwarden/server:latest
    container_name: vaultwarden
    volumes:
      - vw-data:/data
    environment:
      DOMAIN: "https://vault.example.com"
    restart: unless-stopped

  # Local hourly backups — the on-host safety net
  drk-vw-local:
    image: gozippy/drk-vaultwarden:0.1.0
    container_name: drk-vw-local
    depends_on: [vaultwarden]
    volumes:
      - vw-data:/source/data:ro              # read-only mount of vaultwarden's volume
      - drk-vw-local-backups:/backups
    environment:
      BACKUP_SCHEDULE: "0 * * * *"           # hourly
      BACKUP_TYPE: local
      RETENTION_KEEP_HOURLY: "24"
      RETENTION_KEEP_DAILY: "14"
    restart: unless-stopped

  # Daily off-site to Backblaze — the house-fire safety net
  drk-vw-b2:
    image: gozippy/drk-vaultwarden:0.1.0
    container_name: drk-vw-b2
    depends_on: [vaultwarden]
    volumes:
      - vw-data:/source/data:ro
      - drk-vw-restic-cache:/restic-cache
    environment:
      BACKUP_SCHEDULE: "0 4 * * *"           # daily at 04:00
      BACKUP_TYPE: b2
      RESTIC_REPOSITORY: "b2:my-vault-bucket/vaultwarden"
      RESTIC_PASSWORD_FILE: "/run/secrets/restic_password"
      B2_ACCOUNT_ID: "${B2_ACCOUNT_ID}"
      B2_ACCOUNT_KEY: "${B2_ACCOUNT_KEY}"
      RETENTION_KEEP_DAILY: "14"
      RETENTION_KEEP_WEEKLY: "8"
      RETENTION_KEEP_MONTHLY: "12"
    secrets: [restic_password]
    restart: unless-stopped

secrets:
  restic_password:
    file: ./secrets/restic_password.txt

volumes:
  vw-data:
  drk-vw-local-backups:
  drk-vw-restic-cache:
```

That's the recommended setup. Two side-cars, two retention horizons,
two locations.

## Quick start (`docker run`, local only)

```bash
docker run -d --name drk-vaultwarden \
  -v vw-data:/source/data:ro \
  -v drk-vw-backups:/backups \
  -e BACKUP_SCHEDULE='0 * * * *' \
  gozippy/drk-vaultwarden:0.1.0
```

---

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `VW_DATA_SOURCE` | `/source/data` | Read-only mountpoint of Vaultwarden's `/data` volume |
| `VW_DB_FILENAME` | `db.sqlite3` | Override only if you renamed it (rare) |
| `BACKUP_DIR` | `/backups` | Where local backups are written |
| `BACKUP_SCHEDULE` | `0 * * * *` (hourly) | Standard 5-field cron expression. Honors `TZ`. |
| `BACKUP_TYPE` | `local` | `local`, `s3`, `sftp`, `b2`, `azure`, `rclone` |
| `BACKUP_ON_START` | `false` | Run one backup immediately on container start |
| `TZ` | `UTC` | Timezone for the schedule |
| **Retention (tiered)** | | |
| `RETENTION_KEEP_HOURLY` | `24` | Last N hourly snapshots — defends against accidental delete |
| `RETENTION_KEEP_DAILY` | `14` | Last N daily — covers a 2-week ransomware-rollback window |
| `RETENTION_KEEP_WEEKLY` | `8` | Last N weekly — long-tail recovery |
| `RETENTION_KEEP_MONTHLY` | `12` | Last N monthly — historical archive |
| **Restic-specific** (`s3`/`sftp`/`b2`/`azure`)** | | |
| `RESTIC_REPOSITORY` | _(required)_ | e.g. `b2:my-bucket/vaultwarden` |
| `RESTIC_PASSWORD` | _(required)_ | Encryption password. **Save this somewhere not in the backup.** |
| **S3-specific** | | |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | — | Standard S3 credentials |
| **B2-specific** | | |
| `B2_ACCOUNT_ID` / `B2_ACCOUNT_KEY` | — | Backblaze application key |
| **Azure-specific** | | |
| `AZURE_ACCOUNT_NAME` / `AZURE_ACCOUNT_KEY` | — | Azure Blob credentials |
| **Rclone-specific** | | |
| `RCLONE_REMOTE` | _(required)_ | Remote name from `rclone.conf` |
| `RCLONE_PATH` | _(required)_ | Path inside the remote |

---

## How to restore

### From a local tarball

```bash
# Stop Vaultwarden
docker stop vaultwarden

# Wipe and restore the /data volume
docker run --rm \
  -v vw-data:/restore \
  -v /path/to/drk-vw-backups:/backups:ro \
  alpine:3.19 \
  sh -c 'rm -rf /restore/* && tar -xzf /backups/vaultwarden-<timestamp>.tar.gz -C /restore'

docker start vaultwarden
```

### From a restic repo

```bash
# List snapshots
docker run --rm \
  -e RESTIC_REPOSITORY -e RESTIC_PASSWORD \
  -e B2_ACCOUNT_ID -e B2_ACCOUNT_KEY \
  restic/restic:latest snapshots --tag vaultwarden

# Restore the latest
docker run --rm \
  -e RESTIC_REPOSITORY -e RESTIC_PASSWORD \
  -e B2_ACCOUNT_ID -e B2_ACCOUNT_KEY \
  -v /tmp/vw-restore:/restore \
  restic/restic:latest restore latest --tag vaultwarden --target /restore

docker stop vaultwarden
docker run --rm -v vw-data:/dst -v /tmp/vw-restore:/src alpine:3.19 \
  sh -c 'rm -rf /dst/* && cp -a /src/tmp/drk-vw-stage.*/* /dst/'
docker start vaultwarden
```

Test the restore by logging in as a non-admin account before anyone
touches the production vault.

---

## Why this side-car is more paranoid than drk-plex

| | drk-plex | drk-vaultwarden |
|---|---|---|
| Default schedule | Daily at 04:00 | **Hourly** |
| Default retention | 14 daily | **24 hourly + 14 daily + 8 weekly + 12 monthly** |
| Recommended targets | 1 (local or cloud) | **2 (local + offsite — strongly recommended)** |
| Docker socket mount | Required (to stop Plex) | **Not required** — atomic SQLite `.backup` |
| Image size | ~50MB (incl docker-cli) | ~30MB (no docker-cli) |
| Pre-backup quiesce | Stop+restart Plex | None — `.backup` is atomic |
| Failure mode if you lose it | Rebuild library metadata | **Lose every saved password** |

The first row is the headline difference: a password vault you can't
restore is a wallet you can't open. Hourly + dual-target is the
minimum responsible posture.

---

## Security notes

| Concern | Mitigation |
|---|---|
| **No Docker socket mount** | This side-car deliberately doesn't mount `/var/run/docker.sock`. Smaller attack surface vs. drk-plex. |
| **Restic password leak** | `RESTIC_PASSWORD` is the *only* thing standing between an attacker who steals your B2 bucket and your master vault. Store it in Docker secrets or a Bitwarden/1Password entry on a DIFFERENT machine — not in `docker-compose.yml`. |
| **Cloud key leak** | Same goes for `B2_ACCOUNT_KEY` / `AWS_SECRET_ACCESS_KEY`. Use least-privilege IAM scoped to *this bucket only*. |
| **Backup destination compromise** | Even with restic encryption, a compromised bucket key could let an attacker DELETE your backups. Use B2 application keys with `writeOnly` permission, OR use a bucket-versioning + lifecycle-rule combination so deletes can be reversed. |
| **Read-only source mount** | The Vaultwarden volume is mounted `:ro` — this side-car cannot modify your live data. |
| **Container runs as uid 1100** | Non-root by design. Match the uid on bind mounts if you use those. |

---

## Logs

One-line JSON per the side-car convention:

```json
{"ts":"2026-05-26T04:00:00Z","level":"info","sidecar":"drk-vaultwarden","msg":"schedule matched at 2026-05-26T04:00 — running backup"}
{"ts":"2026-05-26T04:00:00Z","level":"info","sidecar":"drk-vaultwarden","phase":"backup","msg":"snapshotting /source/data/db.sqlite3 via sqlite .backup (atomic)"}
{"ts":"2026-05-26T04:00:02Z","level":"info","sidecar":"drk-vaultwarden","phase":"backup","msg":"backup complete (started=2026-05-26T04:00:00Z finished=2026-05-26T04:00:02Z)"}
```

Pipe to `jq` for human reading: `docker logs drk-vaultwarden | jq -c .`

---

## Pair with R-1 restore-rehearsal (recommended)

Vaultwarden is the textbook stack for [R-1 restore-rehearsals](../../docs/REHEARSAL_GUIDE.md):
the consequence of a silently-broken backup is catastrophic, and the
smoke checks are trivial.

If you also run the full DRK backend (alongside this side-car or
instead of it), use this rehearsal template once a week:

```bash
drk rehearsal:start \
  --policy vaultwarden \
  --check http:vaultwarden:port=80,path=/alive \
  --check file_exists:vaultwarden:path=/data/db.sqlite3,minBytes=1024
```

The full DRK extension also gives you the policy UI, audit log, and
Prometheus metrics for the same backups — see the
[Stack Recipes](../../docs/STACK_RECIPES.md#vaultwarden) for the
matching policy YAML.

---

## License

Source-available under the
[Zippy Technologies Source-Available Commercial License](../../LICENSE).
The contents of `sidecars/` are designated **Open Material** — you may
fork, adapt, and rebuild for personal or commercial use within the
terms of the LICENSE.

Bundled third-party binaries (`restic`, `rclone`, `sqlite`, `tini`,
busybox/alpine base) retain their upstream licenses.
