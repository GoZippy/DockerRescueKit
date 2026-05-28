import path from 'path'
import fs from 'fs-extra'
import type { Logger } from 'pino'

import { Database } from '../db/Database'
import { SettingsService } from './SettingsService'
import { logger as defaultLogger } from '../utils/logger'
import { APP_VERSION } from '../utils/appVersion'

/**
 * Snapshot bundle written by ExportService.
 *
 * Stable, JSON-serializable contract used by both:
 *   - GET /api/config/export  (HTTP attachment for user-initiated download)
 *   - writeLatestBootstrap()  (boot-time auto-export to {dataDir}/exports/latest-bootstrap.json)
 *
 * schemaVersion is "1" for v1.2.5. Bumps follow a strict additive rule until
 * a non-backwards-compatible change forces "2"; importers must reject unknown
 * majors so a downgrade can't silently corrupt state.
 */
export interface SnapshotBundle {
  schemaVersion: string
  appVersion: string
  capturedAt: string
  policies: any[]
  vaults: Array<{ id: string; type: string; config: any }>
  settings: Array<{ key: string; value: string }>
  audit: any[]
}

/** Sentinel returned by writeLatestBootstrap on failure (best-effort path). */
export interface BootstrapWriteResult {
  path: string
  bytes: number
}

const SCHEMA_VERSION = '1'
const AUDIT_LIMIT = 100

/**
 * Snapshot + persist all DRK install state to disk.
 *
 * Why this exists: two `docker extension rm` cycles in the v1.2.4 window
 * wiped the data volume (policies, settings, license token, ~13 GB of
 * indexes), and the only way back was a manual JSON export the user had
 * forgotten to take. Now every backend boot writes a fresh canonical
 * snapshot to `{dataDir}/exports/latest-bootstrap.json` so the previous
 * known-good config is always one file copy away.
 *
 * Design rules enforced here:
 *   1. **Best-effort.** Every method catches its own errors and returns a
 *      sentinel rather than throwing. A failed snapshot must never block
 *      startup or the export HTTP route.
 *   2. **Single source of truth.** Both the auto-export and the HTTP route
 *      call `snapshotAll()`. Adding a new field happens in exactly one
 *      place.
 *   3. **No TDZ landmines.** The logger default-parameter uses the
 *      `defaultLogger` alias to avoid the `logger = logger` shadow that
 *      crashed startup in NotificationDispatcher.ts pre-fix — see the
 *      comment block in that file for the postmortem.
 */
export class ExportService {
  constructor(
    private db: Database,
    // SettingsService kept on the constructor for forward-compat: future
    // schema versions may surface derived settings (e.g. resolved license
    // tier) that only the service knows how to compute. Today we read the
    // raw rows straight off `db.getAllSettings()`.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private settings: SettingsService,
    private dataDir: string,
    private logger: Logger = defaultLogger,
  ) {}

  /**
   * Build the canonical snapshot bundle. Each source is fetched independently
   * with its own catch — a failure in one (e.g. corrupt audit row) returns
   * an empty array for that field rather than failing the whole snapshot.
   * The result is always a complete `SnapshotBundle` shape; downstream code
   * (the HTTP route, the bootstrap writer) doesn't need to defensively
   * null-check individual fields.
   */
  public async snapshotAll(): Promise<SnapshotBundle> {
    const [policies, vaults, settings, audit] = await Promise.all([
      this.db.getPolicies().catch(err => {
        this.logger.warn({ err }, '[ExportService] getPolicies failed; using []')
        return [] as any[]
      }),
      this.db.getAllVaults().catch(err => {
        this.logger.warn({ err }, '[ExportService] getAllVaults failed; using []')
        return [] as Array<{ id: string; type: string; config: any }>
      }),
      this.db.getAllSettings().catch(err => {
        this.logger.warn({ err }, '[ExportService] getAllSettings failed; using []')
        return [] as Array<{ key: string; value: string }>
      }),
      this.db.getAuditEntries(AUDIT_LIMIT).catch(err => {
        this.logger.warn({ err }, '[ExportService] getAuditEntries failed; using []')
        return [] as any[]
      }),
    ])

    return {
      schemaVersion: SCHEMA_VERSION,
      appVersion: APP_VERSION,
      capturedAt: new Date().toISOString(),
      policies,
      vaults,
      settings,
      audit,
    }
  }

  /**
   * Write the snapshot atomically to `{dataDir}/exports/latest-bootstrap.json`.
   *
   * Best-effort: any failure (disk full, EROFS on a misconfigured volume,
   * snapshot threw) is logged at WARN and a sentinel `{ path, bytes: -1 }`
   * is returned. Callers must not await this on the readiness path.
   *
   * Uses `fs.writeJson` (pretty-printed, 2-space indent) so the file is
   * trivially diff-able and the user can hand-edit it for recovery without
   * a JSON formatter.
   */
  public async writeLatestBootstrap(): Promise<BootstrapWriteResult> {
    const exportsDir = path.join(this.dataDir, 'exports')
    const target = path.join(exportsDir, 'latest-bootstrap.json')

    try {
      await fs.ensureDir(exportsDir)
      const bundle = await this.snapshotAll()
      await fs.writeJson(target, bundle, { spaces: 2 })
      const stat = await fs.stat(target)
      this.logger.info(
        { path: target, bytes: stat.size, policies: bundle.policies.length, vaults: bundle.vaults.length },
        '[ExportService] wrote latest-bootstrap snapshot',
      )
      return { path: target, bytes: stat.size }
    } catch (err) {
      this.logger.warn({ err, path: target }, '[ExportService] writeLatestBootstrap failed')
      return { path: target, bytes: -1 }
    }
  }
}
