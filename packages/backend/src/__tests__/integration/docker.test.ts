/**
 * Integration tests — /api/docker/* graceful-degradation.
 *
 * The DockerService stub in helpers/testServer rejects every list call with
 * `{ code: 'ENOENT' }`. The route layer maps that to 503 with the shape
 * `{ error, offline: true, code: 'ENOENT' }` so the UI can render an
 * "install docker" banner instead of a generic failure.
 */

import request from 'supertest'
import { createTestServer, TestServer } from '../helpers/testServer'

describe('integration: /api/docker (offline)', () => {
  let server: TestServer

  beforeEach(async () => {
    server = await createTestServer()
  })

  afterEach(async () => {
    await server.cleanup()
  })

  const auth = (req: request.Test) => req.set('x-api-key', server.apiKey)

  const offlineRoutes = [
    '/api/docker/containers',
    '/api/docker/volumes',
    '/api/docker/stacks',
    '/api/docker/images',
    '/api/docker/networks',
  ]

  for (const route of offlineRoutes) {
    it(`GET ${route} returns 503 with offline=true, code=ENOENT`, async () => {
      const res = await auth(request(server.app).get(route))
      expect(res.status).toBe(503)
      expect(res.body.offline).toBe(true)
      expect(res.body.code).toBe('ENOENT')
      expect(res.body.error).toMatch(/docker/i)
    })
  }
})
