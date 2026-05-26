#!/usr/bin/env node
/**
 * Capture the 5 marketplace screenshots from a running DRK instance.
 *
 * Unblocks the M-1 marketplace submission gap (04-restore-browser.png and
 * 05-storage-vault.png) — see .autoclaw/internal/marketplace-submission.md.
 *
 * Usage:
 *   1. Start DRK locally:  docker compose up -d
 *   2. Confirm UI is up:   curl http://localhost:42880/healthz
 *   3. Run this script:    node tools/capture-screenshots.js
 *
 * Optional env overrides:
 *   DRK_BASE_URL=http://localhost:42880   # default
 *   DRK_API_KEY=<key>                     # auto-detected from `docker exec drk cat /data/secrets.json` if omitted
 *   SCREENSHOT_DIR=docs/screenshots       # output directory
 *   HEADLESS=true                         # set 'false' to watch the browser
 *   CHROME_PATH=...                       # override Chrome/Chromium binary
 *
 * Captures (1920x1080 per the marketplace spec):
 *   01-dashboard.png         — Main dashboard view
 *   02-policies.png          — Policy editor (with at least one policy listed)
 *   03-settings.png          — Settings page
 *   04-restore-browser.png   — Partial restore file browser
 *   05-storage-vault.png     — Storage Vault page
 *
 * Requires `puppeteer-core` (devDependency) and a local Chrome/Chromium.
 * If puppeteer-core isn't installed:  npm install --save-dev puppeteer-core
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const BASE_URL = process.env.DRK_BASE_URL || 'http://localhost:42880'
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || path.join(__dirname, '..', 'docs', 'screenshots')
const HEADLESS = process.env.HEADLESS !== 'false'
const CHROME_PATH = process.env.CHROME_PATH || autoDetectChrome()
const VIEWPORT = { width: 1920, height: 1080 }

function autoDetectChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  return candidates.find(p => { try { fs.accessSync(p); return true } catch { return false } }) || ''
}

function getApiKey() {
  if (process.env.DRK_API_KEY) return process.env.DRK_API_KEY
  try {
    const out = execSync('docker exec drk cat /data/secrets.json', { encoding: 'utf8' })
    return JSON.parse(out).apiKey
  } catch {
    console.error('Could not auto-detect DRK_API_KEY. Set it explicitly:')
    console.error('  $env:DRK_API_KEY = "<your-key>"   # PowerShell')
    console.error('  export DRK_API_KEY=<your-key>     # bash')
    process.exit(1)
  }
}

async function main() {
  if (!CHROME_PATH) {
    console.error('No Chrome binary detected. Set CHROME_PATH=<path>')
    process.exit(1)
  }

  let puppeteer
  try { puppeteer = require('puppeteer-core') }
  catch {
    console.error('puppeteer-core not installed. Run: npm install --save-dev puppeteer-core')
    process.exit(1)
  }

  const apiKey = getApiKey()
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })

  console.log(`base: ${BASE_URL}`)
  console.log(`out:  ${SCREENSHOT_DIR}`)
  console.log(`chrome: ${CHROME_PATH}`)

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: HEADLESS ? 'new' : false,
    defaultViewport: VIEWPORT,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })

  try {
    const page = await browser.newPage()
    await page.setViewport(VIEWPORT)

    // Seed the API key in localStorage before the app loads so the
    // SetupScreen doesn't intercept us.
    await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 30_000 })
    await page.evaluate(k => localStorage.setItem('drk_api_key', k), apiKey)

    await captureRoute(page, '/',                  '01-dashboard.png')
    await captureRoute(page, '/#/policies',        '02-policies.png')
    await captureRoute(page, '/#/settings',        '03-settings.png')
    await captureRestoreBrowser(page,              '04-restore-browser.png')
    await captureRoute(page, '/#/storage',         '05-storage-vault.png')

    console.log('\nDone. Screenshots written to', SCREENSHOT_DIR)
  } finally {
    await browser.close()
  }
}

async function captureRoute(page, hashPath, filename) {
  const url = BASE_URL + hashPath
  console.log(`→ ${filename}  ${url}`)
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 })
  // Give React + lazy fetches a moment to render.
  await new Promise(r => setTimeout(r, 1500))
  const out = path.join(SCREENSHOT_DIR, filename)
  await page.screenshot({ path: out, fullPage: false })
}

/**
 * The restore-browser shot needs an actual backup to browse. Strategy:
 *  1. Land on the History tab
 *  2. Pick the first backup row and trigger the "Browse files" action
 *  3. Wait for the file-browser modal to appear, then capture
 *
 * If no backups exist, the script prints a helpful hint and skips
 * gracefully so the run still completes.
 */
async function captureRestoreBrowser(page, filename) {
  console.log(`→ ${filename}  (interactive — opening restore browser)`)
  await page.goto(BASE_URL + '/#/history', { waitUntil: 'networkidle2', timeout: 30_000 })
  await new Promise(r => setTimeout(r, 1500))

  // Heuristic: find any clickable row, then click anything labelled
  // "Browse" or carrying a folder icon. Tweak the selector if your UI
  // changes the button text.
  const opened = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const browseBtn = buttons.find(b => /browse/i.test(b.textContent || ''))
    if (!browseBtn) return false
    browseBtn.click()
    return true
  })

  if (!opened) {
    console.warn(`  No "Browse" button found on the History page.`)
    console.warn(`  Create at least one successful backup first (e.g.,`)
    console.warn(`  policy:run from the CLI), then re-run this script.`)
    return
  }

  await new Promise(r => setTimeout(r, 2000))
  const out = path.join(SCREENSHOT_DIR, filename)
  await page.screenshot({ path: out, fullPage: false })
}

main().catch(err => {
  console.error('capture failed:', err.message)
  process.exit(1)
})
