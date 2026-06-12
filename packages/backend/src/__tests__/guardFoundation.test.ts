import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { Database } from '../db/Database'
import { SettingsService } from '../services/SettingsService'
import { DEFAULT_GUARD_SETTINGS, GUARD_AUDIT_EVENTS } from '../services/GuardTypes'
import type { GuardEvent, GuardScope } from '@docker-rescue-kit/shared'

// ---------------------------------------------------------------------------
// PG-1.1 Prune Guard foundation — storage + validation only (no behavior).
// Covers: GuardSettings defaults/merge/validation and the guard_events
// Database round-trip (insert/list/filter/TTL/pin/restore/delete/sumGuardBytes).
// ---------------------------------------------------------------------------

async function newDb(): Promise<{ db: Database; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drk-guard-'))
  return { db: new Database(path.join(dir, 'g.db')), dir }
}

function makeEvent(over: Partial<GuardEvent> = {}): GuardEvent {
  const createdAt = over.createdAt ?? new Date().toISOString()
  return {
    id: over.id ?? `evt-${Math.random().toString(36).slice(2)}`,
    kind: over.kind ?? 'system_prune',
    trigger: over.trigger ?? 'event',
    scope: over.scope ?? 'named',
    volumes: over.volumes ?? [
      { volume: 'pocketos-db', status: 'saved', sizeBytes: 1000, tarPath: 'pocketos-db.tar.gz' },
    ],
    totalBytes: over.totalBytes ?? 1000,
    createdAt,
    ttlAt: over.ttlAt ?? new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
    pinned: over.pinned ?? false,
    restoredAt: over.restoredAt,
    status: over.status ?? 'saved',
  }
}

describe('GuardSettings (SettingsService)', () => {
  let db: Database
  let svc: SettingsService

  beforeEach(async () => {
    const t = await newDb()
    db = t.db
    svc = new SettingsService(db)
  })

  it('returns the spec defaults when nothing is stored', async () => {
    const s = await svc.getGuardSettings()
    expect(s).toEqual(DEFAULT_GUARD_SETTINGS)
    // sanity on the resolved §17 values
    expect(s.scope).toBe('named')
    expect(s.diskBudgetMb).toBe(2048)
    expect(s.perVolumeCapMb).toBe(512)
    expect(s.ttlHours).toBe(72)
    expect(s.periodicCron).toBe('0 */6 * * *')
    expect(s.failClosed).toBe(false)
    expect(s.enabled).toBe(true)
  })

  it('merges stored overrides with defaults', async () => {
    await svc.setGuardSettings({ scope: 'protected', diskBudgetMb: 4096 })
    const s = await svc.getGuardSettings()
    expect(s.scope).toBe('protected')
    expect(s.diskBudgetMb).toBe(4096)
    // untouched fields keep defaults
    expect(s.perVolumeCapMb).toBe(512)
    expect(s.periodicCron).toBe('0 */6 * * *')
  })

  it('persists and round-trips a full valid patch', async () => {
    const out = await svc.setGuardSettings({
      enabled: false,
      scope: 'all-named-under-cap',
      diskBudgetMb: 1024,
      perVolumeCapMb: 256,
      ttlHours: 24,
      periodicCron: '0 */3 * * *',
      failClosed: true,
    })
    expect(out.enabled).toBe(false)
    expect(out.failClosed).toBe(true)
    expect(out.periodicCron).toBe('0 */3 * * *')
    // and a fresh read sees the same
    expect(await svc.getGuardSettings()).toEqual(out)
  })

  it('rejects an invalid cron', async () => {
    await expect(svc.setGuardSettings({ periodicCron: 'not a cron' })).rejects.toThrow(/cron/i)
  })

  it('rejects a non-positive budget', async () => {
    await expect(svc.setGuardSettings({ diskBudgetMb: 0 })).rejects.toThrow(/diskBudgetMb/)
    await expect(svc.setGuardSettings({ diskBudgetMb: -5 })).rejects.toThrow(/diskBudgetMb/)
    await expect(svc.setGuardSettings({ perVolumeCapMb: -1 })).rejects.toThrow(/perVolumeCapMb/)
    await expect(svc.setGuardSettings({ ttlHours: 0 })).rejects.toThrow(/ttlHours/)
  })

  it('rejects a bad scope', async () => {
    await expect(
      svc.setGuardSettings({ scope: 'bogus' as GuardScope })
    ).rejects.toThrow(/scope/i)
  })

  it('does not persist any field when validation fails', async () => {
    await expect(
      svc.setGuardSettings({ diskBudgetMb: 8192, periodicCron: 'bad' })
    ).rejects.toThrow()
    // diskBudgetMb must NOT have been written because the patch threw
    const s = await svc.getGuardSettings()
    expect(s.diskBudgetMb).toBe(DEFAULT_GUARD_SETTINGS.diskBudgetMb)
  })
})

describe('guard_events (Database)', () => {
  let db: Database

  beforeEach(async () => {
    const t = await newDb()
    db = t.db
  })

  it('inserts and reads back a full GuardEvent', async () => {
    const evt = makeEvent({ id: 'e1' })
    await db.insertGuardEvent(evt)
    const got = await db.getGuardEvent('e1')
    expect(got).toEqual(evt)
  })

  it('returns null for an unknown id', async () => {
    expect(await db.getGuardEvent('nope')).toBeNull()
  })

  it('lists newest-first and filters by status', async () => {
    await db.insertGuardEvent(makeEvent({ id: 'a', createdAt: '2026-06-01T00:00:00.000Z', status: 'saved' }))
    await db.insertGuardEvent(makeEvent({ id: 'b', createdAt: '2026-06-02T00:00:00.000Z', status: 'failed' }))
    await db.insertGuardEvent(makeEvent({ id: 'c', createdAt: '2026-06-03T00:00:00.000Z', status: 'saved' }))

    const all = await db.listGuardEvents()
    expect(all.map(e => e.id)).toEqual(['c', 'b', 'a'])

    const saved = await db.listGuardEvents({ status: 'saved' })
    expect(saved.map(e => e.id)).toEqual(['c', 'a'])

    const before = await db.listGuardEvents({ before: '2026-06-02T12:00:00.000Z' })
    expect(before.map(e => e.id)).toEqual(['b', 'a'])

    const limited = await db.listGuardEvents({ limit: 1 })
    expect(limited.map(e => e.id)).toEqual(['c'])
  })

  it('updates status, pin and restoredAt through the JSON column', async () => {
    await db.insertGuardEvent(makeEvent({ id: 'x' }))

    await db.updateGuardEventStatus('x', 'restored')
    expect((await db.getGuardEvent('x'))!.status).toBe('restored')

    await db.setGuardEventPinned('x', true)
    expect((await db.getGuardEvent('x'))!.pinned).toBe(true)

    await db.setGuardEventRestoredAt('x', '2026-06-11T10:00:00.000Z')
    expect((await db.getGuardEvent('x'))!.restoredAt).toBe('2026-06-11T10:00:00.000Z')
  })

  it('lists expired (TTL-elapsed, non-pinned) events only', async () => {
    const past = '2026-06-01T00:00:00.000Z'
    const future = new Date(Date.now() + 3600 * 1000).toISOString()
    await db.insertGuardEvent(makeEvent({ id: 'expired', ttlAt: past, pinned: false }))
    await db.insertGuardEvent(makeEvent({ id: 'pinnedExpired', ttlAt: past, pinned: true }))
    await db.insertGuardEvent(makeEvent({ id: 'fresh', ttlAt: future, pinned: false }))

    const now = '2026-06-11T00:00:00.000Z'
    const expired = await db.listExpiredGuardEvents(now)
    expect(expired.map(e => e.id)).toEqual(['expired'])
  })

  it('sums bytes, honoring excludePinned and the expired exclusion', async () => {
    await db.insertGuardEvent(makeEvent({ id: 's1', totalBytes: 100, pinned: false, status: 'saved' }))
    await db.insertGuardEvent(makeEvent({ id: 's2', totalBytes: 200, pinned: true, status: 'saved' }))
    await db.insertGuardEvent(makeEvent({ id: 's3', totalBytes: 999, pinned: false, status: 'expired' }))

    expect(await db.sumGuardBytes()).toBe(300)              // s1 + s2 (s3 expired excluded)
    expect(await db.sumGuardBytes({ excludePinned: true })).toBe(100) // only s1
  })

  it('deletes an event', async () => {
    await db.insertGuardEvent(makeEvent({ id: 'gone' }))
    await db.deleteGuardEvent('gone')
    expect(await db.getGuardEvent('gone')).toBeNull()
  })

  it('exposes the 6 guard.* audit event constants', () => {
    expect(Object.values(GUARD_AUDIT_EVENTS).sort()).toEqual([
      'guard.expired',
      'guard.restore',
      'guard.skipped',
      'guard.snapshot',
      'guard.snapshot_failed',
      'guard.too_late',
    ])
  })
})
