# Stack Recipes — Copy-Paste DRK Policies for Popular Homelab Apps

This page is a growing catalog of **ready-to-import DockerRescueKit
policies** for the apps homelabbers actually run. Each recipe is:

- A short rationale (what's worth protecting and what's safe to skip)
- A JSON policy block you can POST to `/api/policies` or import via the
  Docker Desktop extension
- Any `pre:` / `post:` hooks needed to make the backup consistent
  (quiescing the app, flushing the cache, etc.)
- A one-paragraph "how to restore" so you know what you're getting
  before you need it at 2 AM

> **Quickstart**
> 1. Install the DockerRescueKit Docker Desktop extension, or
>    `docker run -d gozippy/dockerrescuekit:1.2.0`
> 2. Set up a storage connector (S3, SMB, SFTP, PBS, Rclone) on the
>    **Integrations** page
> 3. Open the recipe you need below, copy the JSON, replace the
>    `connectorId` / `container name` placeholders, and save the policy
> 4. Run it once manually to verify, then let the schedule take over

Recipes ship as **stable JSON** so they're easy to keep current as DRK
evolves. Field reference: [docs/ARCHITECTURE.md](ARCHITECTURE.md#backuppolicy-shape).

---

## Contents

- [Home Assistant](#home-assistant)
- [Plex / Jellyfin](#plex--jellyfin)
- [Immich (photos)](#immich-photos)
- [Nextcloud](#nextcloud)
- [Vaultwarden](#vaultwarden)
- [n8n (workflow automation)](#n8n-workflow-automation)
- [Contributing a recipe](#contributing-a-recipe)

---

## Home Assistant

**What matters:** `/config` is the only directory you cannot rebuild from
scratch. The recorder database (SQLite by default) is the largest churn,
so the recipe quiesces it before snapshotting.

**Container assumed:** `homeassistant` with a named volume `ha-config`
mounted at `/config`.

```json
{
  "name": "homeassistant-nightly",
  "enabled": true,
  "schedule": "0 3 * * *",
  "verifySchedule": "0 4 * * 0",
  "backupType": "full",
  "targets": [
    { "type": "container", "selector": "homeassistant" },
    { "type": "volume",    "selector": "ha-config" }
  ],
  "retention": {
    "strategy": "tiered",
    "tiers": [
      { "tag": "daily",   "maxCount": 7 },
      { "tag": "weekly",  "maxCount": 4 },
      { "tag": "monthly", "maxCount": 12 }
    ]
  },
  "storage": { "id": "ha-backup", "type": "s3", "connectorId": "REPLACE_ME" },
  "hooks": {
    "pre": [
      "exec:homeassistant:wget -qO- -u admin -p $HA_TOKEN http://localhost:8123/api/services/recorder/purge"
    ],
    "databases": [
      { "kind": "sqlite", "container": "homeassistant", "dbPath": "/config/home-assistant_v2.db" }
    ]
  }
}
```

**Restore:** mount the restored volume back at `/config`. HA picks up
`home-assistant_v2.db` automatically. Long-term-statistics survive the
recorder purge so dashboards stay intact after restore.

---

## Plex / Jellyfin

**What matters:** the *metadata* and *transcoder cache* are huge but
mostly rebuildable. The recipe excludes `Transcode/` because it grows
to dozens of GB and re-creates itself on first use. **Media files are
NOT backed up by this recipe** — those should be on a separate, much
larger, file-level backup (this is what you point Restic/Rclone at
directly).

**Containers assumed:** `plex` with volume `plex-config` mounted at
`/config`. For Jellyfin, replace `plex` with `jellyfin` and the volume
path the same way.

```json
{
  "name": "plex-config-nightly",
  "enabled": true,
  "schedule": "0 4 * * *",
  "verifySchedule": "0 5 * * 0",
  "backupType": "full",
  "targets": [
    { "type": "container", "selector": "plex" },
    { "type": "volume",    "selector": "plex-config" }
  ],
  "retention": { "strategy": "count", "count": 14 },
  "storage": { "id": "plex-backup", "type": "smb", "connectorId": "REPLACE_ME" },
  "hooks": {
    "pre": [
      "exec:plex:rm -rf '/config/Library/Application Support/Plex Media Server/Cache/Transcode' || true"
    ]
  }
}
```

**Restore:** mount the volume back at `/config`. Plex will rebuild the
transcoder cache on demand. If you also want to capture watch state
without the cache bulk, set `Plex Media Server/Plug-in Support/Databases`
as a targeted partial restore (DRK's file browser supports that out of
the box).

---

## Immich (photos)

**What matters:** Immich has two distinct data sets — a **Postgres**
database (with the `pgvector` extension that powers face/object search)
and the **upload library** (the actual photo files). Both must be in
the recipe, and the DB dump must happen before the volume snapshot or
you'll restore an index out of sync with the files.

**Containers assumed:** `immich-server`, `immich-postgres` (the
official `tensorchord/pgvecto-rs` image), `immich-redis`.
Volumes: `immich-upload`, `immich-db`.

```json
{
  "name": "immich-nightly",
  "enabled": true,
  "schedule": "30 2 * * *",
  "verifySchedule": "0 4 * * 0",
  "backupType": "full",
  "targets": [
    { "type": "container", "selector": "immich-server" },
    { "type": "container", "selector": "immich-postgres" },
    { "type": "container", "selector": "immich-redis" },
    { "type": "volume",    "selector": "immich-upload" },
    { "type": "volume",    "selector": "immich-db" }
  ],
  "retention": {
    "strategy": "tiered",
    "tiers": [
      { "tag": "daily",   "maxCount": 7 },
      { "tag": "weekly",  "maxCount": 4 },
      { "tag": "monthly", "maxCount": 6 }
    ]
  },
  "storage": { "id": "immich-backup", "type": "rclone", "connectorId": "REPLACE_ME" },
  "hooks": {
    "databases": [
      {
        "kind": "postgres",
        "container": "immich-postgres",
        "user": "postgres",
        "db": "immich",
        "outPath": "/var/lib/postgresql/data/drk-immich.sql.gz"
      },
      { "kind": "redis", "container": "immich-redis" }
    ]
  }
}
```

**Restore:** restore both volumes, restart the stack, then run
`pg_restore` on the `drk-immich.sql.gz` dump inside `immich-postgres`.
DRK's partial-restore browser will surface the SQL dump as a normal file
under the volume's `_data/` tree.

---

## Nextcloud

**What matters:** `/var/www/html` (the data + config), the database
(usually MariaDB), and Redis (for session/locking state). The recipe
puts the database in maintenance mode for the duration of the snapshot
so the SQL dump and the data directory stay consistent.

**Containers assumed:** `nextcloud`, `nextcloud-db` (MariaDB),
`nextcloud-redis`. Volumes: `nextcloud-data`, `nextcloud-db`.

```json
{
  "name": "nextcloud-nightly",
  "enabled": true,
  "schedule": "0 2 * * *",
  "verifySchedule": "0 4 * * 0",
  "backupType": "full",
  "targets": [
    { "type": "container", "selector": "nextcloud" },
    { "type": "container", "selector": "nextcloud-db" },
    { "type": "volume",    "selector": "nextcloud-data" },
    { "type": "volume",    "selector": "nextcloud-db" }
  ],
  "retention": {
    "strategy": "tiered",
    "tiers": [
      { "tag": "daily",   "maxCount": 7 },
      { "tag": "weekly",  "maxCount": 4 },
      { "tag": "monthly", "maxCount": 12 }
    ]
  },
  "storage": { "id": "nextcloud-backup", "type": "sftp", "connectorId": "REPLACE_ME" },
  "hooks": {
    "pre": [
      "exec:nextcloud:php occ maintenance:mode --on"
    ],
    "post": [
      "exec:nextcloud:php occ maintenance:mode --off"
    ],
    "databases": [
      {
        "kind": "mysql",
        "container": "nextcloud-db",
        "user": "nextcloud",
        "password": "REPLACE_ME",
        "db": "nextcloud"
      },
      { "kind": "redis", "container": "nextcloud-redis" }
    ]
  }
}
```

**Restore:** restore the volumes, bring the stack back up, then import
the SQL dump into `nextcloud-db` via `mysql -u nextcloud -p nextcloud <
drk-mysql.sql.gz` (you'll need to `gunzip` first). The post-hook safety
net means even a failed mid-backup leaves the stack in maintenance mode
— check the logs and toggle it back off manually if needed.

---

## Vaultwarden

**What matters:** **everything**. Vaultwarden's data directory contains
the SQLite database, the master key, all attachments, and the sends
table. There is no "nice-to-have" file in there — losing any of it
costs you your password vault. The recipe is paranoid by design:
hourly daily-retained tier, weekly off-site copy via a second policy.

**Container assumed:** `vaultwarden` with volume `vw-data` mounted at
`/data`.

```json
{
  "name": "vaultwarden-hourly",
  "enabled": true,
  "schedule": "0 * * * *",
  "verifySchedule": "0 4 * * *",
  "backupType": "full",
  "targets": [
    { "type": "container", "selector": "vaultwarden" },
    { "type": "volume",    "selector": "vw-data" }
  ],
  "retention": {
    "strategy": "tiered",
    "tiers": [
      { "tag": "hourly",  "maxCount": 24 },
      { "tag": "daily",   "maxCount": 14 },
      { "tag": "weekly",  "maxCount": 8 },
      { "tag": "monthly", "maxCount": 12 }
    ]
  },
  "storage": { "id": "vw-local", "type": "local", "path": "/data/backups/vaultwarden" },
  "hooks": {
    "databases": [
      { "kind": "sqlite", "container": "vaultwarden", "dbPath": "/data/db.sqlite3" }
    ]
  }
}
```

Add a **second policy** with the same targets but a different storage
backend (S3 / Backblaze / off-site SMB) running once a day. Two
storage destinations is the only acceptable backup posture for
credentials-of-record.

**Restore:** mount the volume back at `/data`, restart the container.
Vaultwarden picks up `db.sqlite3` on boot. Test the restore by logging
in as a non-admin account first — if the master key was corrupted
mid-snapshot, this is the cheapest way to find out.

---

## n8n (workflow automation)

**What matters:** the `n8n` database (default SQLite, or Postgres if
you configured one) holds every workflow, every credential, and every
execution history row. Credentials are encrypted with `N8N_ENCRYPTION_KEY`,
so back up that env var separately and **store it where the backup ISN'T**.

**Container assumed:** `n8n` with volume `n8n-data` at
`/home/node/.n8n`. If you're on Postgres, replace the SQLite exporter
below with the Postgres one and add the `n8n-postgres` container as a
target.

```json
{
  "name": "n8n-nightly",
  "enabled": true,
  "schedule": "0 3 * * *",
  "verifySchedule": "0 4 * * 0",
  "backupType": "full",
  "targets": [
    { "type": "container", "selector": "n8n" },
    { "type": "volume",    "selector": "n8n-data" }
  ],
  "retention": {
    "strategy": "tiered",
    "tiers": [
      { "tag": "daily",   "maxCount": 7 },
      { "tag": "weekly",  "maxCount": 4 },
      { "tag": "monthly", "maxCount": 6 }
    ]
  },
  "storage": { "id": "n8n-backup", "type": "s3", "connectorId": "REPLACE_ME" },
  "hooks": {
    "databases": [
      { "kind": "sqlite", "container": "n8n", "dbPath": "/home/node/.n8n/database.sqlite" }
    ]
  }
}
```

**Restore:** mount the volume back, set `N8N_ENCRYPTION_KEY` to the
*same* value you had at backup time (you did save that elsewhere,
right?), restart n8n. Without the original encryption key, every saved
credential becomes opaque garbage — the workflows themselves will
restore fine, but every HTTP node, OAuth connection, and DB connection
will need to be re-entered.

---

## Contributing a recipe

Have a stack you back up with DRK that isn't on this page? Open a
GitHub Discussion at
`github.com/gozippy/dockerrescuekit/discussions` with:

1. The stack (Compose file or image list)
2. The JSON policy you actually use
3. Any pre/post hooks you found you needed
4. The restore procedure that worked for you

We'll review and add it to this page so the next person doesn't have
to reverse-engineer it. The whole point of this catalog is to capture
the "huh, that's the tricky part" knowledge that lives in your head
right now.

*Last updated: 2026-05-24. Tested against DRK v1.2.*
