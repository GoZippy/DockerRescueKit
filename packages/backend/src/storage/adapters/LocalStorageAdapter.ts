import fs from 'fs-extra'
import path from 'path'
import { StorageAdapter, BackupMetadata, StorageInfo, StorageConfig } from '../StorageAdapter'
import { safeJoin } from '../../utils/PathSafety'

/**
 * Local filesystem storage adapter. All remote paths are constrained inside
 * `basePath`; attempts to escape via `..` throw.
 */
export class LocalStorageAdapter extends StorageAdapter {
  readonly type = 'local'
  readonly supportsIncremental = true

  private basePath: string

  constructor(config: StorageConfig) {
    super()
    this.basePath = path.resolve(config.path || config.basePath || 'data/backups')
    fs.ensureDirSync(this.basePath)
  }

  private within(rel: string): string {
    return safeJoin(this.basePath, rel)
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    const targetPath = this.within(remotePath)
    await fs.ensureDir(path.dirname(targetPath))
    await fs.copy(path.resolve(localPath), targetPath)
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    const sourcePath = this.within(remotePath)
    const resolvedLocal = path.resolve(localPath)
    await fs.ensureDir(path.dirname(resolvedLocal))
    await fs.copy(sourcePath, resolvedLocal)
  }

  async list(dir: string = ''): Promise<BackupMetadata[]> {
    const searchPath = this.within(dir)
    if (!(await fs.pathExists(searchPath))) return []

    const entries = await fs.readdir(searchPath, { withFileTypes: true })
    const backups: BackupMetadata[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const fullPath = path.join(searchPath, entry.name)
      const metadata = await this.getMetadata(fullPath)
      if (metadata) backups.push(metadata)
    }

    return backups.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  }

  async delete(remotePath: string): Promise<void> {
    await fs.remove(this.within(remotePath))
  }

  async deletePrefix(prefix: string): Promise<void> {
    await fs.remove(this.within(prefix))
  }

  async test(): Promise<void> {
    const testFile = this.within('.drk-test-write')
    try {
      await fs.writeFile(testFile, 'test')
      await fs.remove(testFile)
    } catch (error) {
      throw new Error(`Cannot write to ${this.basePath}: ${error}`)
    }
  }

  async getInfo(): Promise<StorageInfo> {
    return {
      total: 0,
      used: 0,
      available: 0,
      type: 'local'
    }
  }

  /**
   * Read metadata.json from a backup directory. This is the manifest file
   * PolicyManager writes on every backup.
   */
  private async getMetadata(dir: string): Promise<BackupMetadata | null> {
    const resolved = path.resolve(dir)
    if (!resolved.startsWith(this.basePath)) return null

    const manifestPath = path.join(resolved, 'manifest.json')
    if (!(await fs.pathExists(manifestPath))) return null

    try {
      const m = await fs.readJson(manifestPath)
      return {
        id: m.backupId,
        path: resolved,
        timestamp: new Date(m.timestamp),
        size: Array.isArray(m.files) ? m.files.reduce((a: number, f: any) => a + (f.size || 0), 0) : 0,
        checksum: Array.isArray(m.files) ? m.files.map((f: any) => f.checksum).join(',') : undefined,
        type: m.type || 'full',
        tags: m.tags || []
      }
    } catch (err) {
      console.error(`[Local] failed to read manifest at ${manifestPath}:`, err)
      return null
    }
  }
}
