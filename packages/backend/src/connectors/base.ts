import { ConnectorDefinition, ConnectorType, ConnectorInstance, ConnectorResource } from '@docker-rescue-kit/shared'

export interface IConnectorPlugin {
  readonly definition: ConnectorDefinition
  
  /**
   * Validates the configuration and checks if the remote system is reachable and authenticated.
   */
  testConnection(config: Record<string, any>): Promise<boolean>
  
  /**
   * Discovers available resources on the remote system (e.g., ZFS datasets, S3 buckets).
   */
  discoverResources(config: Record<string, any>): Promise<ConnectorResource[]>
}
