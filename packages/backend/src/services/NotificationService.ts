import { BackupPolicy, Backup, NotificationConfig } from '@docker-rescue-kit/shared'
import axios from 'axios'
import { logger } from '../utils/logger'
import { LicenseService } from './LicenseService'
import type { SettingsService } from './SettingsService'

export type NotifyEvent = 'success' | 'failure'

/**
 * Validate an operator-configured webhook URL before issuing an HTTP request.
 * Accepts only http(s); rejects empty, malformed, or non-HTTP(S) schemes.
 *
 * We intentionally do NOT block private/RFC-1918 hosts — operators commonly
 * point notifications at self-hosted Slack/ntfy on their LAN (10.0.0.0/8,
 * 192.168.0.0/16, etc.). The URL flows from the local DB config row, not
 * from any HTTP request input, so SSRF is bounded to the operator's own
 * configuration choices.
 */
function parseNotificationUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('notification URL is missing')
  }
  const u = new URL(raw)
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`notification URL has unsupported protocol: ${u.protocol}`)
  }
  return u.toString()
}

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
  constructor(
    private license?: LicenseService,
    /** Optional. When supplied, email config can be read from settings
     *  (smtp.host / smtp.port / smtp.user / smtp.pass / smtp.secure +
     *  email.from) so the user can configure SMTP from the Settings UI
     *  without restarting. */
    private settings?: SettingsService,
  ) {}

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
        const target = parseNotificationUrl(config.url)
        await axios.post(target, {
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
        const target = parseNotificationUrl(config.url)
        await axios.post(target, { text: message }, { timeout: 15_000 })
        return
      }
      case 'ntfy': {
        const target = parseNotificationUrl(config.url)
        await axios.post(target, message, {
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
   * Email via user-supplied SMTP (no third-party HTTP service).
   *
   * Each install brings its own SMTP server — Synology Mail, Postfix on a
   * VPS, cpanel mail, Microsoft 365, Gmail SMTP, whatever. We never call
   * an external email API; everything stays self-hosted.
   *
   * Config resolution order (first that's complete wins):
   *   1. Per-notification `config.smtp` block (UI per-policy override)
   *   2. SettingsService keys 'smtp.host' / 'smtp.port' / 'smtp.user' /
   *      'smtp.pass' / 'smtp.secure' + 'email.from' (Settings UI)
   *   3. Env vars DRK_SMTP_HOST / _PORT / _USER / _PASS / _SECURE +
   *      DRK_EMAIL_FROM (docker-compose / systemd)
   *
   * Recipient (`to`) MUST come from the per-notification `config.to` —
   * the per-policy alert target is policy-level, not install-level.
   *
   * Implementation note: nodemailer is the standard for SMTP in Node.
   * We lazy-require it so installs that never send email don't pay the
   * import cost and so older test rigs that mock the service still work.
   */
  private async sendEmail(
    config: Record<string, any>,
    event: NotifyEvent,
    policy: BackupPolicy,
    backup: Backup,
    message: string,
  ): Promise<void> {
    const to = config.to
    if (!to) {
      logger.warn('[Notify:email] missing config.to')
      return
    }
    const smtp = await this.resolveSmtpConfig(config)
    if (!smtp) {
      logger.warn(
        '[Notify:email] no SMTP config found — set DRK_SMTP_HOST/PORT/USER/PASS + DRK_EMAIL_FROM env, or save smtp.* settings via the Settings UI, or pass config.smtp inline',
      )
      return
    }

    // Lazy import — nodemailer is only loaded the first time an email
    // notification actually fires.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodemailer = require('nodemailer') as typeof import('nodemailer')
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      // Require STARTTLS even when secure: false (port 587). Without this,
      // nodemailer may attempt AUTH before upgrading to TLS — most mail
      // servers reject plaintext AUTH with the misleading '535 Incorrect
      // authentication data', which looks like a credential problem but is
      // actually a session-encryption problem.
      requireTLS: !smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      // Keep the connect attempt bounded so a misconfigured host doesn't
      // wedge the scheduler tick.
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    })

    const subject = event === 'success'
      ? `[DRK] Backup succeeded: ${policy.name}`
      : `[DRK] Backup FAILED: ${policy.name}`

    await transport.sendMail({
      from: smtp.from,
      to,
      subject,
      text: message,
    })
  }

  private async resolveSmtpConfig(config: Record<string, any>): Promise<{
    host: string
    port: number
    secure: boolean
    user?: string
    pass?: string
    from: string
  } | null> {
    // 1. inline override on the notification config
    if (config.smtp && config.smtp.host && config.from) {
      const s = config.smtp
      return {
        host: String(s.host),
        port: Number(s.port || 587),
        secure: s.secure === true || String(s.secure).toLowerCase() === 'true',
        user: s.user || undefined,
        pass: s.pass || undefined,
        from: String(config.from),
      }
    }
    // 2. SettingsService (UI-pasted creds)
    if (this.settings) {
      const host = await this.settings.getSetting('smtp.host')
      const from = await this.settings.getSetting('email.from')
      if (host && from) {
        return {
          host,
          port: Number((await this.settings.getSetting('smtp.port')) || 587),
          secure: (await this.settings.getSetting('smtp.secure')) === 'true',
          user: (await this.settings.getSetting('smtp.user')) || undefined,
          pass: (await this.settings.getSetting('smtp.pass')) || undefined,
          from,
        }
      }
    }
    // 3. env vars (compose / systemd)
    const envHost = process.env.DRK_SMTP_HOST
    const envFrom = process.env.DRK_EMAIL_FROM
    if (envHost && envFrom) {
      return {
        host: envHost,
        port: Number(process.env.DRK_SMTP_PORT || '587'),
        secure: (process.env.DRK_SMTP_SECURE || '').toLowerCase() === 'true',
        user: process.env.DRK_SMTP_USER || undefined,
        pass: process.env.DRK_SMTP_PASS || undefined,
        from: envFrom,
      }
    }
    return null
  }
}
