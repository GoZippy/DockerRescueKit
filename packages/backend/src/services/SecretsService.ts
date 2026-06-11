import fs from 'fs-extra'
import path from 'path'
import crypto from 'crypto'

export interface Secrets {
  apiKey: string
  encryptionKey: string
}

/**
 * Hardcoded literals that shipped as defaults in pre-1.4 builds. If an
 * EXISTING secrets.json still contains either of these, the vault was
 * encrypted with a guessable key — but we must NOT rotate it, because the
 * stored ciphertext would become undecryptable. Instead we flag it loudly
 * (boot warning + GET /api/status `securityWarnings`) so the operator can
 * rotate deliberately via a migration that re-encrypts existing data.
 */
const KNOWN_DEFAULT_API_KEY = 'rescue-kit-secret-key-2026'
const KNOWN_DEFAULT_ENCRYPTION_KEY = 'super-secret-vault-key-32-chars!!'

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
  private warnings: string[] = []

  constructor(private secretsPath: string) {}

  /**
   * Security warnings surfaced after load(). Empty on a healthy fresh
   * install. Populated when an existing secrets.json still holds a known
   * shipped-default value (see KNOWN_DEFAULT_* above). Read-exposed via
   * GET /api/status so the UI can nag the operator to rotate.
   */
  public getSecurityWarnings(): string[] {
    // Ensure load() has run so warnings are populated.
    this.load()
    return [...this.warnings]
  }

  public load(): Secrets {
    if (this.secrets) return this.secrets

    fs.ensureDirSync(path.dirname(this.secretsPath))

    if (fs.existsSync(this.secretsPath)) {
      const raw = fs.readFileSync(this.secretsPath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<Secrets>
      if (parsed.apiKey && parsed.encryptionKey) {
        this.secrets = { apiKey: parsed.apiKey, encryptionKey: parsed.encryptionKey }
        // DATA SAFETY: do NOT rotate an existing weak key — vault data already
        // encrypted with it would become unreadable. Warn instead.
        this.detectWeakDefaults(this.secrets)
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

  /**
   * Flag a loaded secrets set that still carries a shipped default value.
   * Populates `this.warnings` and prints a prominent boot warning. Does not
   * mutate the secrets — rotation here would orphan existing vault ciphertext.
   */
  private detectWeakDefaults(secrets: Secrets): void {
    if (secrets.apiKey === KNOWN_DEFAULT_API_KEY) {
      const msg =
        'Your API key is the publicly-known shipped default. Rotate it now via ' +
        'Settings → Regenerate API Key (or POST /api/settings/regenerate-api-key).'
      this.warnings.push(msg)
      console.warn(`\x1b[31m[Secrets] SECURITY WARNING:\x1b[0m ${msg}`)
    }
    if (secrets.encryptionKey === KNOWN_DEFAULT_ENCRYPTION_KEY) {
      const msg =
        'Your vault encryption key is the publicly-known shipped default. Existing ' +
        'vault data is at risk. It cannot be rotated automatically without making ' +
        'current vault entries unreadable — re-create connectors/secrets after ' +
        'manually replacing encryptionKey in secrets.json to migrate.'
      this.warnings.push(msg)
      console.warn(`\x1b[31m[Secrets] SECURITY WARNING:\x1b[0m ${msg}`)
    }
  }

  private generate(byteLen: number): string {
    return crypto.randomBytes(byteLen).toString('hex')
  }
}
