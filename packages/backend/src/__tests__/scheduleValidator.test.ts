import cron from 'node-cron'

describe('cron.validate (sanity-check for policy input)', () => {
  it('accepts standard 5-field expressions', () => {
    expect(cron.validate('0 2 * * *')).toBe(true)
    expect(cron.validate('0 */6 * * *')).toBe(true)
    expect(cron.validate('0 4 * * 0')).toBe(true)
    expect(cron.validate('0 5 1 * *')).toBe(true)
  })

  it('rejects obviously malformed input', () => {
    expect(cron.validate('not a cron')).toBe(false)
    expect(cron.validate('99 99 99 * *')).toBe(false)
    expect(cron.validate('')).toBe(false)
  })
})
