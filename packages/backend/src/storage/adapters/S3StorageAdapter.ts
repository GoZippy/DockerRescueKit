import { ResticStorageAdapter } from './ResticStorageAdapter'
import { ResticRepoConfig } from '../engines/ResticEngine'
import { StorageConfig } from '../StorageAdapter'

/**
 * S3-compatible storage (AWS S3, Backblaze B2 via S3 API, Wasabi, MinIO).
 * Expects `config.bucket`, `config.endpoint` (optional), `config.accessKey`,
 * `config.secretKey`, `config.password`, and optionally `config.region`.
 */
export class S3StorageAdapter extends ResticStorageAdapter {
  constructor(config: StorageConfig) {
    super(config, 's3')
  }

  protected resolveRepoConfig(config: StorageConfig): ResticRepoConfig {
    if (!config.bucket) throw new Error('S3 adapter requires config.bucket')
    if (!config.password) throw new Error('S3 adapter requires config.password (repo encryption)')

    // restic expects s3:<endpoint>/<bucket>/<prefix?>
    const endpoint = config.endpoint || 's3.amazonaws.com'
    const prefix = config.prefix ? `/${config.prefix.replace(/^\//, '')}` : ''
    const repo = `s3:${endpoint}/${config.bucket}${prefix}`

    return {
      repo,
      password: config.password,
      env: {
        ...(config.accessKey ? { AWS_ACCESS_KEY_ID: config.accessKey } : {}),
        ...(config.secretKey ? { AWS_SECRET_ACCESS_KEY: config.secretKey } : {}),
        ...(config.region ? { AWS_DEFAULT_REGION: config.region } : {})
      }
    }
  }
}
