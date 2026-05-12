/**
 * Integration tests — /api/settings + API-key rotation.
 *
 * Worth noting: the regenerate-api-key endpoint mutates SecretsService in
 * memory AND writes secrets.json. The auth middleware re-reads the current
 * key on every request, so the rotation should take effect immediately.
 */

import request from 'supertest'
import { createTestServer, readApiKey, TestServer } from '../helpers/testServer'

describe('integration: /api/settings', () => {
  let server: TestServer

  beforeEach(async () => {
    server = await createTestServer()
  })

  afterEach(async () => {
    await server.cleanup()
  })

  const auth = (req: request.Test) => req.set('x-api-key', server.apiKey)

  it('GET /api/settings/meta returns version + dataDir', async () => {
    const res = await auth(request(server.app).get('/api/settings/meta'))
    expect(res.status).toBe(200)
    expect(res.body.version).toBeDefined()
    expect(res.body.dataDir).toBe(server.dataDir)
    expect(res.body.staging).toContain(server.dataDir)
  })

  it('POST /api/settings/:key persists the value, GET reads it back', async () => {
    const post = await auth(
      request(server.app)
        .post('/api/settings/foo')
        .send({ value: 'bar' })
    )
    expect(post.status).toBe(200)
    expect(post.body.success).toBe(true)

    const get = await auth(request(server.app).get('/api/settings/foo'))
    expect(get.status).toBe(200)
    expect(get.body.value).toBe('bar')
  })

  it('GET /api/settings/<unset> returns { value: null }', async () => {
    const res = await auth(request(server.app).get('/api/settings/never-set'))
    expect(res.status).toBe(200)
    expect(res.body.value).toBeNull()
  })

  it('POST /api/settings/regenerate-api-key rotates the key (old key now 401s)', async () => {
    const oldKey = server.apiKey

    const rot = await auth(
      request(server.app).post('/api/settings/regenerate-api-key')
    )
    expect(rot.status).toBe(200)
    expect(typeof rot.body.apiKey).toBe('string')
    expect(rot.body.apiKey).not.toBe(oldKey)

    // Confirm secrets.json on disk matches the rotated key.
    const onDisk = await readApiKey(server.dataDir)
    expect(onDisk).toBe(rot.body.apiKey)

    // Old key should now be rejected.
    const old = await request(server.app)
      .get('/api/status')
      .set('x-api-key', oldKey)
    expect(old.status).toBe(401)

    // New key should authenticate.
    const fresh = await request(server.app)
      .get('/api/status')
      .set('x-api-key', rot.body.apiKey)
    expect(fresh.status).toBe(200)
  })
})
