import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { Database } from '../db/Database'
import { SecretsService } from '../services/SecretsService'
import { VaultService } from '../services/VaultService'
import { EncryptionKeyService } from '../services/EncryptionKeyService'
import { EncryptionUtility } from '../utils/Encryption'

const OLD_KEY = 'old-encryption-key-0123456789'
const NEW_KEY = 'new-encryption-key-9876543210'

describe('EncryptionKeyService (BYOK key rotation)', () => {
  let tmp: string
  let db: Database
  let secrets: SecretsService
  let vault: VaultService
  let svc: EncryptionKeyService

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'drk-rotate-'))
    delete process.env.DRK_ENCRYPTION_KEY
    delete process.env.ENCRYPTION_KEY

    // Seed secrets.json with a known key so load() doesn't auto-generate.
    fs.writeJsonSync(path.join(tmp, 'secrets.json'), {
      apiKey: 'a'.repeat(64),
      encryptionKey: OLD_KEY,
      keySource: 'generated',
    })

    EncryptionUtility.init(OLD_KEY, tmp) // establishes the per-install salt
    db = new Database(path.join(tmp, 'k.db'))
    secrets = new SecretsService(path.join(tmp, 'secrets.json'))
    vault = new VaultService(db)
    svc = new EncryptionKeyService(db, secrets, vault, () => 1234)
  })

  afterEach(async () => {
    await fs.remove(tmp).catch(() => {})
  })

  const sampleConfig = () => ({
    host: 'sftp.example.com',
    port: 22,
    password: 'super-secret-pw',
    nested: { secretKey: 'AKIA-deep-secret' },
  })

  it('rotates: re-encrypts data and the new key decrypts it; old key no longer used', async () => {
    await vault.setCredentials('s1', 'sftp', sampleConfig())

    const res = await svc.rotate(NEW_KEY)

    expect(res).toEqual({ rotated: 1 })
    expect(secrets.getEncryptionKey()).toBe(NEW_KEY)
    expect(secrets.getEncryptionKeySource()).toBe('customer-managed')
    expect(secrets.readRotationMarker()).toBeNull()

    // Active key is now NEW_KEY; data round-trips back to plaintext.
    const got = await vault.getCredentials('s1')
    expect(got.config.password).toBe('super-secret-pw')
    expect(got.config.nested.secretKey).toBe('AKIA-deep-secret')

    // Stored ciphertext must NOT decrypt under the old key anymore.
    const raw = JSON.parse(
      (db as any).db.prepare('SELECT config FROM storage_vault WHERE id = ?').get('s1').config,
    )
    expect(() => EncryptionUtility.decryptWithRawKey(OLD_KEY, raw.password)).toThrow()
  })

  it('is a no-op when the new key equals the current key', async () => {
    await vault.setCredentials('s1', 'sftp', sampleConfig())
    const res = await svc.rotate(OLD_KEY)
    expect(res).toEqual({ rotated: 0, alreadyCurrent: true })
    expect(secrets.readRotationMarker()).toBeNull()
  })

  it('rejects a too-short key before touching anything', async () => {
    await vault.setCredentials('s1', 'sftp', sampleConfig())
    await expect(svc.rotate('short')).rejects.toThrow(/at least/)
    // Untouched: still old key, data still readable, no marker.
    expect(secrets.getEncryptionKey()).toBe(OLD_KEY)
    expect((await vault.getCredentials('s1')).config.password).toBe('super-secret-pw')
    expect(secrets.readRotationMarker()).toBeNull()
  })

  describe('crash recovery', () => {
    it('FINISHES a rotation that wrote rows + marker but crashed before the key swap', async () => {
      await vault.setCredentials('s1', 'sftp', sampleConfig())

      // Simulate: rows migrated to NEW_KEY and marker written, but secrets.json
      // still holds OLD_KEY (crash between step 3 and step 4).
      const vaults = await db.getAllVaults()
      db.replaceStorageConfigs(
        vaults.map(v => ({ id: v.id, type: v.type, config: vault.reencryptConfig(v.config, OLD_KEY, NEW_KEY) })),
      )
      secrets.writeRotationMarker(OLD_KEY, NEW_KEY, 1234)
      EncryptionUtility.reinit(OLD_KEY) // active key is still the old one

      const outcome = await svc.recoverIfInterrupted()

      expect(outcome).toBe('finished')
      expect(secrets.getEncryptionKey()).toBe(NEW_KEY)
      expect(secrets.readRotationMarker()).toBeNull()
      expect((await vault.getCredentials('s1')).config.password).toBe('super-secret-pw')
    })

    it('ROLLS BACK a rotation that wrote the marker but never migrated rows', async () => {
      await vault.setCredentials('s1', 'sftp', sampleConfig())

      // Simulate: marker written, but rows still under OLD_KEY (crash between
      // step 2 and step 3) and secrets.json still OLD_KEY.
      secrets.writeRotationMarker(OLD_KEY, NEW_KEY, 1234)
      EncryptionUtility.reinit(OLD_KEY)

      const outcome = await svc.recoverIfInterrupted()

      expect(outcome).toBe('rolled-back')
      expect(secrets.getEncryptionKey()).toBe(OLD_KEY)
      expect(secrets.readRotationMarker()).toBeNull()
      expect((await vault.getCredentials('s1')).config.password).toBe('super-secret-pw')
    })

    it('clears a stale marker when the vault has no ciphertext to test', async () => {
      // No vault rows. Marker present; secrets already advanced to NEW_KEY.
      secrets.setEncryptionKey(NEW_KEY)
      secrets.writeRotationMarker(OLD_KEY, NEW_KEY, 1234)

      const outcome = await svc.recoverIfInterrupted()

      expect(outcome).toBe('cleared')
      expect(secrets.readRotationMarker()).toBeNull()
      expect(secrets.getEncryptionKey()).toBe(NEW_KEY)
    })

    it('does nothing when there is no marker', async () => {
      expect(await svc.recoverIfInterrupted()).toBe('none')
    })
  })
})
