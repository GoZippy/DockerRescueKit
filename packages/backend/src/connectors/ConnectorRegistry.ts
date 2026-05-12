import { IConnectorPlugin } from './base'
import { ConnectorType } from '@docker-rescue-kit/shared'

export class ConnectorRegistry {
  private static plugins = new Map<ConnectorType, IConnectorPlugin>()

  public static register(plugin: IConnectorPlugin) {
    this.plugins.set(plugin.definition.type, plugin)
  }

  public static getPlugin(type: ConnectorType): IConnectorPlugin | undefined {
    return this.plugins.get(type)
  }

  public static getAllDefinitions() {
    return Array.from(this.plugins.values()).map(p => p.definition)
  }
}
