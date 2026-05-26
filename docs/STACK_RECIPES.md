# Stack Recipes — Copy-Paste DRK Policies for Popular Homelab Apps

Each recipe below is a complete, copy-pasteable backup policy for DockerRescueKit.
They capture the right volumes, use the right database exporters, and include
pre/post hooks where the app needs quiescing.

**After pasting:** adjust container names to match your setup (DRK will auto-detect
them in the Policy Wizard), pick your storage backend, and you're done.

---

## Home Assistant

**What it backs up:** HA configuration, automations, integrations, SQLite database, add-on data.

**Pre-backup hook:** HA needs a snapshot before the filesystem backup. The built-in
snapshot API quiesces the database.

```yaml
name: homeassistant-daily
description: Daily backup of Home Assistant
enabled: true
targets:
  - type: volume
    selector: homeassistant_config
  - type: volume
    selector: homeassistant_ssl
schedule: "0 3 * * *"
backupType: full
retention:
  strategy: count
  count: 14
storage:
  id: ha-backup-storage
  type: local
  path: data/backups
hooks:
  databases:
    - kind: sqlite
      container: homeassistant
      dbPath: /config/home-assistant_v2.db
      outPath: /var/backups/drk-ha.db
  pre:
    - "curl -s -X POST http://localhost:8123/api/services/snapshot/create"
  post:
    - "curl -s -X POST http://localhost:8123/api/services/snapshot/cleanup"
verifySchedule: "0 5 * * 0"
```

**Notes:**
- Container name is typically `homeassistant` for the official image. Adjust if yours differs.
- The snapshot API calls require an access token — set `SUPERVISOR_TOKEN` env var or use the HA long-lived token.
- For MariaDB add-on users, add a `mysql` exporter instead of sqlite.

---

## Plex / Jellyfin

**What it backs up:** Media server config, metadata database, user preferences, playlists.

**Pre-backup hook:** Stop the server briefly to ensure database consistency.

```yaml
name: plex-daily
description: Daily backup of Plex Media Server
enabled: true
targets:
  - type: volume
    selector: plex_config
schedule: "0 4 * * *"
backupType: full
retention:
  strategy: count
  count: 7
storage:
  id: plex-backup-storage
  type: local
  path: data/backups
hooks:
  databases:
    - kind: sqlite
      container: plex
      dbPath: /config/Library/Application Support/Plex Media Server/Plug-in Support/Databases/com.plexapp.plugins.library.db
      outPath: /var/backups/drk-plex.db
  pre:
    - "plexmediaserver --stop || true"
  post:
    - "plexmediaserver --start || true"
verifySchedule: "0 6 * * 0"
```

**Notes:**
- For Jellyfin, replace container name with `jellyfin` and adjust the config path to `/config/data/`.
- Media files are NOT backed up — only config/metadata. Your media should be on a separate volume with its own backup strategy.
- The stop/start hooks are best-effort; Plex tolerates abrupt stops but a clean shutdown is better.

---

## Immich

**What it backs up:** Photo metadata database (PostgreSQL), user data, machine learning models.

**Pre-backup hook:** PostgreSQL dump via `pg_dump`.

```yaml
name: immich-daily
description: Daily backup of Immich photo server
enabled: true
targets:
  - type: volume
    selector: immich_upload
  - type: volume
    selector: immich_machine-learning
schedule: "0 3 * * *"
backupType: full
retention:
  strategy: count
  count: 14
storage:
  id: immich-backup-storage
  type: local
  path: data/backups
hooks:
  databases:
    - kind: postgres
      container: immich-postgres
      user: postgres
      db: immich
      outPath: /var/backups/drk-immich.sql.gz
verifySchedule: "0 5 * * 0"
```

**Notes:**
- Immich uses a separate PostgreSQL container. The `immich-postgres` container name is the default from the official compose file.
- Upload volume contains thumbnails and encoded videos — the original files are in the `upload` volume.
- For large libraries (>50K photos), consider weekly full + daily incremental.

---

## Nextcloud

**What it backs up:** File metadata (MySQL/PostgreSQL), config, user data, app data.

**Pre-backup hook:** Set Nextcloud to maintenance mode before backup, disable after.

```yaml
name: nextcloud-daily
description: Daily backup of Nextcloud
enabled: true
targets:
  - type: volume
    selector: nextcloud_data
  - type: volume
    selector: nextcloud_config
  - type: volume
    selector: nextcloud_db
schedule: "0 2 * * *"
backupType: full
retention:
  strategy: count
  count: 14
storage:
  id: nextcloud-backup-storage
  type: local
  path: data/backups
hooks:
  databases:
    - kind: postgres
      container: nextcloud-db
      user: nextcloud
      db: nextcloud
      outPath: /var/backups/drk-nextcloud.sql.gz
  pre:
    - "docker exec nextcloud php occ maintenance:mode --on"
  post:
    - "docker exec nextcloud php occ maintenance:mode --off"
verifySchedule: "0 4 * * 0"
```

**Notes:**
- Replace `postgres` with `mysql` in the exporter if you use MariaDB/MySQL.
- The `occ maintenance:mode` command prevents file operations during backup.
- For large Nextcloud instances, exclude the `data/` user files directory from the volume backup and use `rsync` separately — DRK handles the DB and config.

---

## Vaultwarden

**What it backs up:** Encrypted password database (SQLite), attachments, config, icons cache.

**Pre-backup hook:** None needed — SQLite `.backup` is atomic.

```yaml
name: vaultwarden-daily
description: Daily backup of Vaultwarden
enabled: true
targets:
  - type: volume
    selector: vaultwarden_data
schedule: "0 3 * * *"
backupType: full
retention:
  strategy: count
  count: 30
storage:
  id: vw-backup-storage
  type: local
  path: data/backups
hooks:
  databases:
    - kind: sqlite
      container: vaultwarden
      dbPath: /data/db.sqlite3
      outPath: /var/backups/drk-vaultwarden.db
verifySchedule: "0 5 * * 0"
```

**Notes:**
- 30-day retention recommended — password databases are small but critical.
- The SQLite `.backup` command is atomic and doesn't require stopping the server.
- For PostgreSQL-backed Vaultwarden, use the `postgres` exporter instead.
- Consider S3 or B2 as the storage backend for offsite redundancy — a password manager should survive a house fire.

---

## n8n

**What it backs up:** Workflow definitions, credentials (encrypted), execution history, SQLite/PostgreSQL database.

**Pre-backup hook:** None needed for SQLite. For PostgreSQL, use `pg_dump`.

```yaml
name: n8n-daily
description: Daily backup of n8n workflows
enabled: true
targets:
  - type: volume
    selector: n8n_data
schedule: "0 2 * * *"
backupType: full
retention:
  strategy: count
  count: 14
storage:
  id: n8n-backup-storage
  type: local
  path: data/backups
hooks:
  databases:
    - kind: sqlite
      container: n8n
      dbPath: /home/node/.n8n/database.sqlite
      outPath: /var/backups/drk-n8n.db
verifySchedule: "0 4 * * 0"
```

**Notes:**
- For PostgreSQL-backed n8n, replace the sqlite exporter with:
  ```yaml
  - kind: postgres
    container: n8n-postgres
    user: n8n
    db: n8n
    outPath: /var/backups/drk-n8n.sql.gz
  ```
- Credentials are encrypted in the database — the backup captures them safely.
- n8n's `.n8n` directory contains all workflow definitions.

---

## How to Use These Recipes

1. **Via the UI:** Open the Policy Wizard → paste the YAML values into the form fields.
2. **Via the CLI:** Save the YAML to a file and run:
   ```
   drk policy create --file ha-recipe.yaml
   ```
3. **Via the API:** POST the policy JSON to `/api/policies`.

## Contributing

Have a recipe for another stack? Open a GitHub Discussion with the `stack-recipe` tag.
We'll add it here with credit.

See also: [Backup Tools Comparison](BACKUP_TOOLS_COMPARISON.md) | [Architecture](ARCHITECTURE.md) | [Roadmap](ROADMAP.md)
