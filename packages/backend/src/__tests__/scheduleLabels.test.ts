/**
 * UI schedule labels.
 *
 * The extension package has no test runner of its own, and these helpers are
 * pure (no DOM, no React), so they are exercised from here, the same way CI
 * already runs the backend suite.
 */

import { humanizeCron, humanizeSchedule } from '../../../extension/src/utils/cronHumanize'
import {
  UTC,
  formatNextRun,
  getBrowserTimeZone,
  isLegacyUtcPolicy,
  isValidTimeZone,
  listTimeZones,
  policyTimeZone,
} from '../../../extension/src/utils/schedule'

describe('humanizeSchedule', () => {
  it('puts the zone next to the schedule', () => {
    expect(humanizeSchedule('0 2 * * *', 'America/Chicago')).toBe('Daily at 02:00 (America/Chicago)')
    expect(humanizeSchedule('0 4 * * 0', 'Europe/London')).toBe('Weekly — Sunday 04:00 (Europe/London)')
    expect(humanizeSchedule('30 3 * * 1-5', 'Asia/Kolkata')).toBe('Weekdays at 03:30 (Asia/Kolkata)')
  })

  it('labels a legacy policy (no zone) as UTC instead of leaving the time ambiguous', () => {
    expect(humanizeSchedule('0 2 * * *')).toBe('Daily at 02:00 (UTC)')
    expect(humanizeSchedule('0 2 * * *', undefined)).toBe('Daily at 02:00 (UTC)')
    expect(humanizeSchedule('0 2 * * *', null)).toBe('Daily at 02:00 (UTC)')
    expect(humanizeSchedule('0 2 * * *', '')).toBe('Daily at 02:00 (UTC)')
  })

  it('keeps the raw cron readable when it has no friendly form, still with the zone', () => {
    expect(humanizeSchedule('5 4 */2 * *', 'UTC')).toBe('5 4 */2 * * (UTC)')
  })

  it('leaves humanizeCron itself unchanged', () => {
    expect(humanizeCron('0 2 * * *')).toBe('Daily at 02:00')
    expect(humanizeCron('0 */6 * * *')).toBe('Every 6 hours')
    expect(humanizeCron('0 5 1 * *')).toBe('Monthly — 1st at 05:00')
  })
})

describe('policyTimeZone / isLegacyUtcPolicy', () => {
  it('prefers the zone the scheduler reports, then the stored one, then UTC', () => {
    expect(policyTimeZone({ effectiveTimezone: 'America/Chicago', timezone: 'America/Chicago' })).toBe('America/Chicago')
    expect(policyTimeZone({ timezone: 'Europe/London' })).toBe('Europe/London')
    expect(policyTimeZone({})).toBe(UTC)
    expect(policyTimeZone({ timezone: null, effectiveTimezone: null })).toBe(UTC)
  })

  it('flags only policies with no stored zone as legacy', () => {
    expect(isLegacyUtcPolicy({})).toBe(true)
    expect(isLegacyUtcPolicy({ effectiveTimezone: 'UTC' })).toBe(true) // reported zone alone is not a stored one
    expect(isLegacyUtcPolicy({ timezone: 'UTC', effectiveTimezone: 'UTC' })).toBe(false)
    expect(isLegacyUtcPolicy({ timezone: 'America/Chicago' })).toBe(false)
  })
})

describe('formatNextRun', () => {
  it('shows the next run in the viewer\'s own zone, with the zone abbreviation', () => {
    // 07:00Z is 02:00 in Chicago (CDT) and 08:00 in London (BST, UTC+1) on this date.
    expect(formatNextRun('2026-10-06T07:00:00.000Z', 'America/Chicago', 'en-US')).toMatch(/Tue, Oct 6.*2:00\sAM CDT/)
    expect(formatNextRun('2026-10-06T07:00:00.000Z', 'Europe/London', 'en-US')).toMatch(/Tue, Oct 6.*8:00\sAM/)
    expect(formatNextRun('2026-10-06T07:00:00.000Z', 'UTC', 'en-US')).toMatch(/Tue, Oct 6.*7:00\sAM UTC/)
  })

  it('follows DST: the same local 02:00 is a different instant in winter', () => {
    expect(formatNextRun('2026-12-08T08:00:00.000Z', 'America/Chicago', 'en-US')).toMatch(/Tue, Dec 8.*2:00\sAM CST/)
  })

  it('returns a dash for missing or unparsable values, never throws', () => {
    expect(formatNextRun(null)).toBe('—')
    expect(formatNextRun(undefined)).toBe('—')
    expect(formatNextRun('not a date')).toBe('—')
  })
})

describe('time-zone helpers', () => {
  it('validates IANA names and rejects offsets and junk', () => {
    expect(isValidTimeZone('America/Chicago')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    for (const bad of ['', ' UTC', '+05:00', '-03:00', 'Mars/Base', 'Central']) {
      expect(isValidTimeZone(bad)).toBe(false)
    }
  })

  it('reports a valid browser zone and lists zones with UTC first', () => {
    expect(isValidTimeZone(getBrowserTimeZone())).toBe(true)
    const zones = listTimeZones()
    expect(zones[0]).toBe('UTC')
    expect(zones).toContain('America/Chicago')
    expect(new Set(zones).size).toBe(zones.length)
  })
})
