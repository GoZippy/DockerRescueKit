import fs from 'fs-extra'
import path from 'path'
import crypto from 'crypto'

export interface Secrets {
  apiKey: string
  encryptionKey: string
}

/**
 * Manages long-lived local secrets (API key + encryption key).
 *
 * Why: previous versions shipped a hardcoded API key and a hardcoded
 * encryption-key fallback. Any installer running with defaults exposed
 * every vault entry. Secrets are now generated on first run and stored
 * with 0600 permissions in the data directory.
 */
export class SecretsService {
  private secrets: Secrets | null = null

  constructor(private secretsPath: string) {}

  public load(): Secrets {
    if (this.secrets) return this.secrets

    fs.ensureDirSync(path.dirname(this.secretsPath))

    if (fs.existsSync(this.secretsPath)) {
      const raw = fs.readFileSync(this.secretsPath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<Secrets>
      if (parsed.apiKey && parsed.encryptionKey) {
        this.secrets = { apiKey: parsed.apiKey, encryptionKey: parsed.encryptionKey }
        return this.secrets
      }
    }

    // Respect env overrides (Docker/Kubernetes pattern) but never fall back
    // to a hardcoded literal.
    const apiKey = process.env.DRK_API_KEY || process.env.API_KEY || this.generate(32)
    const encryptionKey = process.env.DRK_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY || this.generate(32)

    this.secrets = { apiKey, encryptionKey }
    fs.writeFileSync(this.secretsPath, JSON.stringify(this.secrets, null, 2), { mode: 0o600 })
    try {
      fs.chmodSync(this.secretsPath, 0o600)
    } catch {
      // Windows: chmod is a best-effort; ACLs govern access there.
    }

    // Print once at startup so operators can find the bootstrap key.
    console.log(`\x1b[33m[Secrets]\x1b[0m Initialized secrets at ${this.secretsPath}`)
    console.log(`\x1b[33m[Secrets]\x1b[0m API key: ${apiKey}`)

    return this.secrets
  }

  public getApiKey(): string {
    return this.load().apiKey
  }

  public getEncryptionKey(): string {
    return this.load().encryptionKey
  }

  /**
   * Regenerate the API key and persist. The encryption key is intentionally
   * NOT rotated here — changing it would make every stored vault entry
   * undecryptable. Rotate that via a dedicated migration tool.
   */
  public regenerateApiKey(): string {
    const cur = this.load()
    const next: Secrets = { ...cur, apiKey: this.generate(32) }
    this.secrets = next
    fs.writeFileSync(this.secretsPath, JSON.stringify(next, null, 2), { mode: 0o600 })
    try {
      fs.chmodSync(this.secretsPath, 0o600)
    } catch { /* Windows: ignore */ }
    console.log(`\x1b[33m[Secrets]\x1b[0m API key regenerated`)
    return next.apiKey
  }

  private generate(byteLen: number): string {
    return crypto.randomBytes(byteLen).toString('hex')
  }
}
