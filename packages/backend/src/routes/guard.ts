import type { Application, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import type { PruneGuardService } from '../services/PruneGuardService'
import type { SettingsService } from '../services/SettingsService'
import type { Database } from '../db/Database'
import type { AuditService } from '../services/AuditService'
import type { GuardOpKind } from '@docker-rescue-kit/shared'
import { BadRequestError, NotFoundError } from '../errors'
import { validateParams, validateQuery } from '../validation/validate'

/**
 * Prune Guard REST surface — PG-1.4 (docs/design/PRUNE_GUARD.md §9).
 *
 * Mount with `mountGuardRoutes(app, { guard, settings, db, audit })`. Kept in
 * its own module so the wiring lands without editing index.ts's inline route
 * block (one registration line), mirroring `mountRehearsalRoutes`.
 *
 * Prune Guard is a FREE feature (§2 goal 7, §10.4): NO `requireFeature` gate on
 * any of these routes. The env kill-switch `DRK_PRUNE_GUARD` decides at the
 * index.ts level whether the routes mount at all — when off, the frontend sees
 * 404 on GET /api/guard/settings and hides the feature (per commit 1a6fa31).
 *
 * Endpoints registered:
 *   GET    /api/guard/settings
 *   PUT    /api/guard/settings
 *   GET    /api/guard/events            (?limit, ?status, ?before)
 *   GET    /api/guard/events/:id
 *   POST   /api/guard/events/:id/restore   → 202 { restored: [...] }
 *   POST   /api/guard/events/:id/pin
 *   DELETE /api/guard/events/:id
 *   POST   /api/guard/snapshot          → GuardEvent  (the MCP contract addition)
 *   GET    /api/guard/stream            (SSE — snapshot/too_late/warning frames)
 *   POST   /api/guard/test              (dev/E2E only, behind DRK_GUARD_TEST=1)
 */

export interface GuardRouteDeps {
  guard: PruneGuardService
  settings: SettingsService
  db: Database
  audit: AuditService
}

/** The 8 GuardOpKind values (§8.1). */
const GUARD_OP_KINDS = [
  'volume_rm',
  'volume_prune',
  'container_rm_v',
  'system_prune',
  'image_prune',
  'compose_down_v',
  'container_die',
  'periodic_floor',
] as const

/** GuardEvent.trigger enum (§8.1). */
const GUARD_TRIGGERS = ['mcp', 'proxy', 'event', 'periodic'] as const

// :id is a uuid v4 in normal use, but we accept any short opaque token so
// dev/test ids ('e-1') pass too; reject obviously-malformed (overlong) ids.
const idParamSchema = z.object({ id: z.string().min(1).max(128) })

const eventsQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().max(500).optional(),
    status: z.string().min(1).max(32).optional(),
    before: z.string().min(1).max(64).optional(),
  })
  .passthrough()

const restoreBodySchema = z.object({
  volumes: z.array(z.string()).optional(),
})

const snapshotBodySchema = z.object({
  kind: z.enum(GUARD_OP_KINDS).optional(),
  trigger: z.enum(GUARD_TRIGGERS).optional(),
  volumes: z.array(z.string()).min(1),
})

const testBodySchema = z.object({
  kind: z.enum(GUARD_OP_KINDS).optional(),
  volumes: z.array(z.string()).min(1),
})

export function mountGuardRoutes(app: Application, deps: GuardRouteDeps): void {
  const { guard, settings, db } = deps

  const asyncHandler =
    (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
    (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve(fn(req, res, next)).catch(next)
    }

  // -------------------------------------------------------------------------
  // GET /api/guard/settings
  // -------------------------------------------------------------------------
  app.get(
    '/api/guard/settings',
    asyncHandler(async (_req, res) => {
      res.json(await settings.getGuardSettings())
    }),
  )

  // -------------------------------------------------------------------------
  // PUT /api/guard/settings — validated by SettingsService.setGuardSettings
  // -------------------------------------------------------------------------
  app.put(
    '/api/guard/settings',
    asyncHandler(async (req, res) => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new BadRequestError('request body must be a JSON object', 'INVALID_BODY')
      }
      try {
        // SettingsService validates each field (cron via node-cron, budgets > 0,
        // scope enum) and throws on a bad patch so nothing partial persists.
        const next = await settings.setGuardSettings(req.body)
        res.json(next)
      } catch (err: any) {
        throw new BadRequestError(err?.message || 'invalid guard settings', 'INVALID_GUARD_SETTINGS')
      }
    }),
  )

  // -------------------------------------------------------------------------
  // GET /api/guard/events  (?limit, ?status, ?before)
  // -------------------------------------------------------------------------
  app.get(
    '/api/guard/events',
    validateQuery(eventsQuerySchema),
    asyncHandler(async (req, res) => {
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined
      const status = typeof req.query.status === 'string' ? req.query.status : undefined
      const before = typeof req.query.before === 'string' ? req.query.before : undefined
      const list = await db.listGuardEvents({ limit, status, before })
      res.json(list)
    }),
  )

  // -------------------------------------------------------------------------
  // GET /api/guard/events/:id — full event
  // -------------------------------------------------------------------------
  app.get(
    '/api/guard/events/:id',
    validateParams(idParamSchema),
    asyncHandler(async (req, res) => {
      const event = await db.getGuardEvent(req.params.id)
      if (!event) throw new NotFoundError('guard event', req.params.id)
      res.json(event)
    }),
  )

  // -------------------------------------------------------------------------
  // POST /api/guard/events/:id/restore  → 202 { restored: [...] }
  // -------------------------------------------------------------------------
  app.post(
    '/api/guard/events/:id/restore',
    validateParams(idParamSchema),
    asyncHandler(async (req, res) => {
      const parsed = restoreBodySchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        throw new BadRequestError('volumes must be an array of strings', 'INVALID_VOLUMES')
      }
      const exists = await db.getGuardEvent(req.params.id)
      if (!exists) throw new NotFoundError('guard event', req.params.id)
      const { restored, failed } = await guard.restore(req.params.id, parsed.data.volumes)
      res.status(202).json({ restored, failed })
    }),
  )

  // -------------------------------------------------------------------------
  // POST /api/guard/events/:id/pin — promote to a kept backup ('keep my work')
  // -------------------------------------------------------------------------
  app.post(
    '/api/guard/events/:id/pin',
    validateParams(idParamSchema),
    asyncHandler(async (req, res) => {
      const exists = await db.getGuardEvent(req.params.id)
      if (!exists) throw new NotFoundError('guard event', req.params.id)
      await guard.pin(req.params.id)
      res.json({ id: req.params.id, pinned: true })
    }),
  )

  // -------------------------------------------------------------------------
  // DELETE /api/guard/events/:id — drop record + tarballs (reclaim disk)
  // -------------------------------------------------------------------------
  app.delete(
    '/api/guard/events/:id',
    validateParams(idParamSchema),
    asyncHandler(async (req, res) => {
      const { reclaimedBytes } = await guard.remove(req.params.id)
      res.json({ id: req.params.id, reclaimedBytes })
    }),
  )

  // -------------------------------------------------------------------------
  // POST /api/guard/snapshot — the production "snapshot now" endpoint.
  //
  // REQUIRED-CONTRACT-ADDITION (not in §9): the MCP package (drkClient.ts) calls
  // POST /guard/snapshot { kind, trigger:'mcp', volumes } and expects a
  // GuardEvent back. Thin wrapper over PruneGuardService.guard(kind, trigger,
  // volumes). Defaults: kind='system_prune' (matches drkClient.snapshotNow),
  // trigger='mcp'.
  // -------------------------------------------------------------------------
  app.post(
    '/api/guard/snapshot',
    asyncHandler(async (req, res) => {
      const parsed = snapshotBodySchema.safeParse(req.body)
      if (!parsed.success) {
        throw new BadRequestError(
          'snapshot requires a non-empty volumes array; kind/trigger must be valid enums',
          'INVALID_SNAPSHOT',
        )
      }
      const kind: GuardOpKind = parsed.data.kind ?? 'system_prune'
      const trigger = parsed.data.trigger ?? 'mcp'
      const event = await guard.guard(kind, trigger, parsed.data.volumes)
      res.json(event)
    }),
  )

  // -------------------------------------------------------------------------
  // GET /api/guard/stream — Server-Sent Events (mirrors rehearsals/:id/stream).
  // The extension subscribes once globally to drive the undo toast.
  // -------------------------------------------------------------------------
  app.get('/api/guard/stream', (req: Request, res: Response, next: NextFunction) => {
    try {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      // Initial frame so the client knows we're alive.
      res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`)

      // Bridge PruneGuardService frames (snapshot/too_late/warning) → SSE events.
      const unsubscribe = guard.subscribe(frame => {
        res.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`)
      })

      // Heartbeat every 15s so reverse proxies don't time out the connection.
      const heartbeat = setInterval(() => res.write(`: ping\n\n`), 15_000)

      req.on('close', () => {
        clearInterval(heartbeat)
        unsubscribe()
      })
    } catch (err) {
      next(err)
    }
  })

  // -------------------------------------------------------------------------
  // POST /api/guard/test — dev/E2E only, behind DRK_GUARD_TEST=1 (404 otherwise).
  // Simulate a guard event end-to-end (§9, §14.2).
  // -------------------------------------------------------------------------
  app.post(
    '/api/guard/test',
    asyncHandler(async (req, res) => {
      if (process.env.DRK_GUARD_TEST !== '1') {
        throw new NotFoundError('guard test endpoint')
      }
      const parsed = testBodySchema.safeParse(req.body)
      if (!parsed.success) {
        throw new BadRequestError('test requires { kind?, volumes: [...] }', 'INVALID_TEST')
      }
      const kind: GuardOpKind = parsed.data.kind ?? 'system_prune'
      const event = await guard.guard(kind, 'event', parsed.data.volumes)
      res.status(202).json(event)
    }),
  )
}
