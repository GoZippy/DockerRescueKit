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
import { mountRehearsalRoutes } from './routes/rehearsals'
import { PartialRestoreService } from './services/PartialRestoreService'
import { AuditService } from './services/AuditService'
import { RcloneService } from './services/RcloneService'
import { EncryptionUtility } from './utils/Encryption'
import { Server } from 'http'

dotenv.config()

// Read backend version from package.json once at startup. Walks up from
// __dirname until it finds the backend's own manifest — works in both dev
// (src/index.ts) and prod (dist/backend/src/index.js).
const APP_VERSION: string = (() => {
  let dir = __dirname
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, 'package.json')
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (pkg?.name === '@docker-rescue-kit/backend' && typeof pkg.version === 'string') {
        return pkg.version
      }
    } catch { /* keep walking */ }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return 'unknown'
})()

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
  private partial: PartialRestoreService
  private audit: AuditService
  private rclone: RcloneService
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
    this.policyManager = new PolicyManager(this.db, path.join(dataDir, 'staging'))
    this.dockerService = new DockerService()
    this.connectorManager = new ConnectorManager(this.db)
    this.telemetry = new TelemetryService()
    this.settings = new SettingsService(this.db)
    this.metrics = new MetricsService(this.policyManager, this.db)
    this.verify = new VerifyService(this.policyManager, this.dockerService, path.join(dataDir, 'staging'), this.db)
    this.partial = new PartialRestoreService(this.policyManager, path.join(dataDir, 'staging'))
    this.audit = new AuditService(this.db)
    this.rclone = new RcloneService(dataDir)
    this.scheduler = new SchedulerEngine(this.policyManager, this.verify)
    this.rehearsal = new RehearsalService({
      docker: this.dockerService,
      policyManager: this.policyManager,
      audit: this.audit,
      stagingDir: path.join(dataDir, 'staging'),
      db: this.db,
    })
    this.health = new HealthCheckService(this.dockerService, this.policyManager, this.rehearsal, this.db)

    this.setupMiddleware()
    this.setupRoutes()
    mountRehearsalRoutes(this.app, { rehearsalService: this.rehearsal, audit: this.audit })
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

    this.app.get('/api/policies/:id/history', validateParams(idParamSchema), async (req, res) => {
      res.json(await this.policyManager.getBackupHistory(req.params.id))
    })

    // ---- Backups ---------------------------------------------------------
    this.app.get('/api/backups', async (_req, res) => {
      res.json(await this.policyManager.listAllBackups())
    })

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
      res.json({
        dataDir: process.env.DRK_DATA_DIR || 'data',
        hasEncryptionKey: true,
        version: APP_VERSION,
        staging: path.join(process.env.DRK_DATA_DIR || 'data', 'staging')
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

    const uiDir = candidates.find(d => fs.existsSync(path.join(d, 'index.html')))
    if (!uiDir) {
      console.warn(`[DockerRescueKit] No UI bundle found. Tried: ${candidates.join(', ')}`)
      return
    }

    console.log(`\x1b[34m[UI]\x1b[0m Serving static bundle from ${uiDir}`)
    this.app.use(express.static(uiDir))
    this.app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/metrics')) return next()
      res.sendFile(path.join(uiDir, 'index.html'))
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
      })
    } else {
      const port = Number(process.env.PORT || 42880)
      this.httpServer = this.app.listen(port, () => {
        console.log(`\x1b[32m[DockerRescueKit]\x1b[0m Service running on port ${port}`)
        console.log(`\x1b[34m[Scheduler]\x1b[0m Engine initialized`)
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
