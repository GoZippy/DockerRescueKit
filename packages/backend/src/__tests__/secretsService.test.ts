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

  it('no warnings when existing secrets are strong', () => {
    const p = path.join(tmp, 'secrets.json')
    fs.writeJsonSync(p, {
      apiKey: 'a'.repeat(64),
      encryptionKey: 'b'.repeat(64),
    })
    const svc = new SecretsService(p)
    expect(svc.getSecurityWarnings()).toEqual([])
  })
})
