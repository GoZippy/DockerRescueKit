import { IConnectorPlugin } from './base'
import { ConnectorDefinition, ConnectorResource } from '@docker-rescue-kit/shared'
import { S3StorageAdapter } from '../storage/adapters/S3StorageAdapter'

export class S3Connector implements IConnectorPlugin {
  public readonly definition: ConnectorDefinition = {
    type: 's3',
    displayName: 'S3-compatible object storage',
    description: 'AWS S3, Backblaze B2 (S3 API), Wasabi, Cloudflare R2, MinIO. Uses restic for dedup + encryption.',
    icon: 'cloud',
    fields: [
      { name: 'endpoint', label: 'Endpoint', type: 'text', required: false, placeholder: 's3.amazonaws.com', description: 'Leave blank for AWS' },
      { name: 'bucket', label: 'Bucket', type: 'text', required: true },
      { name: 'prefix', label: 'Path prefix (optional)', type: 'text', required: false, placeholder: 'drk' },
      { name: 'region', label: 'Region (AWS only)', type: 'text', required: false, placeholder: 'us-east-1' },
      { name: 'accessKey', label: 'Access key ID', type: 'password', required: true },
      { name: 'secretKey', label: 'Secret access key', type: 'password', required: true },
      { name: 'password', label: 'Repository encryption password', type: 'password', required: true, description: 'Used by restic to encrypt the repo; keep it safe — losing it means losing the backup.' }
    ]
  }

  public async testConnection(config: Record<string, any>): Promise<boolean> {
    try {
      const adapter = new S3StorageAdapter({ type: 's3', ...config })
      await adapter.test()
      return true
    } catch (err) {
      console.error('S3 test failed:', err)
      return false
    }
  }

  public async discoverResources(_config: Record<string, any>): Promise<ConnectorResource[]> {
    return []
  }
}
