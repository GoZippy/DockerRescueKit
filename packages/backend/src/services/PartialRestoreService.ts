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

  public async extractFile(backupId: string, fileName: string, entryPath: string): Promise<NodeJS.ReadableStream> {
    // Validate the user-supplied entry path BEFORE any I/O. Throws on `..`,
    // null bytes, leading `/`, leading `-`, absolute Windows paths, etc.
    const safeEntry = assertSafeEntryPath(entryPath)
    const tarPath = await this.fetchToStaging(backupId, fileName)
    // tar -xzOf <archive> -- <path>  emits the file's bytes on stdout.
    // The `--` separator prevents any future entry name that begins with `-`
    // (already rejected above, but defense in depth) from being parsed as a
    // CLI option. We also pass `--no-same-owner` and `--no-same-permissions`
    // for hygiene even though `-O` writes to stdout (no filesystem write).
    const proc = spawn('tar', [
      '-xzO',
      '--no-same-owner',
      '--no-same-permissions',
      '-f', tarPath,
      '--', safeEntry
    ])
    proc.on('error', err => console.error('[PartialRestore] tar spawn failed:', err))
    return proc.stdout
  }

  // --- internals ---------------------------------------------------------

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

  private tarList(tarPath: string): Promise<TarEntry[]> {
    return new Promise((resolve, reject) => {
      const proc = spawn('tar', ['-tzvf', tarPath])
      const chunks: Buffer[] = []
      const errChunks: Buffer[] = []
      proc.stdout.on('data', c => chunks.push(c))
      proc.stderr.on('data', c => errChunks.push(c))
      proc.on('error', reject)
      proc.on('close', code => {
        if (code !== 0) {
          return reject(new Error(`tar -tzvf exited ${code}: ${Buffer.concat(errChunks)}`))
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
