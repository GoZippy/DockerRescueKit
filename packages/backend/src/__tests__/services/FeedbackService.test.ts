/**
 * Tests for FeedbackService — v1.2.2 in-product feedback.
 *
 * Local sink writes a JSON file; network sinks (email, GitHub, webhook) are
 * verified to skip cleanly when unconfigured.  No real network calls are made —
 * nodemailer and axios are fully mocked.
 */

import fs from 'fs-extra'
import os from 'os'
import path from 'path'
import axios from 'axios'
import { FeedbackService, FEEDBACK_TYPES } from '../../services/FeedbackService'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test-msg-id' })
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: mockSendMail })),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSettings(overrides: Record<string, string | undefined> = {}) {
  return {
    getSetting: jest.fn(async (key: string) => overrides[key] ?? null),
  } as any
}

function makeDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'drk-feedback-test-'))
}

// ---------------------------------------------------------------------------

let dataDir: string
let settings: ReturnType<typeof makeSettings>
let svc: FeedbackService

beforeEach(() => {
  jest.clearAllMocks()
  mockedAxios.post = jest.fn().mockResolvedValue({ status: 200, data: 'ok' })
  mockSendMail.mockClear().mockResolvedValue({ messageId: 'test-msg-id' })
  dataDir = makeDataDir()
  settings = makeSettings()
  svc = new FeedbackService(settings, dataDir)
})

afterEach(() => {
  fs.removeSync(dataDir)
  delete process.env.DRK_GITHUB_FEEDBACK_TOKEN
  delete process.env.DRK_GITHUB_FEEDBACK_REPO
  delete process.env.DRK_SMTP_HOST
  delete process.env.DRK_SMTP_PORT
  delete process.env.DRK_SMTP_SECURE
  delete process.env.DRK_SMTP_USER
  delete process.env.DRK_SMTP_PASS
  delete process.env.DRK_EMAIL_FROM
})

// ---------------------------------------------------------------------------
// Local sink
// ---------------------------------------------------------------------------

describe('FeedbackService — local sink', () => {
  it('writes a .json file into {dataDir}/feedback/ on submit', async () => {
    const result = await svc.submit({ type: 'bug', message: 'something broke' })

    const feedbackDir = path.join(dataDir, 'feedback')
    const files = await fs.readdir(feedbackDir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/\.json$/)

    const written = await fs.readJson(path.join(feedbackDir, files[0]))
    expect(written.id).toBe(result.id)
    expect(written.type).toBe('bug')
    expect(written.message).toBe('something broke')
  })

  it('local sink always fires (returns sent)', async () => {
    const result = await svc.submit({ type: 'suggestion', message: 'please add X' })
    expect(result.sinks.local).toBe('sent')
  })
})

// ---------------------------------------------------------------------------
// Email sink
// ---------------------------------------------------------------------------

describe('FeedbackService — email sink', () => {
  it('returns skipped when no SMTP is configured', async () => {
    const result = await svc.submit({ type: 'bug', message: 'test' })
    expect(result.sinks.email).toBe('skipped')
  })

  it('sends email when SMTP is configured via settings', async () => {
    settings = makeSettings({
      'smtp.host': 'mail.example.com',
      'smtp.port': '587',
      'smtp.secure': 'false',
      'email.from': 'alerts@example.com',
    })
    svc = new FeedbackService(settings, dataDir)

    const result = await svc.submit({ type: 'bug', message: 'test email' })
    expect(result.sinks.email).toBe('sent')
  })
})

// ---------------------------------------------------------------------------
// GitHub sink
// ---------------------------------------------------------------------------

describe('FeedbackService — GitHub sink', () => {
  it('returns skipped when DRK_GITHUB_FEEDBACK_TOKEN is unset', async () => {
    delete process.env.DRK_GITHUB_FEEDBACK_TOKEN
    const result = await svc.submit({ type: 'bug', message: 'test' })
    expect(result.sinks.github).toBe('skipped')
  })

  it('posts an issue when token is set', async () => {
    process.env.DRK_GITHUB_FEEDBACK_TOKEN = 'ghp_test123'
    const result = await svc.submit({ type: 'bug', message: 'gh issue' })
    expect(result.sinks.github).toBe('sent')
    expect(mockedAxios.post).toHaveBeenCalledTimes(1)
    const [url] = (mockedAxios.post as jest.Mock).mock.calls[0]
    expect(url).toContain('api.github.com/repos/')
  })
})

// ---------------------------------------------------------------------------
// Webhook sink
// ---------------------------------------------------------------------------

describe('FeedbackService — webhook sink', () => {
  it('returns skipped when no webhook URL is configured', async () => {
    const result = await svc.submit({ type: 'bug', message: 'test' })
    expect(result.sinks.webhook).toBe('skipped')
  })

  it('posts to webhook when URL is configured', async () => {
    settings = makeSettings({
      'feedback.webhook_url': 'https://hooks.example.com/drk',
    })
    svc = new FeedbackService(settings, dataDir)

    const result = await svc.submit({ type: 'bug', message: 'webhook test' })
    expect(result.sinks.webhook).toBe('sent')
    expect(mockedAxios.post).toHaveBeenCalledTimes(1)
    const [url] = (mockedAxios.post as jest.Mock).mock.calls[0]
    expect(url).toBe('https://hooks.example.com/drk')
  })
})

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

describe('FeedbackService — result shape', () => {
  it('returns { id: string, sinks: { local, email, github, webhook } }', async () => {
    const result = await svc.submit({ type: 'bug', message: 'shape test' })
    expect(result).toHaveProperty('id')
    expect(typeof result.id).toBe('string')
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.sinks).toEqual({
      local: expect.any(String),
      email: expect.any(String),
      github: expect.any(String),
      webhook: expect.any(String),
    })
  })
})

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

describe('FeedbackService — screenshot', () => {
  it('includes screenshotPngBase64 in the written JSON when provided', async () => {
    const b64 = Buffer.from('fake-png-bytes').toString('base64')
    await svc.submit({ type: 'bug', message: 'ss test', screenshotPngBase64: b64 })

    const feedbackDir = path.join(dataDir, 'feedback')
    const files = await fs.readdir(feedbackDir)
    const written = await fs.readJson(path.join(feedbackDir, files[0]))
    expect(written.screenshotPngBase64).toBe(b64)
  })
})

// ---------------------------------------------------------------------------
// Version enrichment
// ---------------------------------------------------------------------------

describe('FeedbackService — version enrichment', () => {
  it('includes version from APP_VERSION in the written context', async () => {
    await svc.submit({ type: 'bug', message: 'version test' })

    const feedbackDir = path.join(dataDir, 'feedback')
    const files = await fs.readdir(feedbackDir)
    const written = await fs.readJson(path.join(feedbackDir, files[0]))
    expect(written.context).toBeDefined()
    expect(written.context.version).toBeDefined()
    expect(typeof written.context.version).toBe('string')
  })
})
