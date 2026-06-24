import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { SecretsService } from '../services/SecretsService'

const KNOWN_DEFAULT_API_KEY = 'rescue-kit-secret-key-2026'
const KNOWN_DEFAULT_ENCRYPTION_KEY = 'super-secret-vault-key-32-chars!!'

describe('SecretsService', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'drk-secrets-'))
    // Ensure env overrides don't leak in from the shell / .env
    delete process.env.DRK_API_KEY
    delete process.env.API_KEY
    delete process.env.DRK_ENCRYPTION_KEY
    delete process.env.ENCRYPTION_KEY
  })

  afterEach(async () => {
    await fs.remove(tmp).catch(() => { /* best-effort */ })
  })

  it('fresh install generates cryptographically random, non-default secrets', () => {
    const svc = new SecretsService(path.join(tmp, 'secrets.json'))
    const secrets = svc.load()

    expect(secrets.apiKey).not.toBe(KNOWN_DEFAULT_API_KEY)
    expect(secrets.encryptionKey).not.toBe(KNOWN_DEFAULT_ENCRYPTION_KEY)
    // 32 random bytes rendered as hex => 64 chars; high-entropy.
    expect(secrets.apiKey).toMatch(/^[0-9a-f]{64}$/)
    expect(secrets.encryptionKey).toMatch(/^[0-9a-f]{64}$/)
    expect(svc.getSecurityWarnings()).toEqual([])
  })

  it('two fresh installs generate distinct secrets', () => {
    const a = new SecretsService(path.join(tmp, 'a.json')).load()
    const b = new SecretsService(path.join(tmp, 'b.json')).load()
    expect(a.apiKey).not.toBe(b.apiKey)
    expect(a.encryptionKey).not.toBe(b.encryptionKey)
  })

  it('does NOT rotate an existing secrets.json that holds default values', () => {
    const p = path.join(tmp, 'secrets.json')
    fs.writeJsonSync(p, {
      apiKey: KNOWN_DEFAULT_API_KEY,
      encryptionKey: KNOWN_DEFAULT_ENCRYPTION_KEY,
    })

    const svc = new SecretsService(p)
    const secrets = svc.load()

    // Vault data would be encrypted with the existing key — must be preserved.
    expect(secrets.apiKey).toBe(KNOWN_DEFAULT_API_KEY)
    expect(secrets.encryptionKey).toBe(KNOWN_DEFAULT_ENCRYPTION_KEY)
    const onDisk = fs.readJsonSync(p)
    expect(onDisk.encryptionKey).toBe(KNOWN_DEFAULT_ENCRYPTION_KEY)
  })

  it('emits securityWarnings when existing secrets use known defaults', () => {
    const p = path.join(tmp, 'secrets.json')
    fs.writeJsonSync(p, {
      apiKey: KNOWN_DEFAULT_API_KEY,
      encryptionKey: KNOWN_DEFAULT_ENCRYPTION_KEY,
    })

    const svc = new SecretsService(p)
    const warnings = svc.getSecurityWarnings()
    expect(warnings.length).toBe(2)
    expect(warnings.join(' ')).toMatch(/API key/i)
    expect(warnings.join(' ')).toMatch(/encryption key/i)
  })

  it('does not duplicate warnings across repeated reads', () => {
    const p = path.join(tmp, 'secrets.json')
    fs.writeJsonSync(p, {
      apiKey: KNOWN_DEFAULT_API_KEY,
      encryptionKey: 'some-strong-random-thing',
    })
    const svc = new SecretsService(p)
    svc.load()
    svc.getSecurityWarnings()
    expect(svc.getSecurityWarnings().length).toBe(1)
  })

  it('double-load does not duplicate warnings (idempotent)', () => {
    const p = path.join(tmp, 'secrets.json')
    fs.writeJsonSync(p, {
      apiKey: KNOWN_DEFAULT_API_KEY,
      encryptionKey: KNOWN_DEFAULT_ENCRYPTION_KEY,
    })
    const svc = new SecretsService(p)
    // Simulate re-entrancy by clearing the cached secrets and calling load() twice
    svc.load()
    ;(svc as any).secrets = null
    svc.load()
    expect(svc.getSecurityWarnings().length).toBe(2)
  })

  it('no warnings when existing secrets are strong', () => {
    const p = path.join(tmp, 'secrets.json')
    fs.writeJsonSync(p, {
      apiKey: 'a'.repeat(64),
      encryptionKey: 'b'.repeat(64),
    })
    const svc = new SecretsService(p)
    expect(svc.getSecurityWarnings()).toEqual([])
  })

  describe('encryption key provenance (BYOK visibility)', () => {
    it('fresh install with no env key is reported as generated and persists provenance', () => {
      const p = path.join(tmp, 'secrets.json')
      const svc = new SecretsService(p)
      svc.load()
      expect(svc.getEncryptionKeySource()).toBe('generated')
      // Provenance is written to disk so later boots need no env re-check.
      expect(fs.readJsonSync(p).keySource).toBe('generated')
    })

    it('fresh install with an env key is reported as customer-managed (BYOK)', () => {
      process.env.DRK_ENCRYPTION_KEY = 'operator-supplied-key-value'
      const p = path.join(tmp, 'secrets.json')
      const svc = new SecretsService(p)
      const secrets = svc.load()
      expect(secrets.encryptionKey).toBe('operator-supplied-key-value')
      expect(svc.getEncryptionKeySource()).toBe('customer-managed')
      expect(fs.readJsonSync(p).keySource).toBe('env')
    })

    it('honors recorded provenance from an existing secrets.json', () => {
      const p = path.join(tmp, 'secrets.json')
      fs.writeJsonSync(p, {
        apiKey: 'a'.repeat(64),
        encryptionKey: 'b'.repeat(64),
        keySource: 'env',
      })
      const svc = new SecretsService(p)
      expect(svc.getEncryptionKeySource()).toBe('customer-managed')
      // DATA SAFETY: an existing file is never rewritten.
      expect(fs.readJsonSync(p).encryptionKey).toBe('b'.repeat(64))
    })

    it('infers customer-managed for a pre-provenance file when env matches the stored key', () => {
      const p = path.join(tmp, 'secrets.json')
      fs.writeJsonSync(p, { apiKey: 'a'.repeat(64), encryptionKey: 'shared-secret' })
      process.env.DRK_ENCRYPTION_KEY = 'shared-secret'
      const svc = new SecretsService(p)
      expect(svc.getEncryptionKeySource()).toBe('customer-managed')
    })

    it('reports unknown for a pre-provenance file with no matching env key', () => {
      const p = path.join(tmp, 'secrets.json')
      fs.writeJsonSync(p, { apiKey: 'a'.repeat(64), encryptionKey: 'b'.repeat(64) })
      const svc = new SecretsService(p)
      expect(svc.getEncryptionKeySource()).toBe('unknown')
    })
  })
})
