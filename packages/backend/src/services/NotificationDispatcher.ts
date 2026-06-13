import axios from 'axios'
import { Database } from '../db/Database'
import { DockerService } from './DockerService'
import { NotificationService } from './NotificationService'
import { SsrfGuard } from '../security/SsrfGuard'
import { logger as defaultLogger } from '../utils/logger'
import { v4 as uuid } from 'uuid'
import type { NotificationPayload, NotificationEventType } from '@docker-rescue-kit/shared'
import type { Logger } from 'pino'

/**
 * Validate + SSRF-check an operator-configured delivery URL. Accepts only
 * http(s). SsrfGuard.assertSafe() blocks the cloud-metadata endpoint always,
 * and (under DRK_SSRF_STRICT) the full private range. RFC-1918 / LAN hosts
 * stay reachable by default because operators commonly point at LAN-hosted
 * Slack/ntfy/n8n — DRK is homelab-first.
 */
async function assertSafeDeliveryUrl(raw: unknown): Promise<string> {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('delivery URL is missing')
  }
  const u = new URL(raw)
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`delivery URL has unsupported protocol: ${u.protocol}`)
  }
  await SsrfGuard.assertSafe(u.toString())
  return u.toString()
}

/**
 * N-1 Notification Dispatcher — sends proactive health alerts before failure occurs.
 *
 * Handles:
 * - Unhealthy containers (running but health check failing)
 * - Restart-looping containers (frequent restarts approaching CrashLoopBackOff)
 * - Volumes without backups or with stale backups
 * - Disk pressure rising toward capacity
 * - Restore rehearsal failures (backup test failed)
 *
 * Features:
 * - Deduplication (24-hour cooldown per event per resource)
 * - User preference support (enable/disable per event type, custom thresholds)
 * - Multi-channel delivery (webhook, email)
 * - Automatic retry for critical events
 * - TTL cleanup of old notifications (30 days)
 */
export class NotificationDispatcher {
  // Default-parameter referencing the imported `logger` name was a TDZ
  // hazard — once TypeScript renamed the param to `logger` to match the
  // property, the param shadowed the import in the default expression,
  // crashing every container startup with
  //   ReferenceError: Cannot access 'logger' before initialization
  // Renaming the import to defaultLogger removes the shadow.
  constructor(
    private database: Database,
    private docker: DockerService,
    private notificationService: NotificationService,
    private logger: Logger = defaultLogger
  ) {}

  /**
   * Dispatch a notification event if not recently sent to this resource.
   * Implements 24-hour deduplication per (eventType, resourceId).
   *
   * Returns true if notification was sent, false if skipped due to deduplication.
   */
  public async dispatchNotification(
    eventType: NotificationEventType,
    resourceId: string,
    resourceName: string,
    details: any,
    severity: 'warning' | 'critical' = 'warning'
  ): Promise<boolean> {
    try {
      // 1. Check deduplication — has this event been sent in last 24 hours?
      const lastNotif = await this.database.getLastNotification(eventType, resourceId)
      if (lastNotif) {
        this.logger.debug(`[N1Notif] Skipping duplicate ${eventType}/${resourceId} (last sent at ${lastNotif.sentAt})`)
        return false
      }

      // 2. Load user preferences (currently single-user, no userId column)
      const prefs = await this.database.getNotificationPreferences('default')
      if (!prefs) {
        this.logger.debug(`[N1Notif] No preferences configured; skipping ${eventType}`)
        return false
      }

      // 3. Check if event type is enabled
      if (!prefs.enabled[eventType]) {
        this.logger.debug(`[N1Notif] Event type ${eventType} disabled in preferences`)
        return false
      }

      // 4. Build notification payload
      const payload = this.buildPayload(eventType, resourceId, resourceName, details, severity)

      // 5. Insert log entry as 'pending'
      const logId = await this.database.insertNotificationLog({
        eventType,
        resourceId,
        resourceName,
        severity,
        status: 'pending',
        payload
      })

      // 6. Dispatch to configured channels
      let success = false
      for (const channel of prefs.deliveryChannels) {
        try {
          await this.sendNotification(channel, payload, prefs)
          success = true
        } catch (err) {
          this.logger.error(
            { channel, eventType, resourceId, err },
            '[N1Notif] Channel delivery failed'
          )
        }
      }

      // 7. Update log entry status
      if (success) {
        await this.database.updateNotificationStatus(logId, 'sent')
        this.logger.info(`[N1Notif] Sent ${eventType} for ${resourceName} (${resourceId})`)
      } else {
        await this.database.updateNotificationStatus(logId, 'failed', 'All channels failed')
      }

      return success
    } catch (err) {
      this.logger.error(
        { eventType, resourceId, err },
        '[N1Notif] Dispatch failed'
      )
      return false
    }
  }

  /**
   * Build event-specific notification payload with subject, message, and details.
   */
  private buildPayload(
    eventType: NotificationEventType,
    resourceId: string,
    resourceName: string,
    details: any,
    severity: 'warning' | 'critical'
  ): NotificationPayload {
    const now = new Date().toISOString()

    switch (eventType) {
      case 'unhealthy': {
        return {
          id: uuid(),
          eventType,
          severity,
          timestamp: now,
          subject: `Container ${resourceName} is unhealthy`,
          message: `Container ${resourceName} (${resourceId.substring(0, 12)}) is unhealthy and may fail soon. Last health check failed at ${details.lastHealthCheck}.`,
          actionUrl: `/api/dashboard?container=${encodeURIComponent(resourceName)}`,
          details
        }
      }

      case 'restart_loop': {
        return {
          id: uuid(),
          eventType,
          severity,
          timestamp: now,
          subject: `Container ${resourceName} is restarting frequently`,
          message: `Container ${resourceName} has restarted ${details.restartCount} times in the last hour. Last exit code: ${details.lastExitCode}. This may indicate a critical application error.`,
          actionUrl: `/api/dashboard?container=${encodeURIComponent(resourceName)}`,
          details
        }
      }

      case 'no_backup': {
        return {
          id: uuid(),
          eventType,
          severity,
          timestamp: now,
          subject: `Volume ${resourceName} has no backup`,
          message: `Volume ${resourceName} (${(details.volumeSize / 1024 / 1024 / 1024).toFixed(1)} GB) is not covered by a backup policy. This data is at risk.`,
          actionUrl: `/api/dashboard?tab=policies`,
          details
        }
      }

      case 'disk_pressure': {
        const usedPercent = (details.usedPercent || 0).toFixed(1)
        return {
          id: uuid(),
          eventType,
          severity,
          timestamp: now,
          subject: `Disk usage is ${usedPercent}% — running low on space`,
          message: `Docker host disk is ${usedPercent}% full. Reclaimable space: ${(details.reclaimableBytes / 1024 / 1024 / 1024).toFixed(1)} GB. Consider running the Safe Cleanup Wizard.`,
          actionUrl: `/api/dashboard?tab=cleanup`,
          details
        }
      }

      case 'restore_failed': {
        return {
          id: uuid(),
          eventType,
          severity: 'critical',  // Always critical
          timestamp: now,
          subject: `Restore test FAILED for policy ${resourceName}`,
          message: `The periodic restore rehearsal for policy ${resourceName} failed. This indicates backups may not restore correctly when needed. Reason: ${details.failureReason}`,
          actionUrl: `/api/rehearsals?policyId=${encodeURIComponent(resourceId)}`,
          details
        }
      }

      default: {
        // Fallback
        return {
          id: uuid(),
          eventType,
          severity,
          timestamp: now,
          subject: `Alert: ${eventType} on ${resourceName}`,
          message: `An event occurred.`,
          details
        }
      }
    }
  }

  /**
   * Send notification to a single delivery channel. Throws on failure so the
   * caller can record per-channel errors and decide overall success.
   */
  private async sendNotification(
    channel: string,
    payload: NotificationPayload,
    prefs: any
  ): Promise<void> {
    switch (channel) {
      case 'webhook': {
        if (!prefs.webhookUrl) {
          throw new Error('Webhook URL not configured')
        }
        await this.sendWebhook(payload, prefs.webhookUrl)
        return
      }

      case 'ntfy': {
        if (!prefs.ntfyUrl) {
          throw new Error('ntfy URL not configured')
        }
        await this.sendNtfy(payload, prefs.ntfyUrl)
        return
      }

      case 'email': {
        if (!prefs.emailTo) {
          throw new Error('Email recipient (emailTo) not configured')
        }
        await this.sendEmail(payload, prefs.emailTo)
        return
      }

      default: {
        throw new Error(`Unknown delivery channel: ${channel}`)
      }
    }
  }

  /**
   * POST notification to webhook URL with exponential backoff.
   * Max 3 retries: 1s, 2s, 4s. URL is SSRF-checked before each attempt.
   */
  private async sendWebhook(payload: NotificationPayload, url: string): Promise<void> {
    const target = await assertSafeDeliveryUrl(url)
    const maxRetries = 3
    let lastError: any

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await axios.post(target, payload, {
          timeout: 15_000,
          // assertSafeDeliveryUrl only vets the URL we hand axios; without this
          // a safe-looking host could 30x-redirect to 169.254.169.254 and the
          // SSRF guard never sees the final hop. Refuse to follow redirects.
          maxRedirects: 0,
          headers: {
            'Content-Type': 'application/json',
            'X-DRK-Event': payload.eventType,
            'X-DRK-Severity': payload.severity
          }
        })
        return  // Success
      } catch (err) {
        lastError = err
        if (attempt < maxRetries) {
          const delayMs = Math.pow(2, attempt) * 1000
          await new Promise(resolve => setTimeout(resolve, delayMs))
        }
      }
    }

    throw new Error(`Webhook failed after ${maxRetries} retries: ${lastError?.message}`)
  }

  /**
   * Push a plain-text alert to an ntfy topic URL (homelab-friendly push).
   * Single attempt — ntfy is fire-and-forget; the retry sweep handles the
   * 'failed' rows. URL is SSRF-checked first.
   */
  private async sendNtfy(payload: NotificationPayload, url: string): Promise<void> {
    const target = await assertSafeDeliveryUrl(url)
    await axios.post(target, `${payload.subject}\n\n${payload.message}`, {
      timeout: 15_000,
      maxRedirects: 0, // see sendWebhook — don't let a redirect escape the SSRF guard
      headers: {
        'Content-Type': 'text/plain',
        Title: payload.subject,
        Priority: payload.severity === 'critical' ? 'high' : 'default',
        Tags: payload.severity === 'critical' ? 'rotating_light' : 'warning',
      },
    })
  }

  /**
   * Deliver the alert as email via the shared NotificationService SMTP path
   * (self-hosted SMTP, no third-party API). Throws a clear error when no SMTP
   * config is resolvable so the channel is marked failed honestly rather than
   * silently dropped.
   */
  private async sendEmail(payload: NotificationPayload, to: string): Promise<void> {
    const sent = await this.notificationService.sendAlertEmail(
      to,
      `[DRK] ${payload.subject}`,
      payload.message,
    )
    if (!sent) {
      throw new Error('email sink unavailable — no SMTP configured (set smtp.* settings or DRK_SMTP_* env)')
    }
  }

  /**
   * Fire a real test notification to a single sink so the user can confirm
   * delivery from the Notifications UI. Reuses the live sink code paths and
   * the operator's saved preferences (webhookUrl / ntfyUrl / emailTo).
   *
   * Returns { ok, error? }. Never throws — the route reports the result.
   */
  public async sendTestNotification(
    sink: 'webhook' | 'ntfy' | 'email',
  ): Promise<{ ok: boolean; error?: string }> {
    const prefs = await this.database.getNotificationPreferences('default')
    const payload: NotificationPayload = {
      id: uuid(),
      eventType: 'unhealthy',
      severity: 'warning',
      timestamp: new Date().toISOString(),
      subject: 'DockerRescueKit test notification',
      message: `This is a test ${sink} notification from DockerRescueKit. If you received it, ${sink} delivery is working.`,
      details: { test: true },
    }
    try {
      await this.sendNotification(sink, payload, prefs || {})
      this.logger.info(`[N1Notif] Test notification delivered via ${sink}`)
      return { ok: true }
    } catch (err) {
      const error = (err as Error).message
      this.logger.warn({ sink, err }, '[N1Notif] Test notification failed')
      return { ok: false, error }
    }
  }

  /** Whether the email sink can currently send (SMTP resolvable). The UI uses
   *  this to avoid offering email when no SMTP is configured. */
  public async isEmailAvailable(): Promise<boolean> {
    return this.notificationService.hasSmtpConfigured()
  }
}
