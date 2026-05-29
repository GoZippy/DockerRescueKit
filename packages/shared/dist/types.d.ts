export type BackupType = 'full' | 'incremental' | 'snapshot' | 'commit';
export type StorageType = 'local' | 'smb' | 'nfs' | 's3' | 'gdrive' | 'onedrive' | 'proxmox' | 'sftp';
export type RetentionUnit = 'days' | 'weeks' | 'months' | 'count';
export type BackupStatus = 'pending' | 'running' | 'success' | 'failed' | 'partial';
export type BackupTarget = 'container' | 'volume' | 'image' | 'network';
export interface BackupPolicy {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly enabled: boolean;
    readonly targets: readonly BackupPolicyTarget[];
    readonly schedule: string;
    readonly backupType: BackupType;
    readonly retention: RetentionPolicy;
    readonly storage: StorageConfig;
    readonly hooks?: BackupHooks;
    readonly notifications?: NotificationConfig[];
    /** Optional cron expression that triggers a periodic verify of the latest
     *  successful backup. If set, the scheduler fires VerifyService against
     *  the latest successful backup for this policy on that cadence. */
    readonly verifySchedule?: string;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}
export interface VerifyRecord {
    readonly id: string;
    readonly backupId: string;
    readonly policyId: string;
    readonly ok: boolean;
    readonly startedAt: Date;
    readonly finishedAt: Date;
    readonly durationMs: number;
    readonly steps: Array<{
        label: string;
        ok: boolean;
        detail?: string;
    }>;
}
export interface BackupPolicyTarget {
    readonly type: BackupTarget;
    readonly selector: string;
}
export interface RetentionPolicy {
    readonly strategy: 'count' | 'time' | 'tiered';
    readonly count?: number;
    readonly days?: number;
    readonly weeks?: number;
    readonly months?: number;
    readonly tiers?: BackupTier[];
}
export interface BackupTier {
    readonly tag: string;
    readonly maxCount?: number;
    readonly maxAge?: number;
}
export interface StorageConfig {
    readonly id: string;
    readonly type: StorageType;
    readonly path?: string;
    readonly host?: string;
    readonly port?: number;
    readonly username?: string;
    readonly credentialsId?: string;
    readonly bucket?: string;
    readonly region?: string;
    readonly folder?: string;
    /** When set, the policy runtime resolves the matching connector instance
     *  and merges its decrypted config into this StorageConfig at run time.
     *  Lets users avoid duplicating credentials across policies. */
    readonly connectorId?: string;
    /** Free-form extra config fields passed straight to the adapter. Makes the
     *  shared type surface match what the Restic-backed adapters read. */
    readonly [key: string]: any;
}
export interface BackupHooks {
    readonly pre?: string[];
    readonly post?: string[];
    /** Typed DB exporters. Run during the 'pre' phase. */
    readonly databases?: DatabaseExporter[];
}
export type DatabaseExporter = {
    kind: 'postgres';
    container: string;
    user?: string;
    db?: string;
    outPath?: string;
} | {
    kind: 'mysql';
    container: string;
    user?: string;
    password?: string;
    db?: string;
    outPath?: string;
} | {
    kind: 'redis';
    container: string;
} | {
    kind: 'mongodb';
    container: string;
    outPath?: string;
} | {
    kind: 'sqlite';
    container: string;
    dbPath: string;
    outPath?: string;
} | {
    kind: 'influxdb';
    container: string;
    version: 'v1' | 'v2';
    /** v2 only — auth token; v1 ignores this. Read from $INFLUX_TOKEN
     *  inside the container if omitted. */
    token?: string;
    /** v2 only — organization name. */
    org?: string;
    /** v2 only — single bucket to back up. Backs up all buckets if omitted. */
    bucket?: string;
    /** v1 only — single database to back up. Backs up all DBs if omitted. */
    db?: string;
    /** Output directory inside the container. Defaults to /var/backups/drk-influxdb. */
    outPath?: string;
} | {
    kind: 'mssql';
    container: string;
    /** Required — MSSQL has no "all databases" BACKUP statement. */
    db: string;
    /** Server name; defaults to '.' (local). Use '.\\SQLEXPRESS' for
     *  named instances. */
    server?: string;
    /** 'windows' uses -E (trusted connection, default). 'sql' uses -U/-P. */
    authMode?: 'windows' | 'sql';
    /** Required when authMode='sql'. */
    user?: string;
    /** Required when authMode='sql'. */
    password?: string;
    /** Output file path inside the container. Defaults to /var/backups/drk-mssql.bak. */
    outPath?: string;
};
export interface NotificationConfig {
    readonly type: 'slack' | 'email' | 'webhook' | 'ntfy';
    readonly events: ('success' | 'failure' | 'completion')[];
    readonly config: Record<string, any>;
}
export type SmokeCheckKind = 'http' | 'exec' | 'tcp' | 'file_exists' | 'sql_select_1';
export type SmokeCheck = {
    kind: 'http';
    /** Logical container name from the policy (used to look up the
     *  stand-in container in the sandbox network). */
    container: string;
    port: number;
    path?: string;
    method?: 'GET' | 'HEAD' | 'POST';
    /** Default 200. Special values 'any_2xx' / 'any_3xx' accept any
     *  status in that band. */
    expectStatus?: number | 'any_2xx' | 'any_3xx';
    bodyContains?: string;
    timeoutMs?: number;
} | {
    kind: 'exec';
    container: string;
    command: string[];
    expectExitCode?: number;
    stdoutContains?: string;
    timeoutMs?: number;
} | {
    kind: 'tcp';
    container: string;
    port: number;
    timeoutMs?: number;
} | {
    kind: 'file_exists';
    container: string;
    path: string;
    minBytes?: number;
} | {
    kind: 'sql_select_1';
    container: string;
    driver: 'postgres' | 'mysql' | 'mssql';
    user?: string;
    /** Name of an env var on the stand-in container that holds the
     *  password. Read via `docker exec` so we never log the value. */
    passwordEnv?: string;
    db?: string;
    timeoutMs?: number;
};
export interface RehearsalRequest {
    /** Resolves to "latest successful backup per target in this policy". */
    policyId?: string;
    /** Explicit set of backup IDs. Mutually exclusive with `policyId`. */
    backupIds?: string[];
    smokeChecks: SmokeCheck[];
    options?: {
        /** Stop running further smoke checks after the first failure. Default: true. */
        stopOnFirstCheckFailure?: boolean;
        /** Subnet to allocate for the sandbox bridge network.
         *  Default: 172.31.255.0/24. Override to avoid host-network collisions. */
        networkSubnet?: string;
        /** Wall-clock cap for the whole rehearsal. Default: 30 minutes. */
        timeoutMs?: number;
        /** Env-var names (case-insensitive) to keep on stand-in containers.
         *  Names matching `SCRUB_ENV_DEFAULT_PATTERNS` are stripped unless
         *  listed here. Use to opt back in to e.g. DATABASE_URL when a smoke
         *  check legitimately requires it. */
        allowEnvVars?: string[];
    };
}
export type RehearsalStatus = 'pending' | 'preparing' | 'restoring' | 'launching' | 'probing' | 'tearing_down' | 'success' | 'failed' | 'aborted';
export interface RehearsalStep {
    readonly label: string;
    readonly ok: boolean;
    readonly detail?: string;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly durationMs: number;
}
export interface SmokeCheckResult {
    readonly check: SmokeCheck;
    readonly ok: boolean;
    readonly detail?: string;
    readonly attempt: number;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly durationMs: number;
}
export interface RehearsalReport {
    readonly id: string;
    readonly policyId?: string;
    readonly requestedBackupIds: string[];
    readonly status: RehearsalStatus;
    /** Shorthand for `status === 'success'`. */
    readonly ok: boolean;
    readonly steps: RehearsalStep[];
    readonly smokeCheckResults: SmokeCheckResult[];
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly durationMs: number;
    readonly resources: {
        network?: string;
        containers: string[];
        volumes: string[];
    };
}
/** Default regex patterns matched against env-var names on the source
 *  container; any matching var is stripped from the stand-in unless the
 *  request lists it in `options.allowEnvVars`. Case-insensitive. */
export declare const SCRUB_ENV_DEFAULT_PATTERNS: readonly RegExp[];
export { SMOKE_CHECK_TEMPLATES } from './smokeCheckTemplates';
export interface Backup {
    readonly id: string;
    readonly policyId: string;
    readonly timestamp: Date;
    readonly type: BackupType;
    readonly status: BackupStatus;
    readonly size: number;
    readonly checksum?: string;
    readonly targets: BackupPolicyTarget[];
    readonly error?: string;
    readonly duration: number;
    readonly tags?: string[];
}
export interface RestoreOptions {
    readonly policyId: string;
    readonly backupId?: string;
    readonly timestamp?: Date;
    readonly dryRun?: boolean;
    readonly partial?: {
        containers?: string[];
        volumes?: string[];
        images?: string[];
    };
}
export interface RestoreResult {
    readonly status: 'success' | 'partial' | 'failed';
    readonly restored: {
        containers: string[];
        volumes: string[];
        images: string[];
    };
    readonly failed?: {
        containers?: string[];
        volumes?: string[];
        images?: string[];
    };
    readonly error?: string;
}
export type ConnectorType = 'proxmox' | 'truenas' | 'pbs' | 's3' | 'smb' | 'nfs' | 'sftp' | 'rclone';
export type ConnectorStatus = 'online' | 'offline' | 'error' | 'untested';
export interface ConnectorField {
    name: string;
    label: string;
    type: 'text' | 'password' | 'number' | 'boolean';
    required: boolean;
    default?: any;
    placeholder?: string;
    description?: string;
}
export interface ConnectorDefinition {
    type: ConnectorType;
    displayName: string;
    description: string;
    icon: string;
    fields: ConnectorField[];
}
export interface ConnectorInstance {
    id: string;
    type: ConnectorType;
    name: string;
    config: Record<string, any>;
    status: ConnectorStatus;
    lastTested?: Date;
    error?: string;
    createdAt: Date;
    updatedAt: Date;
}
export interface ConnectorResource {
    id: string;
    connectorId: string;
    name: string;
    type: string;
    path?: string;
    size?: number;
    available?: number;
    metadata?: Record<string, any>;
}
/**
 * Dashboard health scorecard — 6-category summary for at-a-glance system status.
 *
 * Returned by GET /api/health/dashboard. Categories:
 * 1. Engine status (running/stuck/unhealthy + version)
 * 2. Disk pressure (total, reclaimable, high-risk %)
 * 3. Broken containers (exited, restarting, unhealthy, OOMKilled, permission errors)
 * 4. Network problems (port conflicts, exposed ports, failed DNS)
 * 5. Security warnings (root containers, privileged, CVEs if scanned)
 * 6. Backup posture (volumes without backups, last backup age, failed restores)
 */
export interface DashboardHealthScore {
    engineStatus: 'running' | 'stuck' | 'unhealthy';
    engineVersion: string;
    diskPressure: {
        totalBytes: number;
        reclaimableBytes: number;
        highRiskPercent: number;
    };
    brokenContainers: {
        count: number;
        byReason: {
            exited: number;
            restarting: number;
            unhealthy: number;
            oomkilled: number;
            permerror: number;
        };
    };
    networkProblems: {
        portConflicts: string[];
        exposedPorts: string[];
        failedDns: string[];
    };
    securityWarnings: {
        rootContainers: string[];
        privilegedContainers: string[];
        cveCount: number;
    };
    backupPosture: {
        volumesWithoutBackups: string[];
        lastBackupAgeDays: number | null;
        failedRestoresCount: number;
    };
}
/**
 * Detailed broken-container record for GET /api/health/containers.
 *
 * Returned as an array of broken containers with categorization and reasoning.
 */
export interface BrokenContainer {
    id: string;
    name: string;
    state: 'exited' | 'restarting' | 'unhealthy' | 'oomkilled' | 'permerror';
    reason?: string;
    exitCode?: number;
    lastSeen: string;
}
export type LogEventCategory = 'oomkilled' | 'port_conflict' | 'permission_denied' | 'dns_failed' | 'healthcheck_failed' | 'other';
export type LogEventSeverity = 'error' | 'warning';
/**
 * A single triaged log event with categorization and fix suggestion.
 * Returned by GET /api/logs/triage and GET /api/logs/triage/all.
 */
export interface TriagedEvent {
    readonly id: string;
    readonly containerId: string;
    readonly containerName: string;
    readonly image: string;
    readonly category: LogEventCategory;
    readonly severity: LogEventSeverity;
    readonly fullMessage: string;
    readonly logSnippet: string;
    readonly fixSuggestion: string;
    readonly detectedAt: string;
    readonly exitCode?: number;
}
/**
 * Summary of categorized events from a single container.
 * Response type for GET /api/logs/triage.
 */
export interface LogTriageResponse {
    readonly events: TriagedEvent[];
    readonly fetchedLines: number;
    readonly categories: Record<LogEventCategory, number>;
    readonly responseTimeMs?: number;
}
/**
 * Paginated query response for historical log events.
 * Response type for GET /api/logs/triage/all.
 */
export interface LogTriageHistoryResponse {
    readonly events: TriagedEvent[];
    readonly total: number;
    readonly offset: number;
    readonly limit: number;
    readonly pages?: number;
}
/**
 * VolumeManifestEntry represents a single Docker volume that has been backed up.
 * Created when a restore-rehearsal completes successfully with backup volumes.
 * Used by Safe Cleanup Wizard to determine "which volumes have no backups?".
 */
export interface VolumeManifestEntry {
    readonly id: string;
    readonly volumeName: string;
    readonly backupId: string;
    readonly containerNames?: readonly string[];
    readonly policyId?: string;
    readonly restoreSuccess: boolean;
    readonly timestamp: string;
    readonly rehearsalId?: string;
}
/**
 * Response from GET /api/volumes/manifest — list of backed-up volumes.
 */
export interface VolumesManifestResponse {
    readonly volumes: readonly VolumeManifestEntry[];
    readonly total: number;
    readonly policyId?: string;
}
export type NotificationEventType = 'unhealthy' | 'restart_loop' | 'no_backup' | 'disk_pressure' | 'restore_failed';
/**
 * User notification preferences for N-1 events.
 * Configurable per-event-type: enabled/disabled, frequency, channels, custom thresholds.
 */
export interface NotificationPreferences {
    readonly userId: string;
    readonly unsubscribeToken: string;
    readonly enabled: Record<NotificationEventType, boolean>;
    readonly frequencies: Record<NotificationEventType, 'immediate' | 'daily' | 'weekly'>;
    readonly deliveryChannels: ('webhook' | 'email')[];
    readonly webhookUrl?: string;
    readonly customThresholds?: {
        restartCount?: number;
        diskPercent?: number;
        backupAgeDays?: number;
    };
    readonly createdAt: string;
    readonly updatedAt: string;
}
/**
 * N-1 notification payload sent to webhook/email.
 * Structured envelope for all notification types.
 */
export interface NotificationPayload {
    readonly id: string;
    readonly eventType: NotificationEventType;
    readonly severity: 'warning' | 'critical';
    readonly timestamp: string;
    readonly subject: string;
    readonly message: string;
    readonly actionUrl?: string;
    readonly details: Record<string, any>;
}
/**
 * Log entry for notification delivery tracking and deduplication.
 */
export interface NotificationLogEntry {
    readonly id: string;
    readonly eventType: NotificationEventType;
    readonly resourceId?: string;
    readonly resourceName?: string;
    readonly status: 'pending' | 'sent' | 'failed';
    readonly deliveryChannel: string;
    readonly sentAt?: string;
    readonly acknowledgedAt?: string;
    readonly errorMessage?: string;
    readonly retryCount: number;
    readonly createdAt: string;
}
/**
 * Response from GET /api/volumes/unmanaged — volumes without backups.
 * Used by Safe Cleanup Wizard to display "orphaned" volumes safe for cleanup.
 */
export interface UnmanagedVolumesResponse {
    readonly unmanagedVolumes: readonly string[];
    readonly total: number;
}
