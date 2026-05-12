import { SchedulerEngine } from '../scheduler/SchedulerEngine'
import type { Backup, RetentionPolicy } from '@docker-rescue-kit/shared'

const engine = new SchedulerEngine({} as any)

function mkBackup(id: string, ageDays: number, tags: string[] = ['daily']): Backup {
  const t = new Date()
  t.setDate(t.getDate() - ageDays)
  return {
    id,
    policyId: 'p1',
    timestamp: t,
    type: 'full',
    status: 'success',
    size: 1024,
    duration: 1000,
    targets: [],
    tags
  }
}

describe('SchedulerEngine.calculateRetention', () => {
  it('count strategy keeps N most-recent', () => {
    const backups = [
      mkBackup('a', 1),
      mkBackup('b', 2),
      mkBackup('c', 3),
      mkBackup('d', 4),
      mkBackup('e', 5)
    ]
    const retention: RetentionPolicy = { strategy: 'count', count: 2 }
    const toDelete = engine.calculateRetention(backups, retention)
    expect(toDelete.sort()).toEqual(['c', 'd', 'e'])
  })

  it('time strategy drops backups older than the window', () => {
    const backups = [
      mkBackup('a', 1),
      mkBackup('b', 10),
      mkBackup('c', 100)
    ]
    const retention: RetentionPolicy = { strategy: 'time', days: 7 }
    const toDelete = engine.calculateRetention(backups, retention)
    expect(toDelete.sort()).toEqual(['b', 'c'])
  })

  it('tiered strategy keeps per-tier maxCount across tags', () => {
    const backups = [
      mkBackup('d1', 0, ['daily']),
      mkBackup('d2', 1, ['daily']),
      mkBackup('d3', 2, ['daily']),
      mkBackup('d4', 3, ['daily']),
      mkBackup('w1', 7, ['daily', 'weekly']),
      mkBackup('w2', 14, ['daily', 'weekly']),
      mkBackup('w3', 21, ['daily', 'weekly'])
    ]
    const retention: RetentionPolicy = {
      strategy: 'tiered',
      tiers: [
        { tag: 'daily', maxCount: 3 },
        { tag: 'weekly', maxCount: 2 }
      ]
    }
    const toDelete = engine.calculateRetention(backups, retention)
    // daily tier keeps 3 most-recent dailies: d1, d2, d3
    // weekly tier keeps 2 most-recent weeklies: w1, w2
    // d4 and w3 should be deleted.
    expect(toDelete.sort()).toEqual(['d4', 'w3'])
  })

  it('returns empty for unknown retention strategies', () => {
    const toDelete = engine.calculateRetention([mkBackup('a', 1)], { strategy: 'count' } as any)
    expect(toDelete).toEqual([])
  })
})
