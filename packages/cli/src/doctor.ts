/**
 * `drk doctor` — offline Docker daemon diagnosis and repair.
 *
 * DESIGN CONSTRAINT, AND WHY THIS LIVES IN THE CLI
 *
 * When the Docker daemon will not start, every containerised component is also
 * down — including the DRK extension and the DRK standalone container. The
 * extension can therefore never be the rescue path for this class of failure.
 * Diagnosis has to run on the host, outside Docker entirely.
 *
 * The `drk` CLI is a plain Node binary on the host, so it is the natural home.
 * Nothing here requires the DRK API, an API key, or a running daemon.
 *
 * WHAT IT READS
 *
 * Docker Desktop's dialog reports the wrong error for daemon startup failures
 * (see packages/shared/src/dockerFatalErrors.ts). The truth is in the VM-side
 * init log, which Docker Desktop writes to the host filesystem even when the
 * daemon is dead. That file is the source of record here.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import {
  scanDockerFatalErrors,
  findDecoy,
  type DockerFatalErrorMatch
} from '@docker-rescue-kit/shared'

export interface DoctorReport {
  ok: boolean
  platform: NodeJS.Platform
  initLogPath: string | null
  initLogMtime: string | null
  scannedLines: number
  findings: DockerFatalErrorMatch[]
  notes: string[]
}

export interface RepairResult {
  ok: boolean
  vhdxPath: string | null
  storePath: string | null
  backupPath: string | null
  message: string
}

/** Bytes of log tail to read. Enough for several start attempts. */
const TAIL_BYTES = 4 * 1024 * 1024

/**
 * Lines actually scanned. Kept in step with host/drk-doctor.template.sh and
 * Invoke-DrkStartupRescue.ps1 so all three implementations see the same window
 * and cannot disagree about whether a machine is healthy.
 */
const TAIL_LINES = 4000

/**
 * Docker Desktop's VM init log, per platform. This is the only log that carries
 * the daemon's own fatal error; the host-side backend log carries the
 * misattributed one.
 */
export function resolveInitLogPath(explicit?: string): string | null {
  if (explicit) return fs.existsSync(explicit) ? explicit : null

  const home = os.homedir()
  const candidates: string[] = []

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    candidates.push(path.join(localAppData, 'Docker', 'log', 'vm', 'init.log'))
  } else if (process.platform === 'darwin') {
    candidates.push(
      path.join(home, 'Library', 'Containers', 'com.docker.docker', 'Data', 'log', 'vm', 'init.log')
    )
  } else {
    candidates.push(path.join(home, '.docker', 'desktop', 'log', 'vm', 'init.log'))
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch { /* unreadable — treat as absent */ }
  }
  return null
}

/**
 * Read the tail of a possibly-large log without loading all of it. Drops the
 * first line of the window, which is usually truncated mid-record.
 */
export function tailLines(file: string, maxBytes = TAIL_BYTES): string[] {
  const stat = fs.statSync(file)
  const start = Math.max(0, stat.size - maxBytes)
  const length = stat.size - start
  if (length <= 0) return []

  const buffer = Buffer.alloc(length)
  let bytesRead = 0
  const fd = fs.openSync(file, 'r')
  try {
    // A short read leaves the tail zero-filled; slicing to the actual count
    // keeps NUL bytes out of the decoded text.
    bytesRead = fs.readSync(fd, buffer, 0, length, start)
  } finally {
    fs.closeSync(fd)
  }

  const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)
  if (start > 0 && lines.length > 0) lines.shift()
  const nonEmpty = lines.filter(line => line.length > 0)
  return nonEmpty.slice(-TAIL_LINES)
}

/**
 * Scan the init log for fatal daemon failures. Report-only; never mutates.
 */
export function runDoctor(opts: { logPath?: string } = {}): DoctorReport {
  const notes: string[] = []
  const initLogPath = resolveInitLogPath(opts.logPath)

  if (!initLogPath) {
    return {
      ok: false,
      platform: process.platform,
      initLogPath: null,
      initLogMtime: null,
      scannedLines: 0,
      findings: [],
      notes: [
        opts.logPath
          ? `The path passed with --log does not exist or is unreadable: ${opts.logPath}`
          : 'Could not locate the Docker Desktop VM init log. Pass --log <path> if Docker is ' +
            'installed somewhere non-standard.'
      ]
    }
  }

  let lines: string[] = []
  let mtime: string | null = null
  try {
    mtime = fs.statSync(initLogPath).mtime.toISOString()
    lines = tailLines(initLogPath)
  } catch (err: any) {
    return {
      ok: false,
      platform: process.platform,
      initLogPath,
      initLogMtime: mtime,
      scannedLines: 0,
      findings: [],
      notes: [`Could not read ${initLogPath}: ${err?.message || err}`]
    }
  }

  const findings = scanDockerFatalErrors(lines)

  if (findings.length === 0) {
    notes.push(
      'No fatal daemon errors found in the log tail. If Docker still will not start, the failure may ' +
        'predate this log window, or the VM may not be booting at all — check whether the log has any ' +
        'entries newer than your last start attempt.'
    )
  } else {
    // Tell the user, explicitly, that the dialog is lying. Otherwise they keep
    // investigating whatever Docker Desktop showed them.
    const decoyHits = lines
      .map(line => findDecoy(line))
      .filter((hit): hit is NonNullable<typeof hit> => hit !== null)
    if (decoyHits.length > 0) {
      const unique = Array.from(new Set(decoyHits.map(hit => hit.note)))
      // Phrased conditionally on purpose. These messages appear on healthy
      // starts too, so their presence in the log proves nothing about what the
      // dialog is displaying — we cannot read the dialog from here.
      notes.push(
        'If Docker Desktop is showing you one of these messages as the cause, it is not the cause:'
      )
      for (const note of unique) notes.push(`  - ${note}`)
    }
  }

  return {
    ok: findings.length === 0,
    platform: process.platform,
    initLogPath,
    initLogMtime: mtime,
    scannedLines: lines.length,
    findings,
    notes
  }
}

/* ------------------------------------------------------------------ */
/* Offline repair — Windows/WSL2 only                                  */
/* ------------------------------------------------------------------ */

function readDockerSettings(): any | null {
  if (process.platform !== 'win32') return null
  const appData = process.env.APPDATA
  if (!appData) return null
  const settingsPath = path.join(appData, 'Docker', 'settings-store.json')
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Locate the Docker data VHDX. Honours a relocated data directory
 * (`CustomWslDistroDir`) before falling back to the default install location.
 */
export function resolveDataVhdx(explicit?: string): string | null {
  if (explicit) return fs.existsSync(explicit) ? explicit : null
  if (process.platform !== 'win32') return null

  const candidates: string[] = []
  const settings = readDockerSettings()
  if (settings?.CustomWslDistroDir) {
    candidates.push(path.join(settings.CustomWslDistroDir, 'disk', 'docker_data.vhdx'))
  }
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) {
    candidates.push(path.join(localAppData, 'Docker', 'wsl', 'disk', 'docker_data.vhdx'))
    candidates.push(path.join(localAppData, 'Docker', 'wsl', 'data', 'ext4.vhdx'))
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch { /* ignore */ }
  }
  return null
}

interface WslResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

/**
 * Run wsl.exe and decode the output.
 *
 * `encoding` matters and is easy to get wrong. wsl.exe's OWN subcommands
 * (`--list`, `--status`) emit UTF-16LE with a BOM when redirected; commands run
 * *inside* a distro (`wsl -d X -- cmd`) emit whatever the command wrote, which
 * is UTF-8. Decoding UTF-16LE as UTF-8 leaves a `��` prefix on the
 * first line — enough to defeat a `startsWith('docker-desktop')` check, which
 * would silently bypass both the "don't use Docker's own distro" guard and the
 * "don't touch a mounted disk" guard.
 */
function wsl(args: string[], opts: { timeoutMs?: number; wide?: boolean } = {}): WslResult {
  const result = spawnSync('wsl.exe', args, {
    timeout: opts.timeoutMs ?? 180_000,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  })

  const decode = (buf: Buffer | null): string => {
    if (!buf || buf.length === 0) return ''
    const text = opts.wide ? buf.toString('utf16le') : buf.toString('utf8')
    return text.replace(/^﻿/, '').replace(/\0/g, '').replace(/\r/g, '').trim()
  }

  return {
    status: result.status,
    stdout: decode(result.stdout),
    stderr: decode(result.stderr),
    error: result.error
  }
}

/** Distro to run repair commands in. Never docker-desktop — it is Docker's own. */
function pickRepairDistro(): string | null {
  const listing = wsl(['--list', '--quiet'], { timeoutMs: 30_000, wide: true })
  if (listing.status !== 0) return null

  const distro = listing.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(name => name && !name.toLowerCase().startsWith('docker-desktop'))
  return distro[0] || null
}

/**
 * Refuse to touch the disk while Docker still holds it.
 *
 * Note the exit-code handling: `wsl --list --running` exits NON-ZERO and prints
 * "There are no running distributions." when nothing is running — which is
 * exactly the state a user is in after following the documented `wsl --shutdown`
 * prerequisite. Treating any non-zero exit as "cannot tell, assume running"
 * would make repair permanently unreachable.
 */
function dockerWslIsRunning(): boolean {
  const result = wsl(['--list', '--running', '--quiet'], { timeoutMs: 30_000, wide: true })
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase()

  if (/no running distributions/.test(combined)) return false

  if (result.status !== 0) {
    // Genuinely unknown — fail closed.
    return true
  }

  return result.stdout
    .split('\n')
    .some(name => name.trim().toLowerCase().startsWith('docker-desktop'))
}

/**
 * Back up and remove libnetwork's key-value store from the Docker data disk.
 *
 * DESTRUCTIVE: erases every user-defined network. Images, containers, volumes
 * and build cache are untouched, and compose recreates its networks on the next
 * `up`. A timestamped `.bak` is left beside the original.
 *
 * Requires Docker Desktop stopped and `wsl --shutdown` already run.
 */
export function repairNetworkStore(explicitVhdx?: string): RepairResult {
  const base: RepairResult = {
    ok: false,
    vhdxPath: null,
    storePath: null,
    backupPath: null,
    message: ''
  }

  if (process.platform !== 'win32') {
    return { ...base, message: 'Offline network-store repair is currently Windows/WSL2 only.' }
  }

  if (dockerWslIsRunning()) {
    return {
      ...base,
      message:
        'The docker-desktop WSL distro is still running. Quit Docker Desktop and run `wsl --shutdown` ' +
        'before repairing — the data disk cannot be safely mounted while Docker holds it.'
    }
  }

  const vhdxPath = resolveDataVhdx(explicitVhdx)
  if (!vhdxPath) {
    return {
      ...base,
      message: 'Could not locate the Docker data VHDX. Pass --vhdx <path> explicitly.'
    }
  }

  const distro = pickRepairDistro()
  if (!distro) {
    return {
      ...base,
      vhdxPath,
      message: 'No non-docker-desktop WSL distro available to run repair commands in.'
    }
  }

  const mountName = 'drk-netrepair'
  const mount = wsl(['--mount', '--vhd', vhdxPath, '--name', mountName, '--type', 'ext4'], {
    timeoutMs: 120_000,
    wide: true
  })
  if (mount.status !== 0) {
    return {
      ...base,
      vhdxPath,
      message: `Mount failed: ${mount.stderr || mount.stdout || mount.error?.message || 'unknown error'}`
    }
  }

  let storePath: string | null = null
  try {
    const root = `/mnt/wsl/${mountName}`
    const find = wsl([
      '-d', distro, '-u', 'root', '--', 'bash', '-lc',
      `find ${root} -maxdepth 6 -path '*/network/files/local-kv.db' 2>/dev/null | head -n 1`
    ])
    storePath = find.stdout || null

    if (!storePath) {
      return {
        ...base,
        vhdxPath,
        message: 'No network store (local-kv.db) found on the mounted disk. Nothing to repair.'
      }
    }

    // Seconds matter: two repair attempts inside one minute would otherwise
    // overwrite the first attempt's backup.
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
    const backupPath = `${storePath}.drk-${stamp}.bak`

    // Paths are passed as positional arguments rather than interpolated into the
    // script body, so a path containing a quote cannot break out of the quoting
    // and inject into an `rm -f`.
    const repair = wsl([
      '-d', distro, '-u', 'root', '--', 'bash', '-lc',
      'cp -a "$1" "$2" && rm -f "$1" && sync && echo DRK_REPAIR_OK',
      'drk-repair', storePath, backupPath
    ])

    if (repair.status !== 0 || !repair.stdout.includes('DRK_REPAIR_OK')) {
      return {
        ...base,
        vhdxPath,
        storePath,
        message: `Repair command failed: ${repair.stderr || repair.stdout || 'no output'}`
      }
    }

    return {
      ok: true,
      vhdxPath,
      storePath,
      backupPath,
      message:
        `Removed ${storePath} (backup at ${backupPath}). Start Docker Desktop; it will rebuild ` +
        'bridge/host/none. Run `docker compose up` per project to recreate user-defined networks.'
    }
  } catch (err: any) {
    return {
      ...base,
      vhdxPath,
      storePath,
      message: `Repair failed unexpectedly: ${err?.message || err}`
    }
  } finally {
    const unmount = wsl(['--unmount', vhdxPath], { timeoutMs: 120_000, wide: true })
    if (unmount.status !== 0) {
      // WSL sometimes only accepts the \\?\ device form.
      wsl(['--unmount', `\\\\?\\${vhdxPath}`], { timeoutMs: 120_000, wide: true })
    }
  }
}
