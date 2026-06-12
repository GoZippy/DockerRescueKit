# Switching to DockerRescueKit

> **Applies to DRK v1.3+.**
> DRK is source-available under the Zippy Technologies Source-Available Commercial License —
> free for personal use, paid for commercial deployments.
> See [LICENSE](../LICENSE) and [Schedule A](../LICENSE#schedule-a-pricing).

---

## Why people switch

Every tool covered here will back your volumes up reliably.
The gap shows up at 2 AM when you need to restore: none of them will
*prove* a backup works before you need it.
DRK's restore rehearsal spins up a scratch container, restores the backup
into it, runs configurable smoke checks, and tears it down — all from the
UI or the `drk` CLI.
That verification moat is the most common reason users migrate.

---

## From offen/docker-volume-backup

### Concept mapping

| offen env var | DRK policy field | Notes |
|---|---|---|
| `BACKUP_CRON_EXPRESSION` | `schedule` (cron string) | Same cron syntax — copy/paste the expression |
| `BACKUP_RETENTION_DAYS` | `retention.days` | Also supports count-based and tiered retention |
| `BACKUP_PRUNING_LEEWAY` | (built into retention run order) | DRK prunes after write completes; no config needed |
| `BACKUP_FILENAME` | (auto-generated per run) | DRK names backups by policy + timestamp |
| `BACKUP_ARCHIVE_DESTINATION` | `storage.path` | Target sub-path within the configured backend |
| `AWS_S3_BUCKET_NAME` + credentials | connector via Settings → Storage Vault | Credentials stored AES-256-GCM encrypted |
| `BACKUP_NOTIFICATION_URLS` | `notifications` (Pro — webhooks, Slack, email) | Free tier logs only; Pro unlocks channels |
| `BACKUP_STOP_CONTAINER_LABEL` | `hooks.pre` + `hooks.post` | See quiesce note below |

**Container quiesce:** offen stops labeled containers before backup and restarts them after.
DRK does **not** stop containers automatically.
Instead, use `hooks.pre` / `hooks.post` to run `docker exec` commands inside the container
(e.g. `pg_dump`, `redis-cli BGSAVE`, or a custom flush script).
This keeps uptime higher but requires an explicit pre-hook if your app needs write-quiesce.

**What carries over:** the same volumes — DRK backs up the identical Docker-managed volumes.

**What doesn't carry over:** offen's tarball history.
DRK starts a fresh backup series on its first run.
There is no import path for offen's existing archives into DRK's storage layer.
Safe approach: **run both in parallel** until DRK has accumulated at least one verified
rehearsal pass, then retire offen.

### Worked example

offen compose service (excerpt):

```yaml
services:
  backup:
    image: offen/docker-volume-backup:latest
    environment:
      BACKUP_CRON_EXPRESSION: "0 3 * * *"
      BACKUP_RETENTION_DAYS: "14"
      AWS_S3_BUCKET_NAME: my-backups
      AWS_ACCESS_KEY_ID: AKIA...
      AWS_SECRET_ACCESS_KEY: secret
      BACKUP_STOP_CONTAINER_LABEL: "backup.enable=true"
    volumes:
      - myapp_data:/backup/myapp_data:ro
      - /var/run/docker.sock:/var/run/docker.sock
```

Equivalent DRK policy JSON (POST to `/api/policies` or paste into the policy wizard):

```json
{
  "name": "myapp-daily",
  "schedule": "0 3 * * *",
  "targets": [
    { "type": "volume", "selector": "myapp_data" }
  ],
  "retention": {
    "strategy": "time",
    "days": 14
  },
  "storage": {
    "type": "s3",
    "bucket": "my-backups",
    "region": "us-east-1",
    "connectorId": "<vault-entry-id>"
  },
  "hooks": {
    "pre": [
      {
        "type": "exec",
        "container": "myapp",
        "command": ["sh", "-c", "your-quiesce-command"]
      }
    ]
  }
}
```

Store the S3 credentials in Settings → Storage Vault first; the wizard will give you
the `connectorId` to paste here.

---

## From Backrest or zerobyte (restic-based)

### What the restic adapter supports

DRK's `ResticStorageAdapter` wraps the `restic` binary.
When you configure a restic-type policy, DRK calls `restic init` on the repo path you
provide — safe to run on an existing repo (restic no-ops if it's already initialized).

**However:** DRK tags its own snapshots as `drk:<remote-path>`.
It will not surface Backrest or zerobyte snapshots (which carry different tag schemes)
in DRK's backup history or restore wizard.
The data is still in the repo and accessible via the `restic` CLI directly —
DRK simply won't index it.

**There is no automatic migration** of existing Backrest/zerobyte snapshot metadata into
DRK policies.
The safe path is the run-in-parallel approach below.

### What you gain

Backrest and zerobyte do integrity checks (`restic check`).
DRK adds a restore rehearsal layer: it actually restores a snapshot into an isolated
scratch container, runs smoke checks (HTTP probe / arbitrary command), and reports
pass/fail — not just "the chunks are present."
If your restore has never been tested end-to-end, this is the upgrade.

### Concept mapping

| Backrest concept | DRK equivalent |
|---|---|
| Plan (source + schedule + retention) | Policy |
| Repo (restic repo path + password) | `storage` block (`type: restic`, `repo`, `password` via vault) |
| Hook (before/after backup) | `hooks.pre` / `hooks.post` (exec or webhook) |
| Forget policy (keep-daily/weekly) | `retention.strategy: tiered` with daily/weekly/monthly counts |
| Check job | `verifySchedule` (cron) + rehearsal (full restore-test) |

### Configuring the restic adapter

```json
{
  "storage": {
    "type": "restic",
    "repo": "s3:s3.amazonaws.com/my-bucket/drk-repo",
    "password": "<vault-entry-id>"
  }
}
```

For rclone-backed repos (OneDrive, GDrive, Dropbox, etc.), use `type: rclone` instead:

```json
{
  "storage": {
    "type": "rclone",
    "remote": "mydrive",
    "path": "docker-backups/drk",
    "password": "<vault-entry-id>"
  }
}
```

The `remote` name must match a configured remote in your `rclone.conf`.
Both adapters require a `password` (restic encryption key) stored in the vault.
Point at an **existing** Backrest/zerobyte repo path if you want dedup continuity —
new DRK snapshots will be deduplicated against the existing repo data.
DRK just won't show the old snapshots in its history UI.

---

## From Nautical-backup

Nautical-backup discovers containers via the Docker socket and backs up their
bind-mount paths using `rsync`.
It stops each container before the rsync run and restarts it after —
the "stop-to-backup" approach gives crash-consistency.

DRK uses a different approach:

| Behavior | Nautical-backup | DRK |
|---|---|---|
| Volume/bind discovery | Docker socket auto-scan | Docker socket auto-scan via "Protect stack" |
| Consistency mechanism | Container stop + rsync | Pre-hook `docker exec` (app-level quiesce) |
| Container downtime | Yes — stopped during backup | No — containers keep running; app controls quiesce |
| Storage format | rsync tree / tarball | tar.gz (local/SMB/SFTP) or restic snapshot (dedup) |
| Cloud destinations | S3, local | S3, SMB, SFTP, PBS, restic, rclone (40+ clouds) |
| Restore verification | None | Sandbox rehearsal with smoke checks |
| UI | None (label-driven config) | Web UI + Docker Desktop Extension + CLI |

**Stop-to-backup vs exec-quiesce:** if your workloads require crash-consistent
stop/start behavior, replicate it with a pre-hook that calls `docker stop <container>`
and a post-hook that calls `docker start <container>` via the DRK exec hook type.
You get the same consistency guarantee with explicit control over which containers pause.

**Tarball history:** Nautical's rsync tarballs are not importable into DRK.
Run both tools in parallel until DRK has a verified rehearsal, then cut over.

---

## The run-in-parallel pattern (the universal safe path)

Whatever you're switching from, this is the safest migration:

1. **Install DRK** alongside your existing tool — they target the same volumes but write to different destinations.
2. **Create matching DRK policies** and let them run for at least a week.
3. **Run a restore rehearsal** from the DRK UI (Backups → select run → Rehearse).
   Wait for a green pass result.
4. **Compare backup sizes** — confirm DRK is capturing the same data.
5. **Disable your old tool.** Keep its last backup archive for 30 days before deleting.

This pattern turns DRK's restore rehearsal into the migration gate:
you don't cut over until you have proof the new backups actually work.
That's the verification gap your old tool couldn't close.

---

## FAQ

**Can I import my existing offen tarballs into DRK?**
No — there is no import path for offen archives today.
Run both tools in parallel until DRK has history, then retire offen.

**Can I point DRK at my existing Backrest/zerobyte restic repo?**
Yes — DRK will initialize safely on an existing repo and new DRK snapshots
will deduplicate against existing data.
Old snapshots won't appear in DRK's history UI (different tag scheme),
but the data is intact and accessible via `restic` directly.

**Will DRK stop my containers during backup?**
No. DRK keeps containers running and uses `docker exec` pre/post hooks for
app-level quiesce (e.g. `pg_dump`, `redis-cli BGSAVE`).
If you need hard stop/start behavior, add explicit stop/start commands to
your `hooks.pre` and `hooks.post`.

**How many policies can I have on the free tier?**
The free tier allows 5 active policies.
Pro (one-time or annual, see [LICENSE Schedule A](../LICENSE)) removes the cap.

**Is DRK open source?**
No — DRK is source-available under the Zippy Technologies Source-Available
Commercial License. Personal and educational use is free;
commercial use requires a paid license from Zippy Technologies LLC.
See [LICENSE](../LICENSE) for full terms.

---

*See also: [Backup Tools Buyer's Guide](BACKUP_TOOLS_COMPARISON.md) | [Stack Recipes](STACK_RECIPES.md)*
