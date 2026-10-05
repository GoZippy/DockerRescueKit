/**
 * Schedule time zones.
 *
 * Regression for: the UI showed "Daily at 02:00" as local time while the
 * scheduler (in a container with TZ unset, i.e. UTC) fired it at 02:00 UTC,
 * which for a user in CDT is 21:00 the evening before.
 *
 * Covers: next-run computation in a zone, DST in both directions, the legacy
 * (no timezone) UTC fallback, how SchedulerEngine registers its cron jobs,
 * and the persisted-policy migration.
 */

import os from 'os'
import path from 'path'
import fs from 'fs-extra'
import cron from 'node-cron'
import BetterSqlite3 from 'better-sqlite3'
import type { BackupPolicy } from '@docker-rescue-kit/shared'
import {
  DEFAULT_SCHEDULE_TIMEZONE,
  effectiveTimezone,
  isValidTimeZone,
  nextRun,
  nextRuns,
  resolvePolicyTimezone,
} from '../scheduler/timezone'
import { SchedulerEngine } from '../scheduler/SchedulerEngine'
import { Database } from '../db/Database'
import { PolicyManager } from '../services/PolicyManager'

jest.mock('dockerode', () => jest.fn().mockImplementation(() => ({})))

const iso = (dates: Date[]) => dates.map(d => d.toISOString())

function policy(overrides: Partial<BackupPolicy> = {}): BackupPolicy {
  return {
    id: 'p1',
    name: 'nightly',
    enabled: true,
    targets: [],
    schedule: '0 2 * * *',
    backupType: 'full',
    retention: { strategy: 'count', count: 7 },
    storage: { id: 's', type: 'local' } as any,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

describe('isValidTimeZone', () => {
  it('accepts IANA names', () => {
    for (const tz of ['UTC', 'America/Chicago', 'Europe/London', 'Asia/Kolkata', 'Australia/Lord_Howe', 'America/Argentina/Buenos_Aires']) {
      expect(isValidTimeZone(tz)).toBe(true)
    }
  })

  it('rejects unknown zones, fixed offsets, blanks and non-strings', () => {
    for (const tz of ['Mars/Base', 'Not/AZone', '+05:00', '-0300', '', ' UTC', 'UTC ', 'x'.repeat(65)]) {
      expect(isValidTimeZone(tz)).toBe(false)
    }
    for (const tz of [undefined, null, 5, {}, ['UTC']]) {
      expect(isValidTimeZone(tz)).toBe(false)
    }
  })
})

describe('resolvePolicyTimezone / effectiveTimezone', () => {
  it('uses the policy zone when it is valid', () => {
    expect(resolvePolicyTimezone({ timezone: 'America/Chicago' })).toEqual({ timezone: 'America/Chicago', usedFallback: false })
  })

  it('treats a missing zone as a legacy UTC policy (no fallback warning)', () => {
    expect(resolvePolicyTimezone({})).toEqual({ timezone: 'UTC', usedFallback: false })
    expect(resolvePolicyTimezone({ timezone: null })).toEqual({ timezone: 'UTC', usedFallback: false })
    expect(resolvePolicyTimezone({ timezone: '' })).toEqual({ timezone: 'UTC', usedFallback: false })
    expect(effectiveTimezone({})).toBe(DEFAULT_SCHEDULE_TIMEZONE)
  })

  it('falls back to UTC, flagged, when the stored zone is unusable', () => {
    expect(resolvePolicyTimezone({ timezone: 'Mars/Base' })).toEqual({ timezone: 'UTC', usedFallback: true })
  })
})

describe('next run in a time zone', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  const at = (isoNow: string) => jest.useFakeTimers({ now: new Date(isoNow), doNotFake: ['nextTick', 'setImmediate'] })

  it('"0 2 * * *" in America/Chicago is 07:00Z in CDT and 08:00Z in CST, not 02:00Z', () => {
    at('2026-10-03T12:00:00Z') // CDT (UTC-5)
    expect(iso(nextRuns('0 2 * * *', 'America/Chicago', 2))).toEqual([
      '2026-10-04T07:00:00.000Z',
      '2026-10-05T07:00:00.000Z',
    ])

    at('2026-12-01T12:00:00Z') // CST (UTC-6)
    expect(iso(nextRuns('0 2 * * *', 'America/Chicago', 1))).toEqual(['2026-12-02T08:00:00.000Z'])
  })

  it('the same cron in UTC still fires at 02:00Z (the legacy behaviour)', () => {
    at('2026-10-03T12:00:00Z')
    expect(iso(nextRuns('0 2 * * *', 'UTC', 2))).toEqual(['2026-10-04T02:00:00.000Z', '2026-10-05T02:00:00.000Z'])
  })

  it('handles zones with half-hour offsets and zones east of UTC (previous UTC day)', () => {
    at('2026-10-03T12:00:00Z')
    expect(nextRun('0 2 * * *', 'Asia/Kolkata')!.toISOString()).toBe('2026-10-03T20:30:00.000Z')
    expect(nextRun('0 2 * * *', 'Pacific/Auckland')!.toISOString()).toBe('2026-10-03T13:00:00.000Z') // NZDT UTC+13
  })

  it('day-of-week and day-of-month are evaluated in the zone', () => {
    at('2026-10-03T12:00:00Z') // Saturday
    // Sunday 04:00 in Chicago is 09:00Z (CDT)
    expect(nextRun('0 4 * * 0', 'America/Chicago')!.toISOString()).toBe('2026-10-04T09:00:00.000Z')
    // 1st of the month at 05:00 in Chicago, CDT until 1 Nov 2026 02:00, so Nov 1 05:00 is CST => 11:00Z
    expect(nextRun('0 5 1 * *', 'America/Chicago')!.toISOString()).toBe('2026-11-01T11:00:00.000Z')
  })

  describe('daylight saving time', () => {
    it('spring forward: a fixed local time keeps its wall-clock hour across the change', () => {
      // US clocks jump 02:00 -> 03:00 on 2027-03-14.
      at('2027-03-12T12:00:00Z')
      expect(iso(nextRuns('0 3 * * *', 'America/Chicago', 3))).toEqual([
        '2027-03-13T09:00:00.000Z', // CST, UTC-6
        '2027-03-14T08:00:00.000Z', // CDT, UTC-5: still 03:00 local
        '2027-03-15T08:00:00.000Z',
      ])
    })

    it('spring forward: a local time inside the skipped hour does not run that one day (documented node-cron behaviour), then resumes', () => {
      // 02:30 does not exist in Chicago on 2027-03-14. node-cron skips that
      // day's run rather than shifting it to 03:30 or firing it twice. Pinned
      // here so a library upgrade that changes it is noticed, and documented
      // in docs/ARCHITECTURE.md ("Schedule time zones").
      at('2027-03-12T12:00:00Z')
      const runs = nextRuns('30 2 * * *', 'America/Chicago', 3)
      expect(iso(runs)).toEqual([
        '2027-03-13T08:30:00.000Z', // CST
        '2027-03-15T07:30:00.000Z', // CDT: 14th skipped
        '2027-03-16T07:30:00.000Z',
      ])
      expect(new Set(iso(runs)).size).toBe(3)
    })

    it('fall back: a fixed local time keeps its wall-clock hour across the change', () => {
      // US clocks fall back 02:00 -> 01:00 on 2026-11-01.
      at('2026-10-30T12:00:00Z')
      expect(iso(nextRuns('0 3 * * *', 'America/Chicago', 3))).toEqual([
        '2026-10-31T08:00:00.000Z', // CDT
        '2026-11-01T09:00:00.000Z', // CST: still 03:00 local
        '2026-11-02T09:00:00.000Z',
      ])
    })

    it('fall back: the repeated 01:30 runs once that night, not twice', () => {
      at('2026-10-31T12:00:00Z')
      const runs = nextRuns('30 1 * * *', 'America/Chicago', 3)
      expect(runs).toHaveLength(3)
      expect(new Set(iso(runs)).size).toBe(3)
      const days = runs.map(d => d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }))
      expect(days).toEqual(['2026-11-01', '2026-11-02', '2026-11-03'])
    })

    it('a fixed-offset-free zone such as UTC is unaffected by DST', () => {
      at('2027-03-12T12:00:00Z')
      expect(iso(nextRuns('0 3 * * *', 'UTC', 3))).toEqual([
        '2027-03-13T03:00:00.000Z',
        '2027-03-14T03:00:00.000Z',
        '2027-03-15T03:00:00.000Z',
      ])
    })
  })

  it('returns [] / null (never throws) for an invalid zone or expression', () => {
    expect(nextRuns('0 2 * * *', 'Mars/Base')).toEqual([])
    expect(nextRuns('not a cron', 'UTC')).toEqual([])
    expect(nextRun('0 2 * * *', '+05:00')).toBeNull()
  })

  it('does not leak tasks into the global node-cron registry', () => {
    const before = cron.getTasks().size
    for (let i = 0; i < 5; i++) nextRuns('0 2 * * *', 'America/Chicago', 2)
    expect(cron.getTasks().size).toBe(before)
  })
})

describe('SchedulerEngine registers jobs in the policy zone', () => {
  let scheduleSpy: jest.SpyInstance
  const fakeTask = () => ({ stop: jest.fn(), destroy: jest.fn() }) as any

  beforeEach(() => {
    scheduleSpy = jest.spyOn(cron, 'schedule').mockImplementation(() => fakeTask())
  })

  afterEach(() => {
    scheduleSpy.mockRestore()
    jest.restoreAllMocks()
  })

  it('passes the policy timezone to node-cron for the backup job', () => {
    const engine = new SchedulerEngine({} as any)
    engine.schedulePolicy(policy({ timezone: 'America/Chicago' }))
    expect(scheduleSpy).toHaveBeenCalledTimes(1)
    expect(scheduleSpy.mock.calls[0][0]).toBe('0 2 * * *')
    expect(scheduleSpy.mock.calls[0][2]).toEqual({ timezone: 'America/Chicago' })
  })

  it('passes the same timezone to the verify job', () => {
    const engine = new SchedulerEngine({} as any, {} as any)
    engine.schedulePolicy(policy({ timezone: 'Europe/London', verifySchedule: '0 4 * * 0' }))
    expect(scheduleSpy).toHaveBeenCalledTimes(2)
    expect(scheduleSpy.mock.calls[0][2]).toEqual({ timezone: 'Europe/London' })
    expect(scheduleSpy.mock.calls[1][0]).toBe('0 4 * * 0')
    expect(scheduleSpy.mock.calls[1][2]).toEqual({ timezone: 'Europe/London' })
  })

  it('legacy policy (no timezone) keeps UTC behaviour, explicitly, and without a warning', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const engine = new SchedulerEngine({} as any)
    engine.schedulePolicy(policy({ timezone: undefined }))
    expect(scheduleSpy.mock.calls[0][2]).toEqual({ timezone: 'UTC' })
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('an unusable stored zone runs in UTC and logs loudly instead of never running', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const engine = new SchedulerEngine({} as any)
    engine.schedulePolicy(policy({ timezone: 'Mars/Base' }))
    expect(scheduleSpy.mock.calls[0][2]).toEqual({ timezone: 'UTC' })
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/unusable timezone "Mars\/Base".*UTC/))
  })

  it('nextRunFor uses the policy zone, is UTC for legacy rows and null when disabled', () => {
    jest.useFakeTimers({ now: new Date('2026-10-03T12:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] })
    try {
      const engine = new SchedulerEngine({} as any)
      expect(engine.nextRunFor(policy({ timezone: 'America/Chicago' }))!.toISOString()).toBe('2026-10-04T07:00:00.000Z')
      expect(engine.nextRunFor(policy({ timezone: undefined }))!.toISOString()).toBe('2026-10-04T02:00:00.000Z')
      expect(engine.nextRunFor(policy({ enabled: false, timezone: 'America/Chicago' }))).toBeNull()
      expect(engine.nextRunFor(policy({ schedule: 'garbage' }))).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('end to end: a real node-cron job fires at the zoned instant', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('a "0 2 * * *" Chicago policy fires at 07:00Z (CDT), not at 02:00Z', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-04T00:00:00Z') })
    const engine = new SchedulerEngine({} as any)
    const fired: string[] = []
    const policyManager: any = { runBackup: jest.fn(async () => { fired.push(new Date().toISOString()); return { status: 'failed' } }) }
    const real = new SchedulerEngine(policyManager)
    try {
      real.schedulePolicy(policy({ timezone: 'America/Chicago' }))
      // 02:00Z: the old (buggy) firing time. Nothing may run.
      await jest.advanceTimersByTimeAsync(2 * 3600 * 1000 + 60 * 1000)
      expect(fired).toEqual([])
      // 07:00Z: 02:00 in Chicago.
      await jest.advanceTimersByTimeAsync(5 * 3600 * 1000)
      expect(fired).toHaveLength(1)
      expect(new Date(fired[0]).getUTCHours()).toBe(7)
    } finally {
      real.stop()
      engine.stop()
    }
  })
})

describe('persisted policies', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'drk-tz-'))
  })

  afterEach(async () => {
    // SQLite handles stay open until the process exits; on Windows that makes
    // the unlink fail with EBUSY, so cleanup is best-effort.
    await fs.remove(tmp).catch(() => undefined)
  })

  it('migrates a pre-timezone database without moving existing policies off UTC', async () => {
    const dbPath = path.join(tmp, 'old.db')
    // The policies table as shipped before the timezone column existed.
    const old = new BetterSqlite3(dbPath)
    old.exec(`
      CREATE TABLE policies (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, enabled INTEGER DEFAULT 1,
        targets TEXT NOT NULL, schedule TEXT NOT NULL, backupType TEXT NOT NULL,
        retention TEXT NOT NULL, storage TEXT NOT NULL, hooks TEXT, notifications TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `)
    old.prepare(`INSERT INTO policies (id, name, enabled, targets, schedule, backupType, retention, storage)
                 VALUES ('legacy-1', 'legacy nightly', 1, '[]', '0 2 * * *', 'full', '{"strategy":"count","count":7}', '{"id":"s","type":"local"}')`).run()
    old.close()

    const db = new Database(dbPath)
    const loaded = await db.getPolicy('legacy-1')
    expect(loaded).not.toBeNull()
    expect(loaded!.timezone).toBeUndefined()
    expect(effectiveTimezone(loaded!)).toBe('UTC')
    expect(loaded!.schedule).toBe('0 2 * * *')

    // Saving it back (what any edit does) must not invent a zone.
    await db.savePolicy({ ...loaded!, name: 'renamed' })
    const again = await db.getPolicy('legacy-1')
    expect(again!.name).toBe('renamed')
    expect(again!.timezone).toBeUndefined()

    // Re-opening is idempotent (ALTER TABLE already applied).
    expect(() => new Database(dbPath)).not.toThrow()
  })

  it('stack auto-protect runs at 02:00 in the zone it is given, UTC otherwise', async () => {
    const db = new Database(path.join(tmp, 'stack.db'))
    const pm = new PolicyManager(db, path.join(tmp, 'staging'))
    const stack = { containers: [], volumes: ['data'] }

    const mine = await pm.protectStack('web', stack, 'America/Chicago')
    expect(mine.schedule).toBe('0 2 * * *')
    expect(mine.timezone).toBe('America/Chicago')

    const cli = await pm.protectStack('api', stack)
    expect(cli.timezone).toBe('UTC')
  })

  it('new policies default to UTC when no zone is given (CLI / API / stack protect) and keep a given zone', async () => {
    const db = new Database(path.join(tmp, 'new.db'))
    const pm = new PolicyManager(db, path.join(tmp, 'staging'))

    const noZone = await pm.createPolicy({ name: 'from-cli' })
    expect(noZone.timezone).toBe('UTC')
    expect((await pm.getPolicy(noZone.id))!.timezone).toBe('UTC')

    const chicago = await pm.createPolicy({ name: 'from-ui', timezone: 'America/Chicago' })
    expect((await pm.getPolicy(chicago.id))!.timezone).toBe('America/Chicago')

    const moved = await pm.updatePolicy(noZone.id, { timezone: 'America/Chicago' })
    expect(moved.timezone).toBe('America/Chicago')
    expect((await pm.getPolicy(noZone.id))!.timezone).toBe('America/Chicago')

    // An update that does not mention the zone leaves it alone.
    const renamed = await pm.updatePolicy(chicago.id, { name: 'renamed' })
    expect(renamed.timezone).toBe('America/Chicago')
  })
})
