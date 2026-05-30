import { IConnectorPlugin } from './base'
import { ConnectorDefinition, ConnectorResource, ConnectorTestResult } from '@docker-rescue-kit/shared'
import { SFTPStorageAdapter } from '../storage/adapters/SFTPStorageAdapter'
import { Client as SSH2Client } from 'ssh2'
import fs from 'fs'

export class SFTPConnector implements IConnectorPlugin {
  public readonly definition: ConnectorDefinition = {
    type: 'sftp',
    displayName: 'SFTP server',
    description: 'Any SSH/SFTP server. Uses restic; SSH keys resolved via ssh-agent or ~/.ssh/config on the host.',
    icon: 'server',
    fields: [
      { name: 'host', label: 'Hostname', type: 'text', required: true, placeholder: 'backup.example.com' },
      { name: 'port', label: 'Port', type: 'number', required: false, default: 22 },
      { name: 'username', label: 'Username', type: 'text', required: true },
      { name: 'path', label: 'Remote path', type: 'text', required: true, placeholder: '/srv/backups/drk' },
      { name: 'password', label: 'Repository encryption password', type: 'password', required: true }
    ]
  }

  public async testConnection(config: Record<string, any>): Promise<ConnectorTestResult> {
    const started = Date.now()
    try {
      const adapter = new SFTPStorageAdapter({ type: 'sftp', ...config })
      await adapter.test()
      return { success: true, latencyMs: Date.now() - started }
    } catch (err: any) {
      return {
        success: false,
        error: `SFTP repository unreachable: ${err?.message ?? String(err)}`,
        latencyMs: Date.now() - started
      }
    }
  }

  /**
   * D2 (DR-001): list directory entries under config.path on the remote SFTP
   * server. The user has typically given us the parent directory; discovery
   * surfaces the immediate children so the UI picker can pick a subdir as
   * the actual restic repo path.
   *
   * Auth: prefers explicit `privateKeyPath` from config, falls back to
   * SFTP password (note: not the restic encryption password — separate field
   * the existing form doesn't expose yet; we accept either `sshPassword` or
   * the password field for back-compat).
   */
  public async discoverDestinations(config: Record<string, any>): Promise<ConnectorResource[]> {
    if (!config.host) throw new Error('SFTP discovery requires config.host')
    if (!config.username) throw new Error('SFTP discovery requires config.username')
    if (!config.path) throw new Error('SFTP discovery requires config.path')

    const conn = new SSH2Client()

    const connectOpts: any = {
      host: config.host,
      port: Number(config.port) || 22,
      username: config.username,
      readyTimeout: 15_000,
    }

    if (config.privateKeyPath) {
      try {
        connectOpts.privateKey = await fs.promises.readFile(config.privateKeyPath)
      } catch (err: any) {
        throw new Error(`Cannot read SSH private key at ${config.privateKeyPath}: ${err.message}`)
      }
    } else if (config.sshPassword) {
      connectOpts.password = config.sshPassword
    }
    // If neither key nor sshPassword set, ssh2 falls back to ssh-agent.

    try {
      const entries = await new Promise<any[]>((resolve, reject) => {
        const totalTimer = setTimeout(() => {
          conn.end()
          reject(new Error('SFTP discovery timed out after 30s'))
        }, 30_000)

        conn.on('ready', () => {
          conn.sftp((err, sftp) => {
            if (err) { clearTimeout(totalTimer); conn.end(); return reject(err) }
            sftp.readdir(config.path, (rerr, list) => {
              clearTimeout(totalTimer)
              conn.end()
              if (rerr) return reject(rerr)
              resolve(list ?? [])
            })
          })
        })
        conn.on('error', (err) => {
          clearTimeout(totalTimer)
          reject(err)
        })
        conn.connect(connectOpts)
      })

      const basePath = config.path.replace(/\/$/, '')
      return entries.map((e: any) => ({
        id: `sftp-${config.host}-${e.filename}`,
        connectorId: '',
        name: e.filename,
        type: 'sftp-dir',
        path: `${basePath}/${e.filename}`,
        size: e.attrs?.size,
        metadata: {
          host: config.host,
          mode: e.attrs?.mode,
          mtime: e.attrs?.mtime,
        }
      }))
    } catch (err: any) {
      throw new Error(`SFTP discovery failed: ${err?.message ?? String(err)}`)
    }
  }

  /** @deprecated Forwarded to discoverDestinations for route-layer back-compat. */
  public async discoverResources(config: Record<string, any>): Promise<ConnectorResource[]> {
    return this.discoverDestinations(config)
  }
}
