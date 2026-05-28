# Upgrade guide — DockerRescueKit

How to upgrade DRK without losing your data. Read this **before** running
`docker extension rm`, `docker extension update`, or switching between
the sideloaded build and the Hub image.

> **Why this guide exists:** `docker extension rm` deletes the extension's
> named data volume. That volume holds every policy, secret, manifest,
> and audit-log row. If you `rm` an extension under one image ID and then
> install the same product under a different image ID (sideload → Hub,
> repo rename, fork), the old volume becomes orphaned and is wiped on
> the next prune.

---

## TL;DR

- **Always** export your config first (Settings → Export config). Save
  the JSON outside the extension volume — Downloads, a USB stick, a
  cloud drive, anywhere but `/data` inside the container.
- **Hub tag → Hub tag** on `gozippy/dockerrescuekit` (for example
  `:1.2.4` → `:1.2.5`) is **safe**. Docker Desktop reuses the same
  named volume because the extension ID is unchanged.
- **Image ID change** (sideload → Hub, fork, repo rename) is
  **destructive**. The old volume is orphaned. Use the manual-migration
  procedure below before running `docker extension rm` on the old build.

---

## Pre-flight checklist

Do this before **any** extension `update`, `rm`, or reinstall:

1. Docker Desktop → DockerRescueKit → **Settings** → **Export config**.
   A JSON blob downloads to your browser's default location.
2. Confirm the file is **outside** the extension's data volume — your
   Downloads folder is fine; the extension's `/data` is not. Copy to a
   second location (cloud drive, USB) for anything you can't rebuild.
3. Open the JSON in a text editor and confirm it contains at least one
   policy and one connector. An empty export means something failed
   silently — stop and investigate before continuing.

> v1.2.5+ also writes an automatic snapshot to
> `${DRK_DATA_DIR}/exports/latest-bootstrap.json` on every backend
> start. That file lives **inside** the extension volume and is **not**
> a substitute for a manual external export — it dies with the volume.

---

## Safe upgrade path — Hub tag to Hub tag

When both source and target are pulled from `gozippy/dockerrescuekit`
on Docker Hub, the extension's image ID stays stable across tags.
Docker Desktop reuses the existing data volume. All policies,
connectors, secrets, manifests, audit log, and bootstrap exports
survive.

### Via the Docker Desktop UI

1. Docker Desktop → **Extensions Marketplace** → **DockerRescueKit**.
2. Click **Update** if a newer version is available.
3. Wait for the extension to reload. Cold start takes ~25–30 seconds
   (scheduler init + license refresh + better-sqlite3 native bindings)
   — the **Offline** badge during boot is normal, not a failure.
4. Open Settings → confirm your policies and connectors are still
   listed.

### Via the CLI

```bash
docker extension install gozippy/dockerrescuekit:1.2.5 -f
```

The `-f` flag tells Docker to replace the currently installed version.
**The data volume is preserved** because the extension ID
(`gozippy/dockerrescuekit`) is unchanged.

You can also pin to `:latest` if you want auto-tracking:

```bash
docker extension install gozippy/dockerrescuekit:latest -f
```

### Verifying it worked

```bash
docker extension ls
# NAME                           VERSION  IMAGE
# gozippy/dockerrescuekit        1.2.5    gozippy/dockerrescuekit:1.2.5

docker volume ls --filter name=desktop-extension
# DRIVER    VOLUME NAME
# local     gozippy_dockerrescuekit-desktop-extension_drk-data
```

The volume name should be unchanged from before the upgrade.

---

## Unsafe upgrade path — image ID change

These transitions change the extension's image ID, which means
Docker Desktop creates a **new** named volume on install and the **old**
volume is left orphaned. The next `docker extension rm <old-id>` (or
`docker volume prune`) deletes it. **You will lose all policies,
connectors, audit history, and any backups stored inside the volume.**

### When this happens

- **Sideload → Hub** — you built locally (`docker extension install
  ./packages/extension`) and now want to switch to the published
  `gozippy/dockerrescuekit` image.
- **Hub → Sideload** — going back to a local dev build for debugging.
- **Repo rename or fork** — for example, installing a community fork
  with a different image name.
- **Image rename** — historically, DRK shipped briefly as
  `drk-extension` before settling on `gozippy/dockerrescuekit`. Anyone
  who installed those early builds is in this category.

### How to detect it

Before uninstalling the old extension, list the volumes:

```bash
docker volume ls --filter name=desktop-extension
```

If you see two `*-desktop-extension_drk-data` volumes with **different**
prefixes, you have an ID change. Migrate first (next section), then
remove.

If you see only one, you are doing a same-ID upgrade — see "Safe
upgrade path" above.

### Migration procedure

The flow is: **install the new extension first**, copy the data across
inside a throwaway container, **then** remove the old extension.
Reverse this order and the old volume is gone before you can read it.

```bash
# 1. Install the new extension (creates its own data volume)
docker extension install gozippy/dockerrescuekit:latest

# 2. Find the source and destination volume names
docker volume ls --filter name=desktop-extension
# look for entries ending in `_drk-data`

# 3. Copy data from old volume to new volume
#    Replace OLD_VOLUME and NEW_VOLUME with the names from step 2.
docker run --rm \
  -v OLD_VOLUME:/old \
  -v NEW_VOLUME:/new \
  alpine sh -c 'cp -a /old/. /new/ && ls -la /new/'

# 4. Reload the extension UI (close and reopen Docker Desktop)

# 5. Verify policies/connectors are present in the new extension

# 6. ONLY NOW remove the old extension
docker extension rm <OLD_EXTENSION_ID>
```

If step 5 looks wrong, **stop**. Do not run step 6 until you have
confirmed the new install sees your data. The old volume is your only
remaining copy at that point.

---

## Manual recovery commands

These are the raw building blocks. Adapt the volume names to your
actual situation — `docker volume ls` is your source of truth.

### Inspect a volume before touching it

```bash
docker run --rm -v <VOLUME_NAME>:/data alpine ls -la /data
```

You should see `docker_rescue.db`, `secrets.json`, an `exports/`
directory, and possibly `staging/`. If those are missing, you are
looking at the wrong volume.

### Tar a volume to a host file, and restore

```bash
# Backup
docker run --rm -v <VOLUME>:/data -v "$(pwd)":/backup \
  alpine tar czf /backup/drk-data-$(date +%Y%m%d).tar.gz -C /data .

# Restore into a fresh volume
docker volume create drk-data-restored
docker run --rm -v drk-data-restored:/data -v "$(pwd)":/backup \
  alpine sh -c 'cd /data && tar xzf /backup/drk-data-20260528.tar.gz'
```

Keep the tarball outside Docker Desktop's storage — desktop resets
blow away **all** named volumes. The restored volume can be attached
to a standalone DRK container with `-v drk-data-restored:/data` to
inspect files without touching the live extension volume.

### Copy between two volumes (the migration command in full)

```bash
docker run --rm \
  -v drk-extension-desktop-extension_drk-data:/old \
  -v gozippy_dockerrescuekit-desktop-extension_drk-data:/new \
  alpine sh -c 'cp -a /old/. /new/ && ls -la /new/'
```

`cp -a` preserves file modes, timestamps, and ownership. SQLite is
file-based, so an offline copy is consistent — provided no DRK
backend is currently writing to the source volume. If both extensions
are installed and running, stop the source one first via Docker
Desktop's extension panel.

---

## Volume name reference

Docker Desktop names the extension data volume by prefixing the
extension ID with the suffix `-desktop-extension_<volume-name>`. The
extension ID is derived from the **image reference** used at install
time.

| Source ID | Volume name (Docker Desktop convention) | Notes |
|---|---|---|
| `drk-extension` (local sideload) | `drk-extension-desktop-extension_drk-data` | Deleted on `docker extension rm` |
| `gozippy/dockerrescuekit` (Hub) | `gozippy_dockerrescuekit-desktop-extension_drk-data` | Canonical; same across tags |
| Fork at `<user>/<repo>` | `<user>_<repo>-desktop-extension_drk-data` | Different from the canonical Hub volume |
| `docker compose` standalone (this repo's `docker-compose.yml`) | `<project>_drk-data` + `<project>_drk-backups` | Independent of the extension; `<project>` is the compose project name (defaults to the lowercased directory name) |

The standalone container does **not** share its volume with the
extension. If you run both side-by-side, they have separate state.

### How Docker Compose names volumes

When you run `docker compose up -d` from this repo, Compose namespaces
the volumes declared in `docker-compose.yml` with the project name,
which defaults to the directory name converted to lowercase
alphanumerics. For a checkout in a directory called `DockerRescueKit`
you get `dockerrescuekit_drk-data` and `dockerrescuekit_drk-backups`.
Override the project name with `COMPOSE_PROJECT_NAME=...` or `-p` if
you need predictable names across machines.

---

## Recovering after a wipe

If you have already lost the volume:

1. **Check the host file system for a manual JSON export.** Anything
   you downloaded via Settings → Export config is in your browser's
   Downloads folder. That JSON is the fastest path back to a working
   install.
2. **Check for `latest-bootstrap.json` on a still-mounted volume.**
   v1.2.5+ writes one on every backend start. If you migrated the
   volume before deleting it, the snapshot is at
   `<volume>/exports/latest-bootstrap.json`.
3. **Reinstall DRK** (`docker extension install
   gozippy/dockerrescuekit:latest`), let it boot fully (≥30 seconds),
   then import your JSON.

### Importing the JSON

Two routes:

**UI:** Settings → Import from disk (available in v1.2.5+).
A file picker accepts the same JSON shape that Export produces.
See [Settings → Export/Import config](../packages/extension/src/components/SettingsPage.tsx)
for the current UI surface.

**REST:** Any version with the import endpoint (v1.2.3+):

```bash
KEY=$(docker exec drk cat /data/secrets.json | jq -r .apiKey)
curl -X POST http://localhost:42880/api/config/import \
  -H "x-api-key: $KEY" \
  -H "Content-Type: application/json" \
  --data-binary @drk-config-export.json
```

The endpoint is idempotent on policy IDs — re-importing the same
file twice does not produce duplicates.

### What survives a wipe even without an export

Backup *files* themselves live wherever your connectors point them:
restic repositories on a NAS, an S3 bucket, a Backblaze B2 bucket,
rclone-mounted Google Drive, an SFTP host, or a bind-mounted host
directory.

**Those files survive an extension uninstall**, provided you did
not configure DRK to write backups *inside* the extension volume
(which is the default for local-only setups and is explicitly the
wrong call for production data).

After reinstalling DRK and re-registering the same remote credentials,
the connector's "List snapshots" view shows your existing backups
and they can be restored normally. You lose the policy definitions,
schedule history, and audit log — you do not lose the snapshot data.

---

## Backup files vs DRK state

A clear mental model prevents future damage. DRK holds **two**
distinct categories of data:

| Category | Where it lives | Survives `docker extension rm`? |
|---|---|---|
| DRK state (policies, connectors, secrets, audit log, manifests) | The extension's named volume (`*_drk-data`) | **No** — deleted with the volume |
| Backup snapshots (restic repos, S3 objects, rclone remote files, SMB/SFTP shares, bind mounts) | The remote storage backend you configured | **Yes** — they are on external storage |

Anything inside the extension volume is treated as ephemeral
configuration that can be rebuilt from an export JSON. Anything you
care about long-term — the actual backed-up data — should live in
durable remote storage, **not** in the extension volume.

If you do not yet have a remote connector configured (S3, B2, rclone,
PBS, restic over SFTP, etc.) you are running DRK in a mode where the
backups are no safer than the extension itself. Set up a remote
connector and rerun your policies once before treating any DRK
deployment as "production".

---

## Verifying which image is running

Before any destructive action, confirm which build you have
installed:

```bash
docker extension ls
```

Look at the IMAGE column.

- `gozippy/dockerrescuekit:<tag>` — canonical Hub image. Tag-to-tag
  upgrades are safe (see above).
- `drk-extension:<tag>`, `localhost/drk-extension:...`, or any name
  without the `gozippy/` prefix — **sideload**. Upgrading to the Hub
  image is an ID change. Use the migration procedure.
- Anything else — a fork or repackage. Treat the same as a sideload:
  assume the volume name is different and migrate explicitly.

You can also inspect the running container directly:

```bash
docker ps --filter label=com.docker.desktop.extension.name=DockerRescueKit
```

The container's image reference confirms what's actually live.

---

## Troubleshooting

### The Offline badge sticks for 25–30 seconds after install

Expected. Cold start runs:

1. better-sqlite3 native bindings load.
2. Database migrations apply (idempotent — safe even if nothing
   changed).
3. License server is contacted for renewal/refresh (with a short
   timeout if offline).
4. Scheduler initializes from the policy table.
5. HTTP server binds to `42880`.

The UI considers the extension "Online" only after `GET /healthz`
returns 200. If the badge is still red after ~60 seconds, something
is wrong — collect logs.

### Where the logs live

Docker Desktop host logs (wrapper process):

- **Windows:** `%LOCALAPPDATA%\Docker\log\host\com.docker.backend.exe.log`
- **macOS:** `~/Library/Containers/com.docker.docker/Data/log/host/`
- **Linux:** `~/.docker/desktop/log/host/`

DRK backend container logs: Docker Desktop → Containers → DRK
extension container → **Logs**, or via CLI:

```bash
docker ps --filter label=com.docker.desktop.extension.name=DockerRescueKit
docker logs <container-id> --tail 200
```

Look for `[backend] listening on :42880` — that's the moment the API
came up. Anything earlier is bootstrap.

### `latest-bootstrap.json` doesn't exist

Only v1.2.5+ writes this file. Earlier versions only had manual
export. If you are running an older build and missed the manual
export step, the only recovery is whatever JSON you exported and
saved externally — there is no per-boot snapshot to fall back on.

To check on v1.2.5+:

```bash
docker exec <drk-container> ls -la /data/exports/
```

mtime tells you when the backend last started successfully.

### `docker extension rm` returned instantly and the volume is gone

Yes, that's how it works. There is no confirmation prompt and there
is no undo. If you ran `rm` without exporting first, jump to
**Recovering after a wipe**.

### Re-registering a remote shows zero snapshots

For restic / B2 / S3, the **repository path / bucket / prefix** must
match exactly what the old install used. Restic scopes snapshots to
the repo URL; a typo creates a new empty repo rather than opening the
existing one. For rclone, the `remote:path` must be identical
(including trailing slashes). Use the connector row's "Test connector"
button to confirm credentials, and check `docker logs <drk-container>`
for auth or path errors at WARN.

---

## Version history caveat

Not every published image is bootable. The full history of the
v1.2.x line is in [CHANGELOG.md](../CHANGELOG.md); the
upgrade-relevant summary is:

| Tag | Status | Notes |
|---|---|---|
| `:1.2.0` | **Crash-loop** | `shared` package `main` pointed at `.ts` source; `require()` fails immediately. Do not install. |
| `:1.2.1` | **Crash-loop** | Same shared-package bug as 1.2.0. |
| `:1.2.2-pre` | **Crash-loop** | `NotificationDispatcher` constructor had a TDZ self-shadow (`private logger: Logger = logger`). |
| `:1.2.2` | Bootable | First v1.2.x image that starts. Some UI bugs remained. |
| `:1.2.3` | Bootable | Export/import REST endpoints added; code splitting; tests. |
| `:1.2.4` | **First verified-bootable** | Merges Kilo Code's UI fixes (cost-analysis blank page, backup-history 500, modal cutoff) with the v1.2.2 crash fixes. First image where the full UI is usable end-to-end. |
| `:1.2.5` | Latest | Adds auto-export on boot, in-product upgrade banner, this guide. |

If you installed the extension between roughly 2026-05-14 and
2026-05-27 from Hub and saw it crash-loop, pull the latest tag:

```bash
docker extension install gozippy/dockerrescuekit:latest -f
```

This is a **same-ID** upgrade — your existing volume is preserved.
The crash was at runtime, not during install, so the volume was
created and your config (if any) is intact.

---

## See also

- [CHANGELOG.md](../CHANGELOG.md) — full per-version detail of what
  changed and why.
- [SECURITY.md](../SECURITY.md) — how to report vulnerabilities.
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — general (not
  upgrade-specific) issue triage.
- [FAQ.md](FAQ.md) — high-level project questions.

<!-- TODO: screenshot of Settings → Export config button -->
<!-- TODO: screenshot of `docker volume ls --filter name=desktop-extension` output -->
<!-- TODO: diagram of safe vs unsafe upgrade flows -->
