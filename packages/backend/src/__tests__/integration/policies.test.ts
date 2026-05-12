/**
 * Integration tests — /api/policies CRUD.
 *
 * Covers the happy path (create, read, update, delete, history) plus the
 * three error shapes the layer surfaces:
 *   - Zod body validation       → 400 with { error, details }
 *   - Zod params validation     → 400 with { error, details }
 *   - NotFoundError on read     → 404 via central error handler
 */

import request from 'supertest'
import { createTestServer, TestServer } from '../helpers/testServer'

const validPolicyBody = {
  name: 'integration-test-policy',
  description: 'created by jest',
  enabled: true,
  targets: [{ type: 'volume', selector: 'demo-vol' }],
  schedule: '0 2 * * *',
  backupType: 'full' as const,
  retention: { strategy: 'count', count: 5 },
  storage: { id: 'local-default', type: 'local', path: 'data/backups' },
}

describe('integration: /api/policies', () => {
  let server: TestServer

  beforeEach(async () => {
    server = await createTestServer()
  })

  afterEach(async () => {
    await server.cleanup()
  })

  const auth = (req: request.Test) => req.set('x-api-key', server.apiKey)

  it('GET /api/policies (empty) returns 200 []', async () => {
    const res = await auth(request(server.app).get('/api/policies'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('POST /api/policies with empty body returns 400 with Zod details', async () => {
    const res = await auth(request(server.app).post('/api/policies').send({}))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/validation/i)
    expect(res.body.details).toBeDefined()
  })

  it('POST /api/policies with valid body returns 201 with the new policy', async () => {
    const res = await auth(
      request(server.app).post('/api/policies').send(validPolicyBody)
    )
    expect(res.status).toBe(201)
    expect(res.body.id).toMatch(/^[a-f0-9-]{36}$/)
    expect(res.body.name).toBe(validPolicyBody.name)
    expect(res.body.targets).toEqual(validPolicyBody.targets)
  })

  it('GET /api/policies/:id with a malformed id returns 400 (params validation)', async () => {
    // The id schema only allows [a-zA-Z0-9_-]{1,64}; spaces should be rejected.
    const res = await auth(
      request(server.app).get('/api/policies/has%20space')
    )
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid route/i)
  })

  it('GET /api/policies/<unknown-but-valid-id> returns 404', async () => {
    const res = await auth(
      request(server.app).get('/api/policies/00000000-0000-0000-0000-000000000000')
    )
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/policy/i)
  })

  it('GET /api/policies/:id with a real id returns 200', async () => {
    const created = await auth(
      request(server.app).post('/api/policies').send(validPolicyBody)
    )
    const id = created.body.id

    const res = await auth(request(server.app).get(`/api/policies/${id}`))
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(id)
  })

  it('PUT /api/policies/:id updates the policy', async () => {
    const created = await auth(
      request(server.app).post('/api/policies').send(validPolicyBody)
    )
    const id = created.body.id

    const res = await auth(
      request(server.app)
        .put(`/api/policies/${id}`)
        .send({ description: 'updated-desc' })
    )
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(id)
    expect(res.body.description).toBe('updated-desc')
  })

  it('DELETE /api/policies/:id returns 204', async () => {
    const created = await auth(
      request(server.app).post('/api/policies').send(validPolicyBody)
    )
    const id = created.body.id

    const res = await auth(request(server.app).delete(`/api/policies/${id}`))
    expect(res.status).toBe(204)
    expect(res.body).toEqual({})
  })

  it('DELETE /api/policies/:id is idempotent — deleting again still returns 204', async () => {
    // PolicyManager.deletePolicy issues a SQL DELETE that swallows missing
    // rows, so the route returns 204 even on the second call. Documenting
    // this so a future "404 if missing" tweak fails this test loudly.
    const created = await auth(
      request(server.app).post('/api/policies').send(validPolicyBody)
    )
    const id = created.body.id

    const first = await auth(request(server.app).delete(`/api/policies/${id}`))
    expect(first.status).toBe(204)

    const second = await auth(request(server.app).delete(`/api/policies/${id}`))
    expect(second.status).toBe(204)
  })

  it('GET /api/policies/:id/history returns [] for a fresh policy', async () => {
    const created = await auth(
      request(server.app).post('/api/policies').send(validPolicyBody)
    )
    const id = created.body.id

    const res = await auth(
      request(server.app).get(`/api/policies/${id}/history`)
    )
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })
})
