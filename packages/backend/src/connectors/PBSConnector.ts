import { IConnectorPlugin } from './base'
import { ConnectorDefinition, ConnectorResource, ConnectorTestResult } from '@docker-rescue-kit/shared'
import { PBSStorageAdapter } from '../storage/adapters/PBSStorageAdapter'

export class PBSConnector implements IConnectorPlugin {
  public readonly definition: ConnectorDefinition = {
    type: 'pbs',
    displayName: 'Proxmox Backup Server',
    description: 'Direct PBS datastore integration via proxmox-backup-client. Provides dedup, compression, and native PBS snapshots. Requires proxmox-backup-client on the host.',
    icon: 'server',
    fields: [
      {
        name: 'repo',
        label: 'Repository URL',
        type: 'text',
        required: true,
        placeholder: 'backup@pam@192.168.1.50:8007:docker-backups',
        description: 'Format: user@realm@host:port:datastore'
      },
      { name: 'password', label: 'PBS Password', type: 'password', required: true },
      {
        name: 'fingerprint',
        label: 'TLS Fingerprint',
        type: 'text',
        required: false,
        placeholder: 'AB:CD:EF:...',
        description: 'SHA-256 fingerprint of the PBS TLS certificate. Required if using a self-signed cert.'
      },
      {
        name: 'pbsBin',
        label: 'Binary path (optional)',
        type: 'text',
        required: false,
        placeholder: '/usr/bin/proxmox-backup-client',
        description: 'Full path to proxmox-backup-client if not on PATH.'
      }
    ]
  }

  public async testConnection(config: Record<string, any>): Promise<ConnectorTestResult> {
    const started = Date.now()
    try {
      const adapter = new PBSStorageAdapter({ type: 'proxmox-backup-server', ...config })
      await adapter.test()
      return { success: true, latencyMs: Date.now() - started }
    } catch (err: any) {
      return {
        success: false,
        error: `PBS unreachable: ${err?.message ?? String(err)}`,
        latencyMs: Date.now() - started
      }
    }
  }

  /**
   * Per DR-001: PBS *contents* are existing snapshots in the datastore.
   * There is no separate "destinations" enumeration — the datastore is
   * already encoded in the repo URL (the user types it in the form), and
   * proxmox-backup-client provides no API to list peer datastores from a
   * single credential.
   *
   * The wizard skips the discovery step for PBS because discoverDestinations()
   * is intentionally not implemented. listContents() is exposed for the
   * future restore-browser / drift dashboard.
   */
  public async listContents(config: Record<string, any>): Promise<ConnectorResource[]> {
    try {
      const adapter = new PBSStorageAdapter({ type: 'proxmox-backup-server', ...config })
      const snapshots = await adapter.list()
      return snapshots.map(s => ({
        id: s.id,
        connectorId: '',
        name: s.id,
        type: 'pbs-snapshot',
        path: s.path,
        size: s.size,
        available: 0,
      }))
    } catch {
      return []
    }
  }
}
