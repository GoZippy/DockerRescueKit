import { v4 as uuidv4 } from 'uuid'
import { Database } from '../db/Database'
import { logger } from '../utils/logger'

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
}
