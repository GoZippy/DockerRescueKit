import { v4 as uuidv4 } from 'uuid'
import { Database } from '../db/Database'
import { logger } from '../utils/logger'
import { LicenseService, auditRetentionDaysForFeatures } from './LicenseService'

export interface AuditEntry {
  id: string
  timestamp: string
  action: string
  details?: string
  user?: string
}

/**
 * Writes every mutating API call to `audit_logs`. Also read-exposed via
 * GET /api/audit so the SecurityAudit UI has something real to show.
 */
export class AuditService {
  constructor(private db: Database) {}

  public async record(action: string, details?: any, user?: string): Promise<void> {
    try {
      await (this.db as any).saveAuditEntry({
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        action,
        details: details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null,
        user: user || null
      })
    } catch (err) {
      logger.error({ err }, '[Audit] Failed to persist')
    }
  }

  public async list(limit = 200): Promise<AuditEntry[]> {
    return await (this.db as any).getAuditEntries(limit)
  }

  /**
   * Trim audit rows beyond the active license tier's retention window.
   *
   * Retention days come from the tier's audit_log_* feature
   * (free=14d, personal-pro=90d, commercial-pro=365d, enterprise=unlimited).
   * Returns the number of rows deleted (0 when unlimited or on error).
   *
   * DATA SAFETY: trims only rows strictly OLDER than the window. If the tier
   * can't be resolved (license check throws) we treat it as the most permissive
   * interpretation — UNLIMITED, i.e. delete nothing — and log, so a transient
   * license-resolution failure never destroys audit history.
   */
  public async pruneByRetention(license: LicenseService): Promise<number> {
    let retentionDays: number | null
    try {
      const status = await license.getStatus()
      retentionDays = auditRetentionDaysForFeatures(status.features)
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        '[Audit] retention prune skipped — license tier unresolved; keeping all rows (most permissive)'
      )
      return 0
    }

    // Unlimited retention (enterprise) — never trim.
    if (retentionDays === null) return 0

    try {
      const deleted = await (this.db as any).deleteOldAuditEntries(retentionDays)
      if (deleted > 0) {
        logger.info(`[Audit] retention prune: deleted ${deleted} rows older than ${retentionDays} days`)
      }
      return deleted
    } catch (err) {
      logger.error({ err }, '[Audit] retention prune failed')
      return 0
    }
  }
}
