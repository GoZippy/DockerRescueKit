import { IConnectorPlugin } from './base'
import { ConnectorResource, ConnectorDefinition } from '@docker-rescue-kit/shared'
import axios from 'axios'
import https from 'https'

export class TrueNASConnector implements IConnectorPlugin {
  public readonly definition: ConnectorDefinition = {
    type: 'truenas',
    displayName: 'TrueNAS SCALE/CORE',
    description: 'Connect to TrueNAS to manage ZFS datasets and remote backups.',
    icon: 'database',
    fields: [
      { name: 'host', label: 'TrueNAS IP/Hostname', type: 'text', required: true, placeholder: 'https://192.168.1.150' },
      { name: 'apiKey', label: 'API Key', type: 'password', required: true },
      { name: 'verifySSL', label: 'Verify SSL Certificate', type: 'boolean', required: false, default: false }
    ]
  }

  private getClient(config: Record<string, any>) {
    return axios.create({
      baseURL: `${config.host}/api/v2.0`,
      headers: {
        'Authorization': `Bearer ${config.apiKey}`
      },
      httpsAgent: new https.Agent({  
        rejectUnauthorized: config.verifySSL ?? false
      })
    })
  }

  public async testConnection(config: Record<string, any>): Promise<boolean> {
    try {
      const client = this.getClient(config)
      const res = await client.get('/system/info')
      return res.status === 200
    } catch (e) {
      console.error('TrueNAS connection failed:', e)
      return false
    }
  }

  public async discoverResources(config: Record<string, any>): Promise<ConnectorResource[]> {
    try {
      const client = this.getClient(config)
      const res = await client.get('/pool/dataset')
      const resources: ConnectorResource[] = []

      for (const dataset of res.data) {
        // Skip hidden datasets or system datasets if desired, but for now map everything
        resources.push({
          id: `zfs-dataset-${dataset.id}`,
          connectorId: '',
          name: dataset.name,
          type: 'zfs-dataset',
          path: dataset.mountpoint,
          size: dataset.pool ? (dataset.pool.size || 0) : 0,
          available: dataset.available?.parsed || 0,
          metadata: { compression: dataset.compression?.value }
        })
      }
      return resources
    } catch (e) {
      console.error('TrueNAS discovery failed:', e)
      throw new Error('Failed to discover TrueNAS resources.')
    }
  }
}
