import { Express, Request, Response, NextFunction } from 'express'
import { Database } from '../db/Database'
import { HttpError, BadRequestError, NotFoundError } from '../errors'

export function mountNotificationRoutes(
  app: Express,
  { db }: { db: Database }
) {
  const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
    (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve(fn(req, res, next)).catch(next)
    }

  /**
   * GET /api/notifications/preferences
   * Get current user's notification preferences.
   */
  app.get('/api/notifications/preferences', asyncHandler(async (_req, res) => {
    // Note: v1.3 P2 is single-user; userId is hardcoded as 'default'
    const prefs = await db.getNotificationPreferences('default')
    if (!prefs) {
      // Return default preferences if not configured yet
      return res.json({
        userId: 'default',
        unsubscribeToken: '',
        enabled: {
          unhealthy: true,
          restart_loop: true,
          no_backup: true,
          disk_pressure: true,
          restore_failed: true
        },
        frequencies: {
          unhealthy: 'immediate',
          restart_loop: 'immediate',
          no_backup: 'daily',
          disk_pressure: 'immediate',
          restore_failed: 'immediate'
        },
        deliveryChannels: ['webhook'],
        customThresholds: {
          restartCount: 5,
          diskPercent: 70,
          backupAgeDays: 7
        }
      })
    }
    res.json(prefs)
  }))

  /**
   * POST /api/notifications/preferences
   * Update notification preferences.
   *
   * Body:
   * {
   *   enabled: { unhealthy: true, restart_loop: true, no_backup: false, ... },
   *   frequencies: { unhealthy: 'immediate', ... },
   *   deliveryChannels: ['webhook', 'email'],
   *   webhookUrl: 'https://my-server.com/webhook',
   *   customThresholds: { restartCount: 10, diskPercent: 80, backupAgeDays: 14 }
   * }
   */
  app.post('/api/notifications/preferences', asyncHandler(async (req, res) => {
    const { enabled, frequencies, deliveryChannels, webhookUrl, customThresholds } = req.body

    // Validate webhook URL if webhook channel is selected
    if (deliveryChannels?.includes('webhook') && !webhookUrl) {
      throw new BadRequestError('webhookUrl is required when webhook channel is enabled')
    }

    const prefs = {
      enabled: enabled || {
        unhealthy: true,
        restart_loop: true,
        no_backup: true,
        disk_pressure: true,
        restore_failed: true
      },
      frequencies: frequencies || {
        unhealthy: 'immediate',
        restart_loop: 'immediate',
        no_backup: 'daily',
        disk_pressure: 'immediate',
        restore_failed: 'immediate'
      },
      deliveryChannels: deliveryChannels || ['webhook'],
      webhookUrl,
      customThresholds: customThresholds || {
        restartCount: 5,
        diskPercent: 70,
        backupAgeDays: 7
      }
    }

    await db.upsertNotificationPreferences('default', prefs)
    res.json(prefs)
  }))

  /**
   * GET /api/notifications/log?eventType=unhealthy&limit=50&offset=0
   * List recent notifications (for debugging).
   */
  app.get('/api/notifications/log', asyncHandler(async (req, res) => {
    const eventType = String(req.query.eventType || '').trim()
    const limit = Math.min(Number(req.query.limit || 50), 200)
    const offset = Number(req.query.offset || 0)

    // Query from database
    // For now, return empty array as the detailed log listing isn't implemented
    // This is a stub for v1.4 UI integration
    const entries: any[] = []
    res.json({
      entries,
      total: 0,
      limit,
      offset
    })
  }))

  /**
   * POST /api/notifications/{id}/acknowledge
   * Mark a notification as acknowledged by the user.
   */
  app.post('/api/notifications/:id/acknowledge', asyncHandler(async (req, res) => {
    const { id } = req.params
    // Log entry acknowledged — for v1.4 in-app UI
    // For now, this is a stub
    res.json({ ok: true })
  }))
}
