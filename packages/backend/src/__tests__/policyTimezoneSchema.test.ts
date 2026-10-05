import { CreatePolicySchema, UpdatePolicySchema } from '../validation/schemas'

const base = {
  name: 'nightly',
  targets: [{ type: 'volume', selector: 'data' }],
  schedule: '0 2 * * *',
  backupType: 'full' as const,
  retention: { strategy: 'count', count: 7 },
  storage: { id: 'local-default', type: 'local' },
}

describe('CreatePolicySchema timezone', () => {
  it('is optional (CLI/API callers may omit it; the server then uses UTC)', () => {
    const r = CreatePolicySchema.safeParse(base)
    expect(r.success).toBe(true)
    expect(r.success && r.data.timezone).toBeUndefined()
  })

  it.each(['UTC', 'America/Chicago', 'Europe/London', 'Asia/Kolkata'])('accepts IANA zone %s', tz => {
    const r = CreatePolicySchema.safeParse({ ...base, timezone: tz })
    expect(r.success).toBe(true)
    expect(r.success && r.data.timezone).toBe(tz)
  })

  it.each(['Mars/Base', 'Central', '+05:00', '-0300', '', ' ', 'x'.repeat(100)])('rejects %j', tz => {
    const r = CreatePolicySchema.safeParse({ ...base, timezone: tz })
    expect(r.success).toBe(false)
  })

  it.each([5, null, true, {}, ['UTC']])('rejects non-string %j', tz => {
    expect(CreatePolicySchema.safeParse({ ...base, timezone: tz }).success).toBe(false)
  })

  it('names the field and explains what is accepted', () => {
    const r = CreatePolicySchema.safeParse({ ...base, timezone: 'Mars/Base' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.flatten().fieldErrors.timezone?.[0]).toMatch(/IANA/)
    }
  })
})

describe('UpdatePolicySchema timezone', () => {
  it('allows a partial update that sets only the zone', () => {
    const r = UpdatePolicySchema.safeParse({ timezone: 'America/Chicago' })
    expect(r.success).toBe(true)
  })

  it('allows a partial update that omits the zone', () => {
    const r = UpdatePolicySchema.safeParse({ name: 'renamed' })
    expect(r.success).toBe(true)
    expect(r.success && 'timezone' in r.data).toBe(false)
  })

  it('rejects an invalid zone', () => {
    expect(UpdatePolicySchema.safeParse({ timezone: 'Nowhere/Land' }).success).toBe(false)
  })

  it('strips the computed API fields so a fetched policy can be PUT back', () => {
    const r = UpdatePolicySchema.safeParse({ timezone: 'UTC', effectiveTimezone: 'UTC', nextRun: '2026-10-04T02:00:00.000Z' })
    expect(r.success).toBe(true)
    expect(r.success && Object.keys(r.data)).toEqual(['timezone'])
  })
})
