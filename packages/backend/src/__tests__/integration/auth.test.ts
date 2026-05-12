/**
 * Integration tests — auth gate + brute-force throttle + request-id header.
 *
 * The brute-force limiter (`bruteForceLimit` in src/index.ts) caps FAILED
 * auth attempts at 10 per minute per IP. Supertest talks to the app through
 * an in-memory transport, so all requests share the same `req.ip` (typically
 * `::ffff:127.0.0.1`). Eleven wrong-key requests should therefore trip the
 * 429.
 *
 * We isolate this suite from others by using a fresh BackupService instance
 * per test (the limiter is closure state inside `setupMiddleware`).
 */

import request from 'supertest'
import { createTestServer, TestServer } from '../helpers/testServer'

describe('integration: auth + rate limit', () => {
  let server: TestServer

  beforeEach(async () => {
    server = await createTestServer()
  })

  afterEach(async () => {
    await server.cleanup()
  })

  it('rejects unauthenticated GET / POST / PUT / DELETE with 401', async () => {
    const verbs: Array<'get' | 'post' | 'put' | 'delete'> = ['get', 'post', 'put', 'delete']
    for (const verb of verbs) {
      const res = await (request(server.app) as any)[verb]('/api/policies')
      expect(res.status).toBe(401)
      expect(res.body.error).toMatch(/unauthorized/i)
    }
  })

  it('every response carries an X-Request-Id header', async () => {
    const a = await request(server.app).get('/healthz')
    expect(a.headers['x-request-id']).toMatch(/^[a-zA-Z0-9-]+$/)

    const b = await request(server.app)
      .get('/api/status')
      .set('x-api-key', server.apiKey)
    expect(b.headers['x-request-id']).toMatch(/^[a-zA-Z0-9-]+$/)

    // Different requests should get distinct ids.
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id'])
  })

  it('GET /api/policies with a valid key returns an empty array', async () => {
    const res = await request(server.app)
      .get('/api/policies')
      .set('x-api-key', server.apiKey)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body).toHaveLength(0)
  })

  it('POSTing a wrong key 11 times trips the brute-force limiter (429 on the 11th)', async () => {
    let lastStatus = 0
    for (let i = 0; i < 11; i++) {
      const res = await request(server.app)
        .get('/api/status')
        .set('x-api-key', 'nope-' + i)
      lastStatus = res.status
    }
    // After ten 401s the bucket is full and the 11th hits the 429 path inside
    // express-rate-limit. The handler short-circuits with the standard 429.
    expect(lastStatus).toBe(429)
  })
})
