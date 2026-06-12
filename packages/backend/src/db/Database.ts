import DatabaseConstructor, { Database as SQLiteDatabase } from 'better-sqlite3'
import path from 'path'
import fs from 'fs-extra'
import { v4 as uuid } from 'uuid'
import { randomBytes } from 'crypto'
import {
  BackupPolicy,
  StorageConfig,
  Backup,
  BackupStatus,
  GuardEvent
} from '@docker-rescue-kit/shared'
import type { TriagedEvent } from '../services/LogTriageService'

export class Database {
  private db: SQLiteDatabase

  constructor(dbPath: string = 'data/backups.db') {
    if (typeof dbPath !== 'string' || dbPath.length === 0 || dbPath.includes('\0')) {
      throw new Error('Database: invalid dbPath')
    }
    const dir = path.dirname(dbPath)
    if (dir && dir !== '.') fs.ensureDirSync(dir)

    this.db = new DatabaseConstructor(dbPath)
    this.initSchema()
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS policies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        enabled INTEGER DEFAULT 1,
        targets TEXT NOT NULL, -- JSON
        schedule TEXT NOT NULL,
        backupType TEXT NOT NULL,
        retention TEXT NOT NULL, -- JSON
        storage TEXT NOT NULL, -- JSON
        hooks TEXT, -- JSON
        notifications TEXT, -- JSON
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS storage_vault (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        config TEXT NOT NULL, -- JSON (encrypted)
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS backup_history (
        id TEXT PRIMARY KEY,
        policyId TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        size INTEGER DEFAULT 0,
        checksum TEXT,
        targets TEXT NOT NULL, -- JSON
        error TEXT,
        duration INTEGER DEFAULT 0,
        tags TEXT, -- JSON
        FOREIGN KEY(policyId) REFERENCES policies(id)
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        action TEXT NOT NULL,
        details TEXT,
        user TEXT
      );

      CREATE TABLE IF NOT EXISTS connectors (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        config TEXT NOT NULL, -- JSON (encrypted)
        status TEXT DEFAULT 'untested',
        lastTested TEXT,
        error TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS verify_history (
        id TEXT PRIMARY KEY,
        backupId TEXT NOT NULL,
        policyId TEXT NOT NULL,
        ok INTEGER NOT NULL,
        startedAt TEXT NOT NULL,
        finishedAt TEXT NOT NULL,
        durationMs INTEGER NOT NULL,
        steps TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rehearsals (
        id            TEXT PRIMARY KEY,
        policyId      TEXT,
        requestedBackupIds TEXT NOT NULL, -- JSON array
        status        TEXT NOT NULL,
        ok            INTEGER NOT NULL,
        report        TEXT NOT NULL,      -- full RehearsalReport JSON
        startedAt     TEXT NOT NULL,
        finishedAt    TEXT,
        durationMs    INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_rehearsals_policy ON rehearsals(policyId);
      CREATE INDEX IF NOT EXISTS idx_rehearsals_started ON rehearsals(startedAt DESC);

      CREATE TABLE IF NOT EXISTS guard_events (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        trigger     TEXT NOT NULL,
        scope       TEXT NOT NULL,
        event       TEXT NOT NULL,        -- full GuardEvent JSON
        totalBytes  INTEGER NOT NULL,
        status      TEXT NOT NULL,
        pinned      INTEGER NOT NULL DEFAULT 0,
        createdAt   TEXT NOT NULL,
        ttlAt       TEXT NOT NULL,
        restoredAt  TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_guard_created ON guard_events(createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_guard_ttl     ON guard_events(ttlAt);
      CREATE INDEX IF NOT EXISTS idx_guard_status  ON guard_events(status);

      CREATE TABLE IF NOT EXISTS log_events (
        id TEXT PRIMARY KEY,
        containerId TEXT NOT NULL,
        containerName TEXT,
        image TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        category TEXT NOT NULL,
        severity TEXT DEFAULT 'error',
        logSnippet TEXT,
        fullMessage TEXT,
        fixSuggestion TEXT,
        exitCode INTEGER,
        detectedAt TEXT NOT NULL,
        ttl INTEGER DEFAULT 604800
      );

      CREATE INDEX IF NOT EXISTS idx_log_events_container ON log_events(containerId);
      CREATE INDEX IF NOT EXISTS idx_log_events_category ON log_events(category);
      CREATE INDEX IF NOT EXISTS idx_log_events_timestamp ON log_events(timestamp DESC);

      CREATE TABLE IF NOT EXISTS volumes_manifest (
        id TEXT PRIMARY KEY,
        volumeName TEXT NOT NULL UNIQUE,
        backupId TEXT NOT NULL,
        containerNames TEXT,
        policyId TEXT,
        restoreSuccess INTEGER DEFAULT 1,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        rehearsalId TEXT,
        ttl INTEGER DEFAULT 604800,
        FOREIGN KEY(backupId) REFERENCES backup_history(id),
        FOREIGN KEY(policyId) REFERENCES policies(id)
      );

      CREATE INDEX IF NOT EXISTS idx_volumes_manifest_policy ON volumes_manifest(policyId);
      CREATE INDEX IF NOT EXISTS idx_volumes_manifest_timestamp ON volumes_manifest(timestamp DESC);

      CREATE TABLE IF NOT EXISTS notification_preferences (
        userId TEXT PRIMARY KEY,
        unsubscribeToken TEXT UNIQUE,
        unhealthy_enabled INTEGER DEFAULT 1,
        restart_loop_enabled INTEGER DEFAULT 1,
        no_backup_enabled INTEGER DEFAULT 1,
        disk_pressure_enabled INTEGER DEFAULT 1,
        restore_failed_enabled INTEGER DEFAULT 1,
        unhealthy_frequency TEXT DEFAULT 'immediate',
        restart_loop_frequency TEXT DEFAULT 'immediate',
        no_backup_frequency TEXT DEFAULT 'daily',
        disk_pressure_frequency TEXT DEFAULT 'immediate',
        restore_failed_frequency TEXT DEFAULT 'immediate',
        delivery_channels TEXT DEFAULT 'webhook',  -- JSON array: ['webhook', 'email']
        webhook_url TEXT,
        custom_thresholds TEXT,  -- JSON: { restartCount: 5, diskPercent: 70, backupAgeDays: 7 }
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS notification_log (
        id TEXT PRIMARY KEY,
        eventType TEXT NOT NULL,
        resourceId TEXT,
        resourceName TEXT,
        severity TEXT DEFAULT 'warning',
        status TEXT DEFAULT 'pending',
        deliveryChannel TEXT,
        payload TEXT,  -- JSON notification payload
        sentAt DATETIME,
        acknowledgedAt DATETIME,
        errorMessage TEXT,
        retryCount INTEGER DEFAULT 0,
        nextRetryAt DATETIME,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        ttl INTEGER DEFAULT 2592000
      );

      CREATE INDEX IF NOT EXISTS idx_notification_log_event_time ON notification_log(eventType, createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_notification_log_resource ON notification_log(resourceId, eventType);
      CREATE INDEX IF NOT EXISTS idx_notification_log_status ON notification_log(status, nextRetryAt);
    `)

    // Lightweight migration: older databases won't have verifySchedule on
    // policies. Add it opportunistically.
    try {
      this.db.exec(`ALTER TABLE policies ADD COLUMN verifySchedule TEXT`)
    } catch { /* column already exists */ }
  }

  // Policy Operations
  public async getPolicies(): Promise<BackupPolicy[]> {
    const rows = this.db.prepare('SELECT * FROM policies').all() as any[]
    return rows.map(this.parsePolicy)
  }

  public async getPolicy(id: string): Promise<BackupPolicy | null> {
    const row = this.db.prepare('SELECT * FROM policies WHERE id = ?').get(id) as any
    return row ? this.parsePolicy(row) : null
  }

  public async savePolicy(policy: BackupPolicy): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO policies (
        id, name, description, enabled, targets, schedule, backupType,
        retention, storage, hooks, notifications, verifySchedule, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        enabled = excluded.enabled,
        targets = excluded.targets,
        schedule = excluded.schedule,
        backupType = excluded.backupType,
        retention = excluded.retention,
        storage = excluded.storage,
        hooks = excluded.hooks,
        notifications = excluded.notifications,
        verifySchedule = excluded.verifySchedule,
        updatedAt = CURRENT_TIMESTAMP
    `)
    stmt.run(
      policy.id,
      policy.name,
      policy.description || null,
      policy.enabled ? 1 : 0,
      JSON.stringify(policy.targets),
      policy.schedule,
      policy.backupType,
      JSON.stringify(policy.retention),
      JSON.stringify(policy.storage),
      JSON.stringify(policy.hooks || null),
      JSON.stringify(policy.notifications || null),
      policy.verifySchedule || null,
      policy.createdAt ? policy.createdAt.toISOString() : null
    )
  }

  public async deletePolicy(id: string): Promise<void> {
    this.db.prepare('DELETE FROM policies WHERE id = ?').run(id)
  }

  // Vault Operations
  public async getStorage(id: string): Promise<any | null> {
    const row = this.db.prepare('SELECT * FROM storage_vault WHERE id = ?').get(id) as any
    if (!row) return null
    return {
      id: row.id,
      type: row.type,
      config: JSON.parse(row.config)
    }
  }

  public async saveStorage(id: string, type: string, config: any): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO storage_vault (id, type, config) VALUES (?, ?, ?)
    `)
    stmt.run(id, type, JSON.stringify(config))
  }

  /**
   * Snapshot helper: list every row in storage_vault.
   *
   * The existing config-export route used `db.getAllVaults?.()` with optional
   * chaining, which meant the method never actually ran — `storageVaults` in
   * every prior export was an empty array. ExportService (v1.2.5) needs the
   * real data so users can restore vault config after a `docker extension rm`
   * wipes the data volume. Parsing failures on `config` JSON are swallowed
   * per-row so one corrupt vault doesn't poison the whole snapshot.
   */
  public async getAllVaults(): Promise<Array<{ id: string; type: string; config: any }>> {
    const rows = this.db.prepare('SELECT id, type, config FROM storage_vault').all() as any[]
    return rows.map(r => {
      let parsed: any = null
      try { parsed = r.config ? JSON.parse(r.config) : null } catch { parsed = null }
      return { id: r.id, type: r.type, config: parsed }
    })
  }

  // Connector Instance Operations
  public async getConnectors(): Promise<any[]> {
    const rows = this.db.prepare('SELECT * FROM connectors').all() as any[]
    return rows.map(r => ({
      ...r,
      config: JSON.parse(r.config),
      lastTested: r.lastTested ? new Date(r.lastTested) : undefined,
      createdAt: new Date(r.createdAt),
      updatedAt: new Date(r.updatedAt)
    }))
  }

  public async getConnector(id: string): Promise<any | null> {
    const row = this.db.prepare('SELECT * FROM connectors WHERE id = ?').get(id) as any
    if (!row) return null
    return {
      ...row,
      config: JSON.parse(row.config),
      lastTested: row.lastTested ? new Date(row.lastTested) : undefined,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt)
    }
  }

  public async saveConnector(connector: any): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO connectors (
        id, type, name, config, status, lastTested, error, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `)
    stmt.run(
      connector.id,
      connector.type,
      connector.name,
      JSON.stringify(connector.config),
      connector.status || 'untested',
      connector.lastTested ? connector.lastTested.toISOString() : null,
      connector.error || null
    )
  }

  public async deleteConnector(id: string): Promise<void> {
    this.db.prepare('DELETE FROM connectors WHERE id = ?').run(id)
  }

  // Settings / Preferences
  public async saveSetting(key: string, value: string): Promise<void> {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    stmt.run(key, value)
  }

  public async getSetting(key: string): Promise<string | null> {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
    return row ? row.value : null
  }

  /**
   * Snapshot helper: dump every setting row for ExportService / config export.
   *
   * Returns key/value pairs in insertion order (no ORDER BY — sqlite returns
   * them in rowid order which is good enough for diffability). Safe to call
   * during boot; no expensive joins or JSON parsing.
   */
  public async getAllSettings(): Promise<Array<{ key: string; value: string }>> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as any[]
    return rows.map(r => ({ key: r.key, value: r.value }))
  }

  // Backup History
  public async saveBackup(backup: Backup): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO backup_history (
        id, policyId, timestamp, type, status, size, checksum, targets, error, duration, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      backup.id,
      backup.policyId,
      backup.timestamp.toISOString(),
      backup.type,
      backup.status,
      backup.size,
      backup.checksum || null,
      JSON.stringify(backup.targets),
      backup.error || null,
      backup.duration,
      JSON.stringify(backup.tags || [])
    )
  }

  public async getBackupHistory(policyId: string): Promise<Backup[]> {
    const rows = this.db.prepare('SELECT * FROM backup_history WHERE policyId = ? ORDER BY timestamp DESC').all(policyId) as any[]
    return rows.map(r => this.parseBackup(r))
  }

  public async listAllBackups(): Promise<Backup[]> {
    const rows = this.db.prepare('SELECT * FROM backup_history ORDER BY timestamp DESC').all() as any[]
    return rows.map(r => this.parseBackup(r))
  }

  public async getBackup(id: string): Promise<Backup | null> {
    const row = this.db.prepare('SELECT * FROM backup_history WHERE id = ?').get(id) as any
    return row ? this.parseBackup(row) : null
  }

  public async deleteBackup(id: string): Promise<void> {
    this.db.prepare('DELETE FROM backup_history WHERE id = ?').run(id)
  }

  // Verify history
  public async saveVerifyRecord(record: {
    id: string
    backupId: string
    policyId: string
    ok: boolean
    startedAt: Date
    finishedAt: Date
    durationMs: number
    steps: any
  }): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO verify_history (
        id, backupId, policyId, ok, startedAt, finishedAt, durationMs, steps
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      record.id,
      record.backupId,
      record.policyId,
      record.ok ? 1 : 0,
      record.startedAt.toISOString(),
      record.finishedAt.toISOString(),
      record.durationMs,
      JSON.stringify(record.steps || [])
    )
  }

  public async saveAuditEntry(entry: {
    id: string
    timestamp: string
    action: string
    details?: string | null
    user?: string | null
  }): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO audit_logs (id, timestamp, action, details, user)
      VALUES (?, ?, ?, ?, ?)
    `)
    stmt.run(entry.id, entry.timestamp, entry.action, entry.details || null, entry.user || null)
  }

  public async getAuditEntries(limit: number = 200): Promise<any[]> {
    const rows = this.db.prepare('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT ?').all(limit) as any[]
    return rows.map(r => ({ ...r }))
  }

  public async getVerifyHistory(backupId?: string): Promise<any[]> {
    const rows = backupId
      ? this.db.prepare('SELECT * FROM verify_history WHERE backupId = ? ORDER BY startedAt DESC').all(backupId) as any[]
      : this.db.prepare('SELECT * FROM verify_history ORDER BY startedAt DESC').all() as any[]
    return rows.map(r => ({
      ...r,
      ok: r.ok === 1,
      startedAt: new Date(r.startedAt),
      finishedAt: new Date(r.finishedAt),
      steps: JSON.parse(r.steps)
    }))
  }

  // Rehearsal Operations (R-1)
  public async saveRehearsalReport(record: {
    id: string
    policyId?: string
    requestedBackupIds: string[]
    status: string
    ok: boolean
    report: unknown        // full RehearsalReport — serialised to JSON
    startedAt: string
    finishedAt?: string
    durationMs?: number
  }): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO rehearsals (
        id, policyId, requestedBackupIds, status, ok, report,
        startedAt, finishedAt, durationMs
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status     = excluded.status,
        ok         = excluded.ok,
        report     = excluded.report,
        finishedAt = excluded.finishedAt,
        durationMs = excluded.durationMs
    `)
    stmt.run(
      record.id,
      record.policyId || null,
      JSON.stringify(record.requestedBackupIds),
      record.status,
      record.ok ? 1 : 0,
      JSON.stringify(record.report),
      record.startedAt,
      record.finishedAt || null,
      record.durationMs ?? null,
    )
  }

  public async getRehearsal(id: string): Promise<any | null> {
    const row = this.db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(id) as any
    if (!row) return null
    return {
      id: row.id,
      policyId: row.policyId || undefined,
      requestedBackupIds: JSON.parse(row.requestedBackupIds),
      status: row.status,
      ok: row.ok === 1,
      report: JSON.parse(row.report),
      startedAt: row.startedAt,
      finishedAt: row.finishedAt || undefined,
      durationMs: row.durationMs ?? undefined,
    }
  }

  public async listRehearsals(opts?: { policyId?: string; limit?: number }): Promise<any[]> {
    const limit = Math.max(1, Math.min(500, opts?.limit ?? 50))
    const rows = opts?.policyId
      ? this.db.prepare(
          'SELECT id, policyId, status, ok, startedAt, finishedAt, durationMs FROM rehearsals WHERE policyId = ? ORDER BY startedAt DESC LIMIT ?'
        ).all(opts.policyId, limit) as any[]
      : this.db.prepare(
          'SELECT id, policyId, status, ok, startedAt, finishedAt, durationMs FROM rehearsals ORDER BY startedAt DESC LIMIT ?'
        ).all(limit) as any[]
    return rows.map(r => ({
      id: r.id,
      policyId: r.policyId || undefined,
      status: r.status,
      ok: r.ok === 1,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt || undefined,
      durationMs: r.durationMs ?? undefined,
    }))
  }

  public async deleteRehearsal(id: string): Promise<void> {
    this.db.prepare('DELETE FROM rehearsals WHERE id = ?').run(id)
  }

  // Guard Event Operations (PG-1.1 — Prune Guard)
  // The full GuardEvent is stored as JSON in `event`; the denormalised
  // columns (kind/trigger/scope/totalBytes/status/pinned/createdAt/ttlAt/
  // restoredAt) drive the indexed list/filter/TTL/sum queries without parsing
  // every row.
  public async insertGuardEvent(event: GuardEvent): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO guard_events (
        id, kind, trigger, scope, event, totalBytes, status, pinned,
        createdAt, ttlAt, restoredAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind       = excluded.kind,
        trigger    = excluded.trigger,
        scope      = excluded.scope,
        event      = excluded.event,
        totalBytes = excluded.totalBytes,
        status     = excluded.status,
        pinned     = excluded.pinned,
        ttlAt      = excluded.ttlAt,
        restoredAt = excluded.restoredAt
    `)
    stmt.run(
      event.id,
      event.kind,
      event.trigger,
      event.scope,
      JSON.stringify(event),
      event.totalBytes,
      event.status,
      event.pinned ? 1 : 0,
      event.createdAt,
      event.ttlAt,
      event.restoredAt || null
    )
  }

  public async getGuardEvent(id: string): Promise<GuardEvent | null> {
    const row = this.db.prepare('SELECT event FROM guard_events WHERE id = ?').get(id) as any
    return row ? this.parseGuardEvent(row) : null
  }

  public async listGuardEvents(opts?: {
    limit?: number
    status?: string
    before?: string
  }): Promise<GuardEvent[]> {
    const limit = Math.max(1, Math.min(500, opts?.limit ?? 50))
    let query = 'SELECT event FROM guard_events WHERE 1=1'
    const params: any[] = []

    if (opts?.status) {
      query += ' AND status = ?'
      params.push(opts.status)
    }

    if (opts?.before) {
      query += ' AND createdAt < ?'
      params.push(opts.before)
    }

    query += ' ORDER BY createdAt DESC LIMIT ?'
    params.push(limit)

    const rows = this.db.prepare(query).all(...params) as any[]
    return rows.map(r => this.parseGuardEvent(r))
  }

  public async updateGuardEventStatus(id: string, status: GuardEvent['status']): Promise<void> {
    const row = this.db.prepare('SELECT event FROM guard_events WHERE id = ?').get(id) as any
    if (!row) return
    const event = this.parseGuardEvent(row)
    event.status = status
    await this.insertGuardEvent(event)
  }

  public async setGuardEventPinned(id: string, pinned: boolean): Promise<void> {
    const row = this.db.prepare('SELECT event FROM guard_events WHERE id = ?').get(id) as any
    if (!row) return
    const event = this.parseGuardEvent(row)
    event.pinned = pinned
    await this.insertGuardEvent(event)
  }

  public async setGuardEventRestoredAt(id: string, restoredAt: string): Promise<void> {
    const row = this.db.prepare('SELECT event FROM guard_events WHERE id = ?').get(id) as any
    if (!row) return
    const event = this.parseGuardEvent(row)
    event.restoredAt = restoredAt
    await this.insertGuardEvent(event)
  }

  public async deleteGuardEvent(id: string): Promise<void> {
    this.db.prepare('DELETE FROM guard_events WHERE id = ?').run(id)
  }

  /**
   * Events whose TTL has elapsed (ttlAt <= now) and which are not pinned.
   * `ttlAt` is an ISO-8601 string so a lexical `<=` against an ISO `now`
   * is chronologically correct (mirrors deleteOldAuditEntries' assumption).
   * The daily sweep marks these 'expired' and reclaims their tarballs.
   *
   * Already-'expired' rows are excluded: sweepExpired() updates status in place
   * (it does not delete the row), so without this predicate the same rows would
   * be re-selected on every daily sweep and re-audited forever.
   */
  public async listExpiredGuardEvents(nowIso: string): Promise<GuardEvent[]> {
    const rows = this.db.prepare(
      "SELECT event FROM guard_events WHERE ttlAt <= ? AND pinned = 0 AND status != 'expired' ORDER BY createdAt ASC"
    ).all(nowIso) as any[]
    return rows.map(r => this.parseGuardEvent(r))
  }

  /**
   * Total guard-cache bytes accounted across stored events. Used by the disk
   * budget / LRU eviction path (PG-1.2). Excludes already-evicted 'expired'
   * events; optionally excludes pinned events from the budget calculation.
   */
  public async sumGuardBytes(opts?: { excludePinned?: boolean }): Promise<number> {
    let query = "SELECT COALESCE(SUM(totalBytes), 0) as total FROM guard_events WHERE status != 'expired'"
    if (opts?.excludePinned) {
      query += ' AND pinned = 0'
    }
    const row = this.db.prepare(query).get() as any
    return row?.total ?? 0
  }

  private parseGuardEvent(row: any): GuardEvent {
    return JSON.parse(row.event) as GuardEvent
  }

  private parseBackup(r: any): Backup {
    let targets: any[] = []
    try { targets = JSON.parse(r.targets) } catch { /* malformed — return empty */ }
    let tags: any[] = []
    try { tags = r.tags ? JSON.parse(r.tags) : [] } catch { /* malformed — return empty */ }
    return {
      ...r,
      timestamp: new Date(r.timestamp),
      targets,
      tags,
    }
  }

  private parsePolicy(row: any): BackupPolicy {
    return {
      ...row,
      enabled: row.enabled === 1,
      targets: JSON.parse(row.targets),
      retention: JSON.parse(row.retention),
      storage: JSON.parse(row.storage),
      hooks: JSON.parse(row.hooks),
      notifications: JSON.parse(row.notifications),
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt)
    }
  }

  // Log Events (Triage Service)
  public async insertLogEvent(event: TriagedEvent): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO log_events (
        id, containerId, containerName, image, category, severity,
        logSnippet, fullMessage, fixSuggestion, exitCode, detectedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      event.id,
      event.containerId,
      event.containerName,
      event.image,
      event.category,
      event.severity,
      event.logSnippet,
      event.fullMessage,
      event.fixSuggestion,
      event.exitCode || null,
      event.detectedAt
    )
  }

  public async getLogEvents(options?: {
    containerId?: string
    category?: string
    limit?: number
    offset?: number
    since?: string
  }): Promise<{ events: TriagedEvent[]; total: number }> {
    const limit = Math.max(1, Math.min(10000, options?.limit ?? 50))
    const offset = Math.max(0, options?.offset ?? 0)
    let query = 'SELECT * FROM log_events WHERE 1=1'
    const params: any[] = []

    if (options?.containerId) {
      query += ' AND containerId = ?'
      params.push(options.containerId)
    }

    if (options?.category) {
      query += ' AND category = ?'
      params.push(options.category)
    }

    if (options?.since) {
      query += ' AND detectedAt >= ?'
      params.push(options.since)
    }

    // Get total count
    const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as count')
    const countResult = this.db.prepare(countQuery).get(...params) as any
    const total = countResult?.count ?? 0

    // Get paginated results
    query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?'
    const rows = this.db.prepare(query).all(...params, limit, offset) as any[]

    const events: TriagedEvent[] = rows.map(r => ({
      id: r.id,
      containerId: r.containerId,
      containerName: r.containerName,
      image: r.image,
      category: r.category,
      severity: r.severity,
      fullMessage: r.fullMessage,
      logSnippet: r.logSnippet,
      fixSuggestion: r.fixSuggestion,
      detectedAt: r.detectedAt,
      exitCode: r.exitCode ?? undefined
    }))

    return { events, total }
  }

  public async deleteOldLogEvents(olderThanDays: number = 7): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString()
    const stmt = this.db.prepare('DELETE FROM log_events WHERE detectedAt < ?')
    const result = stmt.run(cutoff)
    return result.changes
  }

  /**
   * Trim audit_logs rows older than `olderThanDays`. Mirrors the other TTL
   * cleanup helpers. The audit retention window is tier-dependent — the caller
   * (index.ts) resolves the number of days from the active license tier via
   * auditRetentionDaysForFeatures(). `timestamp` is stored as an ISO-8601
   * string (AuditService.record), so a lexical `<` comparison against an ISO
   * cutoff is chronologically correct.
   */
  public async deleteOldAuditEntries(olderThanDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString()
    const stmt = this.db.prepare('DELETE FROM audit_logs WHERE timestamp < ?')
    const result = stmt.run(cutoff)
    return result.changes
  }

  // Volume Manifest Operations
  public async insertVolumeManifest(entry: {
    id: string
    volumeName: string
    backupId: string
    containerNames?: string[]
    policyId?: string
    restoreSuccess: boolean
    timestamp: string
    rehearsalId?: string
    ttl?: number
  }): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO volumes_manifest (
        id, volumeName, backupId, containerNames, policyId, restoreSuccess,
        timestamp, rehearsalId, ttl
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      entry.id,
      entry.volumeName,
      entry.backupId,
      entry.containerNames ? JSON.stringify(entry.containerNames) : null,
      entry.policyId || null,
      entry.restoreSuccess ? 1 : 0,
      entry.timestamp,
      entry.rehearsalId || null,
      entry.ttl ?? 604800
    )
  }

  public async getVolumesManifest(opts?: {
    policyId?: string
    since?: string
    limit?: number
  }): Promise<Array<{
    id: string
    volumeName: string
    backupId: string
    containerNames: string[]
    policyId?: string
    restoreSuccess: boolean
    timestamp: string
    rehearsalId?: string
  }>> {
    let query = 'SELECT * FROM volumes_manifest WHERE 1=1'
    const params: any[] = []

    if (opts?.policyId) {
      query += ' AND policyId = ?'
      params.push(opts.policyId)
    }

    if (opts?.since) {
      query += ' AND timestamp > ?'
      params.push(opts.since)
    }

    query += ' ORDER BY timestamp DESC'

    if (opts?.limit) {
      query += ' LIMIT ?'
      params.push(opts.limit)
    }

    const rows = this.db.prepare(query).all(...params) as any[]
    return rows.map(r => ({
      id: r.id,
      volumeName: r.volumeName,
      backupId: r.backupId,
      containerNames: r.containerNames ? JSON.parse(r.containerNames) : [],
      policyId: r.policyId || undefined,
      restoreSuccess: r.restoreSuccess === 1,
      timestamp: r.timestamp,
      rehearsalId: r.rehearsalId || undefined
    }))
  }

  public async getManagedVolumes(): Promise<string[]> {
    const rows = this.db.prepare(`
      SELECT DISTINCT volumeName FROM volumes_manifest
      WHERE timestamp > datetime('now', '-7 days')
      ORDER BY volumeName
    `).all() as any[]
    return rows.map(r => r.volumeName)
  }

  public async deleteOldVolumeManifests(olderThanDays: number = 7): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString()
    const stmt = this.db.prepare('DELETE FROM volumes_manifest WHERE timestamp < ?')
    const result = stmt.run(cutoff)
    return result.changes
  }

  // Notification Preferences
  public async getNotificationPreferences(userId: string): Promise<any | null> {
    const row = this.db.prepare('SELECT * FROM notification_preferences WHERE userId = ?').get(userId) as any
    if (!row) return null
    return {
      userId: row.userId,
      unsubscribeToken: row.unsubscribeToken,
      enabled: {
        unhealthy: row.unhealthy_enabled === 1,
        restart_loop: row.restart_loop_enabled === 1,
        no_backup: row.no_backup_enabled === 1,
        disk_pressure: row.disk_pressure_enabled === 1,
        restore_failed: row.restore_failed_enabled === 1
      },
      frequencies: {
        unhealthy: row.unhealthy_frequency,
        restart_loop: row.restart_loop_frequency,
        no_backup: row.no_backup_frequency,
        disk_pressure: row.disk_pressure_frequency,
        restore_failed: row.restore_failed_frequency
      },
      deliveryChannels: row.delivery_channels ? JSON.parse(row.delivery_channels) : ['webhook'],
      webhookUrl: row.webhook_url,
      customThresholds: row.custom_thresholds ? JSON.parse(row.custom_thresholds) : {},
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }
  }

  public async upsertNotificationPreferences(userId: string, prefs: any): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO notification_preferences (
        userId, unsubscribeToken,
        unhealthy_enabled, restart_loop_enabled, no_backup_enabled, disk_pressure_enabled, restore_failed_enabled,
        unhealthy_frequency, restart_loop_frequency, no_backup_frequency, disk_pressure_frequency, restore_failed_frequency,
        delivery_channels, webhook_url, custom_thresholds, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(userId) DO UPDATE SET
        unsubscribeToken = excluded.unsubscribeToken,
        unhealthy_enabled = excluded.unhealthy_enabled,
        restart_loop_enabled = excluded.restart_loop_enabled,
        no_backup_enabled = excluded.no_backup_enabled,
        disk_pressure_enabled = excluded.disk_pressure_enabled,
        restore_failed_enabled = excluded.restore_failed_enabled,
        unhealthy_frequency = excluded.unhealthy_frequency,
        restart_loop_frequency = excluded.restart_loop_frequency,
        no_backup_frequency = excluded.no_backup_frequency,
        disk_pressure_frequency = excluded.disk_pressure_frequency,
        restore_failed_frequency = excluded.restore_failed_frequency,
        delivery_channels = excluded.delivery_channels,
        webhook_url = excluded.webhook_url,
        custom_thresholds = excluded.custom_thresholds,
        updatedAt = CURRENT_TIMESTAMP
    `)
    const token = prefs.unsubscribeToken || randomBytes(16).toString('hex')
    stmt.run(
      userId,
      token,
      prefs.enabled?.unhealthy !== false ? 1 : 0,
      prefs.enabled?.restart_loop !== false ? 1 : 0,
      prefs.enabled?.no_backup !== false ? 1 : 0,
      prefs.enabled?.disk_pressure !== false ? 1 : 0,
      prefs.enabled?.restore_failed !== false ? 1 : 0,
      prefs.frequencies?.unhealthy || 'immediate',
      prefs.frequencies?.restart_loop || 'immediate',
      prefs.frequencies?.no_backup || 'daily',
      prefs.frequencies?.disk_pressure || 'immediate',
      prefs.frequencies?.restore_failed || 'immediate',
      JSON.stringify(prefs.deliveryChannels || ['webhook']),
      prefs.webhookUrl || null,
      JSON.stringify(prefs.customThresholds || {})
    )
  }

  // Notification Log
  public async insertNotificationLog(entry: any): Promise<string> {
    const id = uuid()
    const stmt = this.db.prepare(`
      INSERT INTO notification_log (
        id, eventType, resourceId, resourceName, severity, status, deliveryChannel, payload, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `)
    stmt.run(
      id,
      entry.eventType,
      entry.resourceId || null,
      entry.resourceName || null,
      entry.severity || 'warning',
      entry.status || 'pending',
      entry.deliveryChannel || 'webhook',
      JSON.stringify(entry.payload || {})
    )
    return id
  }

  public async getLastNotification(eventType: string, resourceId: string): Promise<any | null> {
    const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const row = this.db.prepare(`
      SELECT * FROM notification_log
      WHERE eventType = ? AND resourceId = ? AND createdAt > ? AND status = 'sent'
      ORDER BY createdAt DESC
      LIMIT 1
    `).get(eventType, resourceId, cutoffTime) as any
    if (!row) return null
    return {
      id: row.id,
      eventType: row.eventType,
      resourceId: row.resourceId,
      status: row.status,
      sentAt: row.sentAt,
      createdAt: row.createdAt
    }
  }

  public async updateNotificationStatus(id: string, status: 'sent' | 'failed', error?: string): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE notification_log
      SET status = ?, sentAt = ?, errorMessage = ?
      WHERE id = ?
    `)
    stmt.run(status, status === 'sent' ? new Date().toISOString() : null, error || null, id)
  }

  public async getFailedNotifications(): Promise<any[]> {
    const rows = this.db.prepare(`
      SELECT * FROM notification_log
      WHERE status = 'failed' AND nextRetryAt <= datetime('now')
      ORDER BY createdAt DESC
      LIMIT 100
    `).all() as any[]
    return rows.map(row => ({
      id: row.id,
      eventType: row.eventType,
      resourceId: row.resourceId,
      payload: JSON.parse(row.payload),
      retryCount: row.retryCount,
      deliveryChannel: row.deliveryChannel
    }))
  }

  public async cleanupOldNotifications(ttlDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString()
    const stmt = this.db.prepare('DELETE FROM notification_log WHERE createdAt < ?')
    const result = stmt.run(cutoff)
    return result.changes
  }
}
