import { PartialRestoreService } from '../services/PartialRestoreService'

// Exercise the tar -tzvf line parser directly. The parser is private, but we
// can reach it via an instance reflection for testing purposes.
describe('PartialRestoreService line parser', () => {
  const svc: any = new PartialRestoreService({} as any, '/tmp/staging')
  const parseTarLine = (svc as any).constructor.prototype
  // parseTarLine is a module-level helper in PartialRestoreService.ts, so
  // import it indirectly by writing our own parser that mirrors the shape.
  // Instead, assert PartialRestoreService construction doesn't throw and
  // smoke-test end-to-end behaviour via mocked spawn in a future pass.

  it('instantiates cleanly', () => {
    expect(svc).toBeInstanceOf(PartialRestoreService)
  })
})

import { spawn } from 'child_process'
import { EventEmitter } from 'events'

jest.mock('child_process', () => ({
  spawn: jest.fn((_cmd: string, _args: string[]) => {
    const e = new EventEmitter() as any
    e.stdout = new EventEmitter()
    e.stderr = new EventEmitter()
    e.stdin = new EventEmitter()
    process.nextTick(() => {
      // Fake output of `tar -tzvf`
      e.stdout.emit('data', Buffer.from([
        '-rw-r--r-- root/root        12 2026-04-01 10:00 ./hello.txt',
        'drwxr-xr-x root/root         0 2026-04-01 10:00 ./subdir/',
        '-rwxr-xr-x root/root        22 2026-04-01 10:00 ./subdir/run.sh'
      ].join('\n')))
      e.emit('close', 0)
    })
    return e
  })
}))

describe('PartialRestoreService.listEntries (with mocked tar)', () => {
  let svc: PartialRestoreService

  beforeEach(() => {
    const policyManager: any = {
      getBackup: jest.fn().mockResolvedValue({ id: 'b1', policyId: 'p1', status: 'success' }),
      getPolicy: jest.fn().mockResolvedValue({ id: 'p1', storage: { type: 'local', path: '/tmp/x' } })
    }
    svc = new PartialRestoreService(policyManager, '/tmp/drk-staging')
    // Short-circuit fetchToStaging to avoid touching a real adapter.
    ;(svc as any).fetchToStaging = jest.fn().mockResolvedValue('/tmp/drk-staging/b1/vol.tar.gz')
  })

  it('parses tar -tzvf output into entries', async () => {
    const entries = await svc.listEntries('b1', 'volume_foo.tar.gz')
    expect(entries).toHaveLength(3)
    expect(entries[0].path).toBe('./hello.txt')
    expect(entries[0].size).toBe(12)
    expect(entries[1].mode.startsWith('d')).toBe(true)
  })
})
