/**
 * Tests for NotificationService.
 * axios is fully mocked for the webhook/slack/ntfy channels.
 * nodemailer is fully mocked for the email channel — no real SMTP is opened.
 */

import axios from 'axios'
import { NotificationService } from '../services/NotificationService'
import { BackupPolicy, Backup, NotificationConfig } from '@docker-rescue-kit/shared'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test-msg-id' })
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: mockSendMail })),
}))
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodemailerMock = require('nodemailer') as { createTransport: jest.Mock }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makePolicy = (notifications?: NotificationConfig[]): BackupPolicy => ({
  id: 'policy-1',
  name: 'Test Policy',
  enabled: true,
  targets: [{ type: 'volume', selector: 'my-vol' }],
  schedule: '0 0 * * *',
  backupType: 'full',
  retention: { strategy: 'count', count: 7 },
  storage: { id: 'st-1', type: 'local', path: 'data/backups' },
  notifications,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
})

const makeBackup = (overrides: Partial<Backup> = {}): Backup => ({
  id: 'backup-1',
  policyId: 'policy-1',
  timestamp: new Date('2024-06-01T00:00:00Z'),
  type: 'full',
  status: 'success',
  size: 1024 * 1024 * 5, // 5 MB
  targets: [{ type: 'volume', selector: 'my-vol' }],
  duration: 3000,
  tags: ['daily'],
  ...overrides,
})

// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks()
  mockedAxios.post = jest.fn().mockResolvedValue({ status: 200, data: 'ok' })
  mockSendMail.mockClear().mockResolvedValue({ messageId: 'test-msg-id' })
  nodemailerMock.createTransport.mockClear()
  nodemailerMock.createTransport.mockReturnValue({ sendMail: mockSendMail })
})

const svc = new NotificationService()

// ---------------------------------------------------------------------------
// webhook
// ---------------------------------------------------------------------------

describe('NotificationService — webhook', () => {
  it('sends a POST to the configured webhook URL with correct payload', async () => {
    const policy = makePolicy([
      { type: 'webhook', events: ['success'], config: { url: 'https://hooks.example.com/notify' } } as any,
    ])
    const backup = makeBackup()

    await svc.notify('success', policy, backup)

    expect(mockedAxios.post).toHaveBeenCalledTimes(1)
    const [url, body] = (mockedAxios.post as jest.Mock).mock.calls[0]
    expect(url).toBe('https://hooks.example.com/notify')
    expect(body.event).toBe('success')
    expect(body.policyId).toBe('policy-1')
    expect(body.backupId).toBe('backup-1')
    expect(body.status).toBe('success')
    expect(typeof body.message).toBe('string')
  })

  it('does NOT fire when the event does not match the configured events list', async () => {
    const policy = makePolicy([
      { type: 'webhook', events: ['failure'], config: { url: 'https://hooks.example.com/notify' } } as any,
    ])

    await svc.notify('success', policy, makeBackup())

    expect(mockedAxios.post).not.toHaveBeenCalled()
  })

  it('does not throw if the webhook POST rejects (error is swallowed)', async () => {
    mockedAxios.post = jest.fn().mockRejectedValue(new Error('network error'))

    const policy = makePolicy([
      { type: 'webhook', events: ['success'], config: { url: 'https://bad.example.com' } } as any,
    ])

    await expect(svc.notify('success', policy, makeBackup())).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// ntfy
// ---------------------------------------------------------------------------

describe('NotificationService — ntfy', () => {
  it('sends a POST to the ntfy URL with text/plain body and correct headers', async () => {
    const policy = makePolicy([
      { type: 'ntfy', events: ['success', 'failure'], config: { url: 'https://ntfy.sh/mybackups' } } as any,
    ])

    await svc.notify('success', policy, makeBackup())

    expect(mockedAxios.post).toHaveBeenCalledTimes(1)
    const [url, body, opts] = (mockedAxios.post as jest.Mock).mock.calls[0]
    expect(url).toBe('https://ntfy.sh/mybackups')
    expect(typeof body).toBe('string')
    expect(opts.headers['Content-Type']).toBe('text/plain')
    expect(opts.headers['Priority']).toBe('default') // success event
  })

  it('sets priority=high and Tags=warning for failure events', async () => {
    const policy = makePolicy([
      { type: 'ntfy', events: ['failure'], config: { url: 'https://ntfy.sh/mybackups' } } as any,
    ])

    await svc.notify('failure', policy, makeBackup({ status: 'failed' }))

    const [, , opts] = (mockedAxios.post as jest.Mock).mock.calls[0]
    expect(opts.headers['Priority']).toBe('high')
    expect(opts.headers['Tags']).toBe('warning')
  })
})

// ---------------------------------------------------------------------------
// slack
// ---------------------------------------------------------------------------

describe('NotificationService — slack', () => {
  it('sends a POST with text field to the Slack webhook URL', async () => {
    const policy = makePolicy([
      { type: 'slack', events: ['success'], config: { url: 'https://hooks.slack.com/services/T000/B000/xxx' } } as any,
    ])

    await svc.notify('success', policy, makeBackup())

    expect(mockedAxios.post).toHaveBeenCalledTimes(1)
    const [url, body] = (mockedAxios.post as jest.Mock).mock.calls[0]
    expect(url).toBe('https://hooks.slack.com/services/T000/B000/xxx')
    expect(body).toHaveProperty('text')
    expect(typeof body.text).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// Missing / edge cases
// ---------------------------------------------------------------------------

describe('NotificationService — edge cases', () => {
  it('does nothing (no throw) when policy.notifications is undefined', async () => {
    const policy = makePolicy(undefined)
    await expect(svc.notify('success', policy, makeBackup())).resolves.toBeUndefined()
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })

  it('does nothing when policy.notifications is an empty array', async () => {
    const policy = makePolicy([])
    await expect(svc.notify('failure', policy, makeBackup())).resolves.toBeUndefined()
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })

  it('fires on "completion" event even when backup succeeded', async () => {
    const policy = makePolicy([
      { type: 'webhook', events: ['completion'], config: { url: 'https://hooks.example.com/any' } } as any,
    ])

    await svc.notify('success', policy, makeBackup())

    expect(mockedAxios.post).toHaveBeenCalledTimes(1)
  })

  it('logs and skips email when config is missing apiKey/from/to', async () => {
    const policy = makePolicy([
      { type: 'email', events: ['success'], config: {} } as any,
    ])
    // No apiKey/from/to — should warn and no-op rather than crash
    await expect(svc.notify('success', policy, makeBackup())).resolves.toBeUndefined()
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// email (self-hosted SMTP via nodemailer)
// ---------------------------------------------------------------------------

describe('NotificationService — email (SMTP)', () => {
  afterEach(() => {
    delete process.env.DRK_SMTP_HOST
    delete process.env.DRK_SMTP_PORT
    delete process.env.DRK_SMTP_USER
    delete process.env.DRK_SMTP_PASS
    delete process.env.DRK_SMTP_SECURE
    delete process.env.DRK_EMAIL_FROM
  })

  it('connects to inline-config SMTP and sends mail', async () => {
    const policy = makePolicy([
      {
        type: 'email', events: ['success'],
        config: {
          from: 'DRK <alerts@gozippy.com>',
          to: 'ops@example.com',
          smtp: {
            host: 'mail.gozippy.com',
            port: 587,
            secure: false,
            user: 'alerts@gozippy.com',
            pass: 'secret',
          },
        },
      } as any,
    ])

    await svc.notify('success', policy, makeBackup())

    expect(nodemailerMock.createTransport).toHaveBeenCalledTimes(1)
    const transportOpts = nodemailerMock.createTransport.mock.calls[0][0]
    expect(transportOpts.host).toBe('mail.gozippy.com')
    expect(transportOpts.port).toBe(587)
    expect(transportOpts.secure).toBe(false)
    expect(transportOpts.auth).toEqual({ user: 'alerts@gozippy.com', pass: 'secret' })

    expect(mockSendMail).toHaveBeenCalledTimes(1)
    const mailOpts = mockSendMail.mock.calls[0][0]
    expect(mailOpts.from).toBe('DRK <alerts@gozippy.com>')
    expect(mailOpts.to).toBe('ops@example.com')
    expect(mailOpts.subject).toContain('Backup succeeded')
    expect(mailOpts.subject).toContain('Test Policy')
    expect(typeof mailOpts.text).toBe('string')

    // No outbound HTTP for email — confirms we're not calling a 3rd-party
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })

  it('falls back to DRK_SMTP_* env vars when no inline smtp block', async () => {
    process.env.DRK_SMTP_HOST = 'mail.gozippy.com'
    process.env.DRK_SMTP_PORT = '465'
    process.env.DRK_SMTP_SECURE = 'true'
    process.env.DRK_SMTP_USER = 'alerts@gozippy.com'
    process.env.DRK_SMTP_PASS = 'envsecret'
    process.env.DRK_EMAIL_FROM = 'env-from@gozippy.com'

    const policy = makePolicy([
      { type: 'email', events: ['failure'], config: { to: 'on-call@example.com' } } as any,
    ])
    await svc.notify('failure', policy, makeBackup({ status: 'failed' }))

    const transportOpts = nodemailerMock.createTransport.mock.calls[0][0]
    expect(transportOpts.host).toBe('mail.gozippy.com')
    expect(transportOpts.port).toBe(465)
    expect(transportOpts.secure).toBe(true)
    expect(transportOpts.auth.user).toBe('alerts@gozippy.com')

    const mailOpts = mockSendMail.mock.calls[0][0]
    expect(mailOpts.from).toBe('env-from@gozippy.com')
    expect(mailOpts.to).toBe('on-call@example.com')
    expect(mailOpts.subject).toContain('FAILED')
  })

  it('inline smtp config wins over env when both are set', async () => {
    process.env.DRK_SMTP_HOST = 'env.example.com'
    process.env.DRK_EMAIL_FROM = 'env-from@example.com'

    const policy = makePolicy([
      {
        type: 'email', events: ['success'],
        config: {
          from: 'inline@gozippy.com',
          to: 'ops@example.com',
          smtp: { host: 'inline.smtp.example.com', port: 587 },
        },
      } as any,
    ])

    await svc.notify('success', policy, makeBackup())
    const transportOpts = nodemailerMock.createTransport.mock.calls[0][0]
    expect(transportOpts.host).toBe('inline.smtp.example.com')
    const mailOpts = mockSendMail.mock.calls[0][0]
    expect(mailOpts.from).toBe('inline@gozippy.com')
  })

  it('does not throw if SMTP send rejects', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('connection refused'))
    const policy = makePolicy([
      {
        type: 'email', events: ['success'],
        config: {
          from: 'a@b', to: 'c@d',
          smtp: { host: 'mail.example.com', port: 587 },
        },
      } as any,
    ])
    await expect(svc.notify('success', policy, makeBackup())).resolves.toBeUndefined()
  })

  it('skips email when no SMTP config can be resolved at all', async () => {
    // no env, no inline smtp, no settings injected
    const policy = makePolicy([
      { type: 'email', events: ['success'], config: { to: 'ops@example.com' } } as any,
    ])
    await svc.notify('success', policy, makeBackup())
    expect(mockSendMail).not.toHaveBeenCalled()
    expect(nodemailerMock.createTransport).not.toHaveBeenCalled()
  })

  it('resolves SMTP from SettingsService when no env or inline', async () => {
    const settings = {
      getSetting: jest.fn(async (key: string) => {
        const map: Record<string, string> = {
          'smtp.host': 'settings.mail.gozippy.com',
          'smtp.port': '587',
          'smtp.secure': 'false',
          'smtp.user': 'alerts@gozippy.com',
          'smtp.pass': 'settings-secret',
          'email.from': 'settings-from@gozippy.com',
        }
        return map[key]
      }),
    } as any
    const withSettings = new NotificationService(undefined, settings)

    const policy = makePolicy([
      { type: 'email', events: ['success'], config: { to: 'ops@example.com' } } as any,
    ])
    await withSettings.notify('success', policy, makeBackup())

    const transportOpts = nodemailerMock.createTransport.mock.calls[0][0]
    expect(transportOpts.host).toBe('settings.mail.gozippy.com')
    expect(transportOpts.auth.pass).toBe('settings-secret')
    const mailOpts = mockSendMail.mock.calls[0][0]
    expect(mailOpts.from).toBe('settings-from@gozippy.com')
  })
})

// ---------------------------------------------------------------------------
// License gating (Pro-tier feature)
// ---------------------------------------------------------------------------

describe('NotificationService — license gating', () => {
  it('no-ops silently on Free tier when LicenseService is supplied', async () => {
    const fakeLicense = {
      getStatus: jest.fn().mockResolvedValue({
        tier: 'free',
        seats: 1,
        features: [],
        launchLockIn: false,
        staleButValid: false,
        devMode: false,
      }),
    } as any
    const gated = new NotificationService(fakeLicense)

    const policy = makePolicy([
      { type: 'webhook', events: ['success'], config: { url: 'https://hooks.example.com' } } as any,
    ])
    await gated.notify('success', policy, makeBackup())

    expect(mockedAxios.post).not.toHaveBeenCalled()
  })

  it('fires normally when LicenseService reports a tier with notifications feature', async () => {
    const fakeLicense = {
      getStatus: jest.fn().mockResolvedValue({
        tier: 'personal-pro',
        seats: 1,
        features: ['unlimited_policies', 'notifications', 'byok_encryption', 'audit_log_90d'],
        launchLockIn: false,
        staleButValid: false,
        devMode: false,
      }),
    } as any
    const gated = new NotificationService(fakeLicense)

    const policy = makePolicy([
      { type: 'webhook', events: ['success'], config: { url: 'https://hooks.example.com' } } as any,
    ])
    await gated.notify('success', policy, makeBackup())

    expect(mockedAxios.post).toHaveBeenCalledTimes(1)
  })

  it('preserves backward compat: no LicenseService -> notifications always fire', async () => {
    const ungated = new NotificationService() // no license arg
    const policy = makePolicy([
      { type: 'webhook', events: ['success'], config: { url: 'https://hooks.example.com' } } as any,
    ])
    await ungated.notify('success', policy, makeBackup())
    expect(mockedAxios.post).toHaveBeenCalledTimes(1)
  })
})
