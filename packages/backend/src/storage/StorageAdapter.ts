/**
 * Abstract base class for all storage adapters
 * Implementations: Local, CIFS, NFS, Proxmox, S3, GDrive, OneDrive, etc.
 */
export abstract class StorageAdapter {
  abstract readonly type: string
  abstract readonly supportsIncremental: boolean

  /**
   * Upload a file or directory to storage
   */
  abstract upload(localPath: string, remotePath: string): Promise<void>

  /**
   * Download a file or directory from storage
   */
  abstract download(remotePath: string, localPath: string): Promise<void>

  /**
   * List backups in storage
   */
  abstract list(path: string): Promise<BackupMetadata[]>

  /**
   * Delete a backup from storage
   */
  abstract delete(remotePath: string): Promise<void>

  /**
   * Optionally delete everything under a given prefix/directory.
   * Default implementation falls back to a no-op so adapters can override.
   */
  async deletePrefix(prefix: string): Promise<void> {
    throw new Error(`deletePrefix not implemented for ${this.type} (prefix=${prefix})`)
  }

  /**
   * Test connectivity to storage
   */
  abstract test(): Promise<void>

  /**
   * Get storage info (capacity, used, available)
   */
  abstract getInfo(): Promise<StorageInfo>
}

export interface BackupMetadata {
  id: string
  path: string
  timestamp: Date
  size: number
  checksum?: string
  type: 'full' | 'incremental' | 'snapshot'
  tags?: string[]
}

export interface StorageInfo {
  total: number
  used: number
  available: number
  type: string
}

export interface StorageConfig {
  type: string
  [key: string]: any
}
