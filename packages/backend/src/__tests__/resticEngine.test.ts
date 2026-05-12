import { EventEmitter } from 'events'
import { ResticEngine } from '../storage/engines/ResticEngine'

// Minimal mock of child_process.spawn so tests don't need the restic binary.
jest.mock('child_process', () => {
  const emitters: any[] = []
  return {
    __emitters: emitters,
    spawn: jest.fn((cmd: string, args: string[]) => {
      const e = new EventEmitter() as any
      e.stdout = new EventEmitter()
      e.stderr = new EventEmitter()
      e.stdin = new EventEmitter()
      e.stdin.write = () => true
      e.stdin.end = () => {}
      e._args = [cmd, ...args]
      emitters.push(e)
      // Emit async so awaiting tests can script responses.
      process.nextTick(() => {
        if (args[0] === 'version') {
          e.stdout.emit('data', Buffer.from('restic 0.16.0'))
          e.emit('close', 0)
        } else if (args[0] === 'init') {
          e.emit('close', 0)
        } else if (args[0] === 'snapshots') {
          e.stdout.emit('data', Buffer.from(JSON.stringify([
            { id: 'abc123', short_id: 'abc123', time: '2026-01-01T00:00:00Z', paths: ['/'], tags: ['drk:b1/vol.tar.gz'] }
          ])))
          e.emit('close', 0)
        } else if (args[0] === 'backup' && args.includes('--stdin')) {
          e.stdout.emit('data', Buffer.from(JSON.stringify({ message_type: 'summary', snapshot_id: 'deadbeef' })))
          e.emit('close', 0)
        } else if (args[0] === 'forget') {
          e.emit('close', 0)
        } else if (args[0] === 'stats') {
          e.stdout.emit('data', Buffer.from(JSON.stringify({ total_size: 1024, total_file_count: 3 })))
          e.emit('close', 0)
        } else {
          e.emit('close', 0)
        }
      })
      return e
    })
  }
})

describe('ResticEngine (mocked)', () => {
  const cfg = { repo: '/tmp/repo', password: 'secret' }
  const engine = new ResticEngine('restic')

  it('ensureAvailable succeeds when restic responds', async () => {
    await expect(engine.ensureAvailable()).resolves.toBeUndefined()
  })

  it('lists snapshots as parsed JSON', async () => {
    const snaps = await engine.listSnapshots(cfg)
    expect(snaps).toHaveLength(1)
    expect(snaps[0].short_id).toBe('abc123')
  })

  it('extracts snapshot_id from stdin backup output', async () => {
    const { Readable } = require('stream')
    const stream = Readable.from([Buffer.from('x')])
    const id = await engine.backupStdin(cfg, stream, 'vol.tar.gz', { tags: ['drk:b1/vol.tar.gz'] })
    expect(id).toBe('deadbeef')
  })

  it('returns stats', async () => {
    const s = await engine.stats(cfg)
    expect(s.total_size).toBe(1024)
  })
})
