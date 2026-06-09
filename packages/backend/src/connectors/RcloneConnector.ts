import { IConnectorPlugin } from './base'
import { ConnectorDefinition, ConnectorResource, ConnectorTestResult } from '@docker-rescue-kit/shared'
import { RcloneStorageAdapter } from '../storage/adapters/RcloneStorageAdapter'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export class RcloneConnector implements IConnectorPlugin {
  public readonly definition: ConnectorDefinition = {
    type: 'rclone' as any,
    displayName: 'Rclone remote',
    description: 'Any provider rclone supports (GDrive, OneDrive, Dropbox, pCloud, Box, Azure, WebDAV, B2, …). Requires rclone installed on the host and a pre-configured remote.',
    icon: 'cloud',
    fields: [
      { name: 'remote', label: 'Rclone remote name', type: 'text', required: true, placeholder: 'gdrive' },
      { name: 'path', label: 'Path under remote', type: 'text', required: true, placeholder: 'drk-backups' },
      { name: 'rcloneConfig', label: 'rclone.conf path (optional)', type: 'text', required: false, placeholder: '/root/.config/rclone/rclone.conf' },
      { name: 'password', label: 'Repository encryption password', type: 'password', required: true }
    ]
  }

  public async testConnection(config: Record<string, any>): Promise<ConnectorTestResult> {
    const started = Date.now()
    try {
      const adapter = new RcloneStorageAdapter({ type: 'rclone', ...config })
      await adapter.test()
      return { success: true, latencyMs: Date.now() - started }
    } catch (err: any) {
      return {
        success: false,
        error: `Rclone repository unreachable: ${err?.message ?? String(err)}`,
        latencyMs: Date.now() - started
      }
    }
  }

  /**
   * D3 (DR-001): enumerate top-level directories under the configured rclone
   * remote. Uses `rclone lsjson` (bundled in the image — see Dockerfile:46).
   * Returns up to ~2 levels deep so the UI picker has useful breadth without
   * fetching the whole remote (some rclone backends are paginated and slow).
   *
   * The deprecated discoverResources() shim is preserved for the route-layer
   * fallback in resolveDiscovery() until U1 adopts the explicit `mode` param.
   */
  public async discoverDestinations(config: Record<string, any>): Promise<ConnectorResource[]> {
    if (!config.remote) {
      throw new Error('Rclone discovery requires config.remote')
    }
    // Defense-in-depth: rclone remote names per rclone.conf grammar are
    // [A-Za-z0-9_-]+. We already use execFile (no shell), but rejecting
    // malformed remotes here protects future refactors that might switch
    // to shell-true and stops obviously-bogus configs at the boundary.
    if (!/^[A-Za-z0-9_-]+$/.test(String(config.remote))) {
      throw new Error('Rclone remote name must match [A-Za-z0-9_-]+')
    }

    // rclone lsjson returns JSON array of {Name,Path,Size,MimeType,ModTime,IsDir,...}
    // --max-depth 1 keeps the call cheap. --dirs-only narrows it to folders the
    // user might pick as a destination.
    const args = [
      'lsjson',
      '--max-depth', '1',
      '--dirs-only',
      `${config.remote}:${(config.path ?? '').replace(/^\//, '')}`
    ]

    const env = { ...process.env }
    if (config.rcloneConfig) env.RCLONE_CONFIG = config.rcloneConfig

    let stdout = ''
    try {
      // 30s budget — some cloud backends (gdrive) take 5-10s on a cold call.
      const result = await execFileAsync('rclone', args, { timeout: 30_000, env, maxBuffer: 8 * 1024 * 1024 })
      stdout = result.stdout
    } catch (err: any) {
      if (err?.killed && err?.signal === 'SIGTERM') {
        throw new Error('Rclone discovery timed out after 30s — remote may be slow or unreachable')
      }
      const stderr = (err?.stderr ?? '').toString().trim()
      throw new Error(`rclone lsjson failed: ${stderr || err?.message || String(err)}`)
    }

    let entries: Array<{ Name: string; Path: string; Size?: number; ModTime?: string; IsDir?: boolean }>
    try {
      entries = JSON.parse(stdout)
    } catch (err: any) {
      throw new Error(`rclone returned non-JSON output: ${err.message}`)
    }

    const basePrefix = (config.path ?? '').replace(/^\//, '').replace(/\/$/, '')
    return entries
      .filter(e => e.IsDir !== false)
      .map(e => ({
        id: `rclone-${config.remote}-${e.Path}`,
        connectorId: '',
        name: e.Name,
        type: 'rclone-dir',
        path: basePrefix ? `${basePrefix}/${e.Path}` : e.Path,
        metadata: { remote: config.remote, modTime: e.ModTime }
      }))
  }

  /** @deprecated Forwarded to discoverDestinations for route-layer back-compat. */
  public async discoverResources(config: Record<string, any>): Promise<ConnectorResource[]> {
    return this.discoverDestinations(config)
  }
}
