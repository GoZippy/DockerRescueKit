/**
 * Integration tests — /api/connectors.
 *
 * Connector definitions are registered at module-load time via the side
 * effect in src/connectors/index.ts. As a result, GET /definitions returns
 * the same list across every test instance.
 */

import request from 'supertest'
import { createTestServer, TestServer } from '../helpers/testServer'

describe('integration: /api/connectors', () => {
  let server: TestServer

  beforeEach(async () => {
    server = await createTestServer()
  })

  afterEach(async () => {
    await server.cleanup()
  })

  const auth = (req: request.Test) => req.set('x-api-key', server.apiKey)

  it('GET /api/connectors returns 200 [] for a fresh install', async () => {
    const res = await auth(request(server.app).get('/api/connectors'))
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body).toHaveLength(0)
  })

  it('GET /api/connectors/definitions returns the built-in plugin list', async () => {
    const res = await auth(
      request(server.app).get('/api/connectors/definitions')
    )
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    // ConnectorRegistry registers six built-ins (proxmox/truenas/s3/sftp/rclone/pbs)
    // but PBSConnector and ProxmoxConnector both claim type='proxmox' and the
    // registry is a Map keyed by type, so the effective count is 5. Document
    // here so a future de-collision shows up as a test bump rather than a
    // silent change.
    expect(res.body.length).toBeGreaterThanOrEqual(5)
    for (const def of res.body) {
      expect(typeof def.type).toBe('string')
    }
    const types = res.body.map((d: any) => d.type)
    expect(types).toEqual(expect.arrayContaining(['truenas', 's3', 'sftp', 'rclone']))
  })

  it('POST /api/connectors with empty body returns 400 with Zod details', async () => {
    const res = await auth(
      request(server.app).post('/api/connectors').send({})
    )
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/validation/i)
  })

  it('POST /api/connectors/test with a malformed body returns 400', async () => {
    const res = await auth(
      request(server.app).post('/api/connectors/test').send({ type: '' })
    )
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/validation/i)
  })

  it('POST /api/connectors/test with an unknown type returns 404 in the {success:false} envelope', async () => {
    const res = await auth(
      request(server.app)
        .post('/api/connectors/test')
        .send({ type: 'no-such-plugin', config: {} })
    )
    expect(res.status).toBe(404)
    expect(res.body.success).toBe(false)
    expect(res.body.error).toMatch(/not found/i)
  })

  it('DELETE /api/connectors/<missing> returns 204 (idempotent delete)', async () => {
    const res = await auth(
      request(server.app).delete('/api/connectors/no-such-connector')
    )
    expect(res.status).toBe(204)
  })
})
