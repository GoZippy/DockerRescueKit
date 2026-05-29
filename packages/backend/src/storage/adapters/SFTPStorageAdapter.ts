import { ResticStorageAdapter } from './ResticStorageAdapter'
import { ResticRepoConfig } from '../engines/ResticEngine'
import { StorageConfig } from '../StorageAdapter'

/**
 * SFTP-backed repo via Restic. Expects `config.host`, `config.username`,
 * `config.path`, `config.password` (repo encryption), and optionally
 * `config.port`. SSH auth is managed by the host via an ssh-agent or an
 * ~/.ssh/config entry — we don't ship private keys through the service.
 */
export class SFTPStorageAdapter extends ResticStorageAdapter {
  constructor(config: StorageConfig) {
    super(config, 'sftp')
  }

  protected resolveRepoConfig(config: StorageConfig): ResticRepoConfig {
    if (!config.host) throw new Error('SFTP adapter requires config.host')
    if (!config.username) throw new Error('SFTP adapter requires config.username')
    if (!config.path) throw new Error('SFTP adapter requires config.path')
    if (!config.password) throw new Error('SFTP adapter requires config.password (repo encryption)')

    const user = config.username
    const host = config.host
    const remotePath = config.path.startsWith('/') ? config.path : `/${config.path}`
    // Restic's `sftp:` short form does NOT accept an inline port — anything
    // after the host colon is parsed as the path. So we keep the repo host
    // clean and, for a non-default port, override the SSH connect command
    // (restic's documented mechanism for custom SFTP ports).
    const repo = `sftp:${user}@${host}:${remotePath}`

    const cfg: ResticRepoConfig = { repo, password: config.password }
    const port = config.port ? String(config.port) : ''
    if (port && port !== '22') {
      cfg.options = { 'sftp.command': `ssh ${user}@${host} -p ${port} -s sftp` }
    }
    return cfg
  }
}
