import fs from 'fs-extra'
import path from 'path'
import { StorageAdapter, BackupMetadata, StorageInfo, StorageConfig } from '../StorageAdapter'
import { ResticEngine, ResticRepoConfig } from '../engines/ResticEngine'
import { safeJoin } from '../../utils/PathSafety'

/**
 * Generic Restic-backed adapter. The concrete storage URL is decided by the
 * caller via `config.repo` (e.g. s3:..., sftp:..., /data/restic, rclone:x:y).
 *
 * Methods map onto StorageAdapter:
 *  - upload(localPath, remotePath)   -> restic backup (file/dir) tagged by remotePath
 *  - download(remotePath, localPath) -> restic dump/restore snapshot into localPath
 *  - list(prefix)                    -> restic snapshots filtered by tag prefix
 *  - delete(remotePath)              -> forget snapshot(s) tagged with remotePath
 *  - deletePrefix(prefix)            -> forget all snapshots tagged with prefix
 */
export class ResticStorageAdapter extends StorageAdapter {
  readonly type: string
  readonly supportsIncremental = true

  private engine: ResticEngine
  private cfg: ResticRepoConfig
  private initialized = false

  constructor(config: StorageConfig, typeName = 'restic') {
    super()
    this.type = typeName
    this.engine = new ResticEngine(config.resticBin)
    this.cfg = this.resolveRepoConfig(config)
  }

  protected resolveRepoConfig(config: StorageConfig): ResticRepoConfig {
    if (!config.repo) throw new Error(`Restic adapter requires config.repo`)
    if (!config.password) throw new Error(`Restic adapter requires config.password`)
    return {
      repo: config.repo,
      password: config.password,
      env: config.env
    }
  }

  private tagFor(remotePath: string): string {
    // We use a single tag equal to the full remote path so snapshots map 1:1.
    // Colons/slashes in tags are fine for restic.
    return `drk:${remotePath}`
  }

  private prefixTag(prefix: string): string {
    return `drk:${prefix}`
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return
    await this.engine.ensureAvailable()
    await this.engine.initRepo(this.cfg)
    this.initialized = true
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    await this.ensureInit()
    const resolvedLocal = path.resolve(localPath)
    const stats = await fs.stat(resolvedLocal)

    if (stats.isFile()) {
      const stream = fs.createReadStream(resolvedLocal)
      await this.engine.backupStdin(this.cfg, stream, path.basename(remotePath), {
        tags: [this.tagFor(remotePath)]
      })
    } else {
      await this.engine.backupDir(this.cfg, resolvedLocal, {
        tags: [this.tagFor(remotePath)]
      })
    }
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    await this.ensureInit()
    const snapshots = await this.engine.listSnapshots(this.cfg, [this.tagFor(remotePath)])
    if (!snapshots.length) throw new Error(`No snapshot found for ${remotePath}`)
    const latest = snapshots[snapshots.length - 1]
    const resolvedLocal = path.resolve(localPath)

    // stdin-backed snapshots (single file) contain the stored stdin filename
    // directly under /.
    const dumpTarget = `/${path.basename(remotePath)}`
    await fs.ensureDir(path.dirname(resolvedLocal))

    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(resolvedLocal)
      const stream = this.engine.dumpToStream(this.cfg, latest.short_id, dumpTarget)
      stream.on('error', reject)
      out.on('error', reject)
      out.on('finish', () => resolve())
      stream.pipe(out)
    })
  }

  async list(prefix: string = ''): Promise<BackupMetadata[]> {
    await this.ensureInit()
    const snapshots = await this.engine.listSnapshots(
      this.cfg,
      prefix ? [this.prefixTag(prefix)] : []
    )
    return snapshots.map(s => ({
      id: s.short_id,
      path: (s.paths && s.paths[0]) || '',
      timestamp: new Date(s.time),
      size: 0,
      type: 'snapshot' as const,
      tags: s.tags || []
    }))
  }

  async delete(remotePath: string): Promise<void> {
    await this.ensureInit()
    const snaps = await this.engine.listSnapshots(this.cfg, [this.tagFor(remotePath)])
    await this.engine.forget(this.cfg, snaps.map(s => s.short_id), { prune: true })
  }

  async deletePrefix(prefix: string): Promise<void> {
    await this.ensureInit()
    const snaps = await this.engine.listSnapshots(this.cfg, [this.prefixTag(prefix)])
    await this.engine.forget(this.cfg, snaps.map(s => s.short_id), { prune: true })
  }

  async test(): Promise<void> {
    await this.engine.ensureAvailable()
    try {
      await this.engine.initRepo(this.cfg)
    } catch (err: any) {
      throw new Error(`Repository unreachable: ${err.message}`)
    }
  }

  async getInfo(): Promise<StorageInfo> {
    try {
      await this.ensureInit()
      const stats = await this.engine.stats(this.cfg)
      return {
        total: -1,
        used: stats.total_size,
        available: -1,
        type: this.type
      }
    } catch {
      return { total: 0, used: 0, available: 0, type: this.type }
    }
  }

  /** Expose a validated staging path for callers that want to stream into it. */
  protected stagingChild(base: string, name: string): string {
    return safeJoin(base, name)
  }
}
