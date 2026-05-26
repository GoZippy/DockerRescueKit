import type { Application, Request, Response, NextFunction } from 'express'
import type { RehearsalService } from '../services/RehearsalService'
import type { AuditService } from '../services/AuditService'
import { BadRequestError, NotFoundError } from '../errors/HttpError'
import type { RehearsalRequest } from '@docker-rescue-kit/shared'

/**
 * Rehearsal REST surface — R-1.
 *
 * Mount with `mountRehearsalRoutes(app, { rehearsalService, audit })` from
 * the main BackupService constructor. Kept in its own module so the route
 * wiring can land here without touching index.ts (avoids merge conflicts
 * with parallel UI/license-server work).
 *
 * To activate from index.ts, add ONE line near the other route registrations:
 *
 *   mountRehearsalRoutes(this.app, {
 *     rehearsalService: this.rehearsalService,
 *     audit: this.audit,
 *   })
 *
 * The endpoints registered:
 *
 *   POST   /api/rehearsals             — enqueue a rehearsal (202)
 *   GET    /api/rehearsals             — list past runs (?policyId=, ?limit=)
 *   GET    /api/rehearsals/:id         — full report
 *   GET    /api/rehearsals/:id/stream  — SSE: status / step / check / done frames
 *   POST   /api/rehearsals/:id/abort   — signal cancel
 *   DELETE /api/rehearsals/:id         — delete the persisted record
 */

export interface RehearsalRouteDeps {
  rehearsalService: RehearsalService
  audit: AuditService
}

export function mountRehearsalRoutes(app: Application, deps: RehearsalRouteDeps): void {
  const { rehearsalService, audit } = deps

  // -------------------------------------------------------------------------
  // POST /api/rehearsals
  // -------------------------------------------------------------------------
  app.post('/api/rehearsals', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = parseRehearsalRequest(req.body)
      const id = await rehearsalService.enqueue(payload)
      await audit.record('rehearsal.start', {
        rehearsalId: id,
        policyId: payload.policyId,
        backupCount: payload.backupIds?.length ?? 0,
        smokeCheckCount: payload.smokeChecks.length,
      })
      res.status(202).json({ id, status: 'pending' })
    } catch (err) {
      next(err)
    }
  })

  // -------------------------------------------------------------------------
  // GET /api/rehearsals
  // -------------------------------------------------------------------------
  app.get('/api/rehearsals', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const policyId = typeof req.query.policyId === 'string' ? req.query.policyId : undefined
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined
      const list = await rehearsalService.list({ policyId, limit })
      res.json(list)
    } catch (err) {
      next(err)
    }
  })

  // -------------------------------------------------------------------------
  // GET /api/rehearsals/:id
  // -------------------------------------------------------------------------
  app.get('/api/rehearsals/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const report = await rehearsalService.getReport(req.params.id)
      if (!report) throw new NotFoundError('rehearsal', req.params.id)
      res.json(report)
    } catch (err) {
      next(err)
    }
  })

  // -------------------------------------------------------------------------
  // GET /api/rehearsals/:id/stream  — Server-Sent Events
  // -------------------------------------------------------------------------
  app.get('/api/rehearsals/:id/stream', async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      // Initial frame so the client knows we're alive
      res.write(`event: hello\ndata: ${JSON.stringify({ rehearsalId: req.params.id })}\n\n`)

      const unsubscribe = rehearsalService.subscribe(req.params.id, frame => {
        // SSE frame: `event: <name>\n data: <json>\n\n`
        res.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`)
        if (frame.event === 'done') {
          unsubscribe()
          res.end()
        }
      })

      // Heartbeat every 15s so reverse proxies don't time out the connection
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
  // POST /api/rehearsals/:id/abort
  // -------------------------------------------------------------------------
  app.post('/api/rehearsals/:id/abort', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const aborted = await rehearsalService.abort(req.params.id)
      if (!aborted) throw new NotFoundError('active rehearsal', req.params.id)
      await audit.record('rehearsal.abort', { rehearsalId: req.params.id })
      res.status(202).json({ aborted: true })
    } catch (err) {
      next(err)
    }
  })

  // -------------------------------------------------------------------------
  // DELETE /api/rehearsals/:id
  // -------------------------------------------------------------------------
  app.delete('/api/rehearsals/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      // We deliberately do NOT teardown resources here — teardown is owned
      // by the run lifecycle. This endpoint only drops the persisted record.
      const db = (rehearsalService as any).deps?.db
      if (db?.deleteRehearsal) {
        await db.deleteRehearsal(req.params.id)
      }
      res.status(204).send()
    } catch (err) {
      next(err)
    }
  })
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

function parseRehearsalRequest(body: unknown): RehearsalRequest {
  if (!body || typeof body !== 'object') {
    throw new BadRequestError('request body must be a JSON object', 'INVALID_BODY')
  }
  const b = body as Record<string, any>

  if (!Array.isArray(b.smokeChecks) || b.smokeChecks.length === 0) {
    throw new BadRequestError('smokeChecks must be a non-empty array', 'INVALID_SMOKE_CHECKS')
  }
  if (b.policyId !== undefined && typeof b.policyId !== 'string') {
    throw new BadRequestError('policyId must be a string when provided', 'INVALID_POLICY_ID')
  }
  if (b.backupIds !== undefined) {
    if (!Array.isArray(b.backupIds) || b.backupIds.some((x: unknown) => typeof x !== 'string')) {
      throw new BadRequestError('backupIds must be an array of strings', 'INVALID_BACKUP_IDS')
    }
  }
  if (!b.policyId && !b.backupIds?.length) {
    throw new BadRequestError('Either policyId or backupIds is required', 'MISSING_TARGET')
  }
  if (b.policyId && b.backupIds?.length) {
    throw new BadRequestError('policyId and backupIds are mutually exclusive', 'CONFLICTING_TARGET')
  }

  for (const c of b.smokeChecks) {
    if (!c || typeof c !== 'object') {
      throw new BadRequestError('each smoke check must be an object', 'INVALID_SMOKE_CHECK')
    }
    if (typeof c.kind !== 'string') {
      throw new BadRequestError(`smoke check missing kind: ${JSON.stringify(c)}`, 'INVALID_SMOKE_CHECK')
    }
    if (!['http', 'exec', 'tcp', 'file_exists', 'sql_select_1'].includes(c.kind)) {
      throw new BadRequestError(`unknown smoke check kind: ${c.kind}`, 'UNKNOWN_SMOKE_CHECK_KIND')
    }
    if (typeof c.container !== 'string' || !c.container) {
      throw new BadRequestError(`smoke check missing container: ${JSON.stringify(c)}`, 'INVALID_SMOKE_CHECK')
    }
    if (c.kind === 'sql_select_1' && !['postgres', 'mysql', 'mssql'].includes(c.driver)) {
      throw new BadRequestError(`sql_select_1 requires driver in {postgres,mysql,mssql}`, 'INVALID_SQL_DRIVER')
    }
    if (c.kind === 'file_exists' && typeof c.path !== 'string') {
      throw new BadRequestError('file_exists requires path', 'INVALID_FILE_PATH')
    }
    if ((c.kind === 'http' || c.kind === 'tcp') && typeof c.port !== 'number') {
      throw new BadRequestError(`${c.kind} requires numeric port`, 'INVALID_PORT')
    }
    if (c.kind === 'exec' && (!Array.isArray(c.command) || c.command.length === 0)) {
      throw new BadRequestError('exec requires non-empty command array', 'INVALID_EXEC_COMMAND')
    }
  }

  return body as RehearsalRequest
}
