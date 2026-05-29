import { Database } from '../db/Database'
import { VaultService } from './VaultService'
import { ConnectorInstance, ConnectorResource } from '@docker-rescue-kit/shared'
import { ConnectorRegistry } from '../connectors/ConnectorRegistry'
import { resolveDiscovery } from '../connectors/base'
import { SsrfGuard, SsrfBlockedError } from '../security/SsrfGuard'

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
      await this.guardTarget(config)
      const success = await plugin.testConnection(config)
      return { success }
    } catch (e: any) {
      if (e instanceof SsrfBlockedError) {
        return { success: false, error: `${e.message}. If this is an intentional internal target, add its CIDR to DRK_SSRF_ALLOWLIST.` }
      }
      return { success: false, error: e.message }
    }
  }

  public async discoverResources(
    type: string,
    config: any,
    mode: 'destinations' | 'contents' = 'destinations'
  ): Promise<ConnectorResource[]> {
    const plugin = ConnectorRegistry.getPlugin(type as any)
    if (!plugin) throw new Error('Connector type not supported')
    await this.guardTarget(config)
    // Route through the DR-001 resolver so migrated connectors' new
    // discoverDestinations()/listContents() are actually reached.
    return await resolveDiscovery(plugin, config, mode)
  }

  /**
   * F1: gate the connector's network target through the SSRF guard before any
   * server-side request. Uses `config.endpoint` (S3) or `config.host`
   * (Proxmox/TrueNAS/PBS/SMB/SFTP); connectors without one (rclone, local) are
   * skipped. Default posture blocks only cloud metadata — see SsrfGuard.
   */
  private async guardTarget(config: any): Promise<void> {
    const target = config?.endpoint || config?.host
    if (target) await SsrfGuard.assertSafe(String(target))
  }

  private encryptConfig(config: any): any {
    return this.vault.encryptRecursive(config)
  }

  private decryptConfig(config: any): any {
    return this.vault.decryptRecursive(config)
  }
}
