/**
 * Coverage for the day-0 setup commands added for the v1.4 CLI gap-fill:
 * policy:create/update/template, connector:create/discover,
 * config:export/import, license:status/activate, health.
 *
 * Strategy: mock axios so every command's HTTP call is captured as
 * { method, url, body }, and mock `fs` so the file-reading commands don't
 * touch disk. We assert the exact endpoint, verb, and request body each
 * command sends — the same contract the backend routers expose.
 */

// ---- axios mock -------------------------------------------------------------
// createClient() calls axios.create() and then client.get/post/put/delete.
// We record every call and return a canned response per command.

type Call = { method: string; url: string; body?: any; config?: any }
const calls: Call[] = []
let nextResponse: any = { data: {} }

function setResponse(data: any) {
  nextResponse = { data }
}

const fakeClient = {
  get: jest.fn(async (url: string, config?: any) => {
    calls.push({ method: 'get', url, config })
    return nextResponse
  }),
  post: jest.fn(async (url: string, body?: any) => {
    calls.push({ method: 'post', url, body })
    return nextResponse
  }),
  put: jest.fn(async (url: string, body?: any) => {
    calls.push({ method: 'put', url, body })
    return nextResponse
  }),
  delete: jest.fn(async (url: string) => {
    calls.push({ method: 'delete', url })
    return nextResponse
  }),
}

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: () => fakeClient },
  create: () => fakeClient,
}))

// ---- fs mock ----------------------------------------------------------------
import fs from 'fs'
jest.mock('fs')
const mockedFs = fs as jest.Mocked<typeof fs>

// API key so resolveConfig() doesn't throw.
process.env.DRK_API_KEY = 'test-key'

import { findCommand } from '../commands'

function run(name: string, pos: string[] = [], flags: Record<string, string> = {}) {
  const cmd = findCommand(name)
  if (!cmd) throw new Error(`command not found: ${name}`)
  return cmd.run(pos, flags)
}

beforeEach(() => {
  calls.length = 0
  nextResponse = { data: {} }
  jest.clearAllMocks()
})

describe('policy setup commands', () => {
  it('policy:create reads the file and POSTs /policies', async () => {
    const policy = { name: 'p', targets: [], schedule: '0 2 * * *' }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(policy) as any)
    setResponse({ id: 'pol-123', ...policy })

    const code = await run('policy:create', ['policy.json'])

    expect(code).toBe(0)
    expect(calls).toEqual([{ method: 'post', url: '/policies', body: policy }])
  })

  it('policy:update reads the file and PUTs /policies/:id', async () => {
    const patch = { enabled: false }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(patch) as any)
    setResponse({ id: 'pol-9', enabled: false })

    const code = await run('policy:update', ['pol-9', 'patch.json'])

    expect(code).toBe(0)
    expect(calls).toEqual([{ method: 'put', url: '/policies/pol-9', body: patch }])
  })

  it('policy:template prints parseable JSON and makes no HTTP call', async () => {
    const writes: string[] = []
    const spy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: any) => { writes.push(String(chunk)); return true })

    const code = await run('policy:template')
    spy.mockRestore()

    expect(code).toBe(0)
    expect(calls).toEqual([])
    const parsed = JSON.parse(writes.join(''))
    expect(parsed.name).toBeDefined()
    expect(parsed.backupType).toBeDefined()
    expect(Array.isArray(parsed.targets)).toBe(true)
  })
})

describe('connector setup commands', () => {
  it('connector:create POSTs the file body to /connectors', async () => {
    const conn = { type: 's3', name: 'wasabi', config: { endpoint: 'x' } }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(conn) as any)
    setResponse({ success: true })

    const code = await run('connector:create', ['conn.json'])

    expect(code).toBe(0)
    expect(calls).toEqual([{ method: 'post', url: '/connectors', body: conn }])
  })

  it('connector:discover POSTs to /connectors/discover and injects --mode', async () => {
    const body = { type: 's3', config: { endpoint: 'x' } }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(body) as any)
    setResponse([])

    const code = await run('connector:discover', ['conn.json'], { mode: 'contents' })

    expect(code).toBe(0)
    expect(calls).toEqual([
      { method: 'post', url: '/connectors/discover', body: { ...body, mode: 'contents' } },
    ])
  })
})

describe('config export / import', () => {
  it('config:export with an outfile GETs /config/export and writes the file', async () => {
    setResponse({ schemaVersion: '2', policies: [] })

    const code = await run('config:export', ['out.json'])

    expect(code).toBe(0)
    expect(calls).toEqual([{ method: 'get', url: '/config/export', config: undefined }])
    expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(1)
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      'out.json',
      expect.stringContaining('"schemaVersion"')
    )
  })

  it('config:import without --apply only previews', async () => {
    const payload = { schemaVersion: '2', policies: [] }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(payload) as any)
    setResponse({ confirmationToken: 'tok-1', counts: {}, warnings: [] })

    const code = await run('config:import', ['cfg.json'])

    expect(code).toBe(0)
    expect(calls).toEqual([
      { method: 'post', url: '/config/import?mode=preview', body: { mode: 'json', payload } },
    ])
  })

  it('config:import --apply previews then applies with the token', async () => {
    const payload = { schemaVersion: '2', policies: [] }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(payload) as any)
    // First call (preview) returns the token; second call (apply) is what we
    // assert succeeded. fakeClient returns nextResponse for both, so set it to
    // a value that satisfies both: confirmationToken for preview + applied=true.
    setResponse({ confirmationToken: 'tok-77', applied: true })

    const code = await run('config:import', ['cfg.json'], { apply: '' })

    expect(code).toBe(0)
    expect(calls).toEqual([
      { method: 'post', url: '/config/import?mode=preview', body: { mode: 'json', payload } },
      { method: 'post', url: '/config/import?mode=apply', body: { token: 'tok-77' } },
    ])
  })
})

describe('license commands', () => {
  it('license:status GETs /license', async () => {
    setResponse({ tier: 'free', features: [] })

    const code = await run('license:status')

    expect(code).toBe(0)
    expect(calls).toEqual([{ method: 'get', url: '/license', config: undefined }])
  })

  it('license:activate POSTs a bare token string when the arg is not a file', async () => {
    mockedFs.existsSync.mockReturnValue(false)
    setResponse({ tier: 'commercial-pro' })

    const code = await run('license:activate', ['eyJhbG.token.value'])

    expect(code).toBe(0)
    expect(calls).toEqual([
      { method: 'post', url: '/license/activate', body: { token: 'eyJhbG.token.value' } },
    ])
  })

  it('license:activate reads the token from a file when the arg is a path', async () => {
    mockedFs.existsSync.mockReturnValue(true)
    mockedFs.statSync.mockReturnValue({ isFile: () => true } as any)
    mockedFs.readFileSync.mockReturnValue('  file-token\n' as any)
    setResponse({ tier: 'personal-pro' })

    const code = await run('license:activate', ['token.txt'])

    expect(code).toBe(0)
    expect(calls).toEqual([
      { method: 'post', url: '/license/activate', body: { token: 'file-token' } },
    ])
  })
})

describe('health command', () => {
  it('health GETs /health/dashboard', async () => {
    setResponse({ score: 80 })

    const code = await run('health')

    expect(code).toBe(0)
    expect(calls).toEqual([{ method: 'get', url: '/health/dashboard', config: undefined }])
  })
})
