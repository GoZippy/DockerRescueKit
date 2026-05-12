import { spawn } from 'child_process'
import fs from 'fs-extra'
import path from 'path'
import { StorageAdapter, BackupMetadata, StorageInfo, StorageConfig } from '../StorageAdapter'

/**
 * Proxmox Backup Server adapter via the `proxmox-backup-client` CLI.
 *
 * PBS uses its own wire protocol and datastore model — Restic can't talk to
 * it directly. This adapter shells out to `proxmox-backup-client`, which
 * ships with Proxmox and is also available as a standalone package:
 *   apt install proxmox-backup-client   (Debian/Ubuntu)
 *   Available in the PBS ISO extras
 *
 * Repository URL format expected in config.repo:
 *   user@realm@host:port:datastore
 *   e.g. backup@pam@192.168.1.50:8007:docker-backups
 *
 * Auth:  config.password  → PBS_PASSWORD env var
 * Fingerprint (if self-signed): config.fingerprint → PBS_FINGERPRINT env var
 */
export class PBSStorageAdapter extends StorageAdapter {
  readonly type = 'proxmox-backup-server'
  readonly supportsIncremental = true

  private binaryPath: string
  private cfg: { repo: string; password: string; fingerprint?: string }

  constructor(config: StorageConfig) {
    super()
    if (!config.repo) throw new Error('PBS adapter requires config.repo (user@realm@host:port:datastore)')
    if (!config.password) throw new Error('PBS adapter requires config.password')

    this.binaryPath = config.pbsBin || process.env.PBS_BIN || 'proxmox-backup-client'
    this.cfg = {
      repo: config.repo,
      password: config.password,
      fingerprint: config.fingerprint,
    }
  }

  private env(): Record<string, string> {
    const e: Record<string, string> = {
      ...process.env as Record<string, string>,
      PBS_REPOSITORY: this.cfg.repo,
      PBS_PASSWORD: this.cfg.password,
    }
    if (this.cfg.fingerprint) e.PBS_FINGERPRINT = this.cfg.fingerprint
    return e
  }

  private run(args: string[], opts: { input?: Buffer } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.binaryPath, args, { env: this.env() })
      const out: Buffer[] = []
      const err: Buffer[] = []
      proc.stdout.on('data', c => out.push(c))
      proc.stderr.on('data', c => err.push(c))
      if (opts.input) {
        proc.stdin.end(opts.input)
      }
      proc.on('error', reject)
      proc.on('close', code => resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf-8'),
        stderr: Buffer.concat(err).toString('utf-8'),
      }))
    })
  }

  async test(): Promise<void> {
    const r = await this.run(['snapshots'])
    if (r.code !== 0 && !/no.*snapshot/i.test(r.stderr)) {
      throw new Error(`PBS connection failed: ${r.stderr || r.stdout}`)
    }
  }

  /**
   * Upload a file to PBS. PBS expects file archives in its own format:
   * `proxmox-backup-client backup <archive-name.tar.gz>:<local-path>`
   * The snapshot is tagged with the DRK backup ID via the --ns (namespace) flag.
   */
  async upload(localPath: string, remotePath: string): Promise<void> {
    const resolved = path.resolve(localPath)
    if (!(await fs.pathExists(resolved))) throw new Error(`File not found: ${resolved}`)

    const archiveName = path.basename(remotePath)
    const backupId = remotePath.split('/')[0] || 'default'

    const r = await this.run([
      'backup',
      `${archiveName}:${resolved}`,
      '--ns', `drk/${backupId}`,
      '--change-detection-mode', 'metadata',
    ])
    if (r.code !== 0) throw new Error(`PBS backup failed: ${r.stderr}`)
  }

  /**
   * Restore a file from PBS. Finds the latest snapshot in the namespace
   * matching the backup ID extracted from remotePath, then extracts the
   * specific archive to localPath.
   */
  async download(remotePath: string, localPath: string): Promise<void> {
    await fs.ensureDir(path.dirname(path.resolve(localPath)))

    const archiveName = path.basename(remotePath)
    const backupId = remotePath.split('/')[0] || 'default'
    const snapshotId = await this.findLatestSnapshot(backupId)

    const r = await this.run([
      'restore',
      snapshotId,
      archiveName,
      path.resolve(localPath),
      '--ns', `drk/${backupId}`,
    ])
    if (r.code !== 0) throw new Error(`PBS restore failed: ${r.stderr}`)
  }

  async list(prefix: string = ''): Promise<BackupMetadata[]> {
    const args = ['snapshots']
    if (prefix) args.push('--ns', `drk/${prefix}`)

    const r = await this.run(args)
    if (r.code !== 0) return []

    const backups: BackupMetadata[] = []
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^\s*(backup\/\S+)\s+(\d{4}-\d{2}-\d{2}T\S+)/i)
      if (m) {
        backups.push({
          id: m[1],
          path: m[1],
          timestamp: new Date(m[2]),
          size: 0,
          type: 'snapshot',
        })
      }
    }
    return backups.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  }

  async delete(remotePath: string): Promise<void> {
    const backupId = remotePath.split('/')[0] || 'default'
    const snapshotId = await this.findLatestSnapshot(backupId).catch(() => null)
    if (!snapshotId) return

    const r = await this.run(['forget', snapshotId, '--ns', `drk/${backupId}`])
    if (r.code !== 0) throw new Error(`PBS forget failed: ${r.stderr}`)
  }

  async deletePrefix(prefix: string): Promise<void> {
    const snapshots = await this.list(prefix)
    for (const s of snapshots) {
      await this.run(['forget', s.id, '--ns', `drk/${prefix}`]).catch(() => {})
    }
  }

  async getInfo(): Promise<StorageInfo> {
    const r = await this.run(['status'])
    if (r.code !== 0) return { total: 0, used: 0, available: 0, type: this.type }

    const totalMatch = r.stdout.match(/total:\s*([\d.]+)\s*([KMGT]?B)/i)
    const usedMatch = r.stdout.match(/used:\s*([\d.]+)\s*([KMGT]?B)/i)

    return {
      total: totalMatch ? parseBytes(totalMatch[1], totalMatch[2]) : 0,
      used: usedMatch ? parseBytes(usedMatch[1], usedMatch[2]) : 0,
      available: 0,
      type: this.type,
    }
  }

  private async findLatestSnapshot(backupId: string): Promise<string> {
    const snapshots = await this.list(backupId)
    if (!snapshots.length) throw new Error(`No PBS snapshots found for backup ${backupId}`)
    return snapshots[0].path
  }
}

function parseBytes(value: string, unit: string): number {
  const n = parseFloat(value)
  const units: Record<string, number> = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 }
  return n * (units[unit.toUpperCase()] || 1)
}
