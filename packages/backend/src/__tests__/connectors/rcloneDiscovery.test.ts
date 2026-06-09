/**
 * D3-rclone-discovery unit tests.
 * Mocks child_process.execFile so we don't need a real rclone binary on the
 * test host. Integration tests against the docker-compose rclone container
 * live in __tests__/integration/ and are gated on CI_INTEGRATION=1.
 */
import { RcloneConnector } from '../../connectors/RcloneConnector'

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}))

import { execFile } from 'child_process'
const execFileMock = execFile as unknown as jest.Mock

function mockExecFile(stdout: string, stderr: string = '', err: any = null) {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
    process.nextTick(() => cb(err, { stdout, stderr }))
  })
}

function mockExecFileError(err: any) {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
    process.nextTick(() => cb(err, { stdout: '', stderr: err?.stderr ?? '' }))
  })
}

describe('RcloneConnector.discoverDestinations', () => {
  const connector = new RcloneConnector()
  const baseConfig = { remote: 'gdrive', path: 'backups' }

  beforeEach(() => execFileMock.mockReset())

  it('throws when remote is missing', async () => {
    await expect(connector.discoverDestinations({} as any)).rejects.toThrow(/requires config.remote/)
  })

  it('returns ConnectorResource[] for each directory entry', async () => {
    mockExecFile(JSON.stringify([
      { Name: 'daily', Path: 'daily', IsDir: true, ModTime: '2026-05-29T10:00:00Z' },
      { Name: 'weekly', Path: 'weekly', IsDir: true, ModTime: '2026-05-29T11:00:00Z' },
    ]))

    const results = await connector.discoverDestinations(baseConfig)

    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({
      name: 'daily',
      type: 'rclone-dir',
      path: 'backups/daily',
      metadata: { remote: 'gdrive', modTime: '2026-05-29T10:00:00Z' }
    })
    expect(results[1].name).toBe('weekly')
  })

  it('filters out non-directory entries even if rclone returns them', async () => {
    mockExecFile(JSON.stringify([
      { Name: 'folder', Path: 'folder', IsDir: true },
      { Name: 'file.txt', Path: 'file.txt', IsDir: false },
    ]))

    const results = await connector.discoverDestinations(baseConfig)
    expect(results.map(r => r.name)).toEqual(['folder'])
  })

  it('handles empty path config (root of remote)', async () => {
    mockExecFile(JSON.stringify([{ Name: 'top', Path: 'top', IsDir: true }]))

    const results = await connector.discoverDestinations({ remote: 'gdrive' })

    expect(results[0].path).toBe('top')
  })

  it('translates rclone non-zero exit into a meaningful error', async () => {
    mockExecFileError({
      message: 'Command failed',
      code: 1,
      stderr: 'CRITICAL: Failed to create file system: didn\'t find section',
    })

    await expect(connector.discoverDestinations(baseConfig)).rejects.toThrow(/rclone lsjson failed/)
  })

  it('translates rclone timeout into a meaningful error', async () => {
    mockExecFileError({ killed: true, signal: 'SIGTERM' })

    await expect(connector.discoverDestinations(baseConfig)).rejects.toThrow(/timed out after 30s/)
  })

  it('rejects malformed JSON from rclone', async () => {
    mockExecFile('this is not json')

    await expect(connector.discoverDestinations(baseConfig)).rejects.toThrow(/non-JSON output/)
  })

  it('passes RCLONE_CONFIG env when configured', async () => {
    mockExecFile('[]')

    await connector.discoverDestinations({ ...baseConfig, rcloneConfig: '/etc/rclone.conf' })

    const callArgs = execFileMock.mock.calls[0]
    const opts = callArgs[2]
    expect(opts.env.RCLONE_CONFIG).toBe('/etc/rclone.conf')
  })

  it('rejects malformed remote names at the boundary (defense in depth)', async () => {
    // The regex check is belt-and-braces — execFile already prevents shell
    // injection, but the regex stops a bogus config at the validation
    // boundary and protects against any future refactor that switches to
    // shell:true.
    await expect(
      connector.discoverDestinations({ remote: 'evil$(rm -rf /)', path: 'x' })
    ).rejects.toThrow(/Rclone remote name must match/)
  })

  it('invokes rclone with execFile (not exec) for a valid remote', async () => {
    mockExecFile('[]')

    await connector.discoverDestinations({ remote: 'gdrive_backups', path: 'x' })

    const callArgs = execFileMock.mock.calls[0]
    const cmd = callArgs[0]
    const args = callArgs[1]
    expect(cmd).toBe('rclone')
    expect(Array.isArray(args)).toBe(true)
    // The remote name is passed as an argv element — never to a shell.
    expect(args.join(' ')).toContain('gdrive_backups:x')
  })

  it('forwards via deprecated discoverResources() for route-layer back-compat', async () => {
    mockExecFile(JSON.stringify([{ Name: 'd', Path: 'd', IsDir: true }]))

    const viaDeprecated = await connector.discoverResources(baseConfig)
    expect(viaDeprecated).toHaveLength(1)
  })
})
