import { BackupPolicy, Backup, NotificationConfig } from '@docker-rescue-kit/shared'
import axios from 'axios'
import { logger } from '../utils/logger'
import { LicenseService } from './LicenseService'

export type NotifyEvent = 'success' | 'failure'

/**
 * Multi-channel notifier. Supports:
 *  - webhook  (generic POST with JSON body)
 *  - ntfy     (homelab-friendly push)
 *  - slack    (incoming webhook URL)
 *  - email    (Resend HTTP API; SMTP support would need an SMTP client dep)
 *
 * Notifications are a paid-tier feature. When a LicenseService is supplied
 * and the active license doesn't grant `notifications`, notify() is a
 * no-op (silent — we don't want to log spam every time a free-tier user's
 * scheduler ticks).
 */
export class NotificationService {
  constructor(private license?: LicenseService) {}

  public async notify(event: NotifyEvent, policy: BackupPolicy, backup: Backup): Promise<void> {
    if (!policy.notifications || policy.notifications.length === 0) return

    if (this.license) {
      const status = await this.license.getStatus()
      if (!status.features.includes('notifications')) return
    }

    const message = this.buildMessage(event, policy, backup)
    for (const cfg of policy.notifications) {
      if (!this.shouldFire(cfg, event)) continue
      try {
        await this.dispatch(cfg, event, policy, backup, message)
      } catch (err) {
        logger.error({ channel: cfg.type, err }, '[Notify] dispatch failed')
      }
    }
  }

  private shouldFire(cfg: NotificationConfig, event: NotifyEvent): boolean {
    return cfg.events.includes(event) || cfg.events.includes('completion')
  }

  private buildMessage(event: NotifyEvent, policy: BackupPolicy, backup: Backup): string {
    const header = event === 'success' ? 'Backup succeeded' : 'Backup FAILED'
    const targets = backup.targets.map(t => `${t.type}:${t.selector}`).join(', ')
    const durationSec = Math.round(backup.duration / 1000)
    const sizeMb = (backup.size / 1024 / 1024).toFixed(1)
    const lines = [
      `[DockerRescueKit] ${header}`,
      `Policy: ${policy.name}`,
      `Targets: ${targets || '(none)'}`,
      `Duration: ${durationSec}s`,
      `Size: ${sizeMb} MB`
    ]
    if (backup.error) lines.push(`Error: ${backup.error}`)
    return lines.join('\n')
  }

  private async dispatch(
    cfg: NotificationConfig,
    event: NotifyEvent,
    policy: BackupPolicy,
    backup: Backup,
    message: string
  ): Promise<void> {
    const config = cfg.config || {}
    switch (cfg.type) {
      case 'webhook': {
        await axios.post(config.url, {
          event,
          policyId: policy.id,
          policyName: policy.name,
          backupId: backup.id,
          status: backup.status,
          message,
          backup
        }, { timeout: 15_000 })
        return
      }
      case 'slack': {
        await axios.post(config.url, { text: message }, { timeout: 15_000 })
        return
      }
      case 'ntfy': {
        await axios.post(config.url, message, {
          headers: {
            'Content-Type': 'text/plain',
            Title: `DockerRescueKit: ${backup.status}`,
            Priority: event === 'failure' ? 'high' : 'default',
            Tags: event === 'failure' ? 'warning' : 'white_check_mark'
          },
          timeout: 15_000
        })
        return
      }
      case 'email': {
        await this.sendEmail(config, event, policy, backup, message)
        return
      }
    }
  }

  /**
   * Email via Resend HTTP API.
   *
   * Configured by either:
   *  - per-notification `config.apiKey` + `config.from` + `config.to`, OR
   *  - env-wide `DRK_RESEND_API_KEY` + `DRK_EMAIL_FROM` + per-notification `config.to`
   *
   * Why Resend (and not nodemailer / SMTP): the backend doesn't currently
   * depend on a SMTP client, and Resend's free tier (3K emails/mo, 100/day)
   * is more than enough for backup notifications. Operators who need SMTP
   * can run an HTTP-to-SMTP relay (e.g. mailrise, smtp2http) or wait for
   * SMTP support to be added with a separate transport dep.
   */
  private async sendEmail(
    config: Record<string, any>,
    event: NotifyEvent,
    policy: BackupPolicy,
    backup: Backup,
    message: string,
  ): Promise<void> {
    const apiKey = config.apiKey || process.env.DRK_RESEND_API_KEY
    const from = config.from || process.env.DRK_EMAIL_FROM
    const to = config.to

    if (!apiKey || !from || !to) {
      logger.warn(
        { hasApiKey: !!apiKey, hasFrom: !!from, hasTo: !!to },
        '[Notify:email] missing config — need apiKey + from + to (or DRK_RESEND_API_KEY + DRK_EMAIL_FROM env + config.to)',
      )
      return
    }

    const subject = event === 'success'
      ? `[DRK] Backup succeeded: ${policy.name}`
      : `[DRK] Backup FAILED: ${policy.name}`

    await axios.post(
      'https://api.resend.com/emails',
      { from, to, subject, text: message },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
      },
    )
  }
}
