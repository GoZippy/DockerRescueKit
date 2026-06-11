/**
 * Integration — licenseGate (requireFeature) wiring + CORS allowlist +
 * restricted ?apiKey= acceptance.
 *
 * The test server boots with no license token => Free tier (features: []),
 * so the `notifications`-gated route group must answer 402. A paid tier would
 * pass through; we don't have a signed token here, so we assert the Free path
 * (the meaningful regression guard for "the paywall is wired").
 */

import request from 'supertest'
import { createTestServer, TestServer } from '../helpers/testServer'

describe('integration: license gate + cors + query-key', () => {
  let server: TestServer

  beforeEach(async () => {
    server = await createTestServer()
  })

  afterEach(async () => {
    await server.cleanup()
  })

  it('Free tier is blocked from the notifications route group with 402', async () => {
    const res = await request(server.app)
      .get('/api/notifications/preferences')
      .set('x-api-key', server.apiKey)
    expect(res.status).toBe(402)
    expect(res.body.error).toBe('license_required')
    expect(res.body.currentTier).toBe('free')
  })

  it('a non-gated route (policies) still works on Free tier', async () => {
    const res = await request(server.app)
      .get('/api/policies')
      .set('x-api-key', server.apiKey)
    expect(res.status).toBe(200)
  })

  it('GET /api/status exposes securityWarnings (empty array on a fresh install)', async () => {
    const res = await request(server.app)
      .get('/api/status')
      .set('x-api-key', server.apiKey)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.securityWarnings)).toBe(true)
    expect(res.body.securityWarnings).toEqual([])
  })

  it('rejects a disallowed cross-origin request via the CORS allowlist', async () => {
    const res = await request(server.app)
      .get('/api/status')
      .set('x-api-key', server.apiKey)
      .set('Origin', 'https://evil.example.com')
    // cors() invokes the error callback -> express error handler -> 500 with
    // "Not allowed by CORS". The important part is the request is NOT granted
    // an Access-Control-Allow-Origin echo for the bad origin.
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('allows a localhost cross-origin request', async () => {
    const res = await request(server.app)
      .get('/api/status')
      .set('x-api-key', server.apiKey)
      .set('Origin', 'http://localhost:5173')
    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
  })

  it('rejects ?apiKey= on a state-mutating POST (query key only honored on download/stream GETs)', async () => {
    // The scheduler pause route is a POST; presenting the key via query must NOT
    // authenticate it now that query-key acceptance is restricted.
    const res = await request(server.app)
      .post(`/api/scheduler/pause?apiKey=${encodeURIComponent(server.apiKey)}`)
    expect(res.status).toBe(401)
  })
})
