import { spawn } from 'child_process'
import fs from 'fs-extra'
import path from 'path'
import { EventEmitter } from 'events'

export interface RcloneProvider {
  id: string
  name: string
  description: string
  authType: 'oauth' | 'key' | 'none'
  icon: string
  fields: Array<{ name: string; label: string; type: 'text' | 'password'; required: boolean; placeholder?: string; description?: string }>
}

export interface RcloneRemote {
  name: string
  type: string
  configured: boolean
}

/** Providers we surface in the UI. Covers ~95% of homelab use cases. */
export const RCLONE_PROVIDERS: RcloneProvider[] = [
  {
    id: 'drive', name: 'Google Drive', description: 'Google Drive via OAuth2',
    authType: 'oauth', icon: 'gdrive',
    fields: []
  },
  {
    id: 'onedrive', name: 'Microsoft OneDrive', description: 'OneDrive personal & business via OAuth2',
    authType: 'oauth', icon: 'onedrive',
    fields: []
  },
  {
    id: 'dropbox', name: 'Dropbox', description: 'Dropbox via OAuth2',
    authType: 'oauth', icon: 'dropbox',
    fields: []
  },
  {
    id: 'b2', name: 'Backblaze B2', description: 'Backblaze B2 Cloud Storage',
    authType: 'key', icon: 'b2',
    fields: [
      { name: 'account', label: 'Account ID',       type: 'text',     required: true, placeholder: '0123456789abcdef0123456789' },
      { name: 'key',     label: 'Application Key',  type: 'password', required: true },
    ]
  },
  {
    id: 'webdav', name: 'WebDAV', description: 'Any WebDAV server (Nextcloud, ownCloud, etc.)',
    authType: 'key', icon: 'webdav',
    fields: [
      { name: 'url',    label: 'Server URL',   type: 'text',     required: true, placeholder: 'https://nextcloud.example.com/remote.php/dav/files/user/' },
      { name: 'user',   label: 'Username',     type: 'text',     required: true },
      { name: 'pass',   label: 'Password',     type: 'password', required: true },
      { name: 'vendor', label: 'Vendor',       type: 'text',     required: false, placeholder: 'nextcloud', description: 'Optional: nextcloud, owncloud, sharepoint, other' },
    ]
  },
  {
    id: 's3', name: 'S3-compatible', description: 'AWS S3, Wasabi, Cloudflare R2, MinIO, etc.',
    authType: 'key', icon: 's3',
    fields: [
      { name: 'access_key_id',     label: 'Access Key ID',     type: 'text',     required: true },
      { name: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true },
      { name: 'region',            label: 'Region',            type: 'text',     required: false, placeholder: 'us-east-1' },
      { name: 'endpoint',          label: 'Endpoint (custom)', type: 'text',     required: false, placeholder: 'https://s3.wasabisys.com', description: 'Leave blank for AWS S3' },
      { name: 'provider',          label: 'Provider',          type: 'text',     required: false, placeholder: 'AWS', description: 'AWS, Wasabi, Cloudflare, Minio, Other' },
    ]
  },
  {
    id: 'sftp', name: 'SFTP', description: 'SSH file transfer to any remote server',
    authType: 'key', icon: 'sftp',
    fields: [
      { name: 'host',     label: 'Host',     type: 'text',     required: true, placeholder: 'backup.example.com' },
      { name: 'port',     label: 'Port',     type: 'text',     required: false, placeholder: '22' },
      { name: 'user',     label: 'Username', type: 'text',     required: true },
      { name: 'pass',     label: 'Password', type: 'password', required: false, description: 'Or use SSH key via ssh-agent' },
    ]
  },
  {
    id: 'local', name: 'Local / NFS', description: 'Local path or NFS-mounted directory',
    authType: 'none', icon: 'local',
    fields: []
  },
]

/**
 * Manages rclone remote configuration and provides an OAuth authorization
 * helper so the UI can set up cloud storage without the user touching a
 * terminal.
 *
 * Why: rclone handles 40+ storage providers. Rather than maintaining per-
 * provider adapters, we configure rclone remotes through its config API and
 * let `rclone lsd <remote>:` handle the actual I/O through the
 * RcloneStorageAdapter.
 */
export class RcloneService extends EventEmitter {
  private rcloneBin: string
  private configPath: string

  constructor(dataDir: string) {
    super()
    this.rcloneBin = process.env.RCLONE_BIN || 'rclone'
    this.configPath = process.env.RCLONE_CONFIG || path.join(dataDir, 'rclone.conf')
    fs.ensureFileSync(this.configPath)
  }

  public getConfigPath(): string {
    return this.configPath
  }

  // ── Provider catalogue ────────────────────────────────────────────────

  public getProviders(): RcloneProvider[] {
    return RCLONE_PROVIDERS
  }

  // ── Remote management ─────────────────────────────────────────────────

  public async listRemotes(): Promise<RcloneRemote[]> {
    const r = await this.run(['listremotes', '--config', this.configPath])
    if (r.code !== 0) return []
    return r.stdout.trim().split('\n').filter(Boolean).map(name => ({
      name: name.replace(/:$/, ''),
      type: 'unknown',
      configured: true
    }))
  }

  public async createRemote(name: string, providerType: string, params: Record<string, string>): Promise<void> {
    await this.ensureAvailable()
    const args = [
      'config', 'create', name, providerType,
      '--config', this.configPath,
      '--non-interactive',
    ]
    for (const [k, v] of Object.entries(params)) {
      if (v) args.push(`${k}=${v}`)
    }
    const r = await this.run(args)
    if (r.code !== 0) throw new Error(`rclone config create failed: ${r.stderr}`)
  }

  public async deleteRemote(name: string): Promise<void> {
    const r = await this.run(['config', 'delete', name, '--config', this.configPath])
    if (r.code !== 0) throw new Error(`rclone config delete failed: ${r.stderr}`)
  }

  public async testRemote(name: string): Promise<{ ok: boolean; error?: string }> {
    const r = await this.run(['lsd', `${name}:`, '--config', this.configPath], { timeout: 20_000 })
    if (r.code === 0) return { ok: true }
    return { ok: false, error: r.stderr || r.stdout }
  }

  // ── OAuth flow ────────────────────────────────────────────────────────

  /**
   * Build the `rclone authorize` command the user must run **on a machine that
   * has both rclone and a web browser** (typically their own desktop), then
   * paste the resulting token back here via {@link finishOAuth}.
   *
   * Why we don't run `rclone authorize` inside the container: it starts an
   * OAuth callback server on 127.0.0.1:53682, and the provider (Google /
   * Microsoft / Dropbox) only ever redirects back to that fixed loopback
   * address. Inside this container 127.0.0.1 is a separate network namespace
   * and port 53682 is never published, so the user's host browser could never
   * reach the callback and the flow could never complete. This is exactly
   * rclone's documented "remote / headless setup" pattern: authorize on the
   * box that has the browser, copy the token it prints, paste it here.
   */
  public buildAuthorizeCommand(providerType: string): string {
    const provider = RCLONE_PROVIDERS.find(p => p.id === providerType)
    if (!provider || provider.authType !== 'oauth') {
      throw new Error(`'${providerType}' is not an OAuth provider`)
    }
    // providerType is a fixed id from our own catalogue (drive / onedrive /
    // dropbox) — nothing user-controlled, so there is nothing to escape.
    return `rclone authorize "${providerType}"`
  }

  /**
   * Complete an OAuth flow by taking the token JSON the user copied from the
   * `rclone authorize` output on their machine and writing it into a named
   * remote in this container's rclone config.
   */
  public async finishOAuth(remoteName: string, providerType: string, token: string): Promise<void> {
    await this.ensureAvailable()
    try {
      JSON.parse(token)
    } catch {
      throw new Error('Token must be the JSON printed by `rclone authorize` (it starts with {"access_token":...).')
    }
    const args = [
      'config', 'create', remoteName, providerType,
      '--config', this.configPath,
      '--non-interactive',
      `token=${token}`,
    ]
    const r = await this.run(args)
    if (r.code !== 0) throw new Error(`rclone config create (OAuth) failed: ${r.stderr}`)
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /**
   * Probe the rclone binary this backend uses (the one bundled in the
   * container image, or whatever `RCLONE_BIN` points at). Returns a structured
   * result instead of throwing so the UI can render a friendly health badge.
   *
   * Note: this only reflects the rclone *inside DRK*, which handles the actual
   * backup I/O. The OAuth sign-in step still needs rclone on the user's own
   * desktop — a different machine we can't probe from here (see
   * {@link buildAuthorizeCommand}).
   */
  public async checkInstall(): Promise<{ installed: boolean; version: string | null; configPath: string }> {
    const r = await this.run(['version']).catch(() => ({ code: -1, stdout: '', stderr: '' }))
    if (r.code !== 0) {
      return { installed: false, version: null, configPath: this.configPath }
    }
    // First line of `rclone version` is e.g. "rclone v1.65.0".
    const m = r.stdout.match(/rclone\s+(v[\w.\-+]+)/i)
    return { installed: true, version: m ? m[1] : null, configPath: this.configPath }
  }

  public async ensureAvailable(): Promise<void> {
    const { installed } = await this.checkInstall()
    if (!installed) {
      throw new Error('rclone is not installed or not on PATH. Install from https://rclone.org/downloads/ or set RCLONE_BIN.')
    }
  }

  private run(args: string[], opts: { timeout?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.rcloneBin, args, { env: { ...process.env, RCLONE_CONFIG: this.configPath } })
      const out: Buffer[] = []
      const err: Buffer[] = []
      proc.stdout.on('data', c => out.push(c))
      proc.stderr.on('data', c => err.push(c))
      proc.on('error', reject)

      const timer = opts.timeout ? setTimeout(() => { proc.kill(); resolve({ code: -1, stdout: '', stderr: 'timeout' }) }, opts.timeout) : null
      proc.on('close', code => {
        if (timer) clearTimeout(timer)
        resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() })
      })
    })
  }
}
