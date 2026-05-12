import fs from 'fs-extra'
import path from 'path'
import { spawn } from 'child_process'
import { StorageAdapter, BackupMetadata, StorageInfo, StorageConfig } from '../StorageAdapter'
import { LocalStorageAdapter } from './LocalStorageAdapter'

/**
 * SMB/CIFS adapter. We don't talk SMB in-process; instead we mount the share
 * once at startup and delegate to LocalStorageAdapter pointed at the mount.
 *
 * Linux: `mount -t cifs //host/share /mnt/... -o username=..,password=..`
 * Requires the container (or host) to have cifs-utils installed; the backend
 * image does not include it to keep the surface minimal — operators who want
 * SMB should run DRK with `--cap-add SYS_ADMIN --security-opt apparmor=unconfined`
 * and ensure cifs-utils is installed.
 *
 * On platforms without mount(2), this adapter surfaces an explicit error
 * at test() time so the UI can guide the user toward SFTP or rclone instead.
 */
export class SMBStorageAdapter extends StorageAdapter {
  readonly type = 'smb'
  readonly supportsIncremental = true

  private mountPoint: string
  private local: LocalStorageAdapter | null = null
  private config: StorageConfig

  constructor(config: StorageConfig) {
    super()
    this.config = config
    this.mountPoint = config.mountPoint || path.resolve(
      process.env.DRK_DATA_DIR || 'data',
      'mounts',
      `smb-${(config.host || 'host').replace(/[^a-z0-9]/gi, '_')}-${(config.share || 'share').replace(/[^a-z0-9]/gi, '_')}`
    )
  }

  private async ensureMounted(): Promise<void> {
    if (this.local) return
    if (process.platform !== 'linux') {
      throw new Error(
        'SMB adapter requires Linux with cifs-utils. Use the rclone adapter with an smb remote on other platforms.'
      )
    }

    const { host, share, username, password, domain } = this.config
    if (!host || !share) throw new Error('SMB adapter requires config.host and config.share')

    await fs.ensureDir(this.mountPoint)

    const alreadyMounted = await this.isMounted(this.mountPoint)
    if (!alreadyMounted) {
      const target = `//${host}/${share}`
      const opts = [
        username ? `username=${username}` : null,
        password ? `password=${password}` : null,
        domain ? `domain=${domain}` : null,
        'iocharset=utf8',
        'vers=3.0'
      ].filter(Boolean).join(',')

      const res = await this.run('mount', ['-t', 'cifs', target, this.mountPoint, '-o', opts])
      if (res.code !== 0) {
        throw new Error(`mount cifs failed (${res.code}): ${res.stderr}`)
      }
    }

    this.local = new LocalStorageAdapter({ type: 'local', path: this.mountPoint })
  }

  private async isMounted(point: string): Promise<boolean> {
    try {
      const { code, stdout } = await this.run('mountpoint', ['-q', point])
      return code === 0 || stdout.includes('is a mountpoint')
    } catch {
      return false
    }
  }

  private run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const proc = spawn(cmd, args)
      const out: Buffer[] = []
      const err: Buffer[] = []
      proc.stdout.on('data', c => out.push(c))
      proc.stderr.on('data', c => err.push(c))
      proc.on('close', code => resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf-8'),
        stderr: Buffer.concat(err).toString('utf-8')
      }))
      proc.on('error', e => resolve({ code: -1, stdout: '', stderr: e.message }))
    })
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    await this.ensureMounted()
    return this.local!.upload(localPath, remotePath)
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    await this.ensureMounted()
    return this.local!.download(remotePath, localPath)
  }

  async list(prefix: string = ''): Promise<BackupMetadata[]> {
    await this.ensureMounted()
    return this.local!.list(prefix)
  }

  async delete(remotePath: string): Promise<void> {
    await this.ensureMounted()
    return this.local!.delete(remotePath)
  }

  async deletePrefix(prefix: string): Promise<void> {
    await this.ensureMounted()
    return this.local!.deletePrefix(prefix)
  }

  async test(): Promise<void> {
    await this.ensureMounted()
    return this.local!.test()
  }

  async getInfo(): Promise<StorageInfo> {
    await this.ensureMounted()
    return this.local!.getInfo()
  }
}
