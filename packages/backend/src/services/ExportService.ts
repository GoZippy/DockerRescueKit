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

/** Result of writeSnapshot — see ExportService.writeSnapshot. */
export interface SnapshotWriteResult {
  path: string
  bytes: number
}

/** Result of pruneSnapshots — see ExportService.pruneSnapshots. */
export interface PruneResult {
  kept: number
  deleted: number
}

/** Retention config for periodic snapshots (A2). */
export interface RetentionConfig {
  cron: string
  retentionDays: number
}

const SCHEMA_VERSION = '1'
const AUDIT_LIMIT = 100

/**
 * SettingsService keys for A2 periodic exports. Documented here so the
 * scheduler wiring (SchedulerEngine.start) and the UI Settings panel can
 * reference the same constants.
 *
 *   drk.export.cron            — cron expression for the periodic snapshot job.
 *                                Default `0 0,6,12,18 * * *` = every 6 hours.
 *   drk.export.retention_days  — keep all snapshots within this rolling window
 *                                even if it exceeds the count cap. Default 14.
 *
 * Settings are read at scheduler start. A config change via the UI does NOT
 * live-reload the cron expression — the backend restart on next deploy picks
 * it up. (Live-reload would require unscheduling the existing job and
 * re-registering, which is achievable but out of scope for v1.2.5.)
 */
export const EXPORT_SETTING_CRON = 'drk.export.cron'
export const EXPORT_SETTING_RETENTION_DAYS = 'drk.export.retention_days'
export const DEFAULT_EXPORT_CRON = '0 0,6,12,18 * * *'
export const DEFAULT_EXPORT_RETENTION_DAYS = 14

/**
 * Retention math (A2):
 *
 *   keep = union(
 *     newest MIN_RETAINED_COUNT snapshots by mtime,
 *     all snapshots with mtime within last retentionDays
 *   )
 *
 * The OR semantics matter: a user who's been offline for 30 days with the
 * default 14-day window must still have *something* recoverable on disk, so
 * we never drop below `MIN_RETAINED_COUNT` even if every retained snapshot
 * is older than the window.
 */
const MIN_RETAINED_COUNT = 56

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

  /**
   * Write a timestamped snapshot to `{dataDir}/exports/snap-{ISO}.json` and
   * run retention pruning. Called on the scheduler tick.
   *
   * Filename uses `:` replaced with `-` so the file is portable across
   * Windows (where colons in filenames are reserved for ADS). Example:
   *   snap-2026-05-28T18-00-00.000Z.json
   *
   * Best-effort: any failure (snapshot threw, disk full, EROFS) returns a
   * sentinel `{ path, bytes: -1 }` and is logged at WARN. Pruning runs even
   * if the write succeeded — a successful new snapshot is exactly when the
   * retention math is most relevant.
   *
   * Note: this snapshot is *additive*. It does NOT overwrite
   * `latest-bootstrap.json`. The bootstrap file is the "most recent known
   * good config" entry point; the timestamped snapshots are the rolling
   * history for point-in-time recovery.
   */
  public async writeSnapshot(): Promise<SnapshotWriteResult> {
    const exportsDir = path.join(this.dataDir, 'exports')
    // Windows-safe filename: replace `:` with `-`. JSON parsers don't care
    // about the timestamp shape inside the file — this is filesystem-only.
    const stamp = new Date().toISOString().replace(/:/g, '-')
    const target = path.join(exportsDir, `snap-${stamp}.json`)

    try {
      await fs.ensureDir(exportsDir)
      const bundle = await this.snapshotAll()
      await fs.writeJson(target, bundle, { spaces: 2 })
      const stat = await fs.stat(target)
      this.logger.info(
        { path: target, bytes: stat.size, policies: bundle.policies.length, vaults: bundle.vaults.length },
        '[ExportService] wrote periodic snapshot',
      )

      // Run prune in the same call so the disk footprint stays bounded even
      // if no one ever calls pruneSnapshots externally.
      try {
        const pruneResult = await this.pruneSnapshots()
        this.logger.info(
          { kept: pruneResult.kept, deleted: pruneResult.deleted },
          '[ExportService] retention prune complete',
        )
      } catch (pruneErr) {
        // Pruning failure must not surface as a snapshot failure. The
        // snapshot file is already on disk; the next tick will retry prune.
        this.logger.warn({ err: pruneErr }, '[ExportService] prune after writeSnapshot failed')
      }

      return { path: target, bytes: stat.size }
    } catch (err) {
      this.logger.warn({ err, path: target }, '[ExportService] writeSnapshot failed')
      return { path: target, bytes: -1 }
    }
  }

  /**
   * Apply rolling retention to `{dataDir}/exports/snap-*.json`.
   *
   * Keeps `max(MIN_RETAINED_COUNT, all within retentionDays)` snapshots by
   * mtime. The bootstrap file (`latest-bootstrap.json`) is NEVER deleted —
   * it sits outside the snap-* namespace and is the disaster-recovery
   * entrypoint. Files we don't recognise (foreign filenames, manual user
   * copies, partial download artifacts) are left alone for the same reason
   * — pruning is opt-in via the `snap-*.json` naming convention.
   *
   * Returns `{ kept, deleted }` counts so callers / tests can assert math.
   * Best-effort per-file delete: a single EBUSY doesn't abort the rest.
   */
  public async pruneSnapshots(): Promise<PruneResult> {
    const { retentionDays } = await this.getRetentionConfig()
    const exportsDir = path.join(this.dataDir, 'exports')

    let entries: string[]
    try {
      entries = await fs.readdir(exportsDir)
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        // No exports dir yet — nothing to prune. Not an error.
        return { kept: 0, deleted: 0 }
      }
      throw err
    }

    // Stat each snap-*.json entry. Foreign files (including
    // latest-bootstrap.json) are deliberately excluded from the candidate
    // pool so they survive pruning unconditionally.
    const candidates: Array<{ name: string; full: string; mtimeMs: number }> = []
    for (const name of entries) {
      if (!name.startsWith('snap-') || !name.endsWith('.json')) continue
      const full = path.join(exportsDir, name)
      try {
        const stat = await fs.stat(full)
        candidates.push({ name, full, mtimeMs: stat.mtimeMs })
      } catch {
        // Race with another writer or permission flap — ignore and let the
        // next tick re-evaluate.
        continue
      }
    }

    if (candidates.length === 0) return { kept: 0, deleted: 0 }

    // Sort newest first so slice() math reads naturally.
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)

    const now = Date.now()
    const windowMs = retentionDays * 24 * 60 * 60 * 1000
    const keep = new Set<string>()

    // Rule 1: keep all within the retention window.
    for (const c of candidates) {
      if (now - c.mtimeMs <= windowMs) keep.add(c.full)
    }

    // Rule 2: also keep at least MIN_RETAINED_COUNT newest.
    for (const c of candidates.slice(0, MIN_RETAINED_COUNT)) {
      keep.add(c.full)
    }

    const toDelete = candidates.filter(c => !keep.has(c.full))
    let deleted = 0
    for (const victim of toDelete) {
      try {
        await fs.unlink(victim.full)
        deleted++
      } catch (err) {
        this.logger.warn({ err, file: victim.full }, '[ExportService] prune unlink failed')
      }
    }

    return { kept: candidates.length - deleted, deleted }
  }

  /**
   * Resolve the periodic-export retention config from SettingsService.
   *
   * Defaults: every 6 hours (`0 0,6,12,18 * * *`), 14-day window. Both keys
   * can be overridden via the Settings UI. Invalid retention values (NaN,
   * non-positive) fall back to the default rather than erroring out — the
   * scheduler must never fail to start because of a typo in a settings row.
   */
  public async getRetentionConfig(): Promise<RetentionConfig> {
    const cron = (await this.settings.getSetting(EXPORT_SETTING_CRON, DEFAULT_EXPORT_CRON)) ?? DEFAULT_EXPORT_CRON
    const rawDays = await this.settings.getSetting(
      EXPORT_SETTING_RETENTION_DAYS,
      String(DEFAULT_EXPORT_RETENTION_DAYS),
    )
    const parsedDays = Number.parseInt(rawDays ?? '', 10)
    const retentionDays =
      Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : DEFAULT_EXPORT_RETENTION_DAYS
    return { cron, retentionDays }
  }

  /**
   * Return the mtime of `latest-bootstrap.json` as an ISO string, or null
   * if the file is missing. Surfaced via /api/settings/meta so the UI can
   * show "last auto-export N minutes ago" without exposing the full file
   * path or filesystem layout.
   */
  public async getLastExportAt(): Promise<string | null> {
    const target = path.join(this.dataDir, 'exports', 'latest-bootstrap.json')
    try {
      const stat = await fs.stat(target)
      return new Date(stat.mtimeMs).toISOString()
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null
      this.logger.warn({ err, path: target }, '[ExportService] getLastExportAt failed')
      return null
    }
  }
}
