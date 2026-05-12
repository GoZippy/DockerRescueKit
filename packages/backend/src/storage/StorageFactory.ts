import { StorageAdapter, StorageConfig } from './StorageAdapter'
import { LocalStorageAdapter } from './adapters/LocalStorageAdapter'
import { ResticStorageAdapter } from './adapters/ResticStorageAdapter'
import { S3StorageAdapter } from './adapters/S3StorageAdapter'
import { SFTPStorageAdapter } from './adapters/SFTPStorageAdapter'
import { RcloneStorageAdapter } from './adapters/RcloneStorageAdapter'
import { SMBStorageAdapter } from './adapters/SMBStorageAdapter'
import { PBSStorageAdapter } from './adapters/PBSStorageAdapter'

type AdapterFactory = (config: StorageConfig) => StorageAdapter

export class StorageFactory {
  private static adapters = new Map<string, AdapterFactory>()

  static {
    StorageFactory.register('local',    cfg => new LocalStorageAdapter(cfg))
    StorageFactory.register('restic',   cfg => new ResticStorageAdapter(cfg))
    StorageFactory.register('s3',       cfg => new S3StorageAdapter(cfg))
    StorageFactory.register('b2',       cfg => new S3StorageAdapter(cfg))
    StorageFactory.register('sftp',     cfg => new SFTPStorageAdapter(cfg))
    StorageFactory.register('rclone',   cfg => new RcloneStorageAdapter(cfg))
    StorageFactory.register('gdrive',   cfg => new RcloneStorageAdapter(cfg))
    StorageFactory.register('onedrive', cfg => new RcloneStorageAdapter(cfg))
    StorageFactory.register('dropbox',  cfg => new RcloneStorageAdapter(cfg))
    StorageFactory.register('webdav',   cfg => new RcloneStorageAdapter(cfg))
    StorageFactory.register('smb',                    cfg => new SMBStorageAdapter(cfg))
    StorageFactory.register('cifs',                   cfg => new SMBStorageAdapter(cfg))
    StorageFactory.register('proxmox-backup-server',  cfg => new PBSStorageAdapter(cfg))
    StorageFactory.register('pbs',                    cfg => new PBSStorageAdapter(cfg))
  }

  public static register(type: string, factory: AdapterFactory): void {
    StorageFactory.adapters.set(type.toLowerCase(), factory)
  }

  public static create(type: string, config: StorageConfig): StorageAdapter {
    const factory = StorageFactory.adapters.get(type.toLowerCase())
    if (!factory) throw new Error(`Unknown storage type: ${type}`)
    return factory(config)
  }

  public static getAvailableTypes(): string[] {
    return Array.from(StorageFactory.adapters.keys())
  }
}
