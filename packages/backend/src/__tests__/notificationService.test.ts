/**
 * Tests for NotificationService.
 * axios is fully mocked — no real HTTP requests are made.
 */

import axios from 'axios'
import { NotificationService } from '../services/NotificationService'
import { BackupPolicy, Backup, NotificationConfig } from '@docker-rescue-kit/shared'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

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
// email (Resend)
// ---------------------------------------------------------------------------

describe('NotificationService — email (Resend)', () => {
  afterEach(() => {
    delete process.env.DRK_RESEND_API_KEY
    delete process.env.DRK_EMAIL_FROM
  })

  it('POSTs to Resend with bearer auth + JSON body when config is fully inline', async () => {
    const policy = makePolicy([
      {
        type: 'email', events: ['success'],
        config: {
          apiKey: 're_test_key',
          from: 'DRK <alerts@gozippy.com>',
          to: 'ops@example.com',
        },
      } as any,
    ])

    await svc.notify('success', policy, makeBackup())

    expect(mockedAxios.post).toHaveBeenCalledTimes(1)
    const [url, body, opts] = (mockedAxios.post as jest.Mock).mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
    expect(body.from).toBe('DRK <alerts@gozippy.com>')
    expect(body.to).toBe('ops@example.com')
    expect(body.subject).toContain('Backup succeeded')
    expect(body.subject).toContain('Test Policy')
    expect(typeof body.text).toBe('string')
    expect(opts.headers.Authorization).toBe('Bearer re_test_key')
    expect(opts.headers['Content-Type']).toBe('application/json')
  })

  it('falls back to DRK_RESEND_API_KEY + DRK_EMAIL_FROM env vars', async () => {
    process.env.DRK_RESEND_API_KEY = 're_env_key'
    process.env.DRK_EMAIL_FROM = 'env-from@gozippy.com'

    const policy = makePolicy([
      // Only `to` provided — apiKey + from come from env
      { type: 'email', events: ['failure'], config: { to: 'on-call@example.com' } } as any,
    ])

    await svc.notify('failure', policy, makeBackup({ status: 'failed' }))

    expect(mockedAxios.post).toHaveBeenCalledTimes(1)
    const [, body, opts] = (mockedAxios.post as jest.Mock).mock.calls[0]
    expect(body.from).toBe('env-from@gozippy.com')
    expect(body.to).toBe('on-call@example.com')
    expect(body.subject).toContain('FAILED')
    expect(opts.headers.Authorization).toBe('Bearer re_env_key')
  })

  it('inline config wins over env when both are set', async () => {
    process.env.DRK_RESEND_API_KEY = 're_env'
    process.env.DRK_EMAIL_FROM = 'env-from@gozippy.com'

    const policy = makePolicy([
      {
        type: 'email', events: ['success'],
        config: { apiKey: 're_inline', from: 'inline@gozippy.com', to: 'ops@example.com' },
      } as any,
    ])

    await svc.notify('success', policy, makeBackup())
    const [, body, opts] = (mockedAxios.post as jest.Mock).mock.calls[0]
    expect(body.from).toBe('inline@gozippy.com')
    expect(opts.headers.Authorization).toBe('Bearer re_inline')
  })

  it('does not throw if Resend returns an error', async () => {
    mockedAxios.post = jest.fn().mockRejectedValue(new Error('resend 5xx'))
    const policy = makePolicy([
      {
        type: 'email', events: ['success'],
        config: { apiKey: 'k', from: 'f@x', to: 't@x' },
      } as any,
    ])
    await expect(svc.notify('success', policy, makeBackup())).resolves.toBeUndefined()
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
