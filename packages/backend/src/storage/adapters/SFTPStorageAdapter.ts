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
    const portSuffix = config.port ? `:${config.port}` : ''
    const remotePath = config.path.startsWith('/') ? config.path : `/${config.path}`
    const repo = `sftp:${user}@${host}${portSuffix}:${remotePath}`

    return {
      repo,
      password: config.password
    }
  }
}
