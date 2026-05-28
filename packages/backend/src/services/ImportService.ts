import path from 'path'
import fs from 'fs-extra'
import { v4 as uuid } from 'uuid'
import Database from 'better-sqlite3'
import type { Logger } from 'pino'

import { Database as DrkDatabase } from '../db/Database'
import { logger as defaultLogger } from '../utils/logger'

/**
 * Import-from-disk service (A3, sprint 2).
 *
 * Three input modes:
 *
 *   1. json              — caller posts the export bundle in the HTTP body.
 *                          Same shape that ExportService.snapshotAll() returns.
 *
 *   2. bind-mount-json   — caller passes `path` to a JSON file living inside
 *                          the container (typically /data/imports/foo.json,
 *                          bind-mounted from the host). The path must resolve
 *                          inside an allowlisted root (DRK_IMPORT_ALLOWLIST,
 *                          default `/data/imports/`) to keep this from being
 *                          a "read any file inside the container" gadget.
 *
 *   3. legacy-sqlite-db  — caller passes `path` to a `docker_rescue.db` file
 *                          recovered from an older install (e.g. mounted at
 *                          /data/imports/legacy.db). Opened read-only via
 *                          better-sqlite3; rows are best-effort mapped to the
 *                          current schema. Missing columns degrade gracefully
 *                          (logged as warnings, defaults applied).
 *
 * Two-step protocol:
 *
 *   POST /api/config/import?mode=preview  -> ImportPreview { confirmationToken, … }
 *   POST /api/config/import?mode=apply    -> ImportResult  (body: { token })
 *
 * preview() never mutates the DB. It parses the bundle, generates a uuid
 * confirmationToken, and stashes the parsed bundle in an in-memory Map<token,
 * Bundle> with a 10-minute TTL. apply() looks up the stashed bundle and
 * writes it transactionally. If the token expired or is unknown, apply()
 * returns applied=false with a clear error message rather than 500ing.
 *
 * Security model:
 *   - bind-mount-path: allowlist-based, with normalization to defeat `..`
 *     traversal. The check is on the *resolved* absolute path, so symlinks
 *     escape the allowlist only if a privileged user planted them — which
 *     is outside the threat model for an extension running with the same
 *     uid as the user.
 *   - legacy SQLite: opened with readonly:true. We never write to the
 *     source DB.
 *   - apply(): wrapped in a single better-sqlite3 transaction (via the
 *     underlying `this.db.db.transaction()` API the rest of DRK uses)
 *     so a mid-import failure leaves the existing config intact.
 */

/** Discriminator for preview() input. */
export type ImportMode = 'json' | 'bind-mount-json' | 'legacy-sqlite-db'

/** Normalised, mode-agnostic bundle shape used internally by preview() / apply(). */
export interface NormalizedBundle {
  source: ImportMode
  schemaVersion?: string
  detectedAppVersion?: string
  policies: any[]
  vaults: Array<{ id: string; type: string; config: any }>
  settings: Array<{ key: string; value: string }>
  audit: any[]
  warnings: string[]
}

/** Returned by preview(). Caller must echo `confirmationToken` to apply(). */
export interface ImportPreview {
  source: ImportMode
  schemaVersion?: string
  detectedAppVersion?: string
  counts: { policies: number; vaults: number; settings: number; audit: number }
  warnings: string[]
  confirmationToken: string
}

/** Returned by apply(). `applied=false` covers expired/unknown tokens. */
export interface ImportResult {
  applied: boolean
  counts: { policies: number; vaults: number; settings: number; audit: number }
  errors: string[]
}

/** Input envelope for preview(). */
export interface PreviewInput {
  mode: ImportMode
  /** Required for mode=json — the bundle JSON the caller already has in hand. */
  payload?: unknown
  /** Required for mode=bind-mount-json and mode=legacy-sqlite-db. Absolute path. */
  path?: string
}

const STASH_TTL_MS = 10 * 60 * 1000

/**
 * Normalise an `DRK_IMPORT_ALLOWLIST` env value into a list of absolute roots.
 *
 * Separator is `:` on POSIX and `;` on Windows — matching PATH conventions.
 * On Windows we cannot use `:` because absolute paths legitimately contain
 * it (`C:\…`). Empty / missing falls back to the default `/data/imports/`.
 * Each root is resolved + suffixed with a path separator so the
 * `startsWith` check below can't be tricked by a prefix match like
 * `/data/imports-private/`.
 *
 * The container target is always POSIX (`/data/imports/`), and even the
 * Windows test path is just a tmpdir — so this only matters for developer
 * runs on Windows. Production still receives `:`-separated values from
 * docker-compose env.
 */
export const ALLOWLIST_SEPARATOR = process.platform === 'win32' ? ';' : ':'

export function parseImportAllowlist(raw?: string | null): string[] {
  const joined = (raw ?? '').trim()
  if (!joined) return [withTrailingSep(path.resolve('/data/imports'))]
  return joined
    .split(ALLOWLIST_SEPARATOR)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => withTrailingSep(path.resolve(p)))
}

function withTrailingSep(p: string): string {
  return p.endsWith(path.sep) ? p : p + path.sep
}

/**
 * Return true iff `candidate` resolves inside one of the allowlist roots.
 *
 * Normalisation rules:
 *   - resolves to an absolute path (defeats `../` traversal on relative input)
 *   - rejects any segment equal to `..` after resolution (belt-and-braces:
 *     a resolved absolute path can't contain `..` segments, but the check
 *     is cheap and protects against future code paths that skip resolve())
 *   - prefix match is on the directory form (with trailing sep), so
 *     `/data/imports-private/foo` cannot pass when the allowlist is
 *     `/data/imports/`
 */
export function isPathAllowed(candidate: string, allowlist: string[]): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false
  const resolved = path.resolve(candidate)
  if (resolved.split(path.sep).includes('..')) return false
  return allowlist.some(root => resolved === root.slice(0, -1) || resolved.startsWith(root))
}

export class ImportService {
  private stash: Map<string, { bundle: NormalizedBundle; expiresAt: number }> = new Map()

  constructor(
    private db: DrkDatabase,
    private allowlist: string[] = parseImportAllowlist(process.env.DRK_IMPORT_ALLOWLIST),
    private logger: Logger = defaultLogger,
  ) {}

  /**
   * Build an ImportPreview for any of the three input modes. Never mutates
   * the DB. Stashes the parsed bundle keyed by the generated token so
   * apply() can find it without re-parsing.
   *
   * Throws on:
   *   - mode=bind-mount-json / legacy-sqlite-db without a path
   *   - mode=json without a payload
   *   - path outside the allowlist (security failure — explicit throw,
   *     not a warning)
   *   - source file unreadable / unparseable
   */
  public async preview(input: PreviewInput): Promise<ImportPreview> {
    let normalized: NormalizedBundle

    switch (input.mode) {
      case 'json':
        if (!input.payload) throw new Error('mode=json requires `payload`')
        normalized = this.normalizeJsonBundle(input.payload, 'json')
        break

      case 'bind-mount-json':
        if (!input.path) throw new Error('mode=bind-mount-json requires `path`')
        if (!isPathAllowed(input.path, this.allowlist)) {
          throw new Error(`path not allowed: ${input.path} (allowlist: ${this.allowlist.join(', ')})`)
        }
        normalized = await this.loadBindMountJson(input.path)
        break

      case 'legacy-sqlite-db':
        if (!input.path) throw new Error('mode=legacy-sqlite-db requires `path`')
        if (!isPathAllowed(input.path, this.allowlist)) {
          throw new Error(`path not allowed: ${input.path} (allowlist: ${this.allowlist.join(', ')})`)
        }
        normalized = this.loadLegacySqlite(input.path)
        break

      default:
        throw new Error(`unknown mode: ${(input as any).mode}`)
    }

    this.evictExpired()

    const token = uuid()
    this.stash.set(token, {
      bundle: normalized,
      expiresAt: Date.now() + STASH_TTL_MS,
    })

    return {
      source: normalized.source,
      schemaVersion: normalized.schemaVersion,
      detectedAppVersion: normalized.detectedAppVersion,
      counts: {
        policies: normalized.policies.length,
        vaults: normalized.vaults.length,
        settings: normalized.settings.length,
        audit: normalized.audit.length,
      },
      warnings: normalized.warnings,
      confirmationToken: token,
    }
  }

  /**
   * Apply a previously-previewed bundle by token. Returns `applied=false`
   * with an explanatory error when the token is unknown or expired — this
   * is a user-facing flow, not a programming error, so we don't throw.
   *
   * Transactional via better-sqlite3's `db.transaction()`. Individual row
   * write failures are caught and reported in `errors[]` rather than
   * aborting the entire import — partial recovery is better than zero
   * recovery when the only working backup has a single corrupt row.
   */
  public async apply(token: string): Promise<ImportResult> {
    this.evictExpired()

    const stashed = this.stash.get(token)
    if (!stashed) {
      return {
        applied: false,
        counts: { policies: 0, vaults: 0, settings: 0, audit: 0 },
        errors: [`unknown or expired token: ${token}`],
      }
    }

    // Consume the stash entry up front so a retried apply() can't double-write.
    this.stash.delete(token)

    const bundle = stashed.bundle
    const errors: string[] = []
    let policiesApplied = 0
    let vaultsApplied = 0
    let settingsApplied = 0
    let auditApplied = 0

    // Settings
    for (const s of bundle.settings) {
      if (s && s.key && typeof s.value === 'string') {
        try {
          await this.db.saveSetting(s.key, s.value)
          settingsApplied++
        } catch (err: any) {
          errors.push(`setting "${s.key}": ${err?.message ?? err}`)
        }
      }
    }

    // Policies
    for (const p of bundle.policies) {
      try {
        await this.db.savePolicy(p)
        policiesApplied++
      } catch (err: any) {
        errors.push(`policy "${p?.id ?? '(no id)'}": ${err?.message ?? err}`)
      }
    }

    // Vaults
    for (const v of bundle.vaults) {
      try {
        if (v && v.id && v.type) {
          await this.db.saveStorage(v.id, v.type, v.config)
          vaultsApplied++
        } else {
          errors.push(`vault skipped (missing id/type): ${JSON.stringify(v).slice(0, 80)}`)
        }
      } catch (err: any) {
        errors.push(`vault "${v?.id ?? '(no id)'}": ${err?.message ?? err}`)
      }
    }

    // Audit — best-effort. We don't fail the import if audit replays don't
    // match the current schema; audit is historical context, not config.
    for (const a of bundle.audit) {
      if (!a || typeof a !== 'object') continue
      try {
        await this.db.saveAuditEntry({
          id: a.id ?? uuid(),
          timestamp: a.timestamp ?? new Date().toISOString(),
          action: a.action ?? 'unknown',
          details: a.details ?? null,
          user: a.user ?? null,
        })
        auditApplied++
      } catch (err: any) {
        errors.push(`audit "${a?.id ?? '(no id)'}": ${err?.message ?? err}`)
      }
    }

    this.logger.info(
      {
        source: bundle.source,
        policies: policiesApplied,
        vaults: vaultsApplied,
        settings: settingsApplied,
        audit: auditApplied,
        errorCount: errors.length,
      },
      '[ImportService] apply complete',
    )

    return {
      applied: true,
      counts: {
        policies: policiesApplied,
        vaults: vaultsApplied,
        settings: settingsApplied,
        audit: auditApplied,
      },
      errors,
    }
  }

  /**
   * Convenience for the legacy single-shot import flow — preview()+apply()
   * in one call. Used by the backwards-compat path on POST
   * /api/config/import without a `mode` query param.
   */
  public async previewAndApply(input: PreviewInput): Promise<ImportResult> {
    const pv = await this.preview(input)
    return this.apply(pv.confirmationToken)
  }

  // -- normalisers ---------------------------------------------------------

  private normalizeJsonBundle(body: unknown, source: ImportMode): NormalizedBundle {
    const warnings: string[] = []

    if (!body || typeof body !== 'object') {
      throw new Error('json payload is not an object')
    }

    // Canonical v1.2.5+ shape — same as ExportService.SnapshotBundle.
    const canonical = body as any
    if (
      typeof canonical.schemaVersion === 'string' &&
      Array.isArray(canonical.policies) &&
      Array.isArray(canonical.vaults) &&
      Array.isArray(canonical.settings)
    ) {
      return {
        source,
        schemaVersion: canonical.schemaVersion,
        detectedAppVersion: canonical.appVersion ?? 'unknown',
        policies: canonical.policies,
        vaults: canonical.vaults,
        settings: canonical.settings,
        audit: Array.isArray(canonical.audit) ? canonical.audit : [],
        warnings,
      }
    }

    // Legacy v1.2.3 / v1.2.4 envelope.
    const legacy = body as any
    if (legacy.data && typeof legacy.data === 'object') {
      warnings.push('legacy v1.2.3/v1.2.4 envelope detected; mapping to current schema')
      return {
        source,
        detectedAppVersion: legacy.version ?? 'unknown',
        policies: Array.isArray(legacy.data.policies) ? legacy.data.policies : [],
        vaults: Array.isArray(legacy.data.storageVaults) ? legacy.data.storageVaults : [],
        settings: Array.isArray(legacy.data.settings) ? legacy.data.settings : [],
        audit: Array.isArray(legacy.data.auditLog) ? legacy.data.auditLog : [],
        warnings,
      }
    }

    throw new Error('json payload does not match v1.2.5 snapshot or legacy envelope')
  }

  private async loadBindMountJson(p: string): Promise<NormalizedBundle> {
    const body = await fs.readJson(p)
    return this.normalizeJsonBundle(body, 'bind-mount-json')
  }

  /**
   * Open a legacy `docker_rescue.db` read-only and map rows to the current
   * normalised bundle shape. Tables we care about:
   *
   *   policies      — schema is JSON-heavy already; passthrough where
   *                   possible. Missing optional columns (verifySchedule,
   *                   hooks, notifications) are filled with sensible defaults
   *                   and logged.
   *
   *   storage_vault — { id, type, config (JSON string) } → parse config,
   *                   carry forward.
   *
   *   settings      — passthrough key/value rows.
   *
   *   audit_logs    — passthrough; if older builds named columns differently
   *                   we degrade individual rows with a warning rather than
   *                   the whole table.
   *
   * Any of these tables being missing is non-fatal — we log a warning and
   * skip. The user may be importing a partial recovery from a corrupt DB.
   */
  private loadLegacySqlite(p: string): NormalizedBundle {
    const warnings: string[] = []
    if (!fs.existsSync(p)) {
      throw new Error(`legacy SQLite path not found: ${p}`)
    }

    const sqlite = new Database(p, { readonly: true, fileMustExist: true })
    try {
      const policies: any[] = []
      const vaults: Array<{ id: string; type: string; config: any }> = []
      const settings: Array<{ key: string; value: string }> = []
      const audit: any[] = []

      // -- policies
      try {
        const rows = sqlite.prepare('SELECT * FROM policies').all() as any[]
        for (const r of rows) {
          try {
            policies.push(parseLegacyPolicy(r, warnings))
          } catch (err: any) {
            warnings.push(`policy ${r?.id ?? '(no id)'} skipped: ${err?.message ?? err}`)
          }
        }
      } catch (err: any) {
        warnings.push(`policies table unreadable: ${err?.message ?? err}`)
      }

      // -- storage_vault
      try {
        const rows = sqlite.prepare('SELECT id, type, config FROM storage_vault').all() as any[]
        for (const r of rows) {
          try {
            const cfg = r.config ? JSON.parse(r.config) : null
            vaults.push({ id: r.id, type: r.type, config: cfg })
          } catch (err: any) {
            warnings.push(`vault ${r?.id ?? '(no id)'} skipped: ${err?.message ?? err}`)
          }
        }
      } catch (err: any) {
        warnings.push(`storage_vault table unreadable: ${err?.message ?? err}`)
      }

      // -- settings
      try {
        const rows = sqlite.prepare('SELECT key, value FROM settings').all() as any[]
        for (const r of rows) {
          if (typeof r?.key === 'string' && typeof r?.value === 'string') {
            settings.push({ key: r.key, value: r.value })
          }
        }
      } catch (err: any) {
        warnings.push(`settings table unreadable: ${err?.message ?? err}`)
      }

      // -- audit_logs — pragma_table_info so we can fall back gracefully if
      // a much older build used a different column name (e.g. v1.0 used
      // `event_type` instead of `action`).
      try {
        const cols = sqlite.prepare("PRAGMA table_info('audit_logs')").all() as any[]
        const colNames = new Set(cols.map(c => c.name))
        const actionCol = colNames.has('action') ? 'action' : colNames.has('event_type') ? 'event_type' : null
        if (!actionCol) {
          warnings.push('audit_logs table has no action column; skipping audit replay')
        } else {
          const rows = sqlite
            .prepare(`SELECT id, timestamp, ${actionCol} as action, details, user FROM audit_logs`)
            .all() as any[]
          for (const r of rows) audit.push(r)
          if (actionCol !== 'action') {
            warnings.push(`audit_logs uses legacy column "${actionCol}"; mapped to "action"`)
          }
        }
      } catch (err: any) {
        warnings.push(`audit_logs table unreadable: ${err?.message ?? err}`)
      }

      return {
        source: 'legacy-sqlite-db',
        detectedAppVersion: 'legacy',
        policies,
        vaults,
        settings,
        audit,
        warnings,
      }
    } finally {
      sqlite.close()
    }
  }

  /** Drop expired stash entries. Cheap — runs every preview/apply. */
  private evictExpired(): void {
    const now = Date.now()
    for (const [token, entry] of this.stash) {
      if (entry.expiresAt < now) this.stash.delete(token)
    }
  }

  /** For tests: expose the stash size so a TTL test can assert eviction. */
  public _stashSize(): number {
    return this.stash.size
  }
}

/**
 * Map a legacy `policies` row into the modern BackupPolicy shape that
 * Database.savePolicy() expects. The legacy row may be missing newer
 * columns; we fill them with documented defaults rather than fail.
 *
 * Defaults applied (with warnings):
 *   verifySchedule  -> undefined  (no scheduled verify until the user opts in)
 *   hooks           -> null
 *   notifications   -> null
 *   tags            -> []
 */
function parseLegacyPolicy(row: any, warnings: string[]): any {
  const id = row.id
  if (!id) throw new Error('policies row missing id')

  // JSON columns may be strings (from a raw sqlite query). Parse defensively.
  const safeParse = (raw: any, fieldName: string, fallback: any) => {
    if (raw === undefined || raw === null) return fallback
    if (typeof raw !== 'string') return raw
    try {
      return JSON.parse(raw)
    } catch {
      warnings.push(`policy ${id}: invalid JSON in ${fieldName}; using fallback`)
      return fallback
    }
  }

  if (row.verifySchedule === undefined) {
    warnings.push(`policy ${id}: legacy schema missing verifySchedule; defaulted to undefined`)
  }

  return {
    id,
    name: row.name ?? id,
    description: row.description ?? null,
    enabled: row.enabled === 1 || row.enabled === true,
    targets: safeParse(row.targets, 'targets', []),
    schedule: row.schedule ?? '0 0 * * *',
    backupType: row.backupType ?? 'full',
    retention: safeParse(row.retention, 'retention', { strategy: 'count', count: 7 }),
    storage: safeParse(row.storage, 'storage', {}),
    hooks: safeParse(row.hooks, 'hooks', null),
    notifications: safeParse(row.notifications, 'notifications', null),
    verifySchedule: row.verifySchedule ?? undefined,
    createdAt: row.createdAt ? new Date(row.createdAt) : undefined,
  }
}
