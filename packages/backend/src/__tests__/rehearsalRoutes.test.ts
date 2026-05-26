import express from 'express'
import request from 'supertest'
import { mountRehearsalRoutes } from '../routes/rehearsals'

// Minimal fakes — we're testing the route-shape + validation contract,
// not the underlying service. Service-side behaviour is covered by
// rehearsalService.test.ts and (when CI_INTEGRATION=1) the integration
// suite.

class FakeAudit {
  events: Array<{ action: string; details?: any }> = []
  async record(action: string, details?: any) {
    this.events.push({ action, details })
  }
}

class FakeRehearsalService {
  enqueued: any[] = []
  reports = new Map<string, any>()
  aborted: string[] = []

  async enqueue(req: any) {
    const id = `r-${this.enqueued.length + 1}`
    this.enqueued.push({ id, req })
    this.reports.set(id, { id, status: 'pending', ok: false, requestedBackupIds: [] })
    return id
  }
  async getReport(id: string) {
    return this.reports.get(id) || null
  }
  async list(_opts?: any) {
    return [...this.reports.values()]
  }
  subscribe(_id: string, _listener: any) {
    return () => {}
  }
  async abort(id: string) {
    this.aborted.push(id)
    return this.reports.has(id)
  }
}

function buildApp() {
  const app = express()
  app.use(express.json())
  const audit = new FakeAudit() as any
  const rehearsalService = new FakeRehearsalService() as any
  mountRehearsalRoutes(app, { rehearsalService, audit })
  // Trivial error middleware so thrown HttpError instances become real status codes
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = err?.statusCode || 500
    res.status(status).json({ error: err.message, code: err.code })
  })
  return { app, audit, rehearsalService }
}

// ---------------------------------------------------------------------------

describe('POST /api/rehearsals — validation', () => {
  it('400 when body is not an object', async () => {
    const { app } = buildApp()
    const res = await request(app).post('/api/rehearsals').send('hello').set('Content-Type', 'text/plain')
    expect(res.status).toBe(400)
  })

  it('400 when smokeChecks is missing', async () => {
    const { app } = buildApp()
    const res = await request(app).post('/api/rehearsals').send({ policyId: 'p1' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/smokeChecks/i)
  })

  it('400 when both policyId and backupIds are provided', async () => {
    const { app } = buildApp()
    const res = await request(app).post('/api/rehearsals').send({
      policyId: 'p1',
      backupIds: ['b1'],
      smokeChecks: [{ kind: 'tcp', container: 'app', port: 80 }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/mutually exclusive/i)
  })

  it('400 when sql_select_1 has bad driver', async () => {
    const { app } = buildApp()
    const res = await request(app).post('/api/rehearsals').send({
      policyId: 'p1',
      smokeChecks: [{ kind: 'sql_select_1', container: 'db', driver: 'mariadb' }],
    })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('INVALID_SQL_DRIVER')
  })

  it('400 when http check has no port', async () => {
    const { app } = buildApp()
    const res = await request(app).post('/api/rehearsals').send({
      policyId: 'p1',
      smokeChecks: [{ kind: 'http', container: 'app' }],
    })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('INVALID_PORT')
  })

  it('400 when exec check has empty command', async () => {
    const { app } = buildApp()
    const res = await request(app).post('/api/rehearsals').send({
      policyId: 'p1',
      smokeChecks: [{ kind: 'exec', container: 'app', command: [] }],
    })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('INVALID_EXEC_COMMAND')
  })

  it('202 + id on a valid request, and writes rehearsal.start audit', async () => {
    const { app, audit, rehearsalService } = buildApp()
    const res = await request(app).post('/api/rehearsals').send({
      policyId: 'p1',
      smokeChecks: [{ kind: 'tcp', container: 'app', port: 80 }],
    })
    expect(res.status).toBe(202)
    expect(typeof res.body.id).toBe('string')
    expect(rehearsalService.enqueued.length).toBe(1)
    expect(audit.events[0].action).toBe('rehearsal.start')
    expect(audit.events[0].details.smokeCheckCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------

describe('GET /api/rehearsals', () => {
  it('returns the list from the service', async () => {
    const { app, rehearsalService } = buildApp()
    rehearsalService.reports.set('r-1', { id: 'r-1', status: 'success', ok: true })
    rehearsalService.reports.set('r-2', { id: 'r-2', status: 'failed', ok: false })
    const res = await request(app).get('/api/rehearsals')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------

describe('GET /api/rehearsals/:id', () => {
  it('returns the report when present', async () => {
    const { app, rehearsalService } = buildApp()
    rehearsalService.reports.set('r-1', { id: 'r-1', status: 'success', ok: true })
    const res = await request(app).get('/api/rehearsals/r-1')
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('r-1')
  })

  it('404 when unknown', async () => {
    const { app } = buildApp()
    const res = await request(app).get('/api/rehearsals/missing')
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------

describe('POST /api/rehearsals/:id/abort', () => {
  it('202 + audit event when an active run exists', async () => {
    const { app, audit, rehearsalService } = buildApp()
    rehearsalService.reports.set('r-1', { id: 'r-1', status: 'restoring', ok: false })
    const res = await request(app).post('/api/rehearsals/r-1/abort')
    expect(res.status).toBe(202)
    expect(rehearsalService.aborted).toContain('r-1')
    expect(audit.events.find((e: { action: string }) => e.action === 'rehearsal.abort')).toBeTruthy()
  })

  it('404 when nothing to abort', async () => {
    const { app } = buildApp()
    const res = await request(app).post('/api/rehearsals/never-existed/abort')
    expect(res.status).toBe(404)
  })
})
