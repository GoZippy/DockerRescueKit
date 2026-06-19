import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

/**
 * Read an existing per-install salt from `<dataDir>/salt.bin` or, on first
 * run, generate a fresh 32-byte salt and persist it with 0o600 permissions.
 *
 * A random per-install salt means two DockerRescueKit installations that
 * happen to share the same encryption secret still derive different AES
 * keys, so a compromise of one install cannot decrypt another's secrets.
 */
export function loadOrCreateSalt(dataDir: string): Buffer {
  const saltPath = path.join(dataDir, 'salt.bin')
  if (fs.existsSync(saltPath)) {
    const existing = fs.readFileSync(saltPath)
    if (existing.length !== 32) {
      throw new Error(`Invalid salt file at ${saltPath}: expected 32 bytes, got ${existing.length}`)
    }
    return existing
  }
  fs.mkdirSync(dataDir, { recursive: true })
  const fresh = crypto.randomBytes(32)
  // Write with 0o600 so only the owning user can read the salt. On Windows
  // the mode is largely advisory but POSIX hosts (Linux/macOS container
  // mounts) honour it.
  fs.writeFileSync(saltPath, fresh, { mode: 0o600 })
  try {
    fs.chmodSync(saltPath, 0o600)
  } catch {
    /* best-effort on platforms that don't support chmod */
  }
  return fresh
}

export class EncryptionUtility {
  private static readonly ALGORITHM = 'aes-256-gcm'
  private static readonly IV_LENGTH = 12
  private static readonly LEGACY_SALT = Buffer.from('drk-static-salt')
  private static key: Buffer | null = null
  // The per-install salt is retained so key rotation can re-derive against the
  // SAME salt (rotating the raw key must change the derived key, but the salt
  // is a per-install constant — see loadOrCreateSalt).
  private static salt: Buffer | null = null

  /**
   * Set the encryption key. Must be called once at startup by SecretsService
   * before any encrypt/decrypt is issued. Throws if encrypt/decrypt is called
   * before init to avoid silently using a zero key.
   *
   * @param rawKey  raw encryption secret loaded from secrets.json
   * @param dataDir optional data directory; when provided we load/create a
   *                random 32-byte salt at `<dataDir>/salt.bin`. When omitted
   *                we fall back to the legacy static salt so existing unit
   *                tests stay deterministic.
   */
  public static init(rawKey: string, dataDir?: string): void {
    this.salt = dataDir ? loadOrCreateSalt(dataDir) : this.LEGACY_SALT
    this.key = this.deriveKey(rawKey)
  }

  /**
   * Swap the active key after a successful rotation. The salt is unchanged —
   * init() must have run first to establish it.
   */
  public static reinit(rawKey: string): void {
    this.key = this.deriveKey(rawKey)
  }

  /** scrypt-derive a stable 32-byte key from a raw secret using the active salt. */
  private static deriveKey(rawKey: string): Buffer {
    const salt = this.salt ?? this.LEGACY_SALT
    return crypto.scryptSync(rawKey, salt, 32)
  }

  private static getKey(): Buffer {
    if (!this.key) {
      throw new Error('EncryptionUtility not initialized — call EncryptionUtility.init(secret) at startup')
    }
    return this.key
  }

  public static encrypt(text: string): string {
    return this.encryptWith(this.getKey(), text)
  }

  public static decrypt(cipherText: string): string {
    return this.decryptWith(this.getKey(), cipherText)
  }

  /**
   * Encrypt with an explicit RAW key (derived against the active salt) rather
   * than the active key. Used by key rotation to write ciphertext under the
   * incoming key without first swapping the global key.
   */
  public static encryptWithRawKey(rawKey: string, text: string): string {
    return this.encryptWith(this.deriveKey(rawKey), text)
  }

  /** Decrypt with an explicit RAW key (e.g. the old key during rotation). */
  public static decryptWithRawKey(rawKey: string, cipherText: string): string {
    return this.decryptWith(this.deriveKey(rawKey), cipherText)
  }

  private static encryptWith(key: Buffer, text: string): string {
    const iv = crypto.randomBytes(this.IV_LENGTH)
    const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv)
    let encrypted = cipher.update(text, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    const authTag = cipher.getAuthTag().toString('hex')
    return `${iv.toString('hex')}:${authTag}:${encrypted}`
  }

  private static decryptWith(key: Buffer, cipherText: string): string {
    const [ivHex, authTagHex, encryptedText] = cipherText.split(':')
    if (!ivHex || !authTagHex || !encryptedText) {
      throw new Error('Invalid ciphertext format')
    }
    const iv = Buffer.from(ivHex, 'hex')
    const authTag = Buffer.from(authTagHex, 'hex')
    const decipher = crypto.createDecipheriv(this.ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  }
}
