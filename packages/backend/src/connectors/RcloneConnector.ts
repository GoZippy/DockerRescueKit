import { IConnectorPlugin } from './base'
import { ConnectorDefinition, ConnectorResource, ConnectorTestResult } from '@docker-rescue-kit/shared'
import { RcloneStorageAdapter } from '../storage/adapters/RcloneStorageAdapter'

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

  public async discoverResources(_config: Record<string, any>): Promise<ConnectorResource[]> {
    return []
  }
}
