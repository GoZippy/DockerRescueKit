import { Database } from '../db/Database'
import { EncryptionUtility } from '../utils/Encryption'

export class VaultService {
  constructor(private db: Database) {}

  public async setCredentials(id: string, type: string, config: any): Promise<void> {
    const encryptedConfig = this.encryptRecursive(config)
    await this.db.saveStorage(id, type, encryptedConfig)
  }

  public async getCredentials(id: string): Promise<any | null> {
    const storage = await this.db.getStorage(id)
    if (!storage) return null

    return {
      ...storage,
      config: this.decryptRecursive(storage.config)
    }
  }

  public encryptRecursive(obj: any): any {
    if (typeof obj !== 'object' || obj === null) return obj
    
    const result: any = Array.isArray(obj) ? [] : {}
    for (const key in obj) {
      if (typeof obj[key] === 'string' && this.isSensitiveKey(key)) {
        result[key] = EncryptionUtility.encrypt(obj[key])
      } else {
        result[key] = this.encryptRecursive(obj[key])
      }
    }
    return result
  }

  public decryptRecursive(obj: any): any {
    if (typeof obj !== 'object' || obj === null) return obj
    
    const result: any = Array.isArray(obj) ? [] : {}
    for (const key in obj) {
      if (typeof obj[key] === 'string' && this.isSensitiveKey(key)) {
        try {
          result[key] = EncryptionUtility.decrypt(obj[key])
        } catch (e) {
          // If decryption fails, it might not be encrypted
          result[key] = obj[key]
        }
      } else {
        result[key] = this.decryptRecursive(obj[key])
      }
    }
    return result
  }

  private isSensitiveKey(key: string): boolean {
    const sensitiveKeys = ['password', 'secret', 'key', 'token', 'accessKey', 'secretKey', 'credential']
    return sensitiveKeys.some(sk => key.toLowerCase().includes(sk))
  }

  /**
   * Re-encrypt every sensitive field of a config from `oldRawKey` to
   * `newRawKey`. Used by key rotation. If a sensitive value does not decrypt
   * under the old key (it was stored as plaintext, or is the legacy default),
   * the raw value is treated as the plaintext so it ends up encrypted under
   * the new key — rotation only ever strengthens, never weakens.
   *
   * Pure function over `obj` — it does not touch the active EncryptionUtility
   * key, so the caller controls exactly when the global key is swapped.
   */
  public reencryptConfig(obj: any, oldRawKey: string, newRawKey: string): any {
    if (typeof obj !== 'object' || obj === null) return obj

    const result: any = Array.isArray(obj) ? [] : {}
    for (const key in obj) {
      if (typeof obj[key] === 'string' && this.isSensitiveKey(key)) {
        let plain = obj[key]
        try {
          plain = EncryptionUtility.decryptWithRawKey(oldRawKey, obj[key])
        } catch {
          // Value wasn't encrypted under the old key (plaintext / legacy) —
          // keep it verbatim and let it be encrypted under the new key below.
        }
        result[key] = EncryptionUtility.encryptWithRawKey(newRawKey, plain)
      } else {
        result[key] = this.reencryptConfig(obj[key], oldRawKey, newRawKey)
      }
    }
    return result
  }
}
