import { Express, Request, Response } from 'express'
import { logger } from '../utils/logger'
import { APP_VERSION } from '../utils/appVersion'

/**
 * Config export / import routes.
 *
 * GET  /api/config/export  — streams a JSON file containing all DRK state
 * POST /api/config/import  — accepts a JSON body and replaces current state
 *
 * The export covers: settings (key-value store), policies, storage vaults,
 * backup history metadata, audit log, and license token. It does NOT include
 * actual backup data (those live in the vault backends — restic repos, rclone
 * remotes, etc.).
 *
 * Import is destructive — it replaces all existing config. The caller must
 * confirm in the UI before triggering.
 */

const SETTINGS_KEY_TOKEN = 'license.token'

interface ExportBundle {
  version: string
  exportedAt: string
  data: {
    settings: Array<{ key: string; value: string }>
    policies: any[]
    storageVaults: any[]
    backupHistory: any[]
    auditLog: any[]
  }
}

export function mountConfigExportRoutes(
  app: Express,
  { db, license }: { db: any; license: any },
) {
  // ── Export ─────────────────────────────────────────────────────────────────
  app.get('/api/config/export', async (_req: Request, res: Response) => {
    try {
      const [settings, policies, vaults, history, audit] = await Promise.all([
        db.getAllSettings?.().catch(() => []),
        db.getPolicies?.().catch(() => []),
        db.getAllVaults?.().catch(() => []),
        db.listAllBackups?.().catch(() => []),
        db.getAuditEntries?.(500).catch(() => []),
      ])

      const bundle: ExportBundle = {
        version: APP_VERSION,
        exportedAt: new Date().toISOString(),
        data: {
          settings: settings || [],
          policies: policies || [],
          storageVaults: vaults || [],
          backupHistory: history || [],
          auditLog: audit || [],
        },
      }

      const filename = `drk-config-${new Date().toISOString().slice(0, 10)}.json`
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.send(JSON.stringify(bundle, null, 2))
    } catch (err: any) {
      logger.warn({ err }, '[ConfigExport] export failed')
      res.status(500).json({ error: 'export_failed', detail: err?.message })
    }
  })

  // ── Import ─────────────────────────────────────────────────────────────────
  app.post('/api/config/import', async (req: Request, res: Response) => {
    try {
      const bundle = req.body as ExportBundle
      if (!bundle || !bundle.data) {
        res.status(400).json({ error: 'invalid_bundle', detail: 'Missing data field' })
        return
      }

      // Validate version compatibility (same major version only)
      const importVersion = bundle.version || 'unknown'
      const [major] = importVersion.split('.')
      if (major !== '1') {
        res.status(400).json({
          error: 'incompatible_version',
          detail: `Cannot import from v${importVersion}. Only v1.x exports are supported.`,
        })
        return
      }

      const d = bundle.data
      let policiesImported = 0

      // Restore settings (includes license.token if present)
      if (Array.isArray(d.settings)) {
        for (const s of d.settings) {
          if (s.key && typeof s.value === 'string') {
            await db.saveSetting?.(s.key, s.value).catch(() => {})
          }
        }
      }

      // Restore policies
      if (Array.isArray(d.policies)) {
        for (const p of d.policies) {
          try {
            await db.savePolicy?.(p)
            policiesImported++
          } catch {
            // skip individual policy failures
          }
        }
      }

      // Restore storage vaults
      if (Array.isArray(d.storageVaults)) {
        for (const v of d.storageVaults) {
          try {
            await db.saveStorage?.(v.id, v.type, v.config)
          } catch {
            // skip individual vault failures
          }
        }
      }

      // Trigger license re-verification if token was in settings
      const licenseToken = d.settings?.find((s: any) => s.key === SETTINGS_KEY_TOKEN)?.value
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
