import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { Database } from '../db/Database'
import { AuditService } from '../services/AuditService'
import {
  auditRetentionDaysForFeatures,
  LicenseFeature,
  LicenseStatus,
} from '../services/LicenseService'

// Minimal LicenseService stand-in: only getStatus() is used by pruneByRetention.
function fakeLicense(
  features: LicenseFeature[],
  opts: { throws?: boolean } = {}
): any {
  return {
    async getStatus(): Promise<LicenseStatus> {
      if (opts.throws) throw new Error('license backend unavailable')
      return {
        tier: 'personal-pro',
        seats: 1,
        features,
        launchLockIn: false,
        staleButValid: false,
        devMode: true,
      }
    },
  }
}

/** Insert an audit row with an explicit ISO timestamp `daysAgo` in the past. */
async function insertAged(db: Database, action: string, daysAgo: number): Promise<void> {
  const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString()
  await (db as any).saveAuditEntry({
    id: `${action}-${daysAgo}-${Math.random()}`,
    timestamp: ts,
    action,
    details: null,
    user: null,
  })
}

describe('auditRetentionDaysForFeatures', () => {
  it('free tier (no audit feature) → 14 days', () => {
    expect(auditRetentionDaysForFeatures([])).toBe(14)
  })
  it('personal-pro → 90 days', () => {
    expect(auditRetentionDaysForFeatures(['audit_log_90d'])).toBe(90)
  })
  it('commercial-pro → 365 days', () => {
    expect(auditRetentionDaysForFeatures(['audit_log_365d'])).toBe(365)
  })
  it('enterprise (unlimited) → null (no trim)', () => {
    expect(auditRetentionDaysForFeatures(['audit_log_unlimited'])).toBeNull()
  })
  it('highest window wins when multiple present', () => {
    expect(
      auditRetentionDaysForFeatures(['audit_log_90d', 'audit_log_unlimited'])
    ).toBeNull()
    expect(
      auditRetentionDaysForFeatures(['audit_log_90d', 'audit_log_365d'])
    ).toBe(365)
  })
})

describe('AuditService.pruneByRetention', () => {
  let tmp: string
  let db: Database
  let svc: AuditService

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'drk-audit-ttl-'))
    db = new Database(path.join(tmp, 'a.db'))
    svc = new AuditService(db)
  })

  afterEach(async () => {
    try { (db as any).db?.close?.() } catch { /* ignore */ }
    await fs.remove(tmp).catch(() => { /* best-effort */ })
  })

  it('free tier trims rows older than 14 days but keeps newer ones', async () => {
    await insertAged(db, 'old', 30)
    await insertAged(db, 'edge-kept', 10)
    await insertAged(db, 'fresh', 1)

    const deleted = await svc.pruneByRetention(fakeLicense([]))
    expect(deleted).toBe(1)

    const remaining = await svc.list()
    const actions = remaining.map(r => r.action).sort()
    expect(actions).toEqual(['edge-kept', 'fresh'])
  })

  it('personal-pro (90d) keeps rows free tier would have trimmed', async () => {
    await insertAged(db, 'd30', 30)
    await insertAged(db, 'd100', 100)

    const deleted = await svc.pruneByRetention(fakeLicense(['audit_log_90d']))
    expect(deleted).toBe(1) // only the 100-day row goes
    const remaining = await svc.list()
    expect(remaining.map(r => r.action)).toEqual(['d30'])
  })

  it('enterprise unlimited never trims', async () => {
    await insertAged(db, 'ancient', 4000)
    const deleted = await svc.pruneByRetention(fakeLicense(['audit_log_unlimited']))
    expect(deleted).toBe(0)
    expect((await svc.list()).length).toBe(1)
  })

  it('DATA SAFETY: trims nothing when the license tier cannot be resolved', async () => {
    await insertAged(db, 'ancient', 4000)
    const deleted = await svc.pruneByRetention(fakeLicense([], { throws: true }))
    expect(deleted).toBe(0)
    expect((await svc.list()).length).toBe(1)
  })
})
