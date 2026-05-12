import { IConnectorPlugin } from './base'
import { ConnectorDefinition, ConnectorResource } from '@docker-rescue-kit/shared'
import { SFTPStorageAdapter } from '../storage/adapters/SFTPStorageAdapter'

export class SFTPConnector implements IConnectorPlugin {
  public readonly definition: ConnectorDefinition = {
    type: 'sftp',
    displayName: 'SFTP server',
    description: 'Any SSH/SFTP server. Uses restic; SSH keys resolved via ssh-agent or ~/.ssh/config on the host.',
    icon: 'server',
    fields: [
      { name: 'host', label: 'Hostname', type: 'text', required: true, placeholder: 'backup.example.com' },
      { name: 'port', label: 'Port', type: 'number', required: false, default: 22 },
      { name: 'username', label: 'Username', type: 'text', required: true },
      { name: 'path', label: 'Remote path', type: 'text', required: true, placeholder: '/srv/backups/drk' },
      { name: 'password', label: 'Repository encryption password', type: 'password', required: true }
    ]
  }

  public async testConnection(config: Record<string, any>): Promise<boolean> {
    try {
      const adapter = new SFTPStorageAdapter({ type: 'sftp', ...config })
      await adapter.test()
      return true
    } catch (err) {
      console.error('SFTP test failed:', err)
      return false
    }
  }

  public async discoverResources(_config: Record<string, any>): Promise<ConnectorResource[]> {
    return []
  }
}
