# Troubleshooting

Problems you're most likely to hit, in roughly the order people hit
them. Each entry is symptom → diagnosis → fix.

---

## "Docker offline" badge in the dashboard

**Symptom.** The dashboard shows a red "Docker offline" banner;
`/api/docker` returns a 503 or `{ "ok": false, "reason": "EACCES" }`.

**Diagnosis.** The container's `drk` user does not have permission to
read `/var/run/docker.sock` on your host. This is a GID mismatch:
the socket is owned by the host's `docker` group, but the container
was started with a different supplementary group.

**Fix.** Set `DOCKER_GID` to your host's docker group GID before
`docker compose up`. See the prominent callout in
[`QUICKSTART_HOMELAB.md`](./QUICKSTART_HOMELAB.md#5-minute-install) for
the exact commands (R7.10).

```bash
# Linux
export DOCKER_GID=$(getent group docker | cut -d: -f3)
# macOS
export DOCKER_GID=$(dscl . -read /Groups/docker PrimaryGroupID | awk '{print $2}')
docker compose up -d
```

---

## 401 Unauthorized on every API request

**Symptom.** Every `/api/*` call returns `401 Unauthorized`, even
right after a fresh install.

**Diagnosis.** Either you're not passing the API key, or you're
passing the wrong one. Pre-release builds had a hardcoded default;
v1.0 generates a random key on first start.

**Fix.** Read the current key out of the container:

```bash
docker exec drk cat /data/secrets.json
# → {"apiKey":"abc123...","encryptionKey":"..."}
```

Then pass it as the `x-api-key` header:

```bash
curl -H "x-api-key: abc123..." http://localhost:42880/api/status
```

If you want to rotate the key, hit `/api/settings/regenerate-api-key`
(or `make key` from the repo root).

---

## 503 errors immediately after `docker compose up`

**Symptom.** First few requests after start return 503. The dashboard
shows a spinner that doesn't resolve.

**Diagnosis.** The healthcheck has a `start_period: 15s` and the
backend takes a few seconds to open its sqlite DB, run migrations,
and bind the socket.

**Fix.** Wait 5–15 seconds and refresh. If the 503s persist past
30 seconds, check the logs:

```bash
docker logs drk
```

Common offenders: corrupt `/data/policies.db` from a previous bad
shutdown (delete it and let DRK rebuild from manifests), or a port
collision on `42880`.

---

## Backup fails with "no space left on device"

**Symptom.** A scheduled backup transitions to `failed` with `ENOSPC`
or `no space left on device` in the error column.

**Diagnosis.** The staging volume (where DRK assembles the tar before
shipping it to the destination) ran out of room. Restic and rclone
also keep local caches that can balloon — restic's cache lives at
`~/.cache/restic/` by default and is per-repository.

**Fix.**

```bash
# 1. Find the offender
df -h
docker exec drk df -h

# 2. Inspect the staging volume
docker volume inspect drk_drk-backups

# 3. Prune the restic cache if you use the restic adapter
docker exec drk restic cache --cleanup

# 4. Or raise retention shorter-term, then re-run the failed policy
```

---

## Restore fails checksum verification

**Symptom.** `Restore failed: checksum mismatch` or
`integrity check failed` in the restore log.

**Diagnosis.** The backup file is corrupt — usually a partial upload
to S3/SMB/SFTP that wasn't atomic, or bit rot on the storage medium.

**Fix.** Re-run the backup from origin if the source is still alive,
then restore from the fresh copy. If the origin is gone, try restoring
from the *previous* backup (one tick older in the retention list) —
the verify metric (`drk_verify_*`) tells you which copies have round-
tripped successfully.

To prevent this going forward, enable scheduled `verify` runs in the
policy settings so corruption is caught before you need the backup.

---

## `tar: option requires an argument -- 'f'` in partial-restore logs

**Symptom.** Partial restore aborts with `tar: option requires an
argument -- 'f'`, sometimes referencing a file name that starts with
`-`.

**Diagnosis.** Upstream GNU tar bug: filenames beginning with a dash
are interpreted as flags when they appear unquoted on the tar command
line. DRK now refuses to extract such entries through
`assertSafeEntryPath`, but very old archives may still contain them.

**Fix.** Update to the current DRK release — `assertSafeEntryPath`
prevents this from being created. For legacy archives, extract them
manually with `tar -xf archive.tar -- ./` (the `--` separator forces
tar to treat the next argument as a path) and re-import as a fresh
backup.

---

## Browser shows a blank page

**Symptom.** Navigating to `http://localhost:42880` shows a blank
page or "Refused to load script" CSP errors in the browser console.

**Diagnosis.** Three usual suspects:

1. The browser is serving a stale cached `index.html` from a previous
   release with a different bundle hash.
2. CSP is blocking an inline style/script — only an issue if you've
   customised CSP in `helmet`'s config.
3. The static-file middleware failed to mount because `dist/` is
   missing (development build wasn't run).

**Fix.**

```bash
# 1. Hard refresh (Ctrl+Shift+R / Cmd+Shift+R)

# 2. Check the backend actually has the bundle
docker exec drk ls -la /app/packages/extension/dist

# 3. Look for static-file errors
docker logs drk 2>&1 | grep -iE 'static|index\.html|enoent'
```

If the `dist/` directory is empty, rebuild the extension package
(`npm run build -w @docker-rescue-kit/extension`) and rebuild the
backend image.

---

## Multi-arch image won't run on Raspberry Pi

**Symptom.** `exec /usr/local/bin/node: exec format error` on a Pi.

**Diagnosis.** Docker pulled the `amd64` variant of the image
because the Pi's Docker is mis-reporting its arch (common on older
32-bit Raspbian) or because you pulled with `--platform linux/amd64`
explicitly.

**Fix.**

```bash
# Confirm the host's arch
uname -m       # → aarch64 (64-bit Pi) or armv7l (32-bit)

# Re-pull the right manifest
docker pull --platform linux/arm64 gozippy/dockerrescuekit:standalone-latest
# or for 32-bit Pi:
docker pull --platform linux/arm/v7 gozippy/dockerrescuekit:standalone-latest
```

If you're on 32-bit Raspbian, upgrade to 64-bit Bookworm — `better-
sqlite3` (DRK's storage engine) drops 32-bit ARM in its next major.

---

## Cloud OAuth (Google Drive / OneDrive / Dropbox) shows `127.0.0.1:53682` and won't connect

**Symptom.** Adding a Google Drive / OneDrive / Dropbox remote shows a link
like `http://127.0.0.1:53682/` and "Open in browser" does nothing /
connection refused.

**Diagnosis.** Older builds (≤ v1.2.x) ran `rclone authorize` *inside* the
DRK container. rclone's OAuth callback only binds `127.0.0.1:53682`, which
lives in the container's network namespace and is never published — your
host browser can't reach it. The flow could never complete. See
[`decisions/DR-003`](./decisions/DR-003-rclone-oauth-host-authorize.md).

**Fix.** Update to the current build. The wizard now gives you a command to
run on a machine that has a browser (your own desktop), then you paste the
token back:

1. In **Integrations → Add Remote → Google Drive**, enter a name and click
   **Authorize**.
2. On your desktop (with [rclone](https://rclone.org/downloads/) installed),
   run the command shown — e.g. `rclone authorize "drive"`. A browser tab
   opens; sign in and approve.
3. rclone prints a token between `--->` and `<---End paste`. Copy that JSON.
4. Paste it into **Step 2** in the wizard and click **Save token**.

The token is stored encrypted at rest (AES-256-GCM); rclone never runs a
browser flow inside the container.
