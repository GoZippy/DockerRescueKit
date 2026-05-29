import net from 'net'
import dns from 'dns/promises'
import { URL } from 'url'

/**
 * SSRF guard for connector endpoint / host fields. Blocks loopback,
 * link-local (incl. cloud metadata service 169.254.169.254), and
 * RFC1918 private ranges by default.
 *
 * Homelab users (DRK's primary audience) frequently target RFC1918 hosts
 * for SMB/SFTP/Proxmox/TrueNAS, so an override is supported via
 * `DRK_SSRF_ALLOWLIST` (csv of CIDRs). Empty default = strict.
 *
 * Scope (F1 / v1.3-connectors / DR-001):
 *   Applied at ConnectorManager.testInstance() + discoverResources() in
 *   Sprint 2 wiring step. Proxmox/TrueNAS/PBS/S3 go through here.
 *   SFTP and Rclone bypass at the network layer (they don't take URLs)
 *   and are noted as separate concerns.
 *
 * Use:
 *   await SsrfGuard.assertSafe('https://192.168.1.50:8006')
 *   await SsrfGuard.assertSafe('s3.amazonaws.com')
 */

const RFC1918_CIDRS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
]

const LOOPBACK_CIDRS = [
  '127.0.0.0/8',
  '::1/128',
]

const LINK_LOCAL_CIDRS = [
  '169.254.0.0/16',   // includes 169.254.169.254 (cloud metadata)
  'fe80::/10',        // IPv6 link-local
]

const UNIQUE_LOCAL_CIDRS_V6 = [
  'fc00::/7',
]

const DEFAULT_DENY = [
  ...LOOPBACK_CIDRS,
  ...LINK_LOCAL_CIDRS,
  ...RFC1918_CIDRS,
  ...UNIQUE_LOCAL_CIDRS_V6,
]

export class SsrfBlockedError extends Error {
  public readonly target: string
  public readonly resolved: string
  public readonly reason: string

  constructor(target: string, resolved: string, reason: string) {
    super(`SSRF guard blocked target '${target}' (resolved to ${resolved}): ${reason}`)
    this.name = 'SsrfBlockedError'
    this.target = target
    this.resolved = resolved
    this.reason = reason
  }
}

interface SsrfGuardOptions {
  /** Override the deny list entirely (rarely needed). */
  deny?: string[]
  /** CIDRs that escape the deny list. Read from env by default. */
  allowlist?: string[]
  /** DNS resolution timeout in ms (default 3000). */
  dnsTimeoutMs?: number
}

export class SsrfGuard {
  /**
   * Throw `SsrfBlockedError` if the target hostname resolves to a denied
   * IP (and is not allowlisted). Accepts:
   *   - bare hosts          ("backup.local")
   *   - URLs                ("https://192.168.1.50:8006")
   *   - host:port           ("192.168.1.50:22")
   *   - IPv6 in brackets    ("[fe80::1]")
   */
  static async assertSafe(target: string, opts: SsrfGuardOptions = {}): Promise<void> {
    if (!target || typeof target !== 'string') {
      throw new SsrfBlockedError(String(target), '', 'empty or non-string target')
    }

    const host = this.extractHost(target)
    if (!host) {
      throw new SsrfBlockedError(target, '', 'no host found in target string')
    }

    const deny = opts.deny ?? DEFAULT_DENY
    const allowlist = opts.allowlist ?? this.envAllowlist()

    const addrs = await this.resolveAll(host, opts.dnsTimeoutMs ?? 3000)
    if (addrs.length === 0) {
      throw new SsrfBlockedError(target, host, 'host could not be resolved')
    }

    for (const addr of addrs) {
      if (this.inAny(addr, allowlist)) continue
      if (this.inAny(addr, deny)) {
        throw new SsrfBlockedError(target, addr, `address in denied range`)
      }
    }
  }

  static envAllowlist(): string[] {
    const raw = process.env.DRK_SSRF_ALLOWLIST?.trim()
    if (!raw) return []
    return raw.split(',').map(s => s.trim()).filter(Boolean)
  }

  static extractHost(target: string): string | null {
    let candidate = target.trim()
    // URL form: pull hostname out
    if (candidate.includes('://')) {
      try {
        const u = new URL(candidate)
        return u.hostname.replace(/^\[|\]$/g, '')
      } catch {
        return null
      }
    }
    // [ipv6]:port form
    const ipv6Match = candidate.match(/^\[([^\]]+)\](?::\d+)?$/)
    if (ipv6Match) return ipv6Match[1]
    // host:port form (strip the port)
    if (candidate.includes(':') && net.isIP(candidate) === 0) {
      candidate = candidate.split(':')[0]
    }
    return candidate || null
  }

  static async resolveAll(host: string, timeoutMs: number): Promise<string[]> {
    // Pass through if already an IP literal.
    if (net.isIP(host) !== 0) return [host]

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`DNS timeout after ${timeoutMs}ms`)), timeoutMs)
    )
    try {
      const results = await Promise.race([
        dns.lookup(host, { all: true }),
        timeout,
      ])
      return (results as { address: string }[]).map(r => r.address)
    } catch (err) {
      // DNS failure → caller will treat as blocked.
      return []
    }
  }

  static inAny(addr: string, cidrs: string[]): boolean {
    return cidrs.some(c => this.inCidr(addr, c))
  }

  static inCidr(addr: string, cidr: string): boolean {
    if (!cidr.includes('/')) return false
    const [rangeRaw, bitsRaw] = cidr.split('/')
    const bits = parseInt(bitsRaw, 10)
    if (Number.isNaN(bits)) return false

    const addrFamily = net.isIP(addr)
    const rangeFamily = net.isIP(rangeRaw)
    if (addrFamily === 0 || rangeFamily === 0) return false
    if (addrFamily !== rangeFamily) return false

    if (addrFamily === 4) {
      const a = this.ipv4ToInt(addr)
      const r = this.ipv4ToInt(rangeRaw)
      if (a === null || r === null) return false
      if (bits === 0) return true
      const mask = (0xffffffff << (32 - bits)) >>> 0
      return (a & mask) === (r & mask)
    } else {
      const a = this.ipv6ToBytes(addr)
      const r = this.ipv6ToBytes(rangeRaw)
      if (!a || !r) return false
      const fullBytes = Math.floor(bits / 8)
      const remBits = bits % 8
      for (let i = 0; i < fullBytes; i++) {
        if (a[i] !== r[i]) return false
      }
      if (remBits > 0) {
        const mask = (0xff << (8 - remBits)) & 0xff
        if ((a[fullBytes] & mask) !== (r[fullBytes] & mask)) return false
      }
      return true
    }
  }

  static ipv4ToInt(ip: string): number | null {
    const parts = ip.split('.').map(Number)
    if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) return null
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  }

  static ipv6ToBytes(ip: string): number[] | null {
    // Minimal IPv6 expansion. Good enough for CIDR matching of canonical
    // forms; doesn't try to validate against all RFC 4291 edge cases.
    if (ip.includes('::')) {
      const [left, right] = ip.split('::')
      const leftParts = left ? left.split(':') : []
      const rightParts = right ? right.split(':') : []
      const missing = 8 - leftParts.length - rightParts.length
      if (missing < 0) return null
      const middle = Array(missing).fill('0')
      const parts = [...leftParts, ...middle, ...rightParts]
      return this.expandHextets(parts)
    }
    const parts = ip.split(':')
    if (parts.length !== 8) return null
    return this.expandHextets(parts)
  }

  static expandHextets(parts: string[]): number[] | null {
    const bytes: number[] = []
    for (const p of parts) {
      const n = parseInt(p || '0', 16)
      if (Number.isNaN(n) || n < 0 || n > 0xffff) return null
      bytes.push((n >> 8) & 0xff, n & 0xff)
    }
    return bytes.length === 16 ? bytes : null
  }
}
