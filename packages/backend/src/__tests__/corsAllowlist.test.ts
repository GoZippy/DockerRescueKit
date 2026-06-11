import { parseCorsOrigins, isOriginAllowed } from '../index'

describe('CORS allowlist helpers', () => {
  describe('parseCorsOrigins', () => {
    it('returns [] for undefined / empty', () => {
      expect(parseCorsOrigins(undefined)).toEqual([])
      expect(parseCorsOrigins('')).toEqual([])
      expect(parseCorsOrigins('   ')).toEqual([])
    })

    it('splits and trims comma-separated origins', () => {
      expect(parseCorsOrigins('https://a.com, https://b.com ,https://c.com'))
        .toEqual(['https://a.com', 'https://b.com', 'https://c.com'])
    })

    it('drops empty segments from trailing commas', () => {
      expect(parseCorsOrigins('https://a.com,,')).toEqual(['https://a.com'])
    })
  })

  describe('isOriginAllowed', () => {
    it('allows requests with no Origin header (CLI/curl/same-origin/socket)', () => {
      expect(isOriginAllowed(undefined, [])).toBe(true)
    })

    it('allows any localhost origin on any port', () => {
      expect(isOriginAllowed('http://localhost', [])).toBe(true)
      expect(isOriginAllowed('http://localhost:3000', [])).toBe(true)
      expect(isOriginAllowed('https://localhost:42880', [])).toBe(true)
    })

    it('allows 127.0.0.1 and [::1] loopback on any port', () => {
      expect(isOriginAllowed('http://127.0.0.1:5173', [])).toBe(true)
      expect(isOriginAllowed('http://[::1]:8080', [])).toBe(true)
    })

    it('allows origins explicitly listed in the allowlist', () => {
      const allow = ['https://dashboard.example.com']
      expect(isOriginAllowed('https://dashboard.example.com', allow)).toBe(true)
    })

    it('denies arbitrary remote origins not in the allowlist', () => {
      expect(isOriginAllowed('https://evil.example.com', [])).toBe(false)
      expect(isOriginAllowed('http://attacker.test', ['https://ok.test'])).toBe(false)
    })

    it('denies a malformed Origin header', () => {
      expect(isOriginAllowed('not-a-url', [])).toBe(false)
    })

    it('does not treat a hostname that merely contains "localhost" as loopback', () => {
      expect(isOriginAllowed('http://localhost.evil.com', [])).toBe(false)
    })
  })
})
