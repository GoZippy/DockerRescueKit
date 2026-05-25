export type BackupType = 'full' | 'incremental' | 'snapshot' | 'commit'
export type StorageType = 'local' | 'smb' | 'nfs' | 's3' | 'gdrive' | 'onedrive' | 'proxmox' | 'sftp'
export type RetentionUnit = 'days' | 'weeks' | 'months' | 'count'
export type BackupStatus = 'pending' | 'running' | 'success' | 'failed' | 'partial'
export type BackupTarget = 'container' | 'volume' | 'image' | 'network'

export interface BackupPolicy {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly enabled: boolean
  readonly targets: readonly BackupPolicyTarget[]
  readonly schedule: string // cron expression for the backup itself
  readonly backupType: BackupType
  readonly retention: RetentionPolicy
  readonly storage: StorageConfig
  readonly hooks?: BackupHooks
  readonly notifications?: NotificationConfig[]
  /** Optional cron expression that triggers a periodic verify of the latest
   *  successful backup. If set, the scheduler fires VerifyService against
   *  the latest successful backup for this policy on that cadence. */
  readonly verifySchedule?: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface VerifyRecord {
  readonly id: string
  readonly backupId: string
  readonly policyId: string
  readonly ok: boolean
  readonly startedAt: Date
  readonly finishedAt: Date
  readonly durationMs: number
  readonly steps: Array<{ label: string; ok: boolean; detail?: string }>
}

export interface BackupPolicyTarget {
  readonly type: BackupTarget
  readonly selector: string // container name, volume name, image id, etc
}

export interface RetentionPolicy {
  readonly strategy: 'count' | 'time' | 'tiered'
  
  // For 'count' strategy
  readonly count?: number
  
  // For 'time' strategy
  readonly days?: number
  readonly weeks?: number
  readonly months?: number
  
  // For 'tiered' strategy (daily -> weekly -> monthly -> yearly)
  readonly tiers?: BackupTier[]
}

export interface BackupTier {
  readonly tag: string // 'daily', 'weekly', 'monthly', 'yearly'
  readonly maxCount?: number
  readonly maxAge?: number // days
}

export interface StorageConfig {
  readonly id: string
  readonly type: StorageType
  readonly path?: string // for local storage
  readonly host?: string
  readonly port?: number
  readonly username?: string
  readonly credentialsId?: string // reference to encrypted vault
  readonly bucket?: string // for S3
  readonly region?: string // for S3
  readonly folder?: string // for cloud storage
  /** When set, the policy runtime resolves the matching connector instance
   *  and merges its decrypted config into this StorageConfig at run time.
   *  Lets users avoid duplicating credentials across policies. */
  readonly connectorId?: string
  /** Free-form extra config fields passed straight to the adapter. Makes the
   *  shared type surface match what the Restic-backed adapters read. */
  readonly [key: string]: any
}

export interface BackupHooks {
  readonly pre?: string[] // scripts to run before backup
  readonly post?: string[] // scripts to run after backup
  /** Typed DB exporters. Run during the 'pre' phase. */
  readonly databases?: DatabaseExporter[]
}

export type DatabaseExporter =
  | { kind: 'postgres'; container: string; user?: string; db?: string; outPath?: string }
  | { kind: 'mysql'; container: string; user?: string; password?: string; db?: string; outPath?: string }
  | { kind: 'redis'; container: string }
  | { kind: 'mongodb'; container: string; outPath?: string }
  | { kind: 'sqlite'; container: string; dbPath: string; outPath?: string }
  | {
      kind: 'influxdb'
      container: string
      version: 'v1' | 'v2'
      /** v2 only — auth token; v1 ignores this. Read from $INFLUX_TOKEN
       *  inside the container if omitted. */
      token?: string
      /** v2 only — organization name. */
      org?: string
      /** v2 only — single bucket to back up. Backs up all buckets if omitted. */
      bucket?: string
      /** v1 only — single database to back up. Backs up all DBs if omitted. */
      db?: string
      /** Output directory inside the container. Defaults to /var/backups/drk-influxdb. */
      outPath?: string
    }
  | {
      kind: 'mssql'
      container: string
      /** Required — MSSQL has no "all databases" BACKUP statement. */
      db: string
      /** Server name; defaults to '.' (local). Use '.\\SQLEXPRESS' for
       *  named instances. */
      server?: string
      /** 'windows' uses -E (trusted connection, default). 'sql' uses -U/-P. */
      authMode?: 'windows' | 'sql'
      /** Required when authMode='sql'. */
      user?: string
      /** Required when authMode='sql'. */
      password?: string
      /** Output file path inside the container. Defaults to /var/backups/drk-mssql.bak. */
      outPath?: string
    }

export interface NotificationConfig {
  readonly type: 'slack' | 'email' | 'webhook' | 'ntfy'
  readonly events: ('success' | 'failure' | 'completion')[]
  readonly config: Record<string, any> // type-specific config
}

export interface Backup {
  readonly id: string
  readonly policyId: string
  readonly timestamp: Date
  readonly type: BackupType
  readonly status: BackupStatus
  readonly size: number
  readonly checksum?: string
  readonly targets: BackupPolicyTarget[]
  readonly error?: string
  readonly duration: number // milliseconds
  readonly tags?: string[] // e.g., ['daily', 'monday']
}

export interface RestoreOptions {
  readonly policyId: string
  readonly backupId?: string // latest if omitted
  readonly timestamp?: Date
  readonly dryRun?: boolean
  readonly partial?: {
    containers?: string[]
    volumes?: string[]
    images?: string[]
  }
}

export interface RestoreResult {
  readonly status: 'success' | 'partial' | 'failed'
  readonly restored: {
    containers: string[]
    volumes: string[]
    images: string[]
  }
  readonly failed?: {
    containers?: string[]
    volumes?: string[]
    images?: string[]
  }
  readonly error?: string
}

export type ConnectorType = 'proxmox' | 'truenas' | 's3' | 'smb' | 'nfs' | 'sftp' | 'rclone'
export type ConnectorStatus = 'online' | 'offline' | 'error' | 'untested'

export interface ConnectorField {
  name: string
  label: string
  type: 'text' | 'password' | 'number' | 'boolean'
  required: boolean
  default?: any
  placeholder?: string
  description?: string
}

export interface ConnectorDefinition {
  type: ConnectorType
  displayName: string
  description: string
  icon: string
  fields: ConnectorField[]
}

export interface ConnectorInstance {
  id: string
  type: ConnectorType
  name: string
  config: Record<string, any> // The actual values for the fields
  status: ConnectorStatus
  lastTested?: Date
  error?: string
  createdAt: Date
  updatedAt: Date
}

export interface ConnectorResource {
  id: string
  connectorId: string
  name: string
  type: string // e.g., 'zfs-dataset', 's3-bucket', 'pve-storage'
  path?: string
  size?: number
  available?: number
  metadata?: Record<string, any>
}
