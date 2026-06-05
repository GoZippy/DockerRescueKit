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

  // Fixtures use unrealistically-high versions on purpose: any number we put
  // here that overlaps the real package.json semver will rot the moment the
  // release commit bumps the version. Pinning to v99.x.x keeps this test
  // green across future bumps without further edits.

  it('reports updateAvailable: true when Hub has a newer semver tag', async () => {
    mockedAxios.get = jest.fn().mockResolvedValue({
      data: {
        results: [
          { name: 'v99.0.1' },
          { name: 'v99.0.0' },
        ],
      },
    })

    const app = buildApp()
    const res = await request(app).get('/api/version/check')

    expect(res.status).toBe(200)
    expect(res.body.updateAvailable).toBe(true)
    expect(res.body.latest).toBe('v99.0.1')
    expect(res.body.current).toBeDefined()
    expect(res.body.checkedAt).toBeDefined()
    expect(res.body.hubError).toBeUndefined()
  })

  it('reports updateAvailable: false when already on latest', async () => {
    // Use the actual current version so the route's semver comparison
    // resolves to false. Reads from package.json the same way the route does.
    const current = require('../../../package.json').version as string
    mockedAxios.get = jest.fn().mockResolvedValue({
      data: {
        results: [
          { name: `v${current}` },
        ],
      },
    })

    const app = buildApp()
    const res = await request(app).get('/api/version/check')

    expect(res.status).toBe(200)
    expect(res.body.updateAvailable).toBe(false)
    expect(res.body.latest).toBe(`v${current}`)
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
