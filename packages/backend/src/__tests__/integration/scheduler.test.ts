/**
 * Integration tests — pause / resume scheduler + status reflection.
 */

import request from 'supertest'
import { createTestServer, TestServer } from '../helpers/testServer'

describe('integration: scheduler pause/resume', () => {
  let server: TestServer

  beforeEach(async () => {
    server = await createTestServer()
  })

  afterEach(async () => {
    await server.cleanup()
  })

  const auth = (req: request.Test) => req.set('x-api-key', server.apiKey)

  it('POST /api/scheduler/pause sets paused=true and is reflected in /api/status', async () => {
    const pause = await auth(
      request(server.app).post('/api/scheduler/pause').send({})
    )
    expect(pause.status).toBe(200)
    expect(pause.body.paused).toBe(true)

    const status = await auth(request(server.app).get('/api/status'))
    expect(status.status).toBe(200)
    expect(status.body.paused).toBe(true)
    // Docker is mocked offline.
    expect(status.body.docker).toBe(false)
  })

  it('POST /api/scheduler/resume clears paused', async () => {
    await auth(request(server.app).post('/api/scheduler/pause').send({}))

    const resume = await auth(
      request(server.app).post('/api/scheduler/resume').send({})
    )
    expect(resume.status).toBe(200)
    expect(resume.body.paused).toBe(false)

    const status = await auth(request(server.app).get('/api/status'))
    expect(status.body.paused).toBe(false)
  })
})
