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
}
