# DRK Tools

Small operator-driven scripts that aren't part of the runtime image.
These are intentionally JS / shell so they have minimal install
requirements.

## Scripts

| Script | Purpose | Requires |
|---|---|---|
| [`capture-screenshots.js`](capture-screenshots.js) | Capture the 5 marketplace screenshots from a running DRK instance. Unblocks the M-1 verified-publisher submission gap. | `puppeteer-core` (devDep) + a local Chrome/Chromium |
| [`check-rclone.ps1`](check-rclone.ps1) / [`check-rclone.sh`](check-rclone.sh) | Detect whether `rclone` is installed and, if not, recommend (or with a flag, run) the right install for this OS. Mirrors the in-app install helper. | PowerShell 7+ (`.ps1`) or bash (`.sh`) |

## Usage

```bash
# Capture all 5 marketplace screenshots
docker compose up -d
node tools/capture-screenshots.js

# Or override defaults
DRK_BASE_URL=http://localhost:8080 \
DRK_API_KEY=$(cat ~/.drk/key) \
SCREENSHOT_DIR=/tmp/shots \
HEADLESS=false \
node tools/capture-screenshots.js
```

```bash
# Check if rclone is installed; print the right install command if not
./tools/check-rclone.sh            # POSIX (macOS/Linux)
./tools/check-rclone.sh --install  # ...and actually install it

# Windows
pwsh ./tools/check-rclone.ps1
pwsh ./tools/check-rclone.ps1 -Install
```

> Run `check-rclone` on the machine that has your **web browser** — that's the
> one that needs rclone for cloud sign-in (Google Drive / OneDrive / Dropbox).
> DRK already bundles rclone for the actual transfers.

Each script lists its env-var contract at the top of the file.
