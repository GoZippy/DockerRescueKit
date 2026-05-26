import crypto from 'crypto'
import { LicenseService, LicenseTier } from '../services/LicenseService'

// In-memory stand-in for SettingsService (keeps the test self-contained).
class MemorySettings {
  private store = new Map<string, string>()
  async getSetting(key: string, def?: string): Promise<string | undefined> {
    return this.store.has(key) ? this.store.get(key)! : def
  }
  async saveSetting(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }
  // Booleans not exercised here; preserve method surface for type-compat.
  async getBooleanSetting(): Promise<boolean> { return false }
  async saveBooleanSetting(): Promise<void> { /* noop */ }
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

function signToken(payload: Record<string, unknown>): string {
  const header = { alg: 'RS256', typ: 'JWT' }
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const signingInput = `${enc(header)}.${enc(payload)}`
  const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url')
  return `${signingInput}.${sig}`
}

function makeService(): LicenseService {
  // Override the bundled placeholder public key via the env hook so we can
  // verify against the test keypair without modifying source.
  process.env.DRK_LICENSE_PUBLIC_KEY = publicKey
  // Force a fresh load
  return new LicenseService(new MemorySettings() as any)
}

afterEach(() => {
  delete process.env.DRK_LICENSE_KEY
  delete process.env.DRK_LICENSE_PUBLIC_KEY
})

describe('LicenseService', () => {
  it('returns Free tier when no token is configured', async () => {
    const svc = makeService()
    const s = await svc.getStatus()
    expect(s.tier).toBe('free')
    expect(s.features).toEqual([])
    expect(s.seats).toBe(1)
  })

  it('verifies a well-formed Personal Pro token and exposes its features', async () => {
    const svc = makeService()
    const token = signToken({
      iss: 'license.gozippy.com',
      sub: 'lic-abc',
      aud: 'drk',
      tier: 'personal-pro' as LicenseTier,
      major_version: '1',
      iat: Math.floor(Date.now() / 1000),
    })
    process.env.DRK_LICENSE_KEY = token
    const s = await svc.getStatus()
    expect(s.tier).toBe('personal-pro')
    expect(s.licenseId).toBe('lic-abc')
    expect(s.features).toContain('notifications')
    expect(s.features).toContain('byok_encryption')
    expect(s.features).toContain('unlimited_policies')
    expect(s.features).not.toContain('multi_host_fleet')
    expect(s.majorVersion).toBe('1')
  })

  it('Commercial Pro grants multi_host_fleet and seats', async () => {
    const svc = makeService()
    const token = signToken({
      iss: 'license.gozippy.com',
      sub: 'lic-xyz',
      aud: 'drk',
      tier: 'commercial-pro' as LicenseTier,
      seats: 5,
      launch_lock_in: true,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
    })
    process.env.DRK_LICENSE_KEY = token
    const s = await svc.getStatus()
    expect(s.tier).toBe('commercial-pro')
    expect(s.seats).toBe(5)
    expect(s.launchLockIn).toBe(true)
    expect(s.features).toContain('multi_host_fleet')
    expect(s.features).toContain('audit_log_365d')
  })

  it('rejects a token with the wrong audience', async () => {
    const svc = makeService()
    process.env.DRK_LICENSE_KEY = signToken({
      iss: 'license.gozippy.com', sub: 'lic-1', aud: 'someoneelse',
      tier: 'personal-pro', iat: Math.floor(Date.now() / 1000),
    })
    const s = await svc.getStatus()
    expect(s.tier).toBe('free')
  })

  it('rejects an expired token (falls back to Free without grace cache)', async () => {
    const svc = makeService()
    process.env.DRK_LICENSE_KEY = signToken({
      iss: 'license.gozippy.com', sub: 'lic-2', aud: 'drk',
      tier: 'personal-pro', iat: 1, exp: 2,
    })
    const s = await svc.getStatus()
    expect(s.tier).toBe('free')
  })

  it('rejects a token signed with a different key', async () => {
    const svc = makeService()
    const other = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    const header = { alg: 'RS256', typ: 'JWT' }
    const payload = {
      iss: 'evil.example.com', sub: 'lic-bad', aud: 'drk',
      tier: 'enterprise', iat: Math.floor(Date.now() / 1000),
    }
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const signingInput = `${enc(header)}.${enc(payload)}`
    const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), other.privateKey).toString('base64url')
    process.env.DRK_LICENSE_KEY = `${signingInput}.${sig}`
    const s = await svc.getStatus()
    expect(s.tier).toBe('free')
  })

  it('intersects explicit features against tier defaults (server can scope down, not up)', async () => {
    const svc = makeService()
    process.env.DRK_LICENSE_KEY = signToken({
      iss: 'license.gozippy.com', sub: 'lic-3', aud: 'drk',
      tier: 'personal-pro',
      // Server tries to grant enterprise-only features through claims —
      // service must drop them since the tier doesn't include them.
      features: ['notifications', 'rbac', 'sso'],
      iat: Math.floor(Date.now() / 1000),
    })
    const s = await svc.getStatus()
    expect(s.features).toContain('notifications')
    expect(s.features).not.toContain('rbac')
    expect(s.features).not.toContain('sso')
  })

  it('hasFeature returns true only for tier-granted features', async () => {
    const svc = makeService()
    process.env.DRK_LICENSE_KEY = signToken({
      iss: 'license.gozippy.com', sub: 'lic-4', aud: 'drk',
      tier: 'commercial-pro', seats: 3,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    expect(await svc.hasFeature('notifications')).toBe(true)
    expect(await svc.hasFeature('multi_host_fleet')).toBe(true)
    expect(await svc.hasFeature('rbac')).toBe(false)
  })

  it('falls back to Free when a token signed by an unknown key is presented against the bundled production key', async () => {
    // Service uses the bundled LICENSE_PUBLIC_KEY_PEM_DEFAULT (a real
    // production key as of 2026-05-25). A token signed by a different
    // ephemeral test key must not verify.
    delete process.env.DRK_LICENSE_PUBLIC_KEY
    const svc = new LicenseService(new MemorySettings() as any)
    process.env.DRK_LICENSE_KEY = signToken({
      iss: 'license.gozippy.com', sub: 'lic-5', aud: 'drk',
      tier: 'personal-pro', iat: Math.floor(Date.now() / 1000),
    })
    const s = await svc.getStatus()
    expect(s.tier).toBe('free')
    // Production key bundled (not the placeholder), so devMode is false.
    expect(s.devMode).toBe(false)
  })
})
