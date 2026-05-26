import { Express, Request, Response, NextFunction } from 'express'
import { LogTriageService } from '../services/LogTriageService'
import { Database } from '../db/Database'
import { HttpError } from '../errors'
import { logger } from '../utils/logger'

/**
 * Mount logs triage routes to Express app.
 * Requires X-API-Key authentication via parent app middleware.
 */
export function mountLogsRoutes(
  app: Express,
  options: { triageService: LogTriageService; db: Database }
) {
  const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
    (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve(fn(req, res, next)).catch(next)
    }

  /**
   * GET /api/logs/triage?containerId=<id>&limit=100&category=...
   *
   * Classify logs for a single container.
   * Returns categorized events with fix suggestions.
   *
   * Query Parameters:
   * - containerId (required): Container ID or name
   * - limit (optional, default 100, max 10000): Max log lines to fetch
   * - category (optional): Filter results by category (oomkilled, port_conflict, etc)
   *
   * Response:
   * {
   *   events: TriagedEvent[],
   *   fetchedLines: number,
   *   categories: { oomkilled: 0, port_conflict: 1, ... }
   * }
   *
   * Error codes:
   * - 400: Missing containerId or invalid limit
   * - 404: Container not found
   * - 503: Docker offline or log fetch failed
   */
  app.get(
    '/api/logs/triage',
    asyncHandler(async (req, res) => {
      const { containerId, limit: limitStr, category } = req.query

      if (!containerId || typeof containerId !== 'string') {
        return res.status(400).json({ error: 'containerId query parameter required' })
      }

      let limit = 100
      if (limitStr) {
        const parsedLimit = parseInt(limitStr as string, 10)
        if (isNaN(parsedLimit)) {
          return res.status(400).json({ error: 'limit must be a valid integer' })
        }
        limit = Math.min(10000, Math.max(1, parsedLimit))
      }

      try {
        const start = Date.now()
        const categoryParam = category && typeof category === 'string' ? category : undefined
        const response = await options.triageService.classifyEvents(containerId, limit, categoryParam)
        const elapsed = Date.now() - start

        logger.info({
          containerId,
          fetchedLines: response.fetchedLines,
          eventCount: response.events.length,
          responseTimeMs: elapsed
        }, `Triaged logs for ${containerId}`)

        res.json({
          events: response.events,
          fetchedLines: response.fetchedLines,
          categories: response.categories,
          responseTimeMs: elapsed
        })
      } catch (err: any) {
        if (err.message?.includes('not found')) {
          return res.status(404).json({ error: `Container not found: ${containerId}` })
        }
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          return res.status(403).json({ error: 'Permission denied reading logs' })
        }
        logger.error(`Error triaging logs for ${containerId}:`, err)
        res.status(503).json({ error: 'Failed to read container logs (Docker offline or unavailable)' })
      }
    })
  )

  /**
   * GET /api/logs/triage/all?offset=0&limit=50&category=...&since=...
   *
   * Query historical log events with pagination.
   *
   * Query Parameters:
   * - offset (optional, default 0): Pagination offset
   * - limit (optional, default 50, max 10000): Results per page
   * - category (optional): Filter by category
   * - since (optional): ISO 8601 date to filter events from
   *
   * Response:
   * {
   *   events: TriagedEvent[],
   *   total: number,
   *   offset: number,
   *   limit: number
   * }
   */
  app.get(
    '/api/logs/triage/all',
    asyncHandler(async (req, res) => {
      const { offset: offsetStr, limit: limitStr, category, since } = req.query

      let offset = 0
      if (offsetStr) {
        offset = Math.max(0, parseInt(offsetStr as string, 10))
        if (isNaN(offset)) {
          return res.status(400).json({ error: 'offset must be a valid integer' })
        }
      }

      let limit = 50
      if (limitStr) {
        limit = Math.min(10000, Math.max(1, parseInt(limitStr as string, 10)))
        if (isNaN(limit)) {
          return res.status(400).json({ error: 'limit must be a valid integer' })
        }
      }

      try {
        const { events, total } = await options.db.getLogEvents({
          offset,
          limit,
          category: category ? (category as string) : undefined,
          since: since ? (since as string) : undefined
        })

        res.json({
          events,
          total,
          offset,
          limit,
          pages: Math.ceil(total / limit)
        })
      } catch (err) {
        logger.error({ err }, 'Error querying log events')
        res.status(500).json({ error: 'Failed to query log events' })
      }
    })
  )

  /**
   * POST /api/logs/triage/scan-all
   *
   * Background job to scan all broken containers for log patterns.
   * Runs asynchronously; responds immediately with job ID.
   *
   * Response:
   * { jobId: string, status: 'started' }
   */
  app.post(
    '/api/logs/triage/scan-all',
    asyncHandler(async (req, res) => {
      const jobId = `scan-all-${Date.now()}`

      res.json({ jobId, status: 'started' })

      // Run scan in background without blocking response
      setImmediate(async () => {
        try {
          await options.triageService.scanAllContainers()
          logger.info({ jobId }, 'Background container scan completed')
        } catch (err) {
          logger.error({ err }, 'Background container scan failed')
        }
      })
    })
  )
}
