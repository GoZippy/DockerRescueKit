import { SsrfGuard, SsrfBlockedError } from '../../security/SsrfGuard'

describe('SsrfGuard', () => {
  describe('extractHost', () => {
    it.each([
      ['https://192.168.1.50:8006', '192.168.1.50'],
      ['http://backup.local', 'backup.local'],
      ['s3.amazonaws.com', 's3.amazonaws.com'],
      ['192.168.1.50:22', '192.168.1.50'],
      ['[fe80::1]:22', 'fe80::1'],
      ['[::1]', '::1'],
      ['https://[2001:db8::1]:443/path', '2001:db8::1'],
    ])('extracts %s -> %s', (input, expected) => {
      expect(SsrfGuard.extractHost(input)).toBe(expected)
    })

    it('returns null for invalid URLs', () => {
      expect(SsrfGuard.extractHost('://broken')).toBe(null)
    })
  })

  describe('inCidr (IPv4)', () => {
    it.each([
      ['127.0.0.1', '127.0.0.0/8', true],
      ['127.255.255.254', '127.0.0.0/8', true],
      ['128.0.0.1', '127.0.0.0/8', false],
      ['169.254.169.254', '169.254.0.0/16', true],
      ['10.5.5.5', '10.0.0.0/8', true],
      ['11.0.0.1', '10.0.0.0/8', false],
      ['192.168.1.1', '192.168.0.0/16', true],
      ['192.169.1.1', '192.168.0.0/16', false],
      ['172.16.0.1', '172.16.0.0/12', true],
      ['172.31.255.254', '172.16.0.0/12', true],
      ['172.32.0.1', '172.16.0.0/12', false],
      ['8.8.8.8', '0.0.0.0/0', true],
    ])('inCidr(%s, %s) -> %s', (addr, cidr, want) => {
      expect(SsrfGuard.inCidr(addr, cidr)).toBe(want)
    })
  })

  describe('inCidr (IPv6)', () => {
    it.each([
      ['::1', '::1/128', true],
      ['fe80::1', 'fe80::/10', true],
      ['fc00::1', 'fc00::/7', true],
      ['fdff::1', 'fc00::/7', true],
      ['2001:db8::1', 'fc00::/7', false],
    ])('inCidr(%s, %s) -> %s', (addr, cidr, want) => {
      expect(SsrfGuard.inCidr(addr, cidr)).toBe(want)
    })
  })

  describe('assertSafe — default posture (cloud-metadata only)', () => {
    it.each([
      'http://169.254.169.254',     // AWS/GCP/Azure metadata
      '169.254.169.254:80',
      'http://[fd00:ec2::254]',     // AWS IMDSv6
    ])('blocks cloud metadata %s', async (target) => {
      await expect(SsrfGuard.assertSafe(target)).rejects.toBeInstanceOf(SsrfBlockedError)
    })

    it.each([
      'http://127.0.0.1',
      'http://10.0.0.1',
      'http://172.16.0.1',
      'http://192.168.1.50',
      '[::1]',
      'http://[fc00::1]',
    ])('allows %s (homelab default)', async (target) => {
      await expect(SsrfGuard.assertSafe(target)).resolves.toBeUndefined()
    })
  })

  describe('assertSafe — strict posture (DRK_SSRF_STRICT)', () => {
    let prev: string | undefined
    beforeEach(() => { prev = process.env.DRK_SSRF_STRICT; process.env.DRK_SSRF_STRICT = '1' })
    afterEach(() => {
      if (prev === undefined) delete process.env.DRK_SSRF_STRICT
      else process.env.DRK_SSRF_STRICT = prev
    })

    it.each([
      'http://127.0.0.1',
      'http://169.254.169.254',
      'http://10.0.0.1',
      'http://172.16.0.1',
      'http://192.168.1.50',
      '127.0.0.1:8080',
      '[::1]',
      '[fe80::1]',
      'http://[fc00::1]',
    ])('blocks %s', async (target) => {
      await expect(SsrfGuard.assertSafe(target)).rejects.toBeInstanceOf(SsrfBlockedError)
    })
  })

  describe('assertSafe — allowlist override', () => {
    it('allows RFC1918 when allowlist matches', async () => {
      await expect(
        SsrfGuard.assertSafe('http://192.168.1.50', { allowlist: ['192.168.0.0/16'] })
      ).resolves.toBeUndefined()
    })

    it('still blocks targets outside the allowlist', async () => {
      await expect(
        SsrfGuard.assertSafe('http://169.254.169.254', { allowlist: ['192.168.0.0/16'] })
      ).rejects.toBeInstanceOf(SsrfBlockedError)
    })

    it('reads DRK_SSRF_ALLOWLIST env var', () => {
      const prev = process.env.DRK_SSRF_ALLOWLIST
      process.env.DRK_SSRF_ALLOWLIST = '10.0.0.0/8, 192.168.0.0/16'
      try {
        expect(SsrfGuard.envAllowlist()).toEqual(['10.0.0.0/8', '192.168.0.0/16'])
      } finally {
        if (prev === undefined) delete process.env.DRK_SSRF_ALLOWLIST
        else process.env.DRK_SSRF_ALLOWLIST = prev
      }
    })

    it('returns empty when env var unset', () => {
      const prev = process.env.DRK_SSRF_ALLOWLIST
      delete process.env.DRK_SSRF_ALLOWLIST
      try {
        expect(SsrfGuard.envAllowlist()).toEqual([])
      } finally {
        if (prev !== undefined) process.env.DRK_SSRF_ALLOWLIST = prev
      }
    })
  })

  describe('assertSafe — edge cases', () => {
    it('rejects empty target', async () => {
      await expect(SsrfGuard.assertSafe('')).rejects.toBeInstanceOf(SsrfBlockedError)
    })

    it('rejects non-string target', async () => {
      await expect(SsrfGuard.assertSafe(null as any)).rejects.toBeInstanceOf(SsrfBlockedError)
    })

    it('rejects DNS-unresolvable host (treated as block)', async () => {
      // Use a TLD reserved for testing that should never resolve.
      await expect(
        SsrfGuard.assertSafe('http://does-not-exist.invalid', { dnsTimeoutMs: 1000 })
      ).rejects.toBeInstanceOf(SsrfBlockedError)
    })

    it('error surfaces resolved address + reason', async () => {
      try {
        await SsrfGuard.assertSafe('http://169.254.169.254:8080')
        fail('expected throw')
      } catch (err) {
        expect(err).toBeInstanceOf(SsrfBlockedError)
        const e = err as SsrfBlockedError
        expect(e.target).toBe('http://169.254.169.254:8080')
        expect(e.resolved).toBe('169.254.169.254')
        expect(e.reason).toMatch(/denied range/)
      }
    })
  })
})
