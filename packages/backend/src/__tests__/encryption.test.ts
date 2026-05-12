import fs from 'fs'
import os from 'os'
import path from 'path'
import { EncryptionUtility, loadOrCreateSalt } from '../utils/Encryption'

describe('EncryptionUtility', () => {
  beforeAll(() => {
    // No-arg form keeps the legacy static salt for backwards compat with
    // existing tests that depend on this constructor-level init.
    EncryptionUtility.init('test-secret-key-used-only-in-unit-tests')
  })

  it('round-trips a string', () => {
    const plain = 'hunter2'
    const ct = EncryptionUtility.encrypt(plain)
    expect(ct).not.toBe(plain)
    expect(EncryptionUtility.decrypt(ct)).toBe(plain)
  })

  it('produces a different ciphertext each time (random IV)', () => {
    const a = EncryptionUtility.encrypt('same-input')
    const b = EncryptionUtility.encrypt('same-input')
    expect(a).not.toBe(b)
  })

  it('throws on tampered ciphertext (GCM auth tag)', () => {
    const ct = EncryptionUtility.encrypt('data')
    const parts = ct.split(':')
    // Corrupt the ciphertext portion.
    parts[2] = parts[2].replace(/^./, c => (c === 'a' ? 'b' : 'a'))
    expect(() => EncryptionUtility.decrypt(parts.join(':'))).toThrow()
  })

  describe('per-install salt', () => {
    let tmpRoot: string

    beforeAll(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drk-salt-test-'))
    })

    afterAll(() => {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true })
      } catch {
        /* best-effort cleanup */
      }
    })

    it('loadOrCreateSalt generates a 32-byte salt on first call and reuses it after', () => {
      const dir = fs.mkdtempSync(path.join(tmpRoot, 'install-'))
      const first = loadOrCreateSalt(dir)
      expect(first).toBeInstanceOf(Buffer)
      expect(first.length).toBe(32)
      expect(fs.existsSync(path.join(dir, 'salt.bin'))).toBe(true)

      const second = loadOrCreateSalt(dir)
      expect(Buffer.compare(first, second)).toBe(0)
    })

    it('round-trips encrypt+decrypt when init is given a dataDir', () => {
      const dir = fs.mkdtempSync(path.join(tmpRoot, 'install-rt-'))
      EncryptionUtility.init('shared-secret', dir)
      const plain = 'sensitive-payload'
      const ct = EncryptionUtility.encrypt(plain)
      expect(EncryptionUtility.decrypt(ct)).toBe(plain)
    })

    it('two different dataDirs with the same secret yield different ciphertexts', () => {
      const dirA = fs.mkdtempSync(path.join(tmpRoot, 'install-A-'))
      const dirB = fs.mkdtempSync(path.join(tmpRoot, 'install-B-'))

      // Encrypt under install A's salt.
      EncryptionUtility.init('shared-secret', dirA)
      const ctA = EncryptionUtility.encrypt('same-plaintext')

      // Re-init with install B's salt and try to decrypt A's ciphertext —
      // it must fail because the derived key is different.
      EncryptionUtility.init('shared-secret', dirB)
      expect(() => EncryptionUtility.decrypt(ctA)).toThrow()

      // Encrypt the same plaintext under B — ciphertext must differ from A.
      // We can't compare directly since IV randomises output, but the fact
      // that A's ciphertext won't decrypt under B's key is proof the salt
      // (and therefore the derived AES key) differs.
      const ctB = EncryptionUtility.encrypt('same-plaintext')
      expect(EncryptionUtility.decrypt(ctB)).toBe('same-plaintext')

      // Sanity: the persisted salts on disk differ.
      const saltA = fs.readFileSync(path.join(dirA, 'salt.bin'))
      const saltB = fs.readFileSync(path.join(dirB, 'salt.bin'))
      expect(Buffer.compare(saltA, saltB)).not.toBe(0)

      // Restore the no-arg legacy init so subsequent tests in this file
      // (if reordered) and any shared-module callers stay deterministic.
      EncryptionUtility.init('test-secret-key-used-only-in-unit-tests')
    })
  })
})
