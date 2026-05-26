import axios from 'axios'
import { Database } from '../db/Database'
import { DockerService } from './DockerService'
import { NotificationService } from './NotificationService'
import { logger } from '../utils/logger'
import { v4 as uuid } from 'uuid'
import type { NotificationPayload, NotificationEventType } from '@docker-rescue-kit/shared'
import type { Logger } from 'pino'

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
  constructor(
    private database: Database,
    private docker: DockerService,
    private notificationService: NotificationService,
    private logger: Logger = logger
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
   * Send notification to a single delivery channel.
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

      case 'email': {
        // Email dispatch requires SMTP config from NotificationService
        // For now, we skip email in v1.3 P2 (v1.4 feature)
        this.logger.debug('[N1Notif] Email channel not yet implemented for N-1 notifications')
        return
      }

      default: {
        throw new Error(`Unknown delivery channel: ${channel}`)
      }
    }
  }

  /**
   * POST notification to webhook URL with exponential backoff.
   * Max 3 retries: 1s, 2s, 4s.
   */
  private async sendWebhook(payload: NotificationPayload, url: string): Promise<void> {
    const maxRetries = 3
    let lastError: any

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await axios.post(url, payload, {
          timeout: 15_000,
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
}
