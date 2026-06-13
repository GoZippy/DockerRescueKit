/**
 * Sink-delivery tests for NotificationDispatcher (v1.4).
 *
 * Exercises the real delivery paths via the public sendTestNotification()
 * entrypoint: webhook + ntfy POST through a mocked axios, email through a
 * mocked NotificationService, and SSRF rejection through a mocked SsrfGuard.
 */

import axios from 'axios'
import { NotificationDispatcher } from '../../services/NotificationDispatcher'
import { SsrfGuard, SsrfBlockedError } from '../../security/SsrfGuard'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

const fakeLogger = {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  trace: jest.fn(), fatal: jest.fn(), silent: jest.fn(), level: 'info', child: jest.fn(),
} as any

function makeDispatcher(prefs: any, notificationService?: any) {
  const db = { getNotificationPreferences: jest.fn(async () => prefs) } as any
  const docker = {} as any
  const ns = notificationService ?? {
    sendAlertEmail: jest.fn(async () => true),
    hasSmtpConfigured: jest.fn(async () => true),
  }
  return {
    dispatcher: new NotificationDispatcher(db, docker, ns as any, fakeLogger),
    ns,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockedAxios.post = jest.fn().mockResolvedValue({ status: 200, data: 'ok' })
  // Default: every URL is SSRF-safe unless a test overrides.
  jest.spyOn(SsrfGuard, 'assertSafe').mockResolvedValue(undefined as any)
})

afterEach(() => jest.restoreAllMocks())

// ---------------------------------------------------------------------------
// webhook
// ---------------------------------------------------------------------------

describe('webhook sink', () => {
  it('POSTs JSON to the configured webhook URL after an SSRF check', async () => {
    const { dispatcher } = makeDispatcher({ webhookUrl: 'https://hooks.example.com/notify' })
    const res = await dispatcher.sendTestNotification('webhook')

    expect(res.ok).toBe(true)
    expect(SsrfGuard.assertSafe).toHaveBeenCalledWith('https://hooks.example.com/notify')
    expect(mockedAxios.post).toHaveBeenCalledTimes(1)
    const [url, body, opts] = (mockedAxios.post as jest.Mock).mock.calls[0]
    expect(url).toBe('https://hooks.example.com/notify')
    expect(body.subject).toContain('test notification')
    expect(opts.headers['Content-Type']).toBe('application/json')
    expect(opts.headers['X-DRK-Event']).toBeDefined()
  })

  it('fails honestly when no webhook URL is configured', async () => {
    const { dispatcher } = makeDispatcher({})
    const res = await dispatcher.sendTestNotification('webhook')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not configured/i)
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// ntfy
// ---------------------------------------------------------------------------

describe('ntfy sink', () => {
  it('POSTs text/plain to the ntfy URL after an SSRF check', async () => {
    const { dispatcher } = makeDispatcher({ ntfyUrl: 'https://ntfy.sh/my-drk' })
    const res = await dispatcher.sendTestNotification('ntfy')

    expect(res.ok).toBe(true)
    expect(SsrfGuard.assertSafe).toHaveBeenCalledWith('https://ntfy.sh/my-drk')
    const [url, body, opts] = (mockedAxios.post as jest.Mock).mock.calls[0]
    expect(url).toBe('https://ntfy.sh/my-drk')
    expect(typeof body).toBe('string')
    expect(opts.headers['Content-Type']).toBe('text/plain')
    expect(opts.headers.Title).toContain('test notification')
  })

  it('fails honestly when no ntfy URL is configured', async () => {
    const { dispatcher } = makeDispatcher({})
    const res = await dispatcher.sendTestNotification('ntfy')
    expect(res.ok).toBe(false)
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// SSRF rejection
// ---------------------------------------------------------------------------

describe('SSRF-rejected URL', () => {
  it('does not POST when SsrfGuard blocks the webhook target', async () => {
    ;(SsrfGuard.assertSafe as jest.Mock).mockRejectedValueOnce(
      new SsrfBlockedError('http://169.254.169.254', '169.254.169.254', 'address in denied range'),
    )
    const { dispatcher } = makeDispatcher({ webhookUrl: 'http://169.254.169.254/latest/meta-data' })
    const res = await dispatcher.sendTestNotification('webhook')

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/SSRF/i)
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })

  it('does not POST when SsrfGuard blocks the ntfy target', async () => {
    ;(SsrfGuard.assertSafe as jest.Mock).mockRejectedValueOnce(
      new SsrfBlockedError('http://169.254.169.254', '169.254.169.254', 'address in denied range'),
    )
    const { dispatcher } = makeDispatcher({ ntfyUrl: 'http://169.254.169.254' })
    const res = await dispatcher.sendTestNotification('ntfy')
    expect(res.ok).toBe(false)
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// email (delegates to NotificationService — no third-party HTTP)
// ---------------------------------------------------------------------------

describe('email sink', () => {
  it('delegates to NotificationService.sendAlertEmail with the recipient', async () => {
    const ns = {
      sendAlertEmail: jest.fn(async (_to: string, _subject: string, _body: string) => true),
      hasSmtpConfigured: jest.fn(async () => true),
    }
    const { dispatcher } = makeDispatcher({ emailTo: 'ops@example.com' }, ns)
    const res = await dispatcher.sendTestNotification('email')

    expect(res.ok).toBe(true)
    expect(ns.sendAlertEmail).toHaveBeenCalledTimes(1)
    const [to, subject] = ns.sendAlertEmail.mock.calls[0]
    expect(to).toBe('ops@example.com')
    expect(subject).toContain('[DRK]')
    // email must never go over the webhook/ntfy axios path
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })

  it('marks email unavailable when SMTP is not resolvable', async () => {
    const ns = {
      sendAlertEmail: jest.fn(async () => false), // no SMTP resolvable
      hasSmtpConfigured: jest.fn(async () => false),
    }
    const { dispatcher } = makeDispatcher({ emailTo: 'ops@example.com' }, ns)
    const res = await dispatcher.sendTestNotification('email')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/unavailable|SMTP/i)
  })

  it('isEmailAvailable reflects the NotificationService SMTP probe', async () => {
    const ns = { sendAlertEmail: jest.fn(), hasSmtpConfigured: jest.fn(async () => true) }
    const { dispatcher } = makeDispatcher({}, ns)
    expect(await dispatcher.isEmailAvailable()).toBe(true)
  })
})
