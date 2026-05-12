/**
 * Integration tests — Phase 8 socket transport.
 *
 * When DRK_TRANSPORT=socket, the backend is expected to:
 *   1. Bind a Unix domain socket at DRK_SOCKET_PATH (instead of TCP :42880).
 *   2. Skip the /api/* API-key auth middleware entirely — the Docker Desktop
 *      guest-services IPC bridge already scopes the socket, so re-authing
 *      with x-api-key is redundant (and the extension SDK can't attach one).
 *   3. Keep /healthz public, same as the TCP transport.
 *
 * We don't actually need to dial the socket for these tests — supertest
 * accepts the bare Express app, which exercises the full middleware stack
 * including the transport-aware auth bypass. The actual bind is covered by
 * an `app.listen({ path })` smoke test at the bottom (skipped on Windows
 * because Node's Unix-domain-socket support there is unreliable).
 */

import os from 'os'
import path from 'path'
import fs from 'fs-extra'
import http from 'http'
import { v4 as uuidv4 } from 'uuid'
import request from 'supertest'

// Mock DockerService + dockerode the same way testServer.ts does — we don't
// want the BackupService constructor to try to talk to the real socket.
jest.mock('../../services/DockerService', () => ({
  DockerService: jest.fn().mockImplementation(() => ({
    ping: jest.fn().mockResolvedValue(false),
    listContainers: jest.fn().mockRejectedValue(
      Object.assign(new Error('no docker'), { code: 'ENOENT' })
    ),
    listVolumes: jest.fn().mockRejectedValue(
      Object.assign(new Error('no docker'), { code: 'ENOENT' })
    ),
    listComposeStacks: jest.fn().mockRejectedValue(
      Object.assign(new Error('no docker'), { code: 'ENOENT' })
    ),
    listImages: jest.fn().mockRejectedValue(
      Object.assign(new Error('no docker'), { code: 'ENOENT' })
    ),
    listNetworks: jest.fn().mockRejectedValue(
      Object.assign(new Error('no docker'), { code: 'ENOENT' })
    ),
    exportVolume: jest.fn().mockResolvedValue(undefined),
    exportContainer: jest.fn().mockResolvedValue(undefined),
    exportImage: jest.fn().mockResolvedValue(undefined),
    exportNetwork: jest.fn().mockResolvedValue(undefined),
    importVolume: jest.fn().mockResolvedValue(undefined),
    importImage: jest.fn().mockResolvedValue(undefined),
    importNetwork: jest.fn().mockResolvedValue('mock-net'),
  })),
}))

jest.mock('dockerode', () => {
  return jest.fn().mockImplementation(() => ({
    ping: jest.fn(),
    listContainers: jest.fn(),
    listVolumes: jest.fn(),
    listImages: jest.fn(),
    listNetworks: jest.fn(),
  }))
})

describe('integration: socket transport (DRK_TRANSPORT=socket)', () => {
  let service: any
  let dataDir: string
  let socketPath: string
  const prevEnv = {
    transport: process.env.DRK_TRANSPORT,
    socketPath: process.env.DRK_SOCKET_PATH,
    dataDir: process.env.DRK_DATA_DIR,
    dbPath: process.env.DB_PATH,
  }

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `drk-sock-test-${uuidv4()}`)
    await fs.ensureDir(dataDir)
    socketPath = path.join(dataDir, 'drk.sock')

    // Must be set BEFORE the module is required — the TRANSPORT constant is
    // captured at module-load time.
    process.env.DRK_TRANSPORT = 'socket'
    process.env.DRK_SOCKET_PATH = socketPath
    process.env.DRK_DATA_DIR = dataDir

    // jest.isolateModules forces a fresh load of index.ts so the TRANSPORT
    // module constant picks up the env we just set, even if another test
    // file in the same worker already imported it under TCP mode.
    jest.isolateModules(() => {
      // Match testServer.ts ordering: delete DB_PATH AFTER require so the
      // dotenv.config() inside index.ts can't repopulate it from .env.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { BackupService } = require('../../index')
      delete process.env.DB_PATH
      service = new BackupService()
    })
  })

  afterEach(async () => {
    try {
      const inner = service?.db?.db
      if (inner && typeof inner.close === 'function') inner.close()
    } catch { /* ignore */ }
    try {
      service?.scheduler?.stop?.()
    } catch { /* ignore */ }
    try {
      if (service?.httpServer) {
        await new Promise<void>((resolve) => service.httpServer.close(() => resolve()))
      }
    } catch { /* ignore */ }
    await fs.remove(socketPath).catch(() => { /* ignore */ })
    await fs.remove(dataDir).catch(() => { /* ignore */ })

    // Restore env so subsequent test files default back to TCP.
    if (prevEnv.transport === undefined) delete process.env.DRK_TRANSPORT
    else process.env.DRK_TRANSPORT = prevEnv.transport
    if (prevEnv.socketPath === undefined) delete process.env.DRK_SOCKET_PATH
    else process.env.DRK_SOCKET_PATH = prevEnv.socketPath
    if (prevEnv.dataDir === undefined) delete process.env.DRK_DATA_DIR
    else process.env.DRK_DATA_DIR = prevEnv.dataDir
    if (prevEnv.dbPath === undefined) delete process.env.DB_PATH
    else process.env.DB_PATH = prevEnv.dbPath
  })

  it('GET /api/status returns 200 with NO x-api-key header (socket bypasses auth)', async () => {
    const res = await request(service.app).get('/api/status')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('online')
    // DockerService.ping is mocked to resolve(false).
    expect(res.body.docker).toBe(false)
  })

  it('GET /healthz returns 200', async () => {
    const res = await request(service.app).get('/healthz')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(typeof res.body.uptime).toBe('number')
  })

  // Smoke test the actual bind. Unix-domain-socket support on Windows via
  // Node is patchy (named-pipe emulation that won't accept arbitrary tmp
  // paths), so we skip there — the auth-bypass behaviour above is the
  // load-bearing assertion and runs everywhere.
  const itUnix = process.platform === 'win32' ? it.skip : it
  itUnix('binds an actual Unix socket and serves /healthz over it', async () => {
    await new Promise<void>((resolve) => {
      service.httpServer = service.app.listen({ path: socketPath }, () => resolve())
    })

    const body: string = await new Promise((resolve, reject) => {
      const req = http.request(
        { socketPath, path: '/healthz', method: 'GET' },
        (res) => {
          let buf = ''
          res.on('data', (c) => { buf += c })
          res.on('end', () => resolve(buf))
        }
      )
      req.on('error', reject)
      req.end()
    })
    const parsed = JSON.parse(body)
    expect(parsed.status).toBe('ok')
  })
})
