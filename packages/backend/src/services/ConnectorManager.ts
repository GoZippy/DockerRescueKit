import { Database } from '../db/Database'
import { VaultService } from './VaultService'
import { ConnectorInstance } from '@docker-rescue-kit/shared'
import { ConnectorRegistry } from '../connectors/ConnectorRegistry'

export class ConnectorManager {
  private vault: VaultService

  constructor(private db: Database) {
    this.vault = new VaultService(db)
  }

  public async listInstances(): Promise<ConnectorInstance[]> {
    const raw = await this.db.getConnectors()
    return raw.map(inst => ({
      ...inst,
      config: this.decryptConfig(inst.config)
    }))
  }

  public async getInstance(id: string): Promise<ConnectorInstance | null> {
    const raw = await this.db.getConnector(id)
    if (!raw) return null
    return {
      ...raw,
      config: this.decryptConfig(raw.config)
    }
  }

  public async saveInstance(instance: Omit<ConnectorInstance, 'createdAt' | 'updatedAt'>): Promise<void> {
    const encryptedConfig = this.encryptConfig(instance.config)
    await this.db.saveConnector({
      ...instance,
      config: encryptedConfig
    })
  }

  public async deleteInstance(id: string): Promise<void> {
    await this.db.deleteConnector(id)
  }

  public async testInstance(type: string, config: any): Promise<{ success: boolean; error?: string }> {
    const plugin = ConnectorRegistry.getPlugin(type as any)
    if (!plugin) return { success: false, error: 'Connector type not supported' }

    try {
      const success = await plugin.testConnection(config)
      return { success }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  public async discoverResources(type: string, config: any): Promise<any[]> {
    const plugin = ConnectorRegistry.getPlugin(type as any)
    if (!plugin) throw new Error('Connector type not supported')
    return await plugin.discoverResources(config)
  }

  private encryptConfig(config: any): any {
    return this.vault.encryptRecursive(config)
  }

  private decryptConfig(config: any): any {
    return this.vault.decryptRecursive(config)
  }
}
