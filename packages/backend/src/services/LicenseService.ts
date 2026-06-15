import crypto from 'crypto'
import { SettingsService } from './SettingsService'
import { logger } from '../utils/logger'

// ---------------------------------------------------------------------------
// Tier and feature model
// ---------------------------------------------------------------------------
//
// Source of truth: Schedule A in /LICENSE (Zippy Tech Source-Available
// Commercial License v1.3). Any change here is also a license-text change —
// keep both in sync.

export type LicenseTier = 'free' | 'personal-pro' | 'commercial-pro' | 'enterprise'

export type LicenseFeature =
  | 'unlimited_policies'
  | 'notifications'
  // byok_encryption gates BRING-YOUR-OWN / customer-managed encryption keys
  // (supplying + rotating your own key). Baseline AES-256 encryption at rest
  // is ALWAYS ON for every tier regardless of this flag — see Schedule A.
  // NOTE: enforcement of the customer-managed-key UX is pending; see
  // docs/BYOK_FEATURE_SPEC.md. Do NOT gate EncryptionUtility/VaultService on
  // this flag — that would risk orphaning existing encrypted vault data.
  | 'byok_encryption'
  | 'audit_log_90d'
  | 'audit_log_365d'
  | 'audit_log_unlimited'
  | 'multi_host_fleet'
  | 'rbac'
  | 'sso'
  | 'worm'
  | 'compliance_docs'
  | 'msp_white_label'
  | 'managed_cloud_backup'

const FEATURES_BY_TIER: Record<LicenseTier, ReadonlySet<LicenseFeature>> = {
  free: new Set(),
  'personal-pro': new Set<LicenseFeature>([
    'unlimited_policies',
    'notifications',
    'byok_encryption',
    'audit_log_90d',
  ]),
  'commercial-pro': new Set<LicenseFeature>([
    'unlimited_policies',
    'notifications',
    'byok_encryption',
    'audit_log_365d',
    'multi_host_fleet',
  ]),
  enterprise: new Set<LicenseFeature>([
    'unlimited_policies',
    'notifications',
    'byok_encryption',
    'audit_log_unlimited',
    'multi_host_fleet',
    'rbac',
    'sso',
    'worm',
    'compliance_docs',
    'msp_white_label',
    'managed_cloud_backup',
  ]),
}

export const FREE_TIER_POLICY_LIMIT = 5
export const FREE_TIER_AUDIT_RETENTION_DAYS = 14
export const OFFLINE_GRACE_DAYS = 30

/**
 * Audit-log retention window (in days) implied by a feature set.
 * `null` means UNLIMITED — never trim. Free tier (no audit_log_* feature)
 * falls back to FREE_TIER_AUDIT_RETENTION_DAYS.
 *
 * Derived from the audit_log_* features in FEATURES_BY_TIER so the two stay
 * coupled: personal-pro → 90d, commercial-pro → 365d, enterprise → unlimited.
 */
export function auditRetentionDaysForFeatures(
  features: readonly LicenseFeature[]
): number | null {
  if (features.includes('audit_log_unlimited')) return null
  if (features.includes('audit_log_365d')) return 365
  if (features.includes('audit_log_90d')) return 90
  return FREE_TIER_AUDIT_RETENTION_DAYS
}

// ---------------------------------------------------------------------------
// JWT claim shape — what the license server signs
// ---------------------------------------------------------------------------

interface LicenseClaims {
  iss: string             // license server issuer (e.g. "license.gozippy.com")
  sub: string             // license id
  aud: string             // must be "drk"
  tier: LicenseTier
  seats?: number          // commercial-pro only
  features?: LicenseFeature[]   // explicit override; falls back to tier defaults
  major_version?: string  // for Personal Pro lifetime entitlement on a major version (e.g. "1")
  launch_lock_in?: boolean
  iat: number             // issued at (seconds since epoch)
  exp?: number            // expiry (seconds since epoch); undefined for one-time Personal Pro
  jti?: string            // unique id, used by license server for revocation
}

export interface LicenseStatus {
  tier: LicenseTier
  seats: number
  features: LicenseFeature[]
  majorVersion?: string
  launchLockIn: boolean
  expiresAt?: Date
  /** True when the cached verification is past its 24h freshness window but
   *  still within the 30-day offline grace period. */
  staleButValid: boolean
  /** License id (JWT `sub`) — useful for support correspondence. */
  licenseId?: string
  /** Set when running on a placeholder/unset public key (dev mode). */
  devMode: boolean
}

// ---------------------------------------------------------------------------
// Bundled public key (RS256)
// ---------------------------------------------------------------------------
//
// Generate the real keypair with:
//   openssl genrsa -out license-private.pem 2048
//   openssl rsa -in license-private.pem -pubout -out license-public.pem
//
// Keep the private key ONLY on the license server. Paste the contents of
// license-public.pem into LICENSE_PUBLIC_KEY_PEM below (it is safe to commit).
// Until then this is a placeholder and signature verification will fail on
// any real token. To override at runtime without editing source (useful for
// CI and dev), set DRK_LICENSE_PUBLIC_KEY to a full PEM string.

// Production public key issued 2026-05-25. Matches the private key held
// only on the license server (CT 94002, drk-license-server private repo).
// SAFE to commit — public-key half of the RS256 keypair.
const LICENSE_PUBLIC_KEY_PEM_DEFAULT = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyOu1/kvTqQwouz0+Q/OE
nEZKYfaWDYa1tshNdnXUsdihc//wwohQYKEwsKRfo07IYqyRZt9U4oUab3DPyRig
OVlyVN4/9tqgfWWPgwDaH/5WVo0eCwDrnay2zJ3pBoebCvvSj644jwFeWUoS1YHF
OmeFc3QaozZ/tdJtbqjI9KIjyX0nzZjhpC0nyrxACCsyD/VDcYIUw96AlpUsTGJC
beG5rx48I2Hbrovz61y8SbNmAc39jDrEWPotyDsUytiRZtd96Zcfm1arlpPIvdt8
pocn+NjHOHvMGxgE7IYOb4efiS7stk59g6pXh+Kk6Smi60Y86UV6M4c4YPP7yk4y
PQIDAQAB
-----END PUBLIC KEY-----`

function loadPublicKey(): { pem: string; isDev: boolean } {
  const fromEnv = process.env.DRK_LICENSE_PUBLIC_KEY
  if (fromEnv && fromEnv.includes('BEGIN PUBLIC KEY')) {
    return { pem: fromEnv, isDev: false }
  }
  return {
    pem: LICENSE_PUBLIC_KEY_PEM_DEFAULT,
    isDev: LICENSE_PUBLIC_KEY_PEM_DEFAULT.includes('PLACEHOLDER'),
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const SETTINGS_KEY_TOKEN = 'license.token'
const SETTINGS_KEY_LAST_OK_AT = 'license.lastVerifiedAt'

const EXPECTED_AUDIENCE = 'drk'

export class LicenseService {
  private cached: LicenseStatus | null = null
  private cachedRawToken: string | null = null
  private publicKeyPem: string
  private isDevPublicKey: boolean

  constructor(private settings?: SettingsService) {
    const { pem, isDev } = loadPublicKey()
    this.publicKeyPem = pem
    this.isDevPublicKey = isDev
  }

  /**
   * Get the current license status, refreshing from token storage if needed.
   *
   * Resolution order for the token itself:
   * 1. DRK_LICENSE_KEY env var (preferred for headless / docker-compose runs)
   * 2. settings.license.token (set by the Settings UI in the extension)
   * 3. None → Free tier
   */
  public async getStatus(): Promise<LicenseStatus> {
    const token = await this.loadToken()
    if (!token) {
      this.cached = this.freeStatus()
      this.cachedRawToken = null
      return this.cached
    }

    // Hot path: if we already verified this exact token, reuse the result.
    if (this.cachedRawToken === token && this.cached) {
      return this.cached
    }

    try {
      const claims = this.verifyToken(token)
      const status = this.statusFromClaims(claims)
      this.cached = status
      this.cachedRawToken = token
      if (this.settings) {
        await this.settings.saveSetting(SETTINGS_KEY_LAST_OK_AT, Date.now().toString())
      }
      return status
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'License verification failed')
      // Offline grace: if the most recent successful verify was within the
      // grace window, keep the previously cached status but mark it stale.
      const grace = await this.checkOfflineGrace()
      if (grace) return grace
      this.cached = this.freeStatus()
      this.cachedRawToken = null
      return this.cached
    }
  }

  public async getTier(): Promise<LicenseTier> {
    return (await this.getStatus()).tier
  }

  public async hasFeature(feature: LicenseFeature): Promise<boolean> {
    return (await this.getStatus()).features.includes(feature)
  }

  public async getSeats(): Promise<number> {
    return (await this.getStatus()).seats
  }

  /** Persist a pasted license token to settings storage. */
  public async setToken(token: string): Promise<LicenseStatus> {
    if (!this.settings) {
      throw new Error('Cannot persist license token without SettingsService')
    }
    await this.settings.saveSetting(SETTINGS_KEY_TOKEN, token)
    this.cached = null
    this.cachedRawToken = null
    return this.getStatus()
  }

  public async clearToken(): Promise<void> {
    if (this.settings) {
      await this.settings.saveSetting(SETTINGS_KEY_TOKEN, '')
    }
    this.cached = null
    this.cachedRawToken = null
  }

  /**
   * Online revocation check against the license server.
   *
   * Posts the current token to `${DRK_LICENSE_SERVER_URL}/license/verify`
   * and applies the server's authoritative status (active / expired /
   * refunded / revoked). Locally-valid signatures alone don't tell us
   * about server-side revocation — a refunded customer's JWT still has a
   * valid signature, but the server's `licenses.status` reads 'refunded'.
   *
   * Behavior:
   *   - No-op when DRK_LICENSE_SERVER_URL is not set (offline-only mode).
   *   - On network failure, leaves the local cache alone (offline grace
   *     remains in effect for up to OFFLINE_GRACE_DAYS).
   *   - On a 200 with status='active', refreshes the lastVerifiedAt
   *     timestamp so the grace window resets.
   *   - On a 200 with status != 'active', downgrades to Free immediately.
   *   - On 4xx (token mismatch / forged / unknown), downgrades to Free.
   *
   * Callers should invoke this on app start and then periodically (every
   * 24h works for most deployments — Square webhook events propagate to
   * the license server in seconds, so 24h is the maximum staleness
   * window for revocations).
   */
  public async refreshFromServer(): Promise<LicenseStatus> {
    const serverUrl = process.env.DRK_LICENSE_SERVER_URL
    if (!serverUrl) return this.getStatus()

    const token = await this.loadToken()
    if (!token) return this.getStatus()

    try {
      const url = serverUrl.replace(/\/+$/, '') + '/license/verify'
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })

      if (res.status >= 400 && res.status < 500) {
        logger.warn({ status: res.status }, 'License server rejected token; downgrading to Free')
        this.cached = this.freeStatus()
        this.cachedRawToken = null
        return this.cached
      }
      if (!res.ok) {
        logger.warn({ status: res.status }, 'License server returned non-2xx; keeping cached status under offline grace')
        return this.getStatus()
      }

      const body = await res.json() as {
        status: string
        tier: LicenseTier
        seats: number
        features: LicenseFeature[]
        expires_at: number | null
        launch_lock_in: boolean
        major_version: string | null
      }

      if (body.status !== 'active') {
        logger.warn({ serverStatus: body.status }, 'License server reports non-active status; downgrading to Free')
        this.cached = this.freeStatus()
        this.cachedRawToken = null
        return this.cached
      }

      // Server says active — refresh the grace-window timestamp and
      // adopt the server's view of features (it can scope down, never
      // up; the verifier checks intersection anyway when minting).
      if (this.settings) {
        await this.settings.saveSetting(SETTINGS_KEY_LAST_OK_AT, Date.now().toString())
      }
      this.cached = {
        tier: body.tier,
        seats: body.seats,
        features: body.features,
        majorVersion: body.major_version || undefined,
        launchLockIn: body.launch_lock_in === true,
        expiresAt: body.expires_at ? new Date(body.expires_at) : undefined,
        staleButValid: false,
        devMode: this.isDevPublicKey,
      }
      this.cachedRawToken = token
      return this.cached
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'License server unreachable; keeping cached status under offline grace')
      return this.getStatus()
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async loadToken(): Promise<string | null> {
    const envToken = process.env.DRK_LICENSE_KEY
    if (envToken && envToken.trim()) return envToken.trim()
    if (this.settings) {
      const stored = await this.settings.getSetting(SETTINGS_KEY_TOKEN)
      if (stored && stored.trim()) return stored.trim()
    }
    return null
  }

  private freeStatus(): LicenseStatus {
    return {
      tier: 'free',
      seats: 1,
      features: Array.from(FEATURES_BY_TIER.free),
      launchLockIn: false,
      staleButValid: false,
      devMode: this.isDevPublicKey,
    }
  }

  private statusFromClaims(claims: LicenseClaims): LicenseStatus {
    const tierFeatures = Array.from(FEATURES_BY_TIER[claims.tier] || [])
    // If the issuer includes an explicit `features` array, intersect it with
    // the tier-level set — server can scope a license DOWN, never up.
    const features = claims.features
      ? claims.features.filter(f => tierFeatures.includes(f))
      : tierFeatures
    return {
      tier: claims.tier,
      seats: claims.seats ?? 1,
      features,
      majorVersion: claims.major_version,
      launchLockIn: claims.launch_lock_in === true,
      expiresAt: claims.exp ? new Date(claims.exp * 1000) : undefined,
      staleButValid: false,
      licenseId: claims.sub,
      devMode: this.isDevPublicKey,
    }
  }

  private async checkOfflineGrace(): Promise<LicenseStatus | null> {
    if (!this.settings || !this.cached) return null
    const raw = await this.settings.getSetting(SETTINGS_KEY_LAST_OK_AT)
    if (!raw) return null
    const lastOk = Number(raw)
    if (!Number.isFinite(lastOk)) return null
    const ageMs = Date.now() - lastOk
    if (ageMs > OFFLINE_GRACE_DAYS * 24 * 60 * 60 * 1000) return null
    return { ...this.cached, staleButValid: true }
  }

  /**
   * Minimal RS256 JWT verification using Node built-in crypto.
   *
   * Why not jsonwebtoken / jose: the verify path is 30 lines, has no
   * dependency surface, and keeps the supply chain tighter for a security
   * sensitive component (license bypass via dep takeover would be ugly).
   * Re-evaluate adding jose when we need JWKS rotation or other features
   * that justify the dep.
   */
  private verifyToken(token: string): LicenseClaims {
    const parts = token.split('.')
    if (parts.length !== 3) throw new Error('Malformed JWT: expected 3 segments')
    const [headerB64, payloadB64, sigB64] = parts

    const header = JSON.parse(b64urlDecode(headerB64).toString('utf8'))
    if (header.alg !== 'RS256') throw new Error(`Unsupported alg: ${header.alg}`)
    if (header.typ && header.typ !== 'JWT') throw new Error(`Unsupported typ: ${header.typ}`)

    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`)
    const signature = b64urlDecode(sigB64)
    const ok = crypto.verify(
      'RSA-SHA256',
      signingInput,
      this.publicKeyPem,
      signature
    )
    if (!ok) throw new Error('Signature verification failed')

    const claims = JSON.parse(b64urlDecode(payloadB64).toString('utf8')) as LicenseClaims
    if (claims.aud !== EXPECTED_AUDIENCE) {
      throw new Error(`Audience mismatch: expected "${EXPECTED_AUDIENCE}", got "${claims.aud}"`)
    }
    const nowSec = Math.floor(Date.now() / 1000)
    if (claims.exp !== undefined && claims.exp < nowSec) {
      throw new Error('Token expired')
    }
    if (!FEATURES_BY_TIER[claims.tier]) {
      throw new Error(`Unknown tier: ${claims.tier}`)
    }
    return claims
  }
}

function b64urlDecode(input: string): Buffer {
  // RFC 7515 base64url: replace -/_ with +/, pad to %4
  const replaced = input.replace(/-/g, '+').replace(/_/g, '/')
  const pad = replaced.length % 4 === 0 ? '' : '='.repeat(4 - (replaced.length % 4))
  return Buffer.from(replaced + pad, 'base64')
}
