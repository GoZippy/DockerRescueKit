import { Express, Request, Response } from 'express'
import { logger } from '../utils/logger'
import { ExportService, SnapshotBundle } from '../services/ExportService'
import { ImportService, ImportMode } from '../services/ImportService'

/**
 * Config export / import routes.
 *
 * GET  /api/config/export  — streams the canonical snapshot bundle (the same
 *                            JSON shape ExportService writes to disk on boot)
 * POST /api/config/import  — accepts a snapshot bundle and replaces current
 *                            state
 *
 * The export covers: settings (key-value store), policies, storage vaults,
 * audit log. It does NOT include actual backup data (those live in the vault
 * backends — restic repos, rclone remotes, etc.).
 *
 * Import is destructive — it replaces all existing config. The caller must
 * confirm in the UI before triggering.
 *
 * The export response is the single source of truth: it is produced by
 * `ExportService.snapshotAll()`, the same method called at backend boot to
 * write `{dataDir}/exports/latest-bootstrap.json`. Changing the schema in
 * one place changes both.
 *
 * Backwards-compatible import: the v1.2.3/v1.2.4 export route emitted a
 * legacy envelope ({ version, exportedAt, data: { settings, policies,
 * storageVaults, backupHistory, auditLog } }). The importer below accepts
 * both that shape and the v1.2.5+ flat shape so users with files downloaded
 * from a prior version can still restore.
 */

const SETTINGS_KEY_TOKEN = 'license.token'

/** Legacy v1.2.3/v1.2.4 export envelope. Detected on import only. */
interface LegacyExportBundle {
  version?: string
  exportedAt?: string
  data?: {
    settings?: Array<{ key: string; value: string }>
    policies?: any[]
    storageVaults?: any[]
    backupHistory?: any[]
    auditLog?: any[]
  }
}

/**
 * Normalize either the canonical (v1.2.5+) snapshot shape or the legacy
 * (v1.2.3/v1.2.4) envelope into the canonical fields needed for import.
 * Returns null if the body isn't recognizable as either.
 */
function normalizeImportBundle(body: unknown): {
  appVersion: string
  policies: any[]
  vaults: Array<{ id?: string; type?: string; config?: any }>
  settings: Array<{ key: string; value: string }>
} | null {
  if (!body || typeof body !== 'object') return null

  // Canonical v1.2.5+ shape
  const canonical = body as Partial<SnapshotBundle>
  if (
    typeof canonical.schemaVersion === 'string' &&
    Array.isArray(canonical.policies) &&
    Array.isArray(canonical.vaults) &&
    Array.isArray(canonical.settings)
  ) {
    return {
      appVersion: canonical.appVersion ?? 'unknown',
      policies: canonical.policies,
      vaults: canonical.vaults,
      settings: canonical.settings,
    }
  }

  // Legacy v1.2.3/v1.2.4 envelope
  const legacy = body as LegacyExportBundle
  if (legacy.data && typeof legacy.data === 'object') {
    return {
      appVersion: legacy.version ?? 'unknown',
      policies: Array.isArray(legacy.data.policies) ? legacy.data.policies : [],
      vaults: Array.isArray(legacy.data.storageVaults) ? legacy.data.storageVaults : [],
      settings: Array.isArray(legacy.data.settings) ? legacy.data.settings : [],
    }
  }

  return null
}

export function mountConfigExportRoutes(
  app: Express,
  {
    exportService,
    db,
    license,
    importService,
  }: {
    exportService: ExportService
    db: any
    license: any
    /** Optional during the transition — when omitted the route falls back to
     *  the original in-line single-shot importer below, preserving every
     *  pre-A3 behaviour. */
    importService?: ImportService
  },
) {
  // -- Export ---------------------------------------------------------------
  app.get('/api/config/export', async (_req: Request, res: Response) => {
    try {
      const bundle = await exportService.snapshotAll()

      const filename = `drk-config-${new Date().toISOString().slice(0, 10)}.json`
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.send(JSON.stringify(bundle, null, 2))
    } catch (err: any) {
      logger.warn({ err }, '[ConfigExport] export failed')
      res.status(500).json({ error: 'export_failed', detail: err?.message })
    }
  })

  // -- Import ---------------------------------------------------------------
  //
  // Three call shapes:
  //
  //   POST /api/config/import?mode=preview
  //     body: { mode: 'json' | 'bind-mount-json' | 'legacy-sqlite-db',
  //             payload?: <bundle>, path?: <abs path> }
  //     -> ImportPreview { confirmationToken, counts, warnings, … }
  //     (never mutates DB)
  //
  //   POST /api/config/import?mode=apply
  //     body: { token: <confirmationToken from preview> }
  //     -> ImportResult { applied, counts, errors }
  //
  //   POST /api/config/import   (no mode query)
  //     body: <bundle JSON> | { mode, payload, path }
  //     -> legacy single-shot import; preserved for backwards compat with
  //        v1.2.3/v1.2.4 callers and the existing UI button. When
  //        importService is wired we route through previewAndApply so the
  //        legacy callers benefit from the same validation; when it isn't
  //        we fall back to the original in-line flow below.
  //
  app.post('/api/config/import', async (req: Request, res: Response) => {
    const mode = String(req.query.mode || '').toLowerCase()

    // ---- mode=preview ----
    if (mode === 'preview') {
      if (!importService) {
        res.status(503).json({ error: 'import_service_unavailable' })
        return
      }
      try {
        const body = (req.body && typeof req.body === 'object') ? req.body as any : {}
        const inputMode = (body.mode || 'json') as ImportMode
        const preview = await importService.preview({
          mode: inputMode,
          payload: body.payload ?? (inputMode === 'json' && !body.payload ? body : undefined),
          path: body.path,
        })
        res.json(preview)
      } catch (err: any) {
        logger.warn({ err }, '[ConfigExport] preview failed')
        res.status(400).json({ error: 'preview_failed', detail: err?.message })
      }
      return
    }

    // ---- mode=apply ----
    if (mode === 'apply') {
      if (!importService) {
        res.status(503).json({ error: 'import_service_unavailable' })
        return
      }
      try {
        const token = String(req.body?.token || '').trim()
        if (!token) {
          res.status(400).json({ error: 'token_required' })
          return
        }
        const result = await importService.apply(token)
        // Token unknown/expired returns applied=false with a clear error.
        // Surface that as a 410 Gone rather than 200 so callers can branch
        // on status code; the body still tells them precisely what failed.
        if (!result.applied) {
          res.status(410).json(result)
          return
        }
        res.json(result)
      } catch (err: any) {
        logger.warn({ err }, '[ConfigExport] apply failed')
        res.status(500).json({ error: 'apply_failed', detail: err?.message })
      }
      return
    }

    // ---- legacy single-shot path (no mode query) ----
    // If we have an ImportService, prefer the preview+apply round-trip so
    // bind-mount-json / legacy-sqlite-db work transparently for callers
    // that pass `{ mode, path }` bodies. Plain JSON body keeps working
    // (treated as mode=json with payload=<entire body>).
    if (importService) {
      try {
        const body = (req.body && typeof req.body === 'object') ? req.body as any : null
        const inputMode = (body?.mode || 'json') as ImportMode
        const result = await importService.previewAndApply({
          mode: inputMode,
          payload: inputMode === 'json' ? (body?.payload ?? body) : undefined,
          path: body?.path,
        })
        // The legacy response shape exposes `policiesImported` so the
        // existing UI doesn't break — surface both new + old fields.
        res.json({
          ok: result.applied,
          policiesImported: result.counts.policies,
          counts: result.counts,
          errors: result.errors,
        })
        return
      } catch (err: any) {
        // Fall through to in-line legacy path on parse failure so a JSON
        // body that doesn't match either shape gets the same error
        // message users have seen since v1.2.3.
        logger.warn({ err }, '[ConfigExport] previewAndApply failed; falling back to inline')
      }
    }

    try {
      const normalized = normalizeImportBundle(req.body)
      if (!normalized) {
        res
          .status(400)
          .json({ error: 'invalid_bundle', detail: 'Body does not match v1.2.5 snapshot or legacy envelope' })
        return
      }

      // Validate version compatibility (same major version only). 'unknown'
      // passes through — pre-1.0 builds and hand-edited bundles still import.
      const importVersion = normalized.appVersion
      if (importVersion !== 'unknown') {
        const [major] = importVersion.split('.')
        if (major !== '1') {
          res.status(400).json({
            error: 'incompatible_version',
            detail: `Cannot import from v${importVersion}. Only v1.x exports are supported.`,
          })
          return
        }
      }

      let policiesImported = 0

      // Restore settings (includes license.token if present)
      for (const s of normalized.settings) {
        if (s && s.key && typeof s.value === 'string') {
          await db.saveSetting?.(s.key, s.value).catch(() => { /* skip individual failures */ })
        }
      }

      // Restore policies
      for (const p of normalized.policies) {
        try {
          await db.savePolicy?.(p)
          policiesImported++
        } catch {
          // skip individual policy failures
        }
      }

      // Restore storage vaults
      for (const v of normalized.vaults) {
        try {
          if (v && v.id && v.type) {
            await db.saveStorage?.(v.id, v.type, v.config)
          }
        } catch {
          // skip individual vault failures
        }
      }

      // Trigger license re-verification if token was in settings
      const licenseToken = normalized.settings.find((s: any) => s.key === SETTINGS_KEY_TOKEN)?.value
      if (licenseToken && license?.setToken) {
        try {
          await license.setToken(licenseToken)
        } catch {
          logger.warn('[ConfigExport] license token import skipped (invalid for this install)')
        }
      }

      logger.info({ policiesImported }, '[ConfigExport] import completed')
      res.json({ ok: true, policiesImported })
    } catch (err: any) {
      logger.warn({ err }, '[ConfigExport] import failed')
      res.status(500).json({ error: 'import_failed', detail: err?.message })
    }
  })
}
