import { EventEmitter } from 'events'

jest.mock('child_process', () => ({
  spawn: jest.fn((cmd: string, args: string[]) => {
    const e = new EventEmitter() as any
    e.stdout = new EventEmitter()
    e.stderr = new EventEmitter()
    e.stdin = new EventEmitter()
    process.nextTick(() => {
      if (args[0] === 'snapshots') {
        // proxmox-backup-client snapshots output: <type>/<id>/<backup-time>  <timestamp>  <size>
        e.stdout.emit('data', Buffer.from('  backup/vm/100/2026-04-25T02:00:00Z  2026-04-25T02:00:00Z  123456\n'))
        e.emit('close', 0)
      } else if (args[0] === 'backup') {
        e.emit('close', 0)
      } else if (args[0] === 'status') {
        e.stdout.emit('data', Buffer.from('total: 100 GB\nused: 42 GB\n'))
        e.emit('close', 0)
      } else {
        e.emit('close', 0)
      }
    })
    return e
  })
}))

import { PBSStorageAdapter } from '../storage/adapters/PBSStorageAdapter'

describe('PBSStorageAdapter', () => {
  const cfg = { type: 'pbs', repo: 'backup@pam@192.168.1.50:8007:docker', password: 'secret' }
  const adapter = new PBSStorageAdapter(cfg as any)

  it('lists snapshots from PBS output', async () => {
    const snaps = await adapter.list()
    expect(snaps).toHaveLength(1)
    expect(snaps[0].id).toContain('backup/vm/100')
    expect(snaps[0].timestamp).toBeInstanceOf(Date)
  })

  it('parses getInfo from status output', async () => {
    const info = await adapter.getInfo()
    expect(info.type).toBe('proxmox-backup-server')
    expect(info.total).toBeGreaterThan(0)
  })
})
