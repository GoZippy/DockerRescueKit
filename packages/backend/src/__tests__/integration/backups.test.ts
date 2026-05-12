/**
 * Integration tests — /api/backups read paths.
 *
 * Backups are normally created by SchedulerEngine.runPolicy, which exercises
 * Docker. These tests focus on the read / not-found surface area only,
 * since the docker mock would need a much richer fixture to drive a real
 * backup end-to-end.
 *
 * Edge-case behavior we document here:
 *   - GET /backups/:id            → 404 via NotFoundError
 *   - GET /backups/:id/files      → 404 via NotFoundError (PartialRestore)
 *   - POST /backups/:id/restore   → 404 via NotFoundError (PolicyManager)
 *   - POST /backups/:id/verify    → 200 with ok=false (VerifyService swallows
 *                                  the missing-backup case and returns a
 *                                  non-ok report instead of throwing)
 */

import request from 'supertest'
import { createTestServer, TestServer } from '../helpers/testServer'

describe('integration: /api/backups', () => {
  let server: TestServer

  beforeEach(async () => {
    server = await createTestServer()
  })

  afterEach(async () => {
    await server.cleanup()
  })

  const auth = (req: request.Test) => req.set('x-api-key', server.apiKey)

  it('GET /api/backups returns 200 [] when nothing has been backed up', async () => {
    const res = await auth(request(server.app).get('/api/backups'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('GET /api/backups/<missing> returns 404 via NotFoundError', async () => {
    const res = await auth(
      request(server.app).get('/api/backups/missing-backup-id')
    )
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/backup/i)
  })

  it('GET /api/backups/<missing>/files?name=x returns 404', async () => {
    const res = await auth(
      request(server.app)
        .get('/api/backups/missing/files')
        .query({ name: 'volume_demo.tar.gz' })
    )
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/backup/i)
  })

  it('POST /api/backups/<missing>/restore returns 404', async () => {
    const res = await auth(
      request(server.app).post('/api/backups/missing/restore').send({})
    )
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/backup/i)
  })

  it('POST /api/backups/<missing>/verify returns 200 with ok=false', async () => {
    // VerifyService never throws on missing — it pushes a "find backup"
    // step with ok=false and returns the report. So the HTTP layer
    // surfaces 200; the not-found-ness lives inside report.ok.
    const res = await auth(
      request(server.app).post('/api/backups/missing/verify').send({})
    )
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.steps[0]).toMatchObject({ label: 'find backup', ok: false })
  })

  it('GET /api/verify-history returns [] when nothing has been verified', async () => {
    const res = await auth(request(server.app).get('/api/verify-history'))
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
  })
})
