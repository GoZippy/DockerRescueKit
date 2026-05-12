/**
 * Integration tests — /healthz and /api/status.
 *
 * /healthz is intentionally registered BEFORE the auth middleware so external
 * monitors can probe liveness without an API key. /api/status is behind auth
 * and reflects the docker-online/paused state.
 */

import request from 'supertest'
import { createTestServer, TestServer } from '../helpers/testServer'

describe('integration: health + status', () => {
  let server: TestServer

  beforeEach(async () => {
    server = await createTestServer()
  })

  afterEach(async () => {
    await server.cleanup()
  })

  it('GET /healthz returns 200 with status + uptime (no auth required)', async () => {
    const res = await request(server.app).get('/healthz')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(typeof res.body.uptime).toBe('number')
  })

  it('GET /api/status without key returns 401', async () => {
    const res = await request(server.app).get('/api/status')
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/unauthorized/i)
  })

  it('GET /api/status with wrong key returns 401', async () => {
    const res = await request(server.app)
      .get('/api/status')
      .set('x-api-key', 'definitely-not-the-real-key')
    expect(res.status).toBe(401)
  })

  it('GET /api/status with correct key returns 200 with docker:false', async () => {
    const res = await request(server.app)
      .get('/api/status')
      .set('x-api-key', server.apiKey)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('online')
    expect(typeof res.body.version).toBe('string')
    // DockerService.ping is mocked to resolve(false).
    expect(res.body.docker).toBe(false)
    expect(res.body.paused).toBe(false)
    expect(Array.isArray(res.body.inFlight)).toBe(true)
  })
})
