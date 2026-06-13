import { Express, Request, Response, NextFunction } from 'express'
import { Database } from '../db/Database'
import { NotificationDispatcher } from '../services/NotificationDispatcher'
import { BadRequestError, NotFoundError } from '../errors'
import type { NotificationSink } from '@docker-rescue-kit/shared'

const VALID_SINKS: NotificationSink[] = ['webhook', 'ntfy', 'email']

export function mountNotificationRoutes(
  app: Express,
  { db, dispatcher }: { db: Database; dispatcher?: NotificationDispatcher }
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
    // The UI needs to know whether the email sink can actually deliver
    // (SMTP resolvable) so it can mark it unavailable rather than offer a
    // sink that will always fail.
    const emailAvailable = dispatcher ? await dispatcher.isEmailAvailable() : false
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
        webhookUrl: '',
        ntfyUrl: '',
        emailTo: '',
        customThresholds: {
          restartCount: 5,
          diskPercent: 70,
          backupAgeDays: 7
        },
        emailAvailable
      })
    }
    res.json({ ...prefs, emailAvailable })
  }))

  /**
   * POST /api/notifications/preferences
   * Update notification preferences.
   *
   * Body:
   * {
   *   enabled: { unhealthy: true, restart_loop: true, no_backup: false, ... },
   *   frequencies: { unhealthy: 'immediate', ... },
   *   deliveryChannels: ['webhook', 'ntfy', 'email'],
   *   webhookUrl: 'https://my-server.com/webhook',
   *   ntfyUrl: 'https://ntfy.sh/my-topic',
   *   emailTo: 'ops@example.com',
   *   customThresholds: { restartCount: 10, diskPercent: 80, backupAgeDays: 14 }
   * }
   */
  app.post('/api/notifications/preferences', asyncHandler(async (req, res) => {
    const { enabled, frequencies, deliveryChannels, webhookUrl, ntfyUrl, emailTo, customThresholds } = req.body

    const channels: string[] = Array.isArray(deliveryChannels) ? deliveryChannels : ['webhook']
    for (const ch of channels) {
      if (!VALID_SINKS.includes(ch as NotificationSink)) {
        throw new BadRequestError(`Unknown delivery channel: ${ch}`)
      }
    }
    // Each enabled channel needs its target so the dispatcher won't fail at
    // send time on a half-configured sink.
    if (channels.includes('webhook') && !webhookUrl) {
      throw new BadRequestError('webhookUrl is required when the webhook channel is enabled')
    }
    if (channels.includes('ntfy') && !ntfyUrl) {
      throw new BadRequestError('ntfyUrl is required when the ntfy channel is enabled')
    }
    if (channels.includes('email') && !emailTo) {
      throw new BadRequestError('emailTo is required when the email channel is enabled')
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
      deliveryChannels: channels,
      webhookUrl,
      ntfyUrl,
      emailTo,
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
   * GET /api/notifications/log?eventType=unhealthy&acknowledged=false&limit=50&offset=0
   * Paginated notification-log listing, newest first. Drives the in-app
   * notifications panel.
   */
  app.get('/api/notifications/log', asyncHandler(async (req, res) => {
    const eventTypeRaw = String(req.query.eventType || '').trim()
    const eventType = eventTypeRaw || undefined

    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200)
    const offset = Math.max(Number(req.query.offset || 0), 0)
    if (!Number.isFinite(limit) || !Number.isFinite(offset)) {
      throw new BadRequestError('limit and offset must be numbers')
    }

    let acknowledged: boolean | undefined
    if (req.query.acknowledged === 'true') acknowledged = true
    else if (req.query.acknowledged === 'false') acknowledged = false

    const { entries, total } = await db.listNotificationLog({ eventType, acknowledged, limit, offset })
    res.json({ entries, total, limit, offset })
  }))

  /**
   * GET /api/notifications/unread-count
   * Count of un-acknowledged notifications — drives the bell-icon badge.
   */
  app.get('/api/notifications/unread-count', asyncHandler(async (_req, res) => {
    const count = await db.countUnacknowledgedNotifications()
    res.json({ count })
  }))

  /**
   * POST /api/notifications/acknowledge-all
   * Mark every un-acknowledged notification as read.
   * (Declared before /:id/acknowledge so 'acknowledge-all' isn't captured as an id.)
   */
  app.post('/api/notifications/acknowledge-all', asyncHandler(async (_req, res) => {
    const acknowledged = await db.acknowledgeAllNotifications()
    res.json({ ok: true, acknowledged })
  }))

  /**
   * POST /api/notifications/:id/acknowledge
   * Mark a single notification as acknowledged by the user.
   */
  app.post('/api/notifications/:id/acknowledge', asyncHandler(async (req, res) => {
    const { id } = req.params
    const ok = await db.acknowledgeNotification(id)
    if (!ok) {
      throw new NotFoundError(`Notification ${id} not found`)
    }
    res.json({ ok: true, id })
  }))

  /**
   * POST /api/notifications/test  { sink: 'webhook' | 'ntfy' | 'email' }
   * Fire a real test notification to a single sink so the user can confirm
   * delivery. Uses the operator's saved sink targets (webhookUrl/ntfyUrl/emailTo).
   */
  app.post('/api/notifications/test', asyncHandler(async (req, res) => {
    const sink = String(req.body?.sink || '').trim() as NotificationSink
    if (!VALID_SINKS.includes(sink)) {
      throw new BadRequestError(`sink must be one of: ${VALID_SINKS.join(', ')}`)
    }
    if (!dispatcher) {
      // Should not happen in production — dispatcher is always wired. Be honest
      // rather than pretend success.
      return res.status(503).json({ ok: false, error: 'notification dispatcher unavailable' })
    }
    const result = await dispatcher.sendTestNotification(sink)
    res.json(result)
  }))
}
