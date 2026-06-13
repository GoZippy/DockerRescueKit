/**
 * Route tests for the notifications group (v1.4).
 *
 * Mirrors the guardRoutes.test.ts idiom: a real Express app, supertest, and
 * minimal fakes. The license gate (requireFeature) is exercised with both a
 * Pro license (data flows) and a Free license (every call → 402).
 */

import express from 'express'
import request from 'supertest'
import { mountNotificationRoutes } from '../routes/notifications'
import { requireFeature } from '../middleware/licenseGate'
import { HttpError } from '../errors'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeDb {
  prefs: any = null
  log: any[] = []

  async getNotificationPreferences() { return this.prefs }
  async upsertNotificationPreferences(_userId: string, prefs: any) { this.prefs = prefs }

  async listNotificationLog(opts: any = {}) {
    let list = [...this.log]
    if (opts.eventType) list = list.filter(e => e.eventType === opts.eventType)
    if (opts.acknowledged === true) list = list.filter(e => e.acknowledgedAt)
    if (opts.acknowledged === false) list = list.filter(e => !e.acknowledgedAt)
    const total = list.length
    const offset = opts.offset || 0
    const limit = opts.limit || 50
    return { entries: list.slice(offset, offset + limit), total }
  }
  async countUnacknowledgedNotifications() {
    return this.log.filter(e => !e.acknowledgedAt).length
  }
  async acknowledgeNotification(id: string) {
    const row = this.log.find(e => e.id === id)
    if (!row) return false
    row.acknowledgedAt = new Date().toISOString()
    return true
  }
  async acknowledgeAllNotifications() {
    let n = 0
    for (const e of this.log) if (!e.acknowledgedAt) { e.acknowledgedAt = new Date().toISOString(); n++ }
    return n
  }
}

const fakeDispatcher = {
  isEmailAvailable: jest.fn(async () => true),
  sendTestNotification: jest.fn(async (sink: string) => ({ ok: true, sink } as any)),
} as any

function fakeLicense(features: string[], tier = 'personal-pro') {
  return {
    getStatus: jest.fn().mockResolvedValue({
      tier, seats: 1, features, launchLockIn: false, staleButValid: false, devMode: false,
    }),
  } as any
}

function buildApp(license: any) {
  const app = express()
  app.use(express.json())
  const db = new FakeDb()
  app.use('/api/notifications', requireFeature(license, 'notifications'))
  mountNotificationRoutes(app, { db: db as any, dispatcher: fakeDispatcher })
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = err instanceof HttpError ? err.statusCode : 500
    res.status(status).json({ error: err.message, code: err.code })
  })
  return { app, db }
}

const PRO = () => fakeLicense(['notifications'])
const FREE = () => fakeLicense([], 'free')

beforeEach(() => jest.clearAllMocks())

// ---------------------------------------------------------------------------
// Free tier — paywall (402)
// ---------------------------------------------------------------------------

describe('Free tier → 402 on every notifications endpoint', () => {
  it('GET /log → 402', async () => {
    const { app } = buildApp(FREE())
    const res = await request(app).get('/api/notifications/log')
    expect(res.status).toBe(402)
    expect(res.body.error).toBe('license_required')
  })

  it('GET /preferences → 402', async () => {
    const { app } = buildApp(FREE())
    expect((await request(app).get('/api/notifications/preferences')).status).toBe(402)
  })

  it('POST /test → 402', async () => {
    const { app } = buildApp(FREE())
    const res = await request(app).post('/api/notifications/test').send({ sink: 'webhook' })
    expect(res.status).toBe(402)
    expect(fakeDispatcher.sendTestNotification).not.toHaveBeenCalled()
  })

  it('POST /:id/acknowledge → 402', async () => {
    const { app } = buildApp(FREE())
    expect((await request(app).post('/api/notifications/abc/acknowledge')).status).toBe(402)
  })
})

// ---------------------------------------------------------------------------
// Pro tier — data flows
// ---------------------------------------------------------------------------

describe('Pro tier — log listing', () => {
  it('returns paginated entries newest-first shape', async () => {
    const { app, db } = buildApp(PRO())
    db.log = [
      { id: 'n1', eventType: 'unhealthy', acknowledgedAt: null, createdAt: '2026-06-12T10:00:00Z' },
      { id: 'n2', eventType: 'disk_pressure', acknowledgedAt: '2026-06-12T09:00:00Z', createdAt: '2026-06-12T09:00:00Z' },
    ]
    const res = await request(app).get('/api/notifications/log')
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(2)
    expect(res.body.entries.length).toBe(2)
    expect(res.body.limit).toBe(50)
  })

  it('filters by eventType', async () => {
    const { app, db } = buildApp(PRO())
    db.log = [
      { id: 'n1', eventType: 'unhealthy', acknowledgedAt: null },
      { id: 'n2', eventType: 'disk_pressure', acknowledgedAt: null },
    ]
    const res = await request(app).get('/api/notifications/log?eventType=unhealthy')
    expect(res.body.entries.length).toBe(1)
    expect(res.body.entries[0].id).toBe('n1')
  })

  it('filters by acknowledged=false', async () => {
    const { app, db } = buildApp(PRO())
    db.log = [
      { id: 'n1', eventType: 'unhealthy', acknowledgedAt: null },
      { id: 'n2', eventType: 'unhealthy', acknowledgedAt: 'now' },
    ]
    const res = await request(app).get('/api/notifications/log?acknowledged=false')
    expect(res.body.entries.length).toBe(1)
    expect(res.body.entries[0].id).toBe('n1')
  })
})

describe('Pro tier — unread count', () => {
  it('counts un-acknowledged entries', async () => {
    const { app, db } = buildApp(PRO())
    db.log = [
      { id: 'n1', acknowledgedAt: null },
      { id: 'n2', acknowledgedAt: null },
      { id: 'n3', acknowledgedAt: 'now' },
    ]
    const res = await request(app).get('/api/notifications/unread-count')
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(2)
  })
})

describe('Pro tier — acknowledge round-trip', () => {
  it('acks a single notification and drops the unread count', async () => {
    const { app, db } = buildApp(PRO())
    db.log = [{ id: 'n1', acknowledgedAt: null }, { id: 'n2', acknowledgedAt: null }]

    let res = await request(app).post('/api/notifications/n1/acknowledge')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    res = await request(app).get('/api/notifications/unread-count')
    expect(res.body.count).toBe(1)
  })

  it('404 when acknowledging an unknown id', async () => {
    const { app } = buildApp(PRO())
    const res = await request(app).post('/api/notifications/nope/acknowledge')
    expect(res.status).toBe(404)
  })

  it('acknowledge-all clears every unread entry', async () => {
    const { app, db } = buildApp(PRO())
    db.log = [{ id: 'n1', acknowledgedAt: null }, { id: 'n2', acknowledgedAt: null }]
    const res = await request(app).post('/api/notifications/acknowledge-all')
    expect(res.status).toBe(200)
    expect(res.body.acknowledged).toBe(2)
    expect(await db.countUnacknowledgedNotifications()).toBe(0)
  })
})

describe('Pro tier — preferences validation', () => {
  it('GET returns defaults + emailAvailable when none saved', async () => {
    const { app } = buildApp(PRO())
    const res = await request(app).get('/api/notifications/preferences')
    expect(res.status).toBe(200)
    expect(res.body.deliveryChannels).toEqual(['webhook'])
    expect(res.body.emailAvailable).toBe(true)
  })

  it('POST 400 when webhook channel enabled without webhookUrl', async () => {
    const { app } = buildApp(PRO())
    const res = await request(app).post('/api/notifications/preferences')
      .send({ deliveryChannels: ['webhook'] })
    expect(res.status).toBe(400)
  })

  it('POST 400 when ntfy channel enabled without ntfyUrl', async () => {
    const { app } = buildApp(PRO())
    const res = await request(app).post('/api/notifications/preferences')
      .send({ deliveryChannels: ['ntfy'] })
    expect(res.status).toBe(400)
  })

  it('POST 400 on unknown sink', async () => {
    const { app } = buildApp(PRO())
    const res = await request(app).post('/api/notifications/preferences')
      .send({ deliveryChannels: ['carrier-pigeon'] })
    expect(res.status).toBe(400)
  })

  it('POST persists a valid webhook+ntfy preference', async () => {
    const { app, db } = buildApp(PRO())
    const res = await request(app).post('/api/notifications/preferences').send({
      deliveryChannels: ['webhook', 'ntfy'],
      webhookUrl: 'https://hooks.example.com/x',
      ntfyUrl: 'https://ntfy.sh/topic',
    })
    expect(res.status).toBe(200)
    expect(db.prefs.deliveryChannels).toEqual(['webhook', 'ntfy'])
    expect(db.prefs.webhookUrl).toBe('https://hooks.example.com/x')
  })
})

describe('Pro tier — test endpoint', () => {
  it('POST /test fires the dispatcher for a valid sink', async () => {
    const { app } = buildApp(PRO())
    const res = await request(app).post('/api/notifications/test').send({ sink: 'ntfy' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(fakeDispatcher.sendTestNotification).toHaveBeenCalledWith('ntfy')
  })

  it('POST /test 400 on an unknown sink', async () => {
    const { app } = buildApp(PRO())
    const res = await request(app).post('/api/notifications/test').send({ sink: 'fax' })
    expect(res.status).toBe(400)
    expect(fakeDispatcher.sendTestNotification).not.toHaveBeenCalled()
  })
})
