// Re-export real adapter implementations. Historical stub classes have been
// replaced with the Restic-backed implementations.
export { S3StorageAdapter } from './S3StorageAdapter'
export { SFTPStorageAdapter } from './SFTPStorageAdapter'
export { RcloneStorageAdapter } from './RcloneStorageAdapter'
export { SMBStorageAdapter } from './SMBStorageAdapter'
