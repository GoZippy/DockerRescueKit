import { IConnectorPlugin } from './base'
import { ConnectorDefinition, ConnectorResource } from '@docker-rescue-kit/shared'
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

  public async testConnection(config: Record<string, any>): Promise<boolean> {
    try {
      const adapter = new SMBStorageAdapter({ type: 'smb', ...config })
      await adapter.test()
      return true
    } catch (err) {
      console.error('SMB test failed:', err)
      return false
    }
  }

  public async discoverResources(_config: Record<string, any>): Promise<ConnectorResource[]> {
    return []
  }
}
