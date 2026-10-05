/**
 * Integration tests: policy time zones over the HTTP API.
 *
 *  - create with a zone / without one (CLI and API callers) / with a bad one
 *  - the response carries `effectiveTimezone` and a `nextRun` computed in that zone
 *  - a legacy row (no zone) is reported as UTC and keeps UTC next runs
 *  - a fetched policy can be PUT straight back (computed fields are stripped)
 */

import request from 'supertest'
import { createTestServer, TestServer } from '../helpers/testServer'

const body = {
  name: 'tz-policy',
  enabled: true,
  targets: [{ type: 'volume', selector: 'demo-vol' }],
  schedule: '0 2 * * *',
  backupType: 'full' as const,
  retention: { strategy: 'count', count: 5 },
  storage: { id: 'local-default', type: 'local', path: 'data/backups' },
}

/** Hour of day (0-23) of an ISO instant as seen in `tz`. */
function hourIn(iso: string, tz: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso)))
}

describe('integration: policy timezone', () => {
  let server: TestServer

  beforeEach(async () => {
    server = await createTestServer()
  })

  afterEach(async () => {
    await server.cleanup()
  })

  const auth = (req: request.Test) => req.set('x-api-key', server.apiKey)

  it('POST with a zone stores it and reports a next run at 02:00 in that zone', async () => {
    const res = await auth(request(server.app).post('/api/policies').send({ ...body, timezone: 'America/Chicago' }))
    expect(res.status).toBe(201)
    expect(res.body.timezone).toBe('America/Chicago')
    expect(res.body.effectiveTimezone).toBe('America/Chicago')
    expect(hourIn(res.body.nextRun, 'America/Chicago')).toBe(2)
    expect(new Date(res.body.nextRun).getTime()).toBeGreaterThan(Date.now())
  })

  it('POST without a zone (CLI / API) defaults to UTC', async () => {
    const res = await auth(request(server.app).post('/api/policies').send(body))
    expect(res.status).toBe(201)
    expect(res.body.timezone).toBe('UTC')
    expect(res.body.effectiveTimezone).toBe('UTC')
    expect(hourIn(res.body.nextRun, 'UTC')).toBe(2)
  })

  it('POST with an invalid zone is a 400 that names the field', async () => {
    for (const timezone of ['Mars/Base', '+05:00', '']) {
      const res = await auth(request(server.app).post('/api/policies').send({ ...body, timezone }))
      expect(res.status).toBe(400)
      expect(res.body.details.fieldErrors.timezone).toBeDefined()
    }
  })

  it('PUT changes the zone, and rejects an invalid one without changing anything', async () => {
    const created = await auth(request(server.app).post('/api/policies').send(body))
    const id = created.body.id

    const bad = await auth(request(server.app).put(`/api/policies/${id}`).send({ timezone: 'Nope/Nope' }))
    expect(bad.status).toBe(400)

    const ok = await auth(request(server.app).put(`/api/policies/${id}`).send({ timezone: 'Europe/London' }))
    expect(ok.status).toBe(200)
    expect(ok.body.timezone).toBe('Europe/London')
    expect(hourIn(ok.body.nextRun, 'Europe/London')).toBe(2)

    const got = await auth(request(server.app).get(`/api/policies/${id}`))
    expect(got.body.timezone).toBe('Europe/London')
  })

  it('a legacy policy (no stored zone) is reported as UTC and keeps its UTC next run', async () => {
    const created = await auth(request(server.app).post('/api/policies').send({ ...body, timezone: 'America/Chicago' }))
    const id = created.body.id
    // Simulate a row written before the column existed.
    server.service.db.db.prepare('UPDATE policies SET timezone = NULL WHERE id = ?').run(id)

    const one = await auth(request(server.app).get(`/api/policies/${id}`))
    expect(one.status).toBe(200)
    expect(one.body.timezone).toBeUndefined()
    expect(one.body.effectiveTimezone).toBe('UTC')
    expect(hourIn(one.body.nextRun, 'UTC')).toBe(2)

    const list = await auth(request(server.app).get('/api/policies'))
    const row = list.body.find((p: any) => p.id === id)
    expect(row.timezone).toBeUndefined()
    expect(row.effectiveTimezone).toBe('UTC')

    // Editing something else must not give it a zone behind the user's back.
    const put = await auth(request(server.app).put(`/api/policies/${id}`).send({ description: 'edited' }))
    expect(put.status).toBe(200)
    expect(put.body.timezone).toBeUndefined()
    expect(put.body.effectiveTimezone).toBe('UTC')
  })

  it('stack protect rejects an invalid zone with a 400 before touching Docker', async () => {
    const res = await auth(request(server.app).post('/api/docker/stacks/app/protect').send({ timezone: 'Mars/Base' }))
    expect(res.status).toBe(400)
    expect(res.body.details.fieldErrors.timezone).toBeDefined()
  })

  it('a disabled policy has no next run', async () => {
    const res = await auth(request(server.app).post('/api/policies').send({ ...body, enabled: false, timezone: 'America/Chicago' }))
    expect(res.status).toBe(201)
    expect(res.body.nextRun).toBeNull()
    expect(res.body.effectiveTimezone).toBe('America/Chicago')
  })

  it('a fetched policy can be PUT back unchanged (computed fields are not persisted)', async () => {
    const created = await auth(request(server.app).post('/api/policies').send({ ...body, timezone: 'America/Chicago' }))
    const fetched = await auth(request(server.app).get(`/api/policies/${created.body.id}`))
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = fetched.body
    // Unrelated, pre-existing: the schema rejects explicit nulls (description,
    // notifications), so a client drops them. Everything else, including the
    // computed effectiveTimezone/nextRun, goes back as fetched.
    const editable = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== null))
    expect(editable).toHaveProperty('effectiveTimezone')
    expect(editable).toHaveProperty('nextRun')
    const put = await auth(request(server.app).put(`/api/policies/${created.body.id}`).send(editable))
    expect(put.status).toBe(200)
    expect(put.body.timezone).toBe('America/Chicago')
  })
})
