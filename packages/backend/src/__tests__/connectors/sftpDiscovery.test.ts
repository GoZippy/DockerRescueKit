/**
 * D2-sftp-discovery unit tests. Mocks ssh2 Client so we don't need an SFTP
 * server during unit testing. Integration tests against the openssh-server
 * docker-compose container are gated on CI_INTEGRATION=1.
 */
import { EventEmitter } from 'events'

// Module-level test state — set per-test to drive the fake Client.
const mockState: {
  capturedOpts: any | null
  readdirImpl: ((path: string, cb: (err: any, list: any[]) => void) => void) | null
  emitError: Error | null
  capturedClient: FakeClient | null
} = {
  capturedOpts: null,
  readdirImpl: null,
  emitError: null,
  capturedClient: null,
}

class FakeClient extends EventEmitter {
  end() {}
  sftp(cb: (err: any, sftp: any) => void) {
    cb(null, {
      readdir: (path: string, rcb: (err: any, list: any[]) => void) => {
        if (mockState.readdirImpl) mockState.readdirImpl(path, rcb)
        else rcb(null, [])
      }
    })
  }
  connect(opts: any) {
    mockState.capturedOpts = opts
    mockState.capturedClient = this
    process.nextTick(() => {
      if (mockState.emitError) this.emit('error', mockState.emitError)
      else this.emit('ready')
    })
    return this
  }
}

jest.mock('ssh2', () => ({
  Client: FakeClient,
}))

import { SFTPConnector } from '../../connectors/SFTPConnector'

describe('SFTPConnector.discoverDestinations', () => {
  const connector = new SFTPConnector()
  const baseConfig = {
    host: 'sftp.example.com',
    username: 'drk',
    sshPassword: 'pw',
    path: '/srv/backups',
  }

  beforeEach(() => {
    mockState.capturedOpts = null
    mockState.readdirImpl = null
    mockState.emitError = null
    mockState.capturedClient = null
  })

  it('throws when required fields are missing', async () => {
    await expect(connector.discoverDestinations({ host: 'x', username: 'u' } as any))
      .rejects.toThrow(/path/)
  })

  it('returns ConnectorResource[] for each readdir entry', async () => {
    mockState.readdirImpl = (path, cb) => {
      expect(path).toBe(baseConfig.path)
      cb(null, [
        { filename: 'daily', attrs: { size: 4096, mode: 16877, mtime: 1700000000 } },
        { filename: 'weekly', attrs: { size: 4096, mode: 16877, mtime: 1700000001 } },
      ])
    }

    const results = await connector.discoverDestinations(baseConfig)

    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({
      name: 'daily',
      type: 'sftp-dir',
      path: '/srv/backups/daily',
      size: 4096,
    })
    expect(results[0].metadata).toMatchObject({ host: 'sftp.example.com' })
  })

  it('handles empty directory', async () => {
    mockState.readdirImpl = (_p, cb) => cb(null, [])

    const results = await connector.discoverDestinations(baseConfig)

    expect(results).toEqual([])
  })

  it('surfaces connection errors with context', async () => {
    mockState.emitError = new Error('All configured authentication methods failed')

    await expect(connector.discoverDestinations(baseConfig))
      .rejects.toThrow(/SFTP discovery failed.*All configured authentication methods failed/)
  })

  it('uses port 22 by default', async () => {
    mockState.readdirImpl = (_p, cb) => cb(null, [])

    await connector.discoverDestinations(baseConfig)

    expect(mockState.capturedOpts.port).toBe(22)
  })

  it('uses configured custom port', async () => {
    mockState.readdirImpl = (_p, cb) => cb(null, [])

    await connector.discoverDestinations({ ...baseConfig, port: 2222 })

    expect(mockState.capturedOpts.port).toBe(2222)
  })

  it('forwards via deprecated discoverResources() for route-layer back-compat', async () => {
    mockState.readdirImpl = (_p, cb) => cb(null, [
      { filename: 'd', attrs: { size: 0, mode: 16877, mtime: 0 } }
    ])

    const results = await connector.discoverResources(baseConfig)
    expect(results).toHaveLength(1)
  })
})
