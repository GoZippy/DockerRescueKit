# DRK Tools

Small operator-driven scripts that aren't part of the runtime image.
These are intentionally JS / shell so they have minimal install
requirements.

## Scripts

| Script | Purpose | Requires |
|---|---|---|
| [`capture-screenshots.js`](capture-screenshots.js) | Capture the 5 marketplace screenshots from a running DRK instance. Unblocks the M-1 verified-publisher submission gap. | `puppeteer-core` (devDep) + a local Chrome/Chromium |

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

Each script lists its env-var contract at the top of the file.
