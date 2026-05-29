import { IConnectorPlugin } from './base'
import { ConnectorResource, ConnectorDefinition, ConnectorTestResult } from '@docker-rescue-kit/shared'
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
      timeout: 10000,
      headers: {
        'Authorization': `Bearer ${config.apiKey}`
      },
      httpsAgent: new https.Agent({  
        rejectUnauthorized: config.verifySSL ?? false
      })
    })
  }

  public async testConnection(config: Record<string, any>): Promise<ConnectorTestResult> {
    const started = Date.now()
    try {
      const client = this.getClient(config)
      const res = await client.get('/system/info')
      const latencyMs = Date.now() - started
      if (res.status !== 200) {
        return { success: false, error: `Unexpected HTTP ${res.status} from /api/v2.0/system/info`, latencyMs }
      }
      return {
        success: true,
        latencyMs,
        serverInfo: { hostname: res.data?.hostname, version: res.data?.version }
      }
    } catch (e: any) {
      const status = e?.response?.status
      const msg = status
        ? `TrueNAS API ${status}: ${e.response?.data?.message || e.message}`
        : (e?.code === 'ECONNABORTED' || e?.message?.includes('timeout'))
          ? 'TrueNAS host did not respond within 10s — check host URL and API key'
          : `TrueNAS unreachable: ${e.message}`
      return { success: false, error: msg, latencyMs: Date.now() - started }
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
