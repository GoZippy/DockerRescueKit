/**
 * CLI time-zone support: --timezone on policy:create / policy:update /
 * stack:protect, validation of the flag, and the policy:template example.
 * Same axios/fs mocking strategy as newCommands.test.ts.
 */

type Call = { method: string; url: string; body?: any }
const calls: Call[] = []

const fakeClient = {
  get: jest.fn(async (url: string) => { calls.push({ method: 'get', url }); return { data: {} } }),
  post: jest.fn(async (url: string, body?: any) => { calls.push({ method: 'post', url, body }); return { data: {} } }),
  put: jest.fn(async (url: string, body?: any) => { calls.push({ method: 'put', url, body }); return { data: {} } }),
  delete: jest.fn(async (url: string) => { calls.push({ method: 'delete', url }); return { data: {} } }),
}

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: () => fakeClient },
  create: () => fakeClient,
}))

import fs from 'fs'
jest.mock('fs')
const mockedFs = fs as jest.Mocked<typeof fs>

process.env.DRK_API_KEY = 'test-key'

import { findCommand } from '../commands'

function run(name: string, pos: string[] = [], flags: Record<string, string> = {}) {
  const cmd = findCommand(name)
  if (!cmd) throw new Error(`command not found: ${name}`)
  return cmd.run(pos, flags)
}

let stdout: jest.SpyInstance
let stderr: jest.SpyInstance
let exit: jest.SpyInstance

beforeEach(() => {
  calls.length = 0
  jest.clearAllMocks()
  stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
  // The commands call process.exit(2) on bad input; turn that into a throw we can assert.
  exit = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`) }) as any)
})

afterEach(() => {
  stdout.mockRestore()
  stderr.mockRestore()
  exit.mockRestore()
})

describe('policy:create --timezone', () => {
  it('sends the body untouched when no flag is given (the server then defaults to UTC)', async () => {
    const policy = { name: 'p', targets: [], schedule: '0 2 * * *' }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(policy) as any)
    await run('policy:create', ['p.json'])
    expect(calls).toEqual([{ method: 'post', url: '/policies', body: policy }])
    expect(calls[0].body.timezone).toBeUndefined()
  })

  it('passes a timezone from the JSON file through', async () => {
    const policy = { name: 'p', schedule: '0 2 * * *', timezone: 'Europe/London' }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(policy) as any)
    await run('policy:create', ['p.json'])
    expect(calls[0].body.timezone).toBe('Europe/London')
  })

  it('--timezone adds the zone, and overrides one in the file', async () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ name: 'p', timezone: 'UTC' }) as any)
    await run('policy:create', ['p.json'], { timezone: 'America/Chicago' })
    expect(calls[0].body).toEqual({ name: 'p', timezone: 'America/Chicago' })
  })

  it.each(['Mars/Base', '+05:00', 'Central'])('rejects --timezone %s before any request', async tz => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ name: 'p' }) as any)
    await expect(run('policy:create', ['p.json'], { timezone: tz })).rejects.toThrow('exit:2')
    expect(calls).toEqual([])
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('--timezone must be an IANA zone name'))
  })
})

describe('policy:update --timezone', () => {
  it('moves a policy to the given zone', async () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ enabled: true }) as any)
    await run('policy:update', ['pol-1', 'patch.json'], { timezone: 'America/Chicago' })
    expect(calls).toEqual([{ method: 'put', url: '/policies/pol-1', body: { enabled: true, timezone: 'America/Chicago' } }])
  })

  it('leaves the zone alone without the flag', async () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ enabled: false }) as any)
    await run('policy:update', ['pol-1', 'patch.json'])
    expect(calls[0].body).toEqual({ enabled: false })
  })
})

describe('stack:protect --timezone', () => {
  it('sends no body without the flag (server: UTC)', async () => {
    await run('stack:protect', ['web'])
    expect(calls).toEqual([{ method: 'post', url: '/docker/stacks/web/protect', body: undefined }])
  })

  it('sends the zone when given', async () => {
    await run('stack:protect', ['web'], { timezone: 'America/Chicago' })
    expect(calls[0].body).toEqual({ timezone: 'America/Chicago' })
  })

  it('rejects an invalid zone before any request', async () => {
    await expect(run('stack:protect', ['web'], { timezone: 'nope' })).rejects.toThrow('exit:2')
    expect(calls).toEqual([])
  })
})

describe('policy:template', () => {
  it('shows a timezone, explains it, and still parses as a valid body', async () => {
    const writes: string[] = []
    stdout.mockImplementation((chunk: any) => { writes.push(String(chunk)); return true })
    await run('policy:template')
    const parsed = JSON.parse(writes.join(''))
    expect(parsed.schedule).toBe('0 2 * * *')
    expect(parsed.timezone).toBe('UTC')
    expect(parsed._comment_timezone).toMatch(/IANA/)
    expect(parsed._comment_schedule).toMatch(/timezone/)
  })
})
