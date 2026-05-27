/**
 * Tests for GET /api/version/check — v1.2.2 update-check route.
 *
 * Mounts the route with supertest and mocks axios to avoid real Docker Hub
 * calls.  Verifies happy path, already-latest, Hub failure, and tag-filtering
 * behaviour.
 */

import express from 'express'
import request from 'supertest'
import axios from 'axios'
import { mountVersionRoutes } from '../../routes/version'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

const fakeSettings = {} as any

function buildApp() {
  const app = express()
  app.use(express.json())
  mountVersionRoutes(app, { settings: fakeSettings })
  return app
}

// ---------------------------------------------------------------------------

describe('GET /api/version/check', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('reports updateAvailable: true when Hub has a newer semver tag', async () => {
    mockedAxios.get = jest.fn().mockResolvedValue({
      data: {
        results: [
          { name: 'v1.2.3' },
          { name: 'v1.2.2' },
        ],
      },
    })

    const app = buildApp()
    const res = await request(app).get('/api/version/check')

    expect(res.status).toBe(200)
    expect(res.body.updateAvailable).toBe(true)
    expect(res.body.latest).toBe('v1.2.3')
    expect(res.body.current).toBeDefined()
    expect(res.body.checkedAt).toBeDefined()
    expect(res.body.hubError).toBeUndefined()
  })

  it('reports updateAvailable: false when already on latest', async () => {
    mockedAxios.get = jest.fn().mockResolvedValue({
      data: {
        results: [
          { name: 'v1.2.2' },
        ],
      },
    })

    const app = buildApp()
    const res = await request(app).get('/api/version/check')

    expect(res.status).toBe(200)
    expect(res.body.updateAvailable).toBe(false)
    expect(res.body.latest).toBe('v1.2.2')
  })

  it('returns hubError instead of throwing when Hub is unreachable', async () => {
    mockedAxios.get = jest.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND hub.docker.com'))

    const app = buildApp()
    const res = await request(app).get('/api/version/check')

    expect(res.status).toBe(200)
    expect(res.body.updateAvailable).toBe(false)
    expect(res.body.latest).toBeNull()
    expect(res.body.hubError).toContain('ENOTFOUND')
  })

  it('ignores non-semver tags like "latest"', async () => {
    mockedAxios.get = jest.fn().mockResolvedValue({
      data: {
        results: [
          { name: 'latest' },
          { name: 'v1.2.2' },
        ],
      },
    })

    const app = buildApp()
    const res = await request(app).get('/api/version/check')

    expect(res.status).toBe(200)
    expect(res.body.updateAvailable).toBe(false)
    expect(res.body.latest).toBe('v1.2.2')
  })
})
