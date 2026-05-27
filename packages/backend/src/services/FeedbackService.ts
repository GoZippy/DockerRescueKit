import path from 'path'
import fs from 'fs-extra'
import axios from 'axios'
import { v4 as uuidv4 } from 'uuid'
import { logger } from '../utils/logger'
import { APP_VERSION } from '../utils/appVersion'
import type { SettingsService } from './SettingsService'

/**
 * v1.2.2 in-product feedback.
 *
 * One submission fans out to every configured sink in parallel — local file
 * (always on), email (SMTP), GitHub issue, generic webhook. We never let one
 * sink's failure block the others; the response reports per-sink outcomes so
 * the UI can surface "email sent, GitHub failed" without losing the report.
 */

export type FeedbackType =
  | 'bug'
  | 'suggestion'
  | 'wish'
  | 'integration_request'
  | 'question'

export const FEEDBACK_TYPES: readonly FeedbackType[] = [
  'bug',
  'suggestion',
  'wish',
  'integration_request',
  'question',
] as const

export interface FeedbackContext {
  page?: string
  version?: string
  dataDir?: string
  userAgent?: string
}

export interface FeedbackSubmission {
  type: FeedbackType
  message: string
  /** Base64-encoded PNG (no `data:` prefix). */
  screenshotPngBase64?: string
  context?: FeedbackContext
}

export type SinkStatus = 'sent' | 'failed' | 'skipped'

export interface FeedbackResult {
  id: string
  sinks: Record<string, SinkStatus>
}

const DEFAULT_GITHUB_REPO = 'gozippy/DockerRescueKit'
const FEEDBACK_RECIPIENT_EMAIL = 'gotadvantage@gmail.com'

/**
 * Same conservative URL validator pattern as NotificationService.parseNotificationUrl.
 * Accepts only http(s); rejects empty / malformed / non-HTTP(S). Private/RFC-1918
 * hosts are intentionally allowed — homelab webhook targets are routine.
 */
function parseWebhookUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('webhook URL is missing')
  }
  const u = new URL(raw)
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`webhook URL has unsupported protocol: ${u.protocol}`)
  }
  return u.toString()
}

interface ResolvedSmtp {
  host: string
  port: number
  secure: boolean
  user?: string
  pass?: string
  from: string
}

export class FeedbackService {
  constructor(
    private settings: SettingsService,
    private dataDir: string,
  ) {}

  /**
   * Submit feedback to every configured sink. Returns the id we minted and a
   * per-sink outcome map. Never throws — sink errors are logged at WARN and
   * surface as `failed` in the outcome map.
   */
  public async submit(input: FeedbackSubmission): Promise<FeedbackResult> {
    const id = uuidv4()
    const timestamp = new Date().toISOString()
    // Enrich context with backend version so reports always carry it even if
    // the UI forgot to include one.
    const submission: FeedbackSubmission = {
      ...input,
      context: { version: APP_VERSION, ...(input.context || {}) },
    }

    // Run sinks in parallel — none is allowed to block another. Each one
    // returns its own status; we collect them into the response map.
    const [local, email, github, webhook] = await Promise.all([
      this.runLocalSink(id, timestamp, submission),
      this.runEmailSink(id, submission),
      this.runGitHubSink(submission),
      this.runWebhookSink(submission),
    ])

    return {
      id,
      sinks: {
        local,
        email,
        github,
        webhook,
      },
    }
  }

  // ---- local file sink ------------------------------------------------------
  // Always on. Writes `{dataDir}/feedback/{timestamp}-{type}-{id}.json` with
  // the full submission (incl. the base64 screenshot if present) so the
  // operator has a local copy even when every network sink fails.
  private async runLocalSink(
    id: string,
    timestamp: string,
    submission: FeedbackSubmission,
  ): Promise<SinkStatus> {
    try {
      const dir = path.join(this.dataDir, 'feedback')
      await fs.ensureDir(dir)
      // Colons aren't valid in Windows filenames — sanitize the ISO timestamp.
      const safeTs = timestamp.replace(/[:]/g, '-')
      const file = path.join(dir, `${safeTs}-${submission.type}-${id}.json`)
      await fs.writeJson(file, { id, timestamp, ...submission }, { spaces: 2 })
      return 'sent'
    } catch (err) {
      logger.warn({ err }, '[Feedback:local] write failed')
      return 'failed'
    }
  }

  // ---- email sink -----------------------------------------------------------
  // Reuses the same resolution order as NotificationService (settings UI →
  // env vars). No per-policy inline override here since feedback is global.
  // If no SMTP config is resolvable the sink is `skipped`.
  private async runEmailSink(
    id: string,
    submission: FeedbackSubmission,
  ): Promise<SinkStatus> {
    try {
      const smtp = await this.resolveSmtpConfig()
      if (!smtp) return 'skipped'

      // Lazy import to match NotificationService — installs that never send
      // feedback email don't pay the nodemailer import cost.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const nodemailer = require('nodemailer') as typeof import('nodemailer')
      const transport = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        // See NotificationService.sendEmail — require STARTTLS on port 587 so
        // we don't AUTH in cleartext on servers that don't reject it outright.
        requireTLS: !smtp.secure,
        auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
        connectionTimeout: 15_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
      })

      const subject = `[DRK Feedback / ${submission.type}] ${submission.message.slice(0, 60)}`
      const ctx = submission.context || {}
      const ctxLines = [
        `Feedback ID: ${id}`,
        `Type: ${submission.type}`,
        `Version: ${ctx.version || 'unknown'}`,
        `Page: ${ctx.page || '(not provided)'}`,
        `Data dir: ${ctx.dataDir || '(not provided)'}`,
        `User agent: ${ctx.userAgent || '(not provided)'}`,
      ]
      const text = [
        '--- DockerRescueKit feedback ---',
        ...ctxLines,
        '',
        submission.message,
      ].join('\n')

      const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = []
      if (submission.screenshotPngBase64) {
        attachments.push({
          filename: 'screenshot.png',
          content: Buffer.from(submission.screenshotPngBase64, 'base64'),
          contentType: 'image/png',
        })
      }

      await transport.sendMail({
        from: smtp.from,
        to: FEEDBACK_RECIPIENT_EMAIL,
        subject,
        text,
        attachments,
      })
      return 'sent'
    } catch (err) {
      logger.warn({ err }, '[Feedback:email] send failed')
      return 'failed'
    }
  }

  // ---- github sink ----------------------------------------------------------
  // Needs both env vars set. The token is the bearer; the repo defaults to
  // gozippy/DockerRescueKit. Screenshot upload via the contents API is
  // marked TODO — too much extra surface for v1.2.2; we instead reference
  // the local-sink file so the operator can attach manually if needed.
  private async runGitHubSink(submission: FeedbackSubmission): Promise<SinkStatus> {
    const token = process.env.DRK_GITHUB_FEEDBACK_TOKEN
    const repo = process.env.DRK_GITHUB_FEEDBACK_REPO || DEFAULT_GITHUB_REPO
    if (!token || !repo) return 'skipped'

    try {
      const firstLine = submission.message.split(/\r?\n/)[0] || submission.message
      const title = `[${submission.type}] ${firstLine.slice(0, 120)}`

      const ctx = submission.context || {}
      const bodyLines = [
        `**Type:** \`${submission.type}\``,
        `**Version:** ${ctx.version || 'unknown'}`,
        `**Page:** ${ctx.page || '_(not provided)_'}`,
        `**User agent:** ${ctx.userAgent ? '`' + ctx.userAgent + '`' : '_(not provided)_'}`,
        '',
        '---',
        '',
        submission.message,
      ]
      if (submission.screenshotPngBase64) {
        // TODO(v1.2.3): upload the PNG via /repos/{owner}/{repo}/contents
        // and embed the resulting raw URL. For now we just note its presence
        // — the local-sink JSON file holds the actual screenshot bytes.
        bodyLines.push('', '_Screenshot attached locally (not uploaded to GitHub in this version)._')
      }

      await axios.post(
        `https://api.github.com/repos/${repo}/issues`,
        {
          title,
          body: bodyLines.join('\n'),
          labels: ['feedback', submission.type],
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          timeout: 15_000,
        },
      )
      return 'sent'
    } catch (err) {
      logger.warn({ err }, '[Feedback:github] post failed')
      return 'failed'
    }
  }

  // ---- webhook sink ---------------------------------------------------------
  // Operator-configured generic webhook (settings key `feedback.webhook_url`).
  // We truncate the screenshot to the first 16KB of base64 to avoid blowing up
  // small webhook receivers (Discord/Slack/ntfy bridges typically reject >1MB).
  private async runWebhookSink(submission: FeedbackSubmission): Promise<SinkStatus> {
    let url: string
    try {
      const raw = await this.settings.getSetting('feedback.webhook_url')
      if (!raw) return 'skipped'
      url = parseWebhookUrl(raw)
    } catch (err) {
      logger.warn({ err }, '[Feedback:webhook] invalid configured URL')
      return 'failed'
    }

    try {
      const SCREENSHOT_MAX = 16 * 1024
      let screenshot = submission.screenshotPngBase64
      let screenshotTruncated = false
      if (screenshot && screenshot.length > SCREENSHOT_MAX) {
        screenshot = screenshot.slice(0, SCREENSHOT_MAX)
        screenshotTruncated = true
      }

      await axios.post(
        url,
        {
          type: submission.type,
          message: submission.message,
          context: submission.context,
          screenshotPngBase64: screenshot,
          screenshotTruncated,
        },
        { timeout: 15_000 },
      )
      return 'sent'
    } catch (err) {
      logger.warn({ err }, '[Feedback:webhook] post failed')
      return 'failed'
    }
  }

  /**
   * Same shape as NotificationService.resolveSmtpConfig but without the
   * per-notification inline override (feedback has no per-call config).
   * Order: SettingsService keys → env vars.
   */
  private async resolveSmtpConfig(): Promise<ResolvedSmtp | null> {
    // 1. SettingsService (UI-pasted creds)
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
    // 2. env vars (compose / systemd)
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

  /**
   * Surface-only configuration check used by the UI to show which sinks are
   * live. Booleans only — no secrets ever leave this method.
   */
  public async describeConfiguration(): Promise<{
    webhookConfigured: boolean
    emailConfigured: boolean
    githubConfigured: boolean
  }> {
    const webhookRaw = await this.settings.getSetting('feedback.webhook_url')
    let webhookConfigured = false
    if (webhookRaw) {
      try {
        parseWebhookUrl(webhookRaw)
        webhookConfigured = true
      } catch {
        webhookConfigured = false
      }
    }

    const smtp = await this.resolveSmtpConfig()
    const emailConfigured = smtp !== null

    const githubConfigured = !!process.env.DRK_GITHUB_FEEDBACK_TOKEN

    return { webhookConfigured, emailConfigured, githubConfigured }
  }
}
