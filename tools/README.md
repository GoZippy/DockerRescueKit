# DRK Tools

Small operator-driven scripts that aren't part of the runtime image.
These are intentionally JS / shell so they have minimal install
requirements.

## Scripts

| Script | Purpose | Requires |
|---|---|---|
| [`capture-screenshots.js`](capture-screenshots.js) | Capture the 5 marketplace screenshots from a running DRK instance. Unblocks the M-1 verified-publisher submission gap. | `puppeteer-core` (devDep) + a local Chrome/Chromium |
| [`check-rclone.ps1`](check-rclone.ps1) / [`check-rclone.sh`](check-rclone.sh) | Detect whether `rclone` is installed and, if not, recommend (or with a flag, run) the right install for this OS. Mirrors the in-app install helper. | PowerShell 7+ (`.ps1`) or bash (`.sh`) |
| [`rescue/Invoke-DrkStartupRescue.ps1`](rescue/Invoke-DrkStartupRescue.ps1) | Companion scanner and conservative rescue workflow for Docker Desktop startup hangs. Runs outside Docker so it still works when the extension cannot load. | PowerShell 5.1+; Windows + Docker Desktop for rescue actions |

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

```powershell
# Report-only startup scan
pwsh ./tools/rescue/Invoke-DrkStartupRescue.ps1

# Gather Docker diagnostics too
pwsh ./tools/rescue/Invoke-DrkStartupRescue.ps1 -GatherDiagnostics

# Stop Docker Desktop, terminate docker-desktop WSL, restart and wait
pwsh ./tools/rescue/Invoke-DrkStartupRescue.ps1 -Rescue -StartDocker

# Use when WSL VM host state remains stuck
pwsh ./tools/rescue/Invoke-DrkStartupRescue.ps1 -Rescue -FullWslShutdown -StartDocker
```

Each script lists its env-var contract at the top of the file.
