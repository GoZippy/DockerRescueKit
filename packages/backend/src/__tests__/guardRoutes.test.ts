import express from 'express'
import request from 'supertest'
import { EventEmitter } from 'events'
import { mountGuardRoutes } from '../routes/guard'

// Minimal fakes — we're testing the route-shape + validation + MCP-contract
// surface, not the snapshot engine. Engine behaviour is covered by
// pruneGuardService.test.ts.

class FakeAudit {
  events: Array<{ action: string; details?: any }> = []
  async record(action: string, details?: any) {
    this.events.push({ action, details })
  }
}

class FakeSettings {
  current: any = {
    enabled: true,
    scope: 'named',
    diskBudgetMb: 2048,
    perVolumeCapMb: 512,
    ttlHours: 72,
    periodicCron: '0 */6 * * *',
    failClosed: false,
  }
  async getGuardSettings() {
    return this.current
  }
  async setGuardSettings(partial: any) {
    if (partial.scope && !['protected', 'named', 'all-named-under-cap', 'off'].includes(partial.scope)) {
      throw new Error(`Invalid guard scope: ${partial.scope}`)
    }
    if (partial.diskBudgetMb !== undefined && (!Number.isInteger(partial.diskBudgetMb) || partial.diskBudgetMb <= 0)) {
      throw new Error('Invalid guard diskBudgetMb: must be a positive integer')
    }
    this.current = { ...this.current, ...partial }
    return this.current
  }
}

class FakeDb {
  events = new Map<string, any>()
  async listGuardEvents(opts?: any) {
    let list = [...this.events.values()]
    if (opts?.status) list = list.filter(e => e.status === opts.status)
    return list
  }
  async getGuardEvent(id: string) {
    return this.events.get(id) || null
  }
}

class FakeGuard {
  bus = new EventEmitter()
  restored: Array<{ id: string; volumes?: string[] }> = []
  pinned: string[] = []
  removed: string[] = []
  snapshots: Array<{ kind: string; trigger: string; volumes: string[] }> = []

  subscribe(listener: (frame: any) => void) {
    const h = (f: any) => listener(f)
    this.bus.on('frame', h)
    return () => this.bus.off('frame', h)
  }
  emitFrame(frame: any) {
    this.bus.emit('frame', frame)
  }
  async restore(id: string, volumes?: string[]) {
    this.restored.push({ id, volumes })
    return { restored: volumes ?? ['vol-a', 'vol-b'], failed: [] }
  }
  async pin(id: string) {
    this.pinned.push(id)
  }
  async remove(id: string) {
    this.removed.push(id)
    return { reclaimedBytes: 1234 }
  }
  async guard(kind: string, trigger: string, volumes: string[]) {
    this.snapshots.push({ kind, trigger, volumes })
    return {
      id: `e-${this.snapshots.length}`,
      kind,
      trigger,
      scope: 'named',
      volumes: volumes.map(v => ({ volume: v, status: 'saved', sizeBytes: 10 })),
      totalBytes: volumes.length * 10,
      createdAt: new Date().toISOString(),
      ttlAt: new Date(Date.now() + 72 * 3600_000).toISOString(),
      pinned: false,
      status: 'saved',
    }
  }
}

function buildApp() {
  const app = express()
  app.use(express.json())
  const audit = new FakeAudit()
  const settings = new FakeSettings()
  const db = new FakeDb()
  const guard = new FakeGuard()
  mountGuardRoutes(app, { guard: guard as any, settings: settings as any, db: db as any, audit: audit as any })
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = err?.statusCode || 500
    res.status(status).json({ error: err.message, code: err.code })
  })
  return { app, audit, settings, db, guard }
}

// ---------------------------------------------------------------------------

describe('GET/PUT /api/guard/settings', () => {
  it('GET returns current settings', async () => {
    const { app } = buildApp()
    const res = await request(app).get('/api/guard/settings')
    expect(res.status).toBe(200)
    expect(res.body.scope).toBe('named')
  })

  it('PUT persists a valid patch', async () => {
    const { app } = buildApp()
    const res = await request(app).put('/api/guard/settings').send({ scope: 'protected', diskBudgetMb: 4096 })
    expect(res.status).toBe(200)
    expect(res.body.scope).toBe('protected')
    expect(res.body.diskBudgetMb).toBe(4096)
  })

  it('PUT 400 on invalid scope (SettingsService throws)', async () => {
    const { app } = buildApp()
    const res = await request(app).put('/api/guard/settings').send({ scope: 'bogus' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('INVALID_GUARD_SETTINGS')
  })
})

// ---------------------------------------------------------------------------

describe('GET /api/guard/events', () => {
  it('returns the list from the db', async () => {
    const { app, db } = buildApp()
    db.events.set('e-1', { id: 'e-1', status: 'saved' })
    db.events.set('e-2', { id: 'e-2', status: 'expired' })
    const res = await request(app).get('/api/guard/events')
    expect(res.status).toBe(200)
    expect(res.body.length).toBe(2)
  })

  it('filters by status', async () => {
    const { app, db } = buildApp()
    db.events.set('e-1', { id: 'e-1', status: 'saved' })
    db.events.set('e-2', { id: 'e-2', status: 'expired' })
    const res = await request(app).get('/api/guard/events?status=saved')
    expect(res.status).toBe(200)
    expect(res.body.length).toBe(1)
    expect(res.body[0].id).toBe('e-1')
  })

  it('400 on a non-numeric limit', async () => {
    const { app } = buildApp()
    const res = await request(app).get('/api/guard/events?limit=abc')
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------

describe('GET /api/guard/events/:id', () => {
  it('returns the full event when present', async () => {
    const { app, db } = buildApp()
    db.events.set('e-1', { id: 'e-1', status: 'saved', volumes: [] })
    const res = await request(app).get('/api/guard/events/e-1')
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('e-1')
  })

  it('404 when unknown', async () => {
    const { app } = buildApp()
    const res = await request(app).get('/api/guard/events/missing')
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------

describe('POST /api/guard/events/:id/restore', () => {
  it('202 + { restored } when the event exists', async () => {
    const { app, db, guard } = buildApp()
    db.events.set('e-1', { id: 'e-1', status: 'saved' })
    const res = await request(app).post('/api/guard/events/e-1/restore').send({ volumes: ['vol-a'] })
    expect(res.status).toBe(202)
    expect(res.body.restored).toEqual(['vol-a'])
    expect(guard.restored[0]).toEqual({ id: 'e-1', volumes: ['vol-a'] })
  })

  it('restores all when volumes omitted', async () => {
    const { app, db } = buildApp()
    db.events.set('e-1', { id: 'e-1', status: 'saved' })
    const res = await request(app).post('/api/guard/events/e-1/restore').send({})
    expect(res.status).toBe(202)
    expect(res.body.restored).toEqual(['vol-a', 'vol-b'])
  })

  it('404 when the event is missing', async () => {
    const { app } = buildApp()
    const res = await request(app).post('/api/guard/events/nope/restore').send({})
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------

describe('POST /api/guard/events/:id/pin', () => {
  it('pins an existing event', async () => {
    const { app, db, guard } = buildApp()
    db.events.set('e-1', { id: 'e-1', status: 'saved' })
    const res = await request(app).post('/api/guard/events/e-1/pin')
    expect(res.status).toBe(200)
    expect(res.body.pinned).toBe(true)
    expect(guard.pinned).toContain('e-1')
  })

  it('404 when the event is missing', async () => {
    const { app } = buildApp()
    const res = await request(app).post('/api/guard/events/nope/pin')
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------

describe('DELETE /api/guard/events/:id', () => {
  it('removes the event + reports reclaimed bytes', async () => {
    const { app, guard } = buildApp()
    const res = await request(app).delete('/api/guard/events/e-1')
    expect(res.status).toBe(200)
    expect(res.body.reclaimedBytes).toBe(1234)
    expect(guard.removed).toContain('e-1')
  })
})

// ---------------------------------------------------------------------------

describe('POST /api/guard/snapshot — the MCP contract addition', () => {
  it('matches drkClient.snapshotNow shape: { kind, trigger:"mcp", volumes } → GuardEvent', async () => {
    const { app, guard } = buildApp()
    const res = await request(app)
      .post('/api/guard/snapshot')
      .send({ kind: 'system_prune', trigger: 'mcp', volumes: ['db', 'uploads'] })
    expect(res.status).toBe(200)
    // The drkClient expects a GuardEvent back (id/kind/volumes/status).
    expect(typeof res.body.id).toBe('string')
    expect(res.body.kind).toBe('system_prune')
    expect(res.body.status).toBe('saved')
    expect(res.body.volumes.map((v: any) => v.volume)).toEqual(['db', 'uploads'])
    expect(guard.snapshots[0]).toEqual({ kind: 'system_prune', trigger: 'mcp', volumes: ['db', 'uploads'] })
  })

  it('defaults kind=system_prune + trigger=mcp when omitted', async () => {
    const { app, guard } = buildApp()
    const res = await request(app).post('/api/guard/snapshot').send({ volumes: ['only'] })
    expect(res.status).toBe(200)
    expect(guard.snapshots[0].kind).toBe('system_prune')
    expect(guard.snapshots[0].trigger).toBe('mcp')
  })

  it('400 on empty volumes', async () => {
    const { app } = buildApp()
    const res = await request(app).post('/api/guard/snapshot').send({ volumes: [] })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('INVALID_SNAPSHOT')
  })

  it('400 on an invalid trigger enum', async () => {
    const { app } = buildApp()
    const res = await request(app).post('/api/guard/snapshot').send({ volumes: ['v'], trigger: 'wat' })
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------

describe('POST /api/guard/test — gated behind DRK_GUARD_TEST=1', () => {
  const prev = process.env.DRK_GUARD_TEST
  afterEach(() => {
    if (prev === undefined) delete process.env.DRK_GUARD_TEST
    else process.env.DRK_GUARD_TEST = prev
  })

  it('404 without the env flag', async () => {
    delete process.env.DRK_GUARD_TEST
    const { app } = buildApp()
    const res = await request(app).post('/api/guard/test').send({ kind: 'volume_rm', volumes: ['v'] })
    expect(res.status).toBe(404)
  })

  it('202 + GuardEvent when DRK_GUARD_TEST=1', async () => {
    process.env.DRK_GUARD_TEST = '1'
    const { app, guard } = buildApp()
    const res = await request(app).post('/api/guard/test').send({ kind: 'volume_rm', volumes: ['v'] })
    expect(res.status).toBe(202)
    expect(res.body.kind).toBe('volume_rm')
    expect(guard.snapshots[0].trigger).toBe('event')
  })
})

// ---------------------------------------------------------------------------

describe('GET /api/guard/stream — SSE', () => {
  it('sends an initial hello + bridges a snapshot frame end-to-end', done => {
    const { app, guard } = buildApp()
    const req = request(app)
      .get('/api/guard/stream')
      .buffer(false)
      .parse((res: any, _cb: any) => {
        let data = ''
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString('utf-8')
          if (data.includes('event: hello')) {
            // Bus → SSE bridge: emit a snapshot frame and assert it arrives.
            guard.emitFrame({ event: 'snapshot', data: { id: 'e-9', kind: 'volume_rm', volumes: [] } })
          }
          if (data.includes('event: snapshot') && data.includes('e-9')) {
            expect(data).toContain('event: hello')
            expect(data).toContain('event: snapshot')
            res.destroy()
            done()
          }
        })
      })
    req.end(() => {})
  })
})
