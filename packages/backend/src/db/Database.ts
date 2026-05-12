import DatabaseConstructor, { Database as SQLiteDatabase } from 'better-sqlite3'
import path from 'path'
import fs from 'fs-extra'
import { 
  BackupPolicy, 
  StorageConfig, 
  Backup, 
  BackupStatus 
} from '@docker-rescue-kit/shared'

export class Database {
  private db: SQLiteDatabase

  constructor(dbPath: string = 'data/backups.db') {
    const fullPath = path.resolve(dbPath)
    fs.ensureDirSync(path.dirname(fullPath))
    
    this.db = new DatabaseConstructor(fullPath)
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

  private parseBackup(r: any): Backup {
    return {
      ...r,
      timestamp: new Date(r.timestamp),
      targets: JSON.parse(r.targets),
      tags: r.tags ? JSON.parse(r.tags) : []
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
}
