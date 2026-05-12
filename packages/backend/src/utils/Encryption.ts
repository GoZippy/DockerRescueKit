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
    const salt = dataDir ? loadOrCreateSalt(dataDir) : this.LEGACY_SALT
    // scrypt derives a stable 32-byte key regardless of input length/format.
    this.key = crypto.scryptSync(rawKey, salt, 32)
  }

  private static getKey(): Buffer {
    if (!this.key) {
      throw new Error('EncryptionUtility not initialized — call EncryptionUtility.init(secret) at startup')
    }
    return this.key
  }

  public static encrypt(text: string): string {
    const iv = crypto.randomBytes(this.IV_LENGTH)
    const cipher = crypto.createCipheriv(this.ALGORITHM, this.getKey(), iv)
    let encrypted = cipher.update(text, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    const authTag = cipher.getAuthTag().toString('hex')
    return `${iv.toString('hex')}:${authTag}:${encrypted}`
  }

  public static decrypt(cipherText: string): string {
    const [ivHex, authTagHex, encryptedText] = cipherText.split(':')
    if (!ivHex || !authTagHex || !encryptedText) {
      throw new Error('Invalid ciphertext format')
    }
    const iv = Buffer.from(ivHex, 'hex')
    const authTag = Buffer.from(authTagHex, 'hex')
    const decipher = crypto.createDecipheriv(this.ALGORITHM, this.getKey(), iv)
    decipher.setAuthTag(authTag)
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  }
}
