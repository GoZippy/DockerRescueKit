import fs from 'fs-extra'
import path from 'path'
import { spawn } from 'child_process'
import { PolicyManager } from './PolicyManager'
import { StorageFactory } from '../storage/StorageFactory'
import { safeJoin, safeFilenameFragment, assertSafeEntryPath } from '../utils/PathSafety'
import { NotFoundError } from '../errors'

export interface TarEntry {
  path: string
  size: number
  mode: string
  mtime?: string
}

/**
 * File-level browse + extract for backups. Operates on the tarball(s) a
 * backup produced and streams selected entries back to the caller. This
 * matches the "I only need one file back" use case without forcing a full
 * volume restore.
 */
export class PartialRestoreService {
  constructor(
    private policyManager: PolicyManager,
    private stagingDir: string
  ) {}

  /**
   * List entries inside one of the tarballs of a backup.
   *
   * The file name is the one recorded in the manifest (e.g. "volume_foo.tar.gz").
   */
  public async listEntries(backupId: string, fileName: string): Promise<TarEntry[]> {
    const tarPath = await this.fetchToStaging(backupId, fileName)
    try {
      return await this.tarList(tarPath)
    } finally {
      // Keep the cached tar around for the subsequent extract call within
      // the same UI session — but clean anything older on each fetch.
      await this.cleanOldStaging()
    }
  }

  public async getStorageLocation(backupId: string): Promise<{ type: string; location: string; path?: string }> {
    const backup = await this.policyManager.getBackup(backupId)
    if (!backup) throw new NotFoundError('Backup', backupId)
    const policy = await this.policyManager.getPolicy(backup.policyId)
    if (!policy) throw new NotFoundError('Policy (parent)', backup.policyId)

    const resolved = await this.policyManager.resolveStorageConfig(policy.storage)
    const type = String(policy.storage?.type || 'local')

    if (type === 'local') {
      const basePath = path.resolve(resolved.path || resolved.basePath || 'data/backups')
      const fullPath = path.join(basePath, backupId)
      return { type: 'local', location: fullPath, path: fullPath }
    } else if (type === 's3') {
      const loc = `s3://${resolved.bucket || 'default'}/${resolved.prefix || ''}${backupId}`
      return { type: 's3', location: loc }
    } else if (type === 'smb') {
      const loc = `\\\\${resolved.host || 'server'}\\${resolved.share || 'backups'}\\${backupId}`
      return { type: 'smb', location: loc }
    } else if (type === 'sftp') {
      const loc = `sftp://${resolved.host || 'server'}:${resolved.port || 22}${resolved.path || '/backups'}/${backupId}`
      return { type: 'sftp', location: loc }
    } else if (type === 'pbs') {
      const loc = `pbs://${resolved.server || 'server'}/${resolved.datastore || 'backup'}/${backupId}`
      return { type: 'pbs', location: loc }
    } else if (type === 'rclone') {
      const loc = `rclone://${resolved.remote || 'remote'}:${resolved.path || ''}/${backupId}`
      return { type: 'rclone', location: loc }
    }
    return { type, location: `${type}://${backupId}` }
  }

  public async extractFile(backupId: string, fileName: string, entryPath: string): Promise<NodeJS.ReadableStream> {
    // Validate the user-supplied entry path BEFORE any I/O. Throws on `..`,
    // null bytes, leading `/`, leading `-`, absolute Windows paths, etc.
    const safeEntry = assertSafeEntryPath(entryPath)
    const tarPath = await this.fetchToStaging(backupId, fileName)
    const gzipped = await this.isGzipped(tarPath)
    const flags = gzipped ? '-xzO' : '-xO'

    // tar -xzOf or -xOf <archive> -- <path> emits the file's bytes on stdout.
    const proc = spawn('tar', [
      flags,
      '--no-same-owner',
      '--no-same-permissions',
      '-f', tarPath,
      '--', safeEntry
    ])
    proc.on('error', err => console.error('[PartialRestore] tar spawn failed:', err))
    return proc.stdout
  }

  // --- internals ---------------------------------------------------------

  private async isGzipped(filePath: string): Promise<boolean> {
    try {
      const fd = await fs.open(filePath, 'r')
      const buf = Buffer.alloc(2)
      await fs.read(fd, buf, 0, 2, 0)
      await fs.close(fd)
      return buf[0] === 0x1f && buf[1] === 0x8b
    } catch {
      return true
    }
  }

  private async fetchToStaging(backupId: string, fileName: string): Promise<string> {
    const backup = await this.policyManager.getBackup(backupId)
    if (!backup) throw new NotFoundError('Backup', backupId)
    const policy = await this.policyManager.getPolicy(backup.policyId)
    if (!policy) throw new NotFoundError('Policy (parent)', backup.policyId)

    const adapter = StorageFactory.create(
      policy.storage.type,
      await this.policyManager.resolveStorageConfig(policy.storage)
    )

    const sessionDir = safeJoin(
      this.stagingDir,
      `partial-${safeFilenameFragment(backupId)}`
    )
    await fs.ensureDir(sessionDir)

    const safeName = safeFilenameFragment(fileName)
    const localTar = safeJoin(sessionDir, safeName)

    if (!(await fs.pathExists(localTar))) {
      const remote = path.posix.join(backupId, fileName)
      await adapter.download(remote, localTar)
    }
    return localTar
  }

  private async tarList(tarPath: string): Promise<TarEntry[]> {
    const gzipped = await this.isGzipped(tarPath)
    const primaryFlags = gzipped ? '-tzvf' : '-tvf'
    try {
      return await this.execTarList(tarPath, primaryFlags)
    } catch (err) {
      // Fallback: if gzip mode failed (e.g. file named .tar.gz but uncompressed), try uncompressed
      if (gzipped) {
        return await this.execTarList(tarPath, '-tvf')
      }
      throw err
    }
  }

  private execTarList(tarPath: string, flags: string): Promise<TarEntry[]> {
    return new Promise((resolve, reject) => {
      const proc = spawn('tar', [flags, tarPath])
      const chunks: Buffer[] = []
      const errChunks: Buffer[] = []
      proc.stdout.on('data', c => chunks.push(c))
      proc.stderr.on('data', c => errChunks.push(c))
      proc.on('error', reject)
      proc.on('close', code => {
        if (code !== 0) {
          return reject(new Error(`tar ${flags} exited ${code}: ${Buffer.concat(errChunks)}`))
        }
        const lines = Buffer.concat(chunks).toString('utf-8').split('\n').filter(Boolean)
        resolve(lines.map(line => parseTarLine(line)).filter((e): e is TarEntry => !!e))
      })
    })
  }

  private async cleanOldStaging(): Promise<void> {
    const root = this.stagingDir
    try {
      const entries = await fs.readdir(root, { withFileTypes: true })
      const now = Date.now()
      for (const e of entries) {
        if (!e.isDirectory() || !e.name.startsWith('partial-')) continue
        const full = safeJoin(root, e.name)
        const stat = await fs.stat(full).catch(() => null)
        if (stat && now - stat.mtimeMs > 30 * 60 * 1000) {
          await fs.remove(full).catch(() => {})
        }
      }
    } catch {
      /* staging dir may not exist yet */
    }
  }
}

function parseTarLine(line: string): TarEntry | null {
  // Example line from `tar -tzvf`:
  //   -rw-r--r-- root/root        12 2024-05-02 14:30 ./file.txt
  const parts = line.trim().split(/\s+/)
  if (parts.length < 6) return null
  const mode = parts[0]
  const size = parseInt(parts[2] || '0', 10)
  const date = parts[3]
  const time = parts[4]
  const entryPath = parts.slice(5).join(' ')
  return {
    path: entryPath,
    size: isNaN(size) ? 0 : size,
    mode,
    mtime: date && time ? `${date} ${time}` : undefined
  }
}
