import { IConnectorPlugin } from './base'
import { ConnectorDefinition, ConnectorTestResult } from '@docker-rescue-kit/shared'
import { SMBStorageAdapter } from '../storage/adapters/SMBStorageAdapter'

export class SMBConnector implements IConnectorPlugin {
  public readonly definition: ConnectorDefinition = {
    type: 'smb',
    displayName: 'SMB / CIFS',
    description: 'Windows file shares, Samba, NAS mounts. Mounts via cifs-utils on Linux. Requires --cap-add SYS_ADMIN.',
    icon: 'server',
    fields: [
      { name: 'host', label: 'Host / IP', type: 'text', required: true, placeholder: '192.168.1.100', description: 'SMB server hostname or IP address' },
      { name: 'share', label: 'Share name', type: 'text', required: true, placeholder: 'backups', description: 'SMB share name (e.g. "backups" for \\\\host\\backups)' },
      { name: 'username', label: 'Username', type: 'text', required: false, placeholder: 'guest', description: 'Leave blank for guest access' },
      { name: 'password', label: 'Password', type: 'password', required: false, description: 'SMB password' },
      { name: 'domain', label: 'Domain / Workgroup', type: 'text', required: false, placeholder: 'WORKGROUP', description: 'Windows domain or workgroup name' },
    ]
  }

  public async testConnection(config: Record<string, any>): Promise<ConnectorTestResult> {
    const started = Date.now()
    try {
      const adapter = new SMBStorageAdapter({ type: 'smb', ...config })
      await adapter.test()
      return { success: true, latencyMs: Date.now() - started }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Connection failed', latencyMs: Date.now() - started }
    }
  }

  // Per DR-001: SMB discovery is intentionally not implemented.
  // Enumerating shares requires a mount (cifs-utils + SYS_ADMIN) which we
  // cannot perform before the user has committed to a target. Deferred to
  // v1.4 when we have a privilege-broker model. The wizard's discovery step
  // gracefully skips when discoverDestinations is absent.
}
