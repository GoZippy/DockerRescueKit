import express, { Express, Request, Response, NextFunction } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import dotenv from 'dotenv'
import path from 'path'
import fs from 'fs-extra'
import { validate, validateParams, validateQuery } from './validation/validate'
import {
  CreatePolicySchema,
  UpdatePolicySchema,
  RestoreRequestSchema,
  ConnectorTestSchema,
  ConnectorDiscoverSchema,
  SaveConnectorSchema,
  RcloneCreateRemoteSchema,
  RcloneOAuthStartSchema,
  RcloneOAuthFinishSchema,
  SaveSettingSchema,
  idParamSchema,
  projectParamSchema,
  nameParamSchema,
  sessionIdParamSchema,
  settingKeyParamSchema,
  fileQuerySchema
} from './validation/schemas'
import { requestId } from './middleware/requestId'
import { logger, requestLogger } from './utils/logger'
import { HttpError, NotFoundError, BadRequestError } from './errors'

import { PolicyManager } from './services/PolicyManager'
import { SchedulerEngine } from './scheduler/SchedulerEngine'
import { Database } from './db/Database'
import { DockerService } from './services/DockerService'
import { ConnectorRegistry } from './connectors'
import { ConnectorManager } from './services/ConnectorManager'
import { TelemetryService } from './services/TelemetryService'
import { SettingsService } from './services/SettingsService'
import { SecretsService } from './services/SecretsService'
import { MetricsService } from './services/MetricsService'
import { VerifyService } from './services/VerifyService'
import { RehearsalService } from './services/RehearsalService'
import { HealthCheckService } from './services/HealthCheckService'
import { LogTriageService } from './services/LogTriageService'
import { NotificationDispatcher } from './services/NotificationDispatcher'
import { NotificationService } from './services/NotificationService'
import { mountRehearsalRoutes } from './routes/rehearsals'
import { mountLogsRoutes } from './routes/logs'
import { mountVolumesRoutes } from './routes/volumes'
import { mountNotificationRoutes } from './routes/notifications'
import { mountFeedbackRoutes } from './routes/feedback'
import { mountVersionRoutes } from './routes/version'
import { mountConfigExportRoutes } from './routes/configExport'
import { FeedbackService } from './services/FeedbackService'
import { APP_VERSION } from './utils/appVersion'
import { PartialRestoreService } from './services/PartialRestoreService'
import { AuditService } from './services/AuditService'
import { ExportService } from './services/ExportService'
import { ImportService } from './services/ImportService'
import { RcloneService } from './services/RcloneService'
import { LicenseService } from './services/LicenseService'
import { EncryptionUtility } from './utils/Encryption'
import { Server } from 'http'

dotenv.config()

export interface StorageCostConfig {
  storageType: string
  label: string
  icon: string
  costPerGBMonth: number
  costPerGBDownload: number
  restoreSpeedMBps: number
  durability: string
  notes: string
}

export function getDefaultCostConfig(): StorageCostConfig[] {
  const raw = process.env.DRK_COST_CONFIG
  if (raw) {
    try { return JSON.parse(raw) } catch { /* fall through to defaults */ }
  }
  return [
    {
      storageType: 'local',
      label: 'Local Disk',
      icon: 'hard-drive',
      costPerGBMonth: 0,
      costPerGBDownload: 0,
      restoreSpeedMBps: 500,
      durability: 'Single disk — no redundancy',
      notes: 'Fastest restore. No cloud egress. Risk: disk failure = total loss.',
    },
    {
      storageType: 'smb',
      label: 'SMB / CIFS (NAS)',
      icon: 'server',
      costPerGBMonth: 0,
      costPerGBDownload: 0,
      restoreSpeedMBps: 100,
      durability: 'Depends on NAS RAID config',
      notes: 'Good for homelab. Speed limited by network. No egress fees.',
    },
    {
      storageType: 'sftp',
      label: 'SFTP / SSH',
      icon: 'lock',
      costPerGBMonth: 0,
      costPerGBDownload: 0,
      restoreSpeedMBps: 50,
      durability: 'Depends on server',
      notes: 'Any SSH server works. Slower than SMB over WAN.',
    },
    {
      storageType: 's3',
      label: 'S3 / Object Storage',
      icon: 'cloud',
      costPerGBMonth: 0.023,
      costPerGBDownload: 0.09,
      restoreSpeedMBps: 200,
      durability: '99.999999999% (11 nines)',
      notes: 'AWS S3 Standard pricing shown. MinIO/Wasabi/B2 may differ. Egress is the main cost.',
    },
    {
      storageType: 'proxmox',
      label: 'Proxmox Backup Server',
      icon: 'database',
      costPerGBMonth: 0,
      costPerGBDownload: 0,
      restoreSpeedMBps: 200,
      durability: 'Depends on PBS storage',
      notes: 'Deduplication + compression. No egress. Requires Proxmox infrastructure.',
    },
    {
      storageType: 'rclone',
      label: 'Rclone (40+ providers)',
      icon: 'globe',
      costPerGBMonth: 0.02,
      costPerGBDownload: 0.08,
      restoreSpeedMBps: 100,
      durability: 'Varies by provider',
      notes: 'Google Drive, OneDrive, Dropbox, B2, etc. Pricing varies — shown as S3 equivalent estimate.',
    },
  ]
}

// Backend version is resolved once at module load in utils/appVersion.ts —
// imported above so both the /api/settings/meta route and the new
// /api/version/check route reference the same constant.

// ---- Transport selection ---------------------------------------------------
// Phase 8 — Docker Desktop extension integration.
//
// In stand-alone mode (the default) the backend listens on TCP :42880 with
// `x-api-key` auth, which is suitable for self-hosted users hitting the API
// over the network.
//
// When packaged as a Docker Desktop extension the backend is expected to bind
// a Unix domain socket inside the extension's guest-services namespace at
// `/run/guest-services/<name>.sock`. The Docker Desktop IPC bridge already
// scopes that socket to the extension, so applying our own API-key check on
// top would be both redundant and impossible (the frontend talks via the
// extension SDK which doesn't propagate the key). The TRANSPORT env var picks
// between the two; everything else (routes, middleware ordering) is shared.
const TRANSPORT: 'tcp' | 'socket' =
  process.env.DRK_TRANSPORT === 'socket' ? 'socket' : 'tcp'

export class BackupService {
  private app: Express
  private db: Database
  private policyManager: PolicyManager
  private scheduler: SchedulerEngine
  private dockerService: DockerService
  private connectorManager: ConnectorManager
  private telemetry: TelemetryService
  private settings: SettingsService
  private secrets: SecretsService
  private metrics: MetricsService
  private verify: VerifyService
  private rehearsal: RehearsalService
  private health: HealthCheckService
  private logTriage: LogTriageService
  private partial: PartialRestoreService
  private audit: AuditService
  private exportService: ExportService
  private importService: ImportService
  private rclone: RcloneService
  private license: LicenseService
  private notificationDispatcher: NotificationDispatcher
  private httpServer: Server | null = null

  constructor() {
    this.app = express()

    const dataDir = process.env.DRK_DATA_DIR || 'data'
    fs.ensureDirSync(dataDir)

    this.secrets = new SecretsService(path.join(dataDir, 'secrets.json'))
    const loaded = this.secrets.load()
    // Pass dataDir so the KDF salt is loaded/generated per-install rather
    // than using a hardcoded constant. Two installs sharing the same secret
    // therefore derive different AES keys.
    EncryptionUtility.init(loaded.encryptionKey, dataDir)

    this.db = new Database(process.env.DB_PATH || path.join(dataDir, 'docker_rescue.db'))
    // SettingsService and LicenseService must be constructed before
    // PolicyManager so the latter can enforce the Free-tier policy cap.
    // Without this wiring, gating in PolicyManager.createPolicy is a no-op.
    this.settings = new SettingsService(this.db)
    this.license = new LicenseService(this.settings)
    this.policyManager = new PolicyManager(this.db, path.join(dataDir, 'staging'), this.license)
    this.dockerService = new DockerService()
    this.connectorManager = new ConnectorManager(this.db)
    this.telemetry = new TelemetryService()
    this.metrics = new MetricsService(this.policyManager, this.db)
    this.verify = new VerifyService(this.policyManager, this.dockerService, path.join(dataDir, 'staging'), this.db)
    this.partial = new PartialRestoreService(this.policyManager, path.join(dataDir, 'staging'))
    this.audit = new AuditService(this.db)
    // ExportService snapshots policies/vaults/settings/audit to disk. On every
    // backend start (see `start()`), it fire-and-forget writes
    // `{dataDir}/exports/latest-bootstrap.json` so the user always has a recent
    // good config on disk. Two `docker extension rm` cycles in the v1.2.4
    // window wiped the data volume and motivated this — see v1.2.5 sprint notes.
    this.exportService = new ExportService(this.db, this.settings, dataDir, logger)
    // ImportService backs the A3 /api/config/import preview+apply flow. The
    // allowlist defaults to `/data/imports/` (overridable via
    // DRK_IMPORT_ALLOWLIST, colon-separated). Bind-mount-json and
    // legacy-sqlite-db modes require paths that resolve inside one of those
    // roots; plain `mode=json` payloads are unconstrained.
    this.importService = new ImportService(this.db)
    this.rclone = new RcloneService(dataDir)
    // Pass exportService so SchedulerEngine.start() can register the A2
    // periodic snapshot + rolling-retention cron job.
    this.scheduler = new SchedulerEngine(this.policyManager, this.verify, this.exportService)
    // NotificationService is for backup notifications (paid tier)
    // NotificationDispatcher is for N-1 health alerts (included in all tiers)
    const notificationService = new NotificationService(this.license, this.settings)
    this.notificationDispatcher = new NotificationDispatcher(
      this.db,
      this.dockerService,
      notificationService
    )
    this.rehearsal = new RehearsalService({
      docker: this.dockerService,
      policyManager: this.policyManager,
      audit: this.audit,
      stagingDir: path.join(dataDir, 'staging'),
      db: this.db,
      notificationDispatcher: this.notificationDispatcher,
    })
    this.health = new HealthCheckService(this.dockerService, this.policyManager, this.rehearsal, this.db, this.notificationDispatcher)
    this.logTriage = new LogTriageService(this.dockerService, this.db, this.health)

    // Schedule daily cleanup of old log events (TTL enforcement)
    // Runs at 02:00 UTC daily to delete events older than 7 days
    const logCleanupInterval = setInterval(async () => {
      try {
        const deletedCount = await this.db.deleteOldLogEvents(7)
        if (deletedCount > 0) {
          logger.info(`Log event TTL cleanup: deleted ${deletedCount} events older than 7 days`)
        }
      } catch (err) {
        logger.error({ err }, 'Log event TTL cleanup failed')
      }
    }, 24 * 60 * 60 * 1000) // Every 24 hours
    logCleanupInterval.unref() // Don't keep process alive just for this timer

    // Schedule daily cleanup of old volume manifest entries (TTL enforcement)
    // Delete entries older than 7 days
    const volumeManifestCleanupInterval = setInterval(async () => {
      try {
        const deletedCount = await this.db.deleteOldVolumeManifests(7)
        if (deletedCount > 0) {
          logger.info(`Volume manifest TTL cleanup: deleted ${deletedCount} entries older than 7 days`)
        }
      } catch (err) {
        logger.error({ err }, 'Volume manifest TTL cleanup failed')
      }
    }, 24 * 60 * 60 * 1000) // Every 24 hours
    volumeManifestCleanupInterval.unref() // Don't keep process alive just for this timer

    // Schedule daily cleanup of old notifications (TTL enforcement)
    // Delete entries older than 30 days
    const notificationCleanupInterval = setInterval(async () => {
      try {
        const deletedCount = await this.db.cleanupOldNotifications(30)
        if (deletedCount > 0) {
          logger.info(`Notification TTL cleanup: deleted ${deletedCount} entries older than 30 days`)
        }
      } catch (err) {
        logger.error({ err }, 'Notification TTL cleanup failed')
      }
    }, 24 * 60 * 60 * 1000) // Every 24 hours
    notificationCleanupInterval.unref() // Don't keep process alive just for this timer

    this.setupMiddleware()
    this.setupRoutes()
    mountRehearsalRoutes(this.app, { rehearsalService: this.rehearsal, audit: this.audit })
    try {
      mountLogsRoutes(this.app, { triageService: this.logTriage, db: this.db })
    } catch (err) {
      logger.error({ err }, 'Failed to mount logs routes')
      throw err
    }
    mountVolumesRoutes(this.app, { db: this.db, docker: this.dockerService })
    mountNotificationRoutes(this.app, { db: this.db })
    // v1.2.2 in-product feedback + update-check. FeedbackService fans out to
    // local file / email / GitHub / webhook sinks; the version route compares
    // the running APP_VERSION against Docker Hub tags so the UI can show an
    // "update available" badge without hard-failing on Hub outages.
    const feedbackService = new FeedbackService(this.settings, dataDir)
    mountFeedbackRoutes(this.app, { feedback: feedbackService })
    mountVersionRoutes(this.app, { settings: this.settings })

    // Config export / import — full settings + policies + vaults + history dump
    // so users can migrate between installs or recover from a broken upgrade.
    mountConfigExportRoutes(this.app, {
      exportService: this.exportService,
      db: this.db,
      license: this.license,
      importService: this.importService,
    })

    // Cost analysis config — static per-backend pricing/performance reference data.
    // Users can override via DRK_COST_CONFIG env var (JSON) for their region.
    this.app.get('/api/settings/cost-config', (_req, res) => {
      res.json(getDefaultCostConfig())
    })

    this.setupStaticUI()
    this.setupErrorHandler()

    // Best-effort cleanup of any resources left by a previously-crashed run.
    // Doesn't block startup; logs whatever it reaps.
    this.rehearsal.reapOrphans().catch(() => { /* docker may be offline at boot — that's fine */ })
  }

  private setupMiddleware() {
    // Stamp every request with a correlation id first so the logger below and
    // any downstream middleware can reference `req.id`.
    this.app.use(requestId())
    // Structured request logging via pino-http. Skips /healthz and /metrics
    // (see utils/logger.ts) so prober traffic doesn't drown real traffic, and
    // redacts the x-api-key header / apiKey query string so secrets never hit
    // the log files.
    this.app.use(requestLogger)
    this.app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],  // Vite inlines a small bootstrap
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],                     // allow XHR back to same host
          fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"]
        }
      },
      crossOriginEmbedderPolicy: false               // Docker Desktop extension compat
    }))
    this.app.use(cors())
    this.app.use(express.json({ limit: '5mb' }))

    // Public liveness probe — registered BEFORE auth so Docker healthchecks
    // and external monitors can hit it without an API key.
    this.app.get('/healthz', (_req, res) => {
      res.json({ status: 'ok', uptime: process.uptime() })
    })

    // General API rate limiter — 100 requests per 15 minutes per IP.
    // Unix socket connections (Docker Desktop extension transport) have no
    // req.ip; skip rate limiting for those — Docker Desktop is the only caller.
    const apiRateLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => !req.ip,
    })

    // Tighter brute-force limiter for auth failures — 10 FAILED requests per
    // minute per IP. `skipSuccessfulRequests` only counts responses with
    // status >= 400, so legitimate API traffic doesn't trip this throttle
    // even when the dashboard fires many parallel calls.
    const bruteForceLimit = rateLimit({
      windowMs: 60 * 1000,
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: true,
      skip: (req) => !req.ip,
    })

    this.app.use('/api', apiRateLimiter)

    this.app.use('/api', (req: Request, res: Response, next: NextFunction) => {
      // Phase 8: when bound to the Docker Desktop guest-services Unix socket
      // the IPC bridge has already scoped the caller to this extension, so
      // there's no API key to check (the frontend talks through the extension
      // SDK which can't attach one). Bypass the auth middleware entirely on
      // the socket transport; /healthz + /metrics remain public as today.
      if (TRANSPORT === 'socket') return next()
      // Resolve on each request so API-key rotation takes effect without
      // restarting the server. Accept via header (preferred) or ?apiKey=.
      const presented = req.headers['x-api-key'] || req.query.apiKey
      const current = this.secrets.getApiKey()
      if (!presented || presented !== current) {
        // Only failed-auth requests pass through the brute-force limiter,
        // so legitimate users with valid keys never trip it even after the
        // bucket is full of prior 401s.
        return bruteForceLimit(req, res, () => {
          res.status(401).json({ error: 'Unauthorized: Invalid API Key' })
        })
      }
      next()
    })
  }

  private setupRoutes() {
    // Wrap an async route handler so any thrown error / rejected promise is
    // forwarded to the central error middleware via `next(err)`. Lets each
    // handler stay free of try/catch boilerplate while still surfacing
    // HttpError subclasses with their proper status code.
    const asyncHandler = (
      fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
    ) => (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve(fn(req, res, next)).catch(next)
    }

    // ---- Health / Telemetry ---------------------------------------------
    this.app.get('/api/status', async (_req, res) => {
      const dockerOk = await this.dockerService.ping()
      res.json({
        status: 'online',
        version: '1.0.0',
        uptime: process.uptime(),
        docker: dockerOk,
        paused: this.scheduler.isPaused(),
        inFlight: this.scheduler.runningPolicyIds(),
        environment: process.env.NODE_ENV || 'development'
      })
    })

    this.app.post('/api/scheduler/pause', async (_req, res) => {
      this.scheduler.pause()
      await this.audit.record('scheduler.pause')
      res.json({ paused: true })
    })

    this.app.post('/api/scheduler/resume', async (_req, res) => {
      this.scheduler.resume()
      await this.audit.record('scheduler.resume')
      res.json({ paused: false })
    })

    this.app.get('/api/system/telemetry', async (_req, res) => {
      const stats = await this.telemetry.getStats()
      res.json(stats)
    })

    // Prometheus scrape endpoint (no auth — scraped by Prometheus directly).
    this.app.get('/metrics', async (_req, res) => {
      res.set('Content-Type', 'text/plain; version=0.0.4')
      res.send(await this.metrics.render())
    })

    // ---- Policies --------------------------------------------------------
    this.app.get('/api/policies', async (_req, res) => {
      res.json(await this.policyManager.listPolicies())
    })

    this.app.post('/api/policies', validate(CreatePolicySchema), async (req, res) => {
      const policy = await this.policyManager.createPolicy(req.body)
      if (policy.enabled) this.scheduler.schedulePolicy(policy)
      await this.audit.record('policy.create', { id: policy.id, name: policy.name })
      res.status(201).json(policy)
    })

    this.app.get('/api/policies/:id', validateParams(idParamSchema), asyncHandler(async (req, res) => {
      const policy = await this.policyManager.getPolicy(req.params.id)
      if (!policy) throw new NotFoundError('Policy', req.params.id)
      res.json(policy)
    }))

    this.app.put('/api/policies/:id', validateParams(idParamSchema), validate(UpdatePolicySchema), async (req, res) => {
      const policy = await this.policyManager.updatePolicy(req.params.id, req.body)
      if (policy.enabled) this.scheduler.schedulePolicy(policy)
      else this.scheduler.unschedulePolicy(policy.id)
      res.json(policy)
    })

    this.app.delete('/api/policies/:id', validateParams(idParamSchema), async (req, res) => {
      await this.policyManager.deletePolicy(req.params.id)
      this.scheduler.unschedulePolicy(req.params.id)
      await this.audit.record('policy.delete', { id: req.params.id })
      res.status(204).send()
    })

    this.app.post('/api/policies/:id/run', validateParams(idParamSchema), asyncHandler(async (req, res) => {
      const result = await this.scheduler.runPolicy(req.params.id)
      res.json(result)
    }))

    this.app.get('/api/policies/:id/history', validateParams(idParamSchema), asyncHandler(async (req, res) => {
      res.json(await this.policyManager.getBackupHistory(req.params.id))
    }))

    // ---- Backups ---------------------------------------------------------
    this.app.get('/api/backups', asyncHandler(async (_req, res) => {
      res.json(await this.policyManager.listAllBackups())
    }))

    this.app.get('/api/backups/:id', validateParams(idParamSchema), asyncHandler(async (req, res) => {
      const backup = await this.policyManager.getBackup(req.params.id)
      if (!backup) throw new NotFoundError('Backup', req.params.id)
      res.json(backup)
    }))

    this.app.post('/api/backups/:id/restore', validateParams(idParamSchema), validate(RestoreRequestSchema), asyncHandler(async (req, res) => {
      const result = await this.policyManager.restoreBackup({
        backupId: req.params.id,
        targetOverrides: req.body?.targetOverrides,
        dryRun: !!req.body?.dryRun
      })
      res.json(result)
    }))

    this.app.delete('/api/backups/:id', validateParams(idParamSchema), asyncHandler(async (req, res) => {
      await this.policyManager.deleteBackup(req.params.id)
      await this.audit.record('backup.delete', { id: req.params.id })
      res.status(204).send()
    }))

    this.app.post('/api/backups/:id/verify', validateParams(idParamSchema), asyncHandler(async (req, res) => {
      const report = await this.verify.verify(req.params.id)
      res.json(report)
    }))

    this.app.get('/api/backups/:id/verify-history', validateParams(idParamSchema), asyncHandler(async (req, res) => {
      const history = await this.db.getVerifyHistory(req.params.id)
      res.json(history)
    }))

    this.app.get('/api/verify-history', asyncHandler(async (_req, res) => {
      res.json(await this.db.getVerifyHistory())
    }))

    this.app.post('/api/policies/:id/verify', validateParams(idParamSchema), asyncHandler(async (req, res) => {
      await this.scheduler.runVerifyForPolicy(req.params.id)
      res.json({ scheduled: true })
    }))

    this.app.get('/api/backups/:id/files', validateParams(idParamSchema), validateQuery(fileQuerySchema), asyncHandler(async (req, res) => {
      const fileName = String(req.query.name || '')
      if (!fileName) throw new BadRequestError('Missing ?name=<fileName>')
      const entries = await this.partial.listEntries(req.params.id, fileName)
      res.json(entries)
    }))

    this.app.get('/api/backups/:id/files/extract', validateParams(idParamSchema), validateQuery(fileQuerySchema), asyncHandler(async (req, res) => {
      const fileName = String(req.query.name || '')
      const entryPath = String(req.query.path || '')
      if (!fileName || !entryPath) {
        throw new BadRequestError('Missing ?name= and/or ?path=')
      }
      const stream = await this.partial.extractFile(req.params.id, fileName, entryPath)
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(entryPath.split('/').pop() || 'file')}"`)
      res.setHeader('Content-Type', 'application/octet-stream')
      stream.pipe(res)
    }))

    // ---- Connectors ------------------------------------------------------
    this.app.get('/api/connectors', async (_req, res) => {
      res.json(await this.connectorManager.listInstances())
    })

    this.app.post('/api/connectors', validate(SaveConnectorSchema), asyncHandler(async (req, res) => {
      await this.connectorManager.saveInstance(req.body)
      res.status(201).json({ success: true })
    }))

    this.app.delete('/api/connectors/:id', validateParams(idParamSchema), asyncHandler(async (req, res) => {
      await this.connectorManager.deleteInstance(req.params.id)
      res.status(204).send()
    }))

    this.app.get('/api/connectors/definitions', (_req, res) => {
      res.json(ConnectorRegistry.getAllDefinitions())
    })

    // NOTE: /connectors/test keeps its local try/catch because the failure
    // payload is shaped specifically for the UI ({ success: false, error }),
    // not just `{ error }` like the central handler returns.
    this.app.post('/api/connectors/test', validate(ConnectorTestSchema), async (req, res) => {
      try {
        const { type, config } = req.body
        const plugin = ConnectorRegistry.getPlugin(type)
        if (!plugin) return res.status(404).json({ error: `Plugin ${type} not found`, success: false })
        res.json({ success: await plugin.testConnection(config) })
      } catch (err: any) {
        res.status(500).json({ error: err.message, success: false })
      }
    })

    this.app.post('/api/connectors/discover', validate(ConnectorDiscoverSchema), asyncHandler(async (req, res) => {
      const { type, config } = req.body
      const plugin = ConnectorRegistry.getPlugin(type)
      if (!plugin) throw new NotFoundError('Plugin', type)
      res.json(await plugin.discoverResources(config))
    }))

    // ---- Settings --------------------------------------------------------
    // Specific routes must be registered before the wildcard /:key routes.
    this.app.post('/api/settings/regenerate-api-key', async (_req, res) => {
      const newKey = this.secrets.regenerateApiKey()
      await this.audit.record('settings.regenerate_api_key')
      res.json({ apiKey: newKey })
    })

    this.app.get('/api/settings/meta', async (_req, res) => {
      // lastExportAt surfaces the mtime of latest-bootstrap.json so the UI
      // can render "Last auto-export N minutes ago". null when the file is
      // missing (first-ever boot before the bootstrap snapshot lands).
      // Best-effort: stat failure other than ENOENT is logged inside
      // ExportService.getLastExportAt and returned as null here.
      const lastExportAt = await this.exportService.getLastExportAt()
      res.json({
        dataDir: process.env.DRK_DATA_DIR || 'data',
        hasEncryptionKey: true,
        version: APP_VERSION,
        staging: path.join(process.env.DRK_DATA_DIR || 'data', 'staging'),
        lastExportAt,
      })
    })

    this.app.get('/api/settings/:key', validateParams(settingKeyParamSchema), async (req, res) => {
      const value = await this.settings.getSetting(req.params.key)
      res.json({ value: value ?? null })
    })

    this.app.post('/api/settings/:key', validateParams(settingKeyParamSchema), validate(SaveSettingSchema), async (req, res) => {
      await this.settings.saveSetting(req.params.key, req.body.value)
      res.json({ success: true })
    })

    // ---- License (paid-tier activation) ---------------------------------
    // GET surfaces the current tier + features + expiry for the Settings
    // UI to render. POST activates a token pasted by the user. DELETE
    // returns the install to Free.
    //
    // Online revocation check via the license server lives in
    // LicenseService.refreshFromServer() and is called periodically by
    // the periodic-tasks loop below; the routes here are synchronous
    // local operations only so the UI feels instant.
    this.app.get('/api/license', async (_req, res) => {
      const status = await this.license.getStatus()
      res.json(status)
    })

    this.app.post('/api/license/activate', async (req, res) => {
      const token = String(req.body?.token || '').trim()
      if (!token) {
        res.status(400).json({ error: 'token_required' })
        return
      }
      try {
        const status = await this.license.setToken(token)
        if (status.tier === 'free') {
          // Token was persisted but failed verification — return 400 so the
          // UI can show "this token isn't valid" instead of pretending it
          // worked.
          await this.license.clearToken()
          res.status(400).json({ error: 'token_invalid' })
          return
        }
        await this.audit.record('license.activate', { tier: status.tier, seats: status.seats })
        res.json(status)
      } catch (err: any) {
        res.status(400).json({ error: 'activation_failed', detail: err?.message })
      }
    })

    this.app.delete('/api/license', async (_req, res) => {
      await this.license.clearToken()
      await this.audit.record('license.clear')
      res.json({ ok: true })
    })

    // ---- Docker inspection ----------------------------------------------
    // All Docker routes degrade gracefully when Docker Desktop is offline.
    // Codes that all mean "the docker socket is not usable from this process":
    //  ENOENT       — socket file missing (Docker Desktop not running)
    //  ECONNREFUSED — daemon down but socket exists
    //  EACCES       — socket exists but our user has no permission (common in
    //                 the Alpine image where we run as a non-root user and the
    //                 host-mounted /var/run/docker.sock is owned by root)
    //  EPERM        — same root cause on some kernels
    const DOCKER_OFFLINE_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'EACCES', 'EPERM'])
    const dockerRoute = (fn: () => Promise<any>) => async (_req: any, res: any) => {
      try {
        res.json(await fn())
      } catch (err: any) {
        const offline = DOCKER_OFFLINE_CODES.has(err.code)
        res.status(offline ? 503 : 500).json({
          error: offline ? 'Docker daemon unavailable' : err.message,
          offline,
          code: err.code
        })
      }
    }

    this.app.get('/api/docker/containers', dockerRoute(() => this.dockerService.listContainers()))
    this.app.get('/api/docker/volumes',    dockerRoute(() => this.dockerService.listVolumes()))
    this.app.get('/api/docker/stacks',     dockerRoute(() => this.dockerService.listComposeStacks()))
    this.app.get('/api/docker/images',     dockerRoute(() => this.dockerService.listImages()))
    this.app.get('/api/docker/networks',   dockerRoute(() => this.dockerService.listNetworks()))

    this.app.get('/api/health/dashboard', dockerRoute(() => this.health.getDashboardScore()))
    this.app.get('/api/health/containers', dockerRoute(() => this.health.getBrokenContainers()))

    this.app.post('/api/docker/stacks/:project/protect', validateParams(projectParamSchema), async (req, res) => {
      try {
        const project = req.params.project
        let stacks
        try {
          stacks = await this.dockerService.listComposeStacks()
        } catch (err: any) {
          const offline = DOCKER_OFFLINE_CODES.has(err.code)
          return res.status(offline ? 503 : 500).json({ error: offline ? 'Docker daemon unavailable' : err.message })
        }
        const match = stacks.find((s: any) => s.project === project)
        if (!match) return res.status(404).json({ error: `Stack ${project} not found` })
        const policy = await this.policyManager.protectStack(project, match)
        if (!policy.existing) {
          this.scheduler.schedulePolicy(policy)
          await this.audit.record('stack.protect', { project, policyId: policy.id })
        }
        const { existing: _existing, ...policyOut } = policy as any
        res.status(policy.existing ? 200 : 201).json(policyOut)
      } catch (err: any) {
        res.status(500).json({ error: err.message })
      }
    })

    // ---- Audit log -------------------------------------------------------
    this.app.get('/api/audit', async (_req, res) => {
      res.json(await this.audit.list())
    })

    // ---- Rclone remote management ----------------------------------------
    this.app.get('/api/rclone/providers', (_req, res) => {
      res.json(this.rclone.getProviders())
    })

    this.app.get('/api/rclone/remotes', asyncHandler(async (_req, res) => {
      res.json(await this.rclone.listRemotes())
    }))

    this.app.post('/api/rclone/remotes', validate(RcloneCreateRemoteSchema), asyncHandler(async (req, res) => {
      const { name, providerType, params } = req.body
      await this.rclone.createRemote(name, providerType, params || {})
      await this.audit.record('rclone.create-remote', { name, providerType })
      res.status(201).json({ success: true })
    }))

    this.app.delete('/api/rclone/remotes/:name', validateParams(nameParamSchema), asyncHandler(async (req, res) => {
      await this.rclone.deleteRemote(req.params.name)
      await this.audit.record('rclone.delete-remote', { name: req.params.name })
      res.status(204).send()
    }))

    this.app.post('/api/rclone/remotes/:name/test', validateParams(nameParamSchema), asyncHandler(async (req, res) => {
      const result = await this.rclone.testRemote(req.params.name)
      res.json(result)
    }))

    // OAuth flow — returns the authorization URL immediately
    this.app.post('/api/rclone/oauth/start', validate(RcloneOAuthStartSchema), asyncHandler(async (req, res) => {
      const { sessionId, providerType } = req.body
      if (!sessionId || !providerType) {
        throw new BadRequestError('sessionId and providerType required')
      }
      const url = await this.rclone.startOAuth(sessionId, providerType)
      res.json({ url })
    }))

    // Poll for the OAuth token (client polls until non-null)
    this.app.get('/api/rclone/oauth/token/:sessionId', validateParams(sessionIdParamSchema), (req, res) => {
      const token = this.rclone.getOAuthToken(req.params.sessionId)
      res.json({ token })
    })

    // Finish OAuth — save the token as a named remote
    this.app.post('/api/rclone/oauth/finish', validate(RcloneOAuthFinishSchema), asyncHandler(async (req, res) => {
      const { sessionId, remoteName, providerType, token } = req.body
      await this.rclone.finishOAuth(sessionId, remoteName, providerType, token)
      await this.audit.record('rclone.oauth-complete', { remoteName, providerType })
      res.json({ success: true })
    }))

    this.app.post('/api/rclone/oauth/cancel', (req, res) => {
      this.rclone.stopOAuth(req.body.sessionId)
      res.json({ success: true })
    })

  }

  /**
   * Serve the built extension UI. Searches a few common locations because
   * the compiled JS sits deeper than the source — relative `../public` from
   * `dist/backend/src/` doesn't reach the package root.
   */
  private setupStaticUI() {
    const candidates = [
      process.env.DRK_UI_DIR,
      path.resolve(__dirname, '..', 'public'),               // dist/backend/src/../public
      path.resolve(__dirname, '..', '..', 'public'),         // dist/backend/../public
      path.resolve(__dirname, '..', '..', '..', 'public'),   // dist/../public  →  packages/backend/public
      path.resolve(process.cwd(), 'public')
    ].filter(Boolean) as string[]

    const uiDir = candidates.find(d => fs.existsSync(`${d}/index.html`))
    if (!uiDir) {
      console.warn(`[DockerRescueKit] No UI bundle found. Tried: ${candidates.join(', ')}`)
      return
    }

    console.log(`\x1b[34m[UI]\x1b[0m Serving static bundle from ${uiDir}`)
    this.app.use(express.static(uiDir))
    const indexHtml = `${uiDir}/index.html`
    this.app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/metrics')) return next()
      res.sendFile(indexHtml)
    })
  }

  private setupErrorHandler() {
    this.app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
      const status = err instanceof HttpError ? err.statusCode : 500
      if (status >= 500) logger.error({ requestId: req.id, err }, 'unhandled error')
      else if (status >= 400) logger.warn({ requestId: req.id, status }, err.message)
      res.status(status).json({
        error: err.message || 'Internal Server Error',
        code: err.code,
        requestId: req.id,
      })
    })
  }

  public async start() {
    await this.scheduler.start()

    // Online license revocation check. Fires once on start, then every 24h.
    // No-op if DRK_LICENSE_SERVER_URL isn't set — the install runs in
    // offline-only mode and stays Free until a token is pasted in
    // Settings, at which point the verifier does its work locally.
    // The 24h cadence matches the maximum staleness window we accept
    // between a Square webhook revoking a license and DRK noticing.
    this.license.refreshFromServer().catch(err => {
      console.warn(`[DRK] license refresh on start failed: ${err?.message || err}`)
    })
    const LICENSE_REFRESH_MS = 24 * 60 * 60 * 1000
    const licenseTimer = setInterval(() => {
      this.license.refreshFromServer().catch(err => {
        console.warn(`[DRK] periodic license refresh failed: ${err?.message || err}`)
      })
    }, LICENSE_REFRESH_MS)
    // Don't hold the event loop open on shutdown.
    if (typeof licenseTimer.unref === 'function') licenseTimer.unref()

    // Single dispatch point — keep transport branching here so the rest of the
    // class stays transport-agnostic. The auth middleware checks TRANSPORT at
    // request time; everything else is shared.
    if (TRANSPORT === 'socket') {
      const socketPath = process.env.DRK_SOCKET_PATH || '/run/guest-services/drk.sock'
      // Ensure the parent directory exists. The compose bind-mount
      // (source=/run/guest-services/gozippy_dockerrescuekit, create_host_path:true)
      // handles this on install; mkdirSync is a safety net for bare dev runs.
      try {
        fs.mkdirSync(require('path').dirname(socketPath), { recursive: true, mode: 0o755 })
      } catch (_) { /* ignore */ }
      // Stale sockets from a previous crash will cause listen() to throw
      // EADDRINUSE — best-effort unlink before we bind. ENOENT is the happy
      // path (no leftover file). Anything else we let bubble so we don't
      // silently mask a permission problem.
      try {
        fs.unlinkSync(socketPath)
      } catch (err: any) {
        if (err && err.code !== 'ENOENT') throw err
      }
      this.httpServer = this.app.listen({ path: socketPath } as any, () => {
        // chmod after listen returns so the socket file actually exists.
        // 0o777 matches the pattern used by all Docker Desktop bundled extensions
        // (e.g. volumes-backup, grafana, harpoon) — Docker Desktop's proxy
        // service runs as a different uid so it needs world-execute to connect.
        try {
          fs.chmodSync(socketPath, 0o777)
        } catch (err: any) {
          console.warn(`[DRK] failed to chmod ${socketPath}: ${err?.message || err}`)
        }
        console.log(`[DRK] listening on unix:${socketPath} (transport=socket, auth=skipped)`)
        console.log(`\x1b[34m[Scheduler]\x1b[0m Engine initialized`)
        // Auto-export on boot. Fire-and-forget so a slow disk write never
        // delays readiness — `latest-bootstrap.json` exists for disaster
        // recovery, not for the request path. ExportService catches its own
        // errors internally; the .catch here is a belt-and-braces guard for
        // an unexpected throw before the service's try/catch engages.
        this.exportService
          .writeLatestBootstrap()
          .catch(err => logger.warn({ err }, '[ExportService] bootstrap snapshot failed'))
      })
    } else {
      const port = Number(process.env.PORT || 42880)
      this.httpServer = this.app.listen(port, () => {
        console.log(`\x1b[32m[DockerRescueKit]\x1b[0m Service running on port ${port}`)
        console.log(`\x1b[34m[Scheduler]\x1b[0m Engine initialized`)
        // Auto-export on boot. Fire-and-forget so a slow disk write never
        // delays readiness — `latest-bootstrap.json` exists for disaster
        // recovery, not for the request path. ExportService catches its own
        // errors internally; the .catch here is a belt-and-braces guard for
        // an unexpected throw before the service's try/catch engages.
        this.exportService
          .writeLatestBootstrap()
          .catch(err => logger.warn({ err }, '[ExportService] bootstrap snapshot failed'))
      })
    }

    const shutdown = async (signal: string) => {
      console.log(`\x1b[33m[DockerRescueKit]\x1b[0m Received ${signal}, shutting down…`)
      try {
        this.scheduler.stop()
        if (this.httpServer) {
          await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()))
        }
        // better-sqlite3 closes synchronously; best-effort here.
        try { (this.db as any).db?.close?.() } catch { /* ignore */ }
      } finally {
        process.exit(0)
      }
    }

    process.on('SIGTERM', () => { shutdown('SIGTERM') })
    process.on('SIGINT', () => { shutdown('SIGINT') })
  }
}

// Safety net: log unhandled rejections instead of crashing. Docker socket
// errors (ENOENT/ECONNREFUSED) surface this way when Docker Desktop is offline.
process.on('unhandledRejection', (reason: any) => {
  const code = reason?.code
  if (code === 'ENOENT' || code === 'ECONNREFUSED') {
    console.warn(`[DockerRescueKit] Docker daemon unreachable (${code}) — waiting for Docker Desktop`)
  } else {
    console.error('[DockerRescueKit] Unhandled rejection:', reason)
  }
})

// Only auto-start when invoked directly. Lets tests import the class without
// binding the port.
if (require.main === module) {
  const service = new BackupService()
  service.start().catch(err => {
    console.error('Failed to start Backup Service:', err)
    process.exit(1)
  })
}
