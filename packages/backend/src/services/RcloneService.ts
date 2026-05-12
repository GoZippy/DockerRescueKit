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

  /** Active OAuth authorize processes keyed by session ID. */
  private oauthSessions = new Map<string, { proc: any; url: string | null; token: string | null }>()

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
   * Start an OAuth authorization flow for a provider that requires browser
   * consent (Google Drive, OneDrive, Dropbox). Returns a session ID and the
   * authorization URL to open in the browser.
   *
   * The backend runs `rclone authorize --auth-no-open-browser <type>` as a
   * background process, parses the authorization URL from its output, and
   * waits for the user to complete the flow. Once the user pastes the
   * authorization code back (via authFinish), we write the token to the
   * config file.
   */
  public async startOAuth(sessionId: string, providerType: string): Promise<string> {
    await this.ensureAvailable()
    this.stopOAuth(sessionId)

    const session: { proc: any; url: string | null; token: string | null } = {
      proc: null, url: null, token: null
    }
    this.oauthSessions.set(sessionId, session)

    return new Promise((resolve, reject) => {
      const proc = spawn(this.rcloneBin, ['authorize', '--auth-no-open-browser', providerType], {
        env: { ...process.env, RCLONE_CONFIG: this.configPath }
      })
      session.proc = proc

      let stdout = ''
      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        const urlMatch = stdout.match(/(https?:\/\/accounts\.google\.[^\s]+|https?:\/\/login\.microsoftonline\.[^\s]+|https?:\/\/www\.dropbox\.[^\s]+|https?:\/\/[^\s]+auth[^\s]+)/i)
        if (urlMatch && !session.url) {
          session.url = urlMatch[1]
          this.emit('oauth-url', sessionId, session.url)
          resolve(session.url)
        }
        // Capture the token JSON when it appears
        const tokenMatch = stdout.match(/Paste the following into your remote machine[\s\S]*?--->\s*([\s\S]+?)\s*<---/)
        if (tokenMatch) {
          session.token = tokenMatch[1].trim()
          this.emit('oauth-token', sessionId, session.token)
        }
      })

      proc.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        const urlMatch = text.match(/(https?:\/\/[^\s]+)/i)
        if (urlMatch && !session.url) {
          session.url = urlMatch[1]
          this.emit('oauth-url', sessionId, session.url)
          resolve(session.url)
        }
      })

      proc.on('error', reject)
      proc.on('close', (code: number) => {
        if (code !== 0 && !session.url) {
          reject(new Error(`rclone authorize exited ${code}`))
        }
      })

      setTimeout(() => {
        if (!session.url) {
          proc.kill()
          reject(new Error('Timed out waiting for rclone authorization URL (30s)'))
        }
      }, 30_000)
    })
  }

  /** Check if the OAuth process has produced a token yet. */
  public getOAuthToken(sessionId: string): string | null {
    return this.oauthSessions.get(sessionId)?.token ?? null
  }

  /**
   * Complete an OAuth flow by taking the token string the user copied from
   * the browser and configuring the remote.
   */
  public async finishOAuth(sessionId: string, remoteName: string, providerType: string, token: string): Promise<void> {
    this.stopOAuth(sessionId)
    const args = [
      'config', 'create', remoteName, providerType,
      '--config', this.configPath,
      '--non-interactive',
      `token=${token}`,
    ]
    const r = await this.run(args)
    if (r.code !== 0) throw new Error(`rclone config create (OAuth) failed: ${r.stderr}`)
  }

  public stopOAuth(sessionId: string): void {
    const session = this.oauthSessions.get(sessionId)
    if (session?.proc) {
      try { session.proc.kill() } catch { /* already dead */ }
    }
    this.oauthSessions.delete(sessionId)
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  public async ensureAvailable(): Promise<void> {
    const r = await this.run(['version']).catch(() => ({ code: -1, stdout: '', stderr: '' }))
    if (r.code !== 0) {
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
