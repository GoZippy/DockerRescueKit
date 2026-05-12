import { ResticStorageAdapter } from './ResticStorageAdapter'
import { ResticRepoConfig } from '../engines/ResticEngine'
import { StorageConfig } from '../StorageAdapter'

/**
 * Rclone-backed repo via Restic. This lets DockerRescueKit speak to every
 * provider rclone supports (GDrive, OneDrive, Dropbox, pCloud, Box, Azure,
 * WebDAV, etc.) without writing per-provider adapters.
 *
 * Expects:
 *   config.remote   - rclone remote name as configured in rclone.conf
 *   config.path     - subpath under the remote
 *   config.password - restic repo encryption password
 *   config.rcloneConfig - optional absolute path to rclone.conf, passed via env
 */
export class RcloneStorageAdapter extends ResticStorageAdapter {
  constructor(config: StorageConfig) {
    super(config, 'rclone')
  }

  protected resolveRepoConfig(config: StorageConfig): ResticRepoConfig {
    if (!config.remote) throw new Error('Rclone adapter requires config.remote')
    if (!config.path) throw new Error('Rclone adapter requires config.path')
    if (!config.password) throw new Error('Rclone adapter requires config.password (repo encryption)')

    const cleanPath = config.path.replace(/^\//, '')
    const repo = `rclone:${config.remote}:${cleanPath}`

    return {
      repo,
      password: config.password,
      env: {
        ...(config.rcloneConfig ? { RCLONE_CONFIG: config.rcloneConfig } : {})
      }
    }
  }
}
