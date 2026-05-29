import { spawn } from 'child_process'
import fs from 'fs-extra'
import path from 'path'

export interface ResticRepoConfig {
  /** Repo URL as restic expects it: s3:..., sftp:..., /path, rclone:remote:path, etc. */
  repo: string
  password: string
  env?: Record<string, string>
  /**
   * Extra backend options passed as `-o key=value` (restic global flags).
   * e.g. `{ 'sftp.command': 'ssh user@host -p 2222 -s sftp' }` to reach an
   * SFTP server on a non-default port (the `sftp:` repo URL can't carry one).
   */
  options?: Record<string, string>
}

export interface ResticSnapshot {
  id: string
  short_id: string
  time: string
  paths: string[]
  tags?: string[]
  hostname?: string
}

export interface ResticStats {
  total_size: number
  total_file_count: number
}

export interface ResticResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Thin wrapper around the `restic` CLI.
 *
 * Why Restic: it solves dedup, encryption, snapshot model, incremental
 * backup, checksumming, and 10+ storage backends in one battle-tested
 * binary. Wrapping it is strictly better than hand-writing per-backend
 * upload/download/delete logic.
 *
 * All methods fail with a clear error if the `restic` binary is not
 * present on PATH. Operators install restic themselves; we do not bundle
 * it to avoid licensing / arch complications.
 */
export class ResticEngine {
  constructor(private binaryPath: string = process.env.RESTIC_BIN || 'restic') {}

  public async ensureAvailable(): Promise<void> {
    try {
      const res = await this.exec(['version'], {})
      if (res.exitCode !== 0) {
        throw new Error(`restic returned ${res.exitCode}: ${res.stderr}`)
      }
    } catch (err: any) {
      throw new Error(
        `restic CLI not available (${err?.message || err}). ` +
        `Install from https://restic.readthedocs.io/ or set RESTIC_BIN.`
      )
    }
  }

  public async initRepo(cfg: ResticRepoConfig): Promise<void> {
    const res = await this.exec(['init'], cfg)
    if (res.exitCode !== 0 && !/already initialized/i.test(res.stderr)) {
      throw new Error(`restic init failed: ${res.stderr}`)
    }
  }

  public async checkRepo(cfg: ResticRepoConfig): Promise<boolean> {
    const res = await this.exec(['snapshots', '--json'], cfg)
    return res.exitCode === 0
  }

  /**
   * Back up a directory (or a tar via stdin if `stdinTarPath` is set).
   * Returns the snapshot id.
   */
  public async backupDir(
    cfg: ResticRepoConfig,
    localDir: string,
    opts: { tags?: string[]; host?: string } = {}
  ): Promise<string> {
    const args = ['backup', '--json', localDir]
    if (opts.host) args.push('--host', opts.host)
    for (const tag of opts.tags || []) args.push('--tag', tag)

    const res = await this.exec(args, cfg)
    if (res.exitCode !== 0) throw new Error(`restic backup failed: ${res.stderr}`)

    const lines = res.stdout.trim().split('\n').filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const msg = JSON.parse(lines[i])
        if (msg.message_type === 'summary' && msg.snapshot_id) return msg.snapshot_id
      } catch { /* skip non-JSON progress lines */ }
    }
    throw new Error('restic backup completed but no snapshot id in output')
  }

  /**
   * Stream a tarball into restic via stdin so we can back up volumes without
   * staging a second on-disk copy. Restic wraps stdin content inside a
   * pseudo-path (`--stdin-filename`).
   */
  public async backupStdin(
    cfg: ResticRepoConfig,
    stream: NodeJS.ReadableStream,
    stdinFilename: string,
    opts: { tags?: string[]; host?: string } = {}
  ): Promise<string> {
    const args = ['backup', '--json', '--stdin', '--stdin-filename', stdinFilename]
    if (opts.host) args.push('--host', opts.host)
    for (const tag of opts.tags || []) args.push('--tag', tag)

    const res = await this.execWithStdin(args, cfg, stream)
    if (res.exitCode !== 0) throw new Error(`restic backup (stdin) failed: ${res.stderr}`)

    const lines = res.stdout.trim().split('\n').filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const msg = JSON.parse(lines[i])
        if (msg.message_type === 'summary' && msg.snapshot_id) return msg.snapshot_id
      } catch { /* skip */ }
    }
    throw new Error('restic backup (stdin) completed but no snapshot id in output')
  }

  public async listSnapshots(cfg: ResticRepoConfig, tags: string[] = []): Promise<ResticSnapshot[]> {
    const args = ['snapshots', '--json']
    for (const tag of tags) args.push('--tag', tag)
    const res = await this.exec(args, cfg)
    if (res.exitCode !== 0) throw new Error(`restic snapshots failed: ${res.stderr}`)
    try {
      return JSON.parse(res.stdout) as ResticSnapshot[]
    } catch {
      return []
    }
  }

  public async restoreSnapshot(
    cfg: ResticRepoConfig,
    snapshotId: string,
    targetDir: string,
    opts: { includePaths?: string[] } = {}
  ): Promise<void> {
    await fs.ensureDir(targetDir)
    const args = ['restore', snapshotId, '--target', targetDir]
    for (const p of opts.includePaths || []) args.push('--include', p)
    const res = await this.exec(args, cfg)
    if (res.exitCode !== 0) throw new Error(`restic restore failed: ${res.stderr}`)
  }

  /**
   * Emit the contents of a single file from a snapshot on stdout. Used for
   * stdin-backed snapshots (volume tarballs) during restore.
   */
  public dumpToStream(
    cfg: ResticRepoConfig,
    snapshotId: string,
    filePath: string
  ): NodeJS.ReadableStream {
    const env = { ...process.env, RESTIC_PASSWORD: cfg.password, RESTIC_REPOSITORY: cfg.repo, ...(cfg.env || {}) }
    const proc = spawn(this.binaryPath, [...this.optionArgs(cfg), 'dump', snapshotId, filePath], { env })
    // Callers pipe proc.stdout and should also attach a stderr listener for errors.
    proc.stderr.on('data', chunk => {
      if (process.env.DEBUG_RESTIC) process.stderr.write(chunk)
    })
    return proc.stdout
  }

  public async forget(
    cfg: ResticRepoConfig,
    snapshotIds: string[],
    opts: { prune?: boolean } = {}
  ): Promise<void> {
    if (snapshotIds.length === 0) return
    const args = ['forget', ...snapshotIds]
    if (opts.prune) args.push('--prune')
    const res = await this.exec(args, cfg)
    if (res.exitCode !== 0) throw new Error(`restic forget failed: ${res.stderr}`)
  }

  public async stats(cfg: ResticRepoConfig): Promise<ResticStats> {
    const res = await this.exec(['stats', '--json'], cfg)
    if (res.exitCode !== 0) throw new Error(`restic stats failed: ${res.stderr}`)
    try {
      return JSON.parse(res.stdout) as ResticStats
    } catch {
      return { total_size: 0, total_file_count: 0 }
    }
  }

  // --- internals ---------------------------------------------------------

  /** Convert backend options into restic `-o key=value` global flags. */
  private optionArgs(cfg: Partial<ResticRepoConfig>): string[] {
    if (!cfg.options) return []
    return Object.entries(cfg.options).flatMap(([k, v]) => ['-o', `${k}=${v}`])
  }

  private async exec(args: string[], cfg: Partial<ResticRepoConfig>): Promise<ResticResult> {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        ...(cfg.password ? { RESTIC_PASSWORD: cfg.password } : {}),
        ...(cfg.repo ? { RESTIC_REPOSITORY: cfg.repo } : {}),
        ...(cfg.env || {})
      }
      const proc = spawn(this.binaryPath, [...this.optionArgs(cfg), ...args], { env })

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      proc.stdout.on('data', c => stdoutChunks.push(c))
      proc.stderr.on('data', c => stderrChunks.push(c))
      proc.on('error', reject)
      proc.on('close', code => resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8')
      }))
    })
  }

  private async execWithStdin(
    args: string[],
    cfg: Partial<ResticRepoConfig>,
    stdin: NodeJS.ReadableStream
  ): Promise<ResticResult> {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        ...(cfg.password ? { RESTIC_PASSWORD: cfg.password } : {}),
        ...(cfg.repo ? { RESTIC_REPOSITORY: cfg.repo } : {}),
        ...(cfg.env || {})
      }
      const proc = spawn(this.binaryPath, [...this.optionArgs(cfg), ...args], { env })

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      proc.stdout.on('data', c => stdoutChunks.push(c))
      proc.stderr.on('data', c => stderrChunks.push(c))
      proc.on('error', reject)
      proc.on('close', code => resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8')
      }))

      stdin.pipe(proc.stdin)
      stdin.on('error', reject)
      proc.stdin.on('error', reject)
    })
  }
}
