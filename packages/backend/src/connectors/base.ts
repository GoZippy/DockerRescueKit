import { ConnectorDefinition, ConnectorType, ConnectorInstance, ConnectorResource, ConnectorTestResult } from '@docker-rescue-kit/shared'

export interface IConnectorPlugin {
  readonly definition: ConnectorDefinition

  /**
   * Validates configuration and checks that the remote system is reachable
   * and authenticated. Returns a structured result so callers can surface
   * the error reason without a side-channel.
   *
   * F2 / v1.3-connectors: contract changed from `Promise<boolean>`.
   * Implementations should return `{ success: true, latencyMs?, serverInfo? }`
   * or `{ success: false, error: 'reason' }`. May still throw on truly
   * unexpected errors — ConnectorManager catches and wraps as
   * `{ success: false, error: e.message }`.
   */
  testConnection(config: Record<string, any>): Promise<ConnectorTestResult>

  /**
   * Enumerate candidate backup destinations BEFORE the user has committed
   * to a specific bucket/path/dataset. Called by AddConnectorWizard between
   * "Test Connection success" and "Save".
   *
   * Returns [] if the connector does not support pre-config enumeration.
   * UI must degrade gracefully — skip the discovery step.
   *
   * Implementations (per DR-001):
   *   - S3: ListBuckets (when no bucket) OR ListObjectsV2 delimiter='/' (D1)
   *   - SFTP: readdir(config.path) (D2)
   *   - Rclone: rclone lsjson (D3)
   *   - Proxmox: storage pools per node (existing)
   *   - TrueNAS: ZFS datasets (existing)
   *   - PBS: datastores via /api2/json/admin/datastore
   *   - SMB: deferred to v1.4 (needs mount privilege at discovery time)
   */
  discoverDestinations?(config: Record<string, any>): Promise<ConnectorResource[]>

  /**
   * Enumerate what is currently stored in this connector AFTER it is fully
   * configured. Used by future restore-browser + drift dashboard.
   *
   * Returns [] if the connector has no listable contents.
   *
   * Implementations (per DR-001):
   *   - PBS: existing snapshots via PBSStorageAdapter.list()
   *   - S3/SFTP/Rclone (restic-backed): restic snapshots via adapter.list()
   *   - Proxmox/TrueNAS: not applicable (returns [])
   */
  listContents?(config: Record<string, any>): Promise<ConnectorResource[]>

  /**
   * @deprecated Use {@link discoverDestinations} or {@link listContents} instead.
   * Kept for one release (v1.3) to avoid breaking external consumers of
   * /api/connectors/discover. Default behavior in the route layer forwards
   * to discoverDestinations() when present, else listContents(), else [].
   *
   * Will be removed in v1.4. Optional so migrated connectors (D1/D2/D3) can
   * drop it once they implement discoverDestinations()/listContents().
   */
  discoverResources?(config: Record<string, any>): Promise<ConnectorResource[]>
}

/**
 * Route-layer helper that picks the right discovery method based on the
 * client's requested mode. Connectors that haven't migrated yet still get
 * their legacy `discoverResources()` called.
 *
 * See DR-001 for the decision rationale.
 */
export async function resolveDiscovery(
  plugin: IConnectorPlugin,
  config: Record<string, any>,
  mode: 'destinations' | 'contents' = 'destinations'
): Promise<ConnectorResource[]> {
  if (mode === 'destinations' && plugin.discoverDestinations) {
    return plugin.discoverDestinations(config)
  }
  if (mode === 'contents' && plugin.listContents) {
    return plugin.listContents(config)
  }
  // Fallback to deprecated unified method (preserves existing behavior).
  // Optional now — a migrated connector may have dropped it.
  if (plugin.discoverResources) {
    return plugin.discoverResources(config)
  }
  return []
}
