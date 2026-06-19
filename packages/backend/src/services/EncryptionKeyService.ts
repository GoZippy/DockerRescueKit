import { Database } from '../db/Database'
import { SecretsService } from './SecretsService'
import { VaultService } from './VaultService'
import { EncryptionUtility } from '../utils/Encryption'

export interface RotateResult {
  /** Number of vault rows re-encrypted. */
  rotated: number
  /** True when the supplied key already equals the active key (no-op). */
  alreadyCurrent?: boolean
}

const CIPHERTEXT_RE = /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i
const MIN_KEY_LEN = 16

/**
 * Bring-your-own-key rotation for the credential vault.
 *
 * DATA SAFETY is the whole point of this class. Rotation re-encrypts every
 * `storage_vault` row from the old key to the new key. The cardinal rule for a
 * backup tool is that a customer's encrypted vault must NEVER be orphaned, so
 * the sequence is engineered to be recoverable from a crash at any step:
 *
 *   1. Re-encrypt all rows IN MEMORY first. If anything throws, nothing on disk
 *      has changed.
 *   2. Write a rotation marker holding BOTH keys (the crash breadcrumb).
 *   3. Write all re-encrypted rows in ONE transaction (all-or-nothing).
 *   4. Atomically swap the key in secrets.json (temp-file + rename).
 *   5. Swap the in-memory active key, then verify a round-trip read.
 *   6. Clear the marker.
 *
 * If the process dies between any two steps, `recoverIfInterrupted()` on next
 * boot inspects which key the stored rows decrypt under and either finishes the
 * rotation (rows already migrated) or rolls it back (rows still under old key).
 * Either way the data stays readable.
 */
export class EncryptionKeyService {
  constructor(
    private db: Database,
    private secrets: SecretsService,
    private vault: VaultService,
    private now: () => number = () => Date.now(),
  ) {}

  async rotate(newRawKeyInput: string): Promise<RotateResult> {
    const newRawKey = (newRawKeyInput || '').trim()
    if (newRawKey.length < MIN_KEY_LEN) {
      throw new Error(`encryption key must be at least ${MIN_KEY_LEN} characters`)
    }
    const oldRawKey = this.secrets.getEncryptionKey()
    if (newRawKey === oldRawKey) return { rotated: 0, alreadyCurrent: true }

    const vaults = await this.db.getAllVaults()

    // (1) Re-encrypt in memory. Throwing here leaves disk untouched.
    const migrated = vaults.map(v => ({
      id: v.id,
      type: v.type,
      config: this.vault.reencryptConfig(v.config, oldRawKey, newRawKey),
    }))

    // (2) Crash breadcrumb.
    this.secrets.writeRotationMarker(oldRawKey, newRawKey, this.now())

    // (3) All-or-nothing row write (still under the old active key — just bytes).
    this.db.replaceStorageConfigs(migrated)

    // (4) Atomic key swap on disk, then (5) swap the in-memory key.
    this.secrets.setEncryptionKey(newRawKey)
    EncryptionUtility.reinit(newRawKey)

    // (5) Verify a round-trip under the new active key before declaring success.
    if (!this.allRowsDecryptUnder(migrated, newRawKey)) {
      // Should be unreachable (we just produced this ciphertext), but if it
      // happens we deliberately LEAVE the marker so boot recovery resolves it
      // rather than risk a partial in-process rollback.
      throw new Error('key rotation verification failed; recovery marker left in place')
    }

    // (6) Done.
    this.secrets.clearRotationMarker()
    return { rotated: migrated.length }
  }

  /**
   * Called once at startup (after EncryptionUtility.init with the current key).
   * If a rotation was interrupted, finish it or roll it back so vault data is
   * never left encrypted under a key that secrets.json no longer holds.
   */
  async recoverIfInterrupted(): Promise<'finished' | 'rolled-back' | 'cleared' | 'none'> {
    const marker = this.secrets.readRotationMarker()
    if (!marker) return 'none'

    const vaults = await this.db.getAllVaults()

    // No encrypted sample to test (empty/plaintext vault): trust secrets.json,
    // make the active key match it, and just clear the stale marker.
    if (!this.hasCiphertext(vaults)) {
      EncryptionUtility.reinit(this.secrets.getEncryptionKey())
      this.secrets.clearRotationMarker()
      return 'cleared'
    }

    if (this.allRowsDecryptUnder(vaults, marker.newKey)) {
      // Rows were migrated before the crash → finish: adopt the new key.
      this.secrets.setEncryptionKey(marker.newKey)
      EncryptionUtility.reinit(marker.newKey)
      this.secrets.clearRotationMarker()
      return 'finished'
    }

    if (this.allRowsDecryptUnder(vaults, marker.oldKey)) {
      // Rows never migrated → roll back: restore the old key.
      if (this.secrets.getEncryptionKey() !== marker.oldKey) {
        this.secrets.setEncryptionKey(marker.oldKey)
      }
      EncryptionUtility.reinit(marker.oldKey)
      this.secrets.clearRotationMarker()
      return 'rolled-back'
    }

    // Neither key decrypts everything — ambiguous. Do NOT clear the marker or
    // touch the key; leave it for an operator. (Should not happen given the
    // all-or-nothing transaction.)
    return 'none'
  }

  /** True if every ciphertext-shaped sensitive value decrypts under rawKey. */
  private allRowsDecryptUnder(
    rows: Array<{ config: any }>,
    rawKey: string,
  ): boolean {
    for (const r of rows) {
      if (!this.deepDecryptsUnder(r.config, rawKey)) return false
    }
    return true
  }

  private deepDecryptsUnder(obj: any, rawKey: string): boolean {
    if (obj == null) return true
    if (typeof obj === 'string') {
      if (!CIPHERTEXT_RE.test(obj)) return true // plaintext field — not our concern
      try {
        EncryptionUtility.decryptWithRawKey(rawKey, obj)
        return true
      } catch {
        return false
      }
    }
    if (typeof obj === 'object') {
      for (const k in obj) {
        if (!this.deepDecryptsUnder(obj[k], rawKey)) return false
      }
    }
    return true
  }

  private hasCiphertext(rows: Array<{ config: any }>): boolean {
    const walk = (obj: any): boolean => {
      if (obj == null) return false
      if (typeof obj === 'string') return CIPHERTEXT_RE.test(obj)
      if (typeof obj === 'object') {
        for (const k in obj) if (walk(obj[k])) return true
      }
      return false
    }
    return rows.some(r => walk(r.config))
  }
}
