import { IConnectorPlugin } from './base'
import { ConnectorResource, ConnectorDefinition } from '@docker-rescue-kit/shared'
import axios from 'axios'
import https from 'https'

export class ProxmoxConnector implements IConnectorPlugin {
  public readonly definition: ConnectorDefinition = {
    type: 'proxmox',
    displayName: 'Proxmox VE',
    description: 'Connect to a Proxmox VE cluster to manage backups for LXC and VMs.',
    icon: 'server',
    fields: [
      { name: 'host', label: 'Proxmox Host/IP', type: 'text', required: true, placeholder: 'https://192.168.1.100:8006' },
      { name: 'tokenId', label: 'API Token ID', type: 'text', required: true, placeholder: 'root@pam!mytoken' },
      { name: 'tokenSecret', label: 'API Token Secret', type: 'password', required: true },
      { name: 'verifySSL', label: 'Verify SSL Certificate', type: 'boolean', required: false, default: false }
    ]
  }

  private getClient(config: Record<string, any>) {
    return axios.create({
      baseURL: `${config.host}/api2/json`,
      headers: {
        'Authorization': `PVEAPIToken=${config.tokenId}=${config.tokenSecret}`
      },
      httpsAgent: new https.Agent({  
        rejectUnauthorized: config.verifySSL ?? false
      })
    })
  }

  public async testConnection(config: Record<string, any>): Promise<boolean> {
    try {
      const client = this.getClient(config)
      const res = await client.get('/version')
      return res.status === 200
    } catch (e) {
      console.error('Proxmox connection failed:', e)
      return false
    }
  }

  public async discoverResources(config: Record<string, any>): Promise<ConnectorResource[]> {
    try {
      const client = this.getClient(config)
      const nodesRes = await client.get('/nodes')
      const resources: ConnectorResource[] = []

      for (const node of nodesRes.data.data) {
        // Get storage on this node
        const storageRes = await client.get(`/nodes/${node.node}/storage`)
        for (const storage of storageRes.data.data) {
          resources.push({
            id: `pve-storage-${node.node}-${storage.storage}`,
            connectorId: '', // Filled by the manager later
            name: `${node.node} / ${storage.storage}`,
            type: 'pve-storage',
            path: storage.storage,
            size: storage.total,
            available: storage.avail,
            metadata: { node: node.node, type: storage.type }
          })
        }
      }
      return resources
    } catch (e) {
      console.error('Proxmox discovery failed:', e)
      throw new Error('Failed to discover Proxmox resources.')
    }
  }
}
