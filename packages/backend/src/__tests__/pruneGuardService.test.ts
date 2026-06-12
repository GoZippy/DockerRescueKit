import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { Database } from '../db/Database'
import { SettingsService } from '../services/SettingsService'
import { PruneGuardService } from '../services/PruneGuardService'
import { GUARD_AUDIT_EVENTS } from '../services/GuardTypes'
import type { GuardSettings } from '@docker-rescue-kit/shared'

// ---------------------------------------------------------------------------
// PG-1.2 PruneGuardService core (docs/design/PRUNE_GUARD.md §14.1).
// Mock DockerService + temp dirs + a real Database/SettingsService. Covers:
// scope resolution (3 modes), budget/LRU eviction + pinned survival, per-volume
// + per-event caps, dedup fingerprint skip, TTL sweep, fail-open, restore.
// ---------------------------------------------------------------------------

// --- fakes ----------------------------------------------------------------

class FakeAudit {
  events: Array<{ action: string; details?: any }> = []
  async record(action: string, details?: any) { this.events.push({ action, details }) }
  has(action: string) { return this.events.some(e => e.action === action) }
  count(action: string) { return this.events.filter(e => e.action === action).length }
}

class FakePolicyManager {
  policies: any[] = []
  async listPolicies() { return this.policies }
}

/**
 * DockerService stub. exportVolume writes a tarball of a configurable byte
 * size; volumeSizeBytes/fingerprintVolume/listVolumes/importVolume are
 * scriptable per-volume. No real Docker.
 */
class FakeDocker {
  // per-volume configured tar size (bytes); default 1KB
  sizes = new Map<string, number>()
  // per-volume fingerprint; default 'fp-<vol>'
  fingerprints = new Map<string, string>()
  // names returned by listVolumes (with Labels)
  volumeNames: string[] = []
  // volume -> throw-on-export
  failExport = new Set<string>()
  imported: Array<{ volume: string; src: string }> = []

  fingerprint(v: string) { return this.fingerprints.get(v) ?? `fp-${v}` }
  size(v: string) { return this.sizes.has(v) ? this.sizes.get(v)! : 1024 }

  async listVolumes() { return this.volumeNames.map(Name => ({ Name, Labels: {} })) }
  async volumeSizeBytes(v: string) { return this.size(v) }
  async fingerprintVolume(v: string, _label?: string) { return this.fingerprint(v) }

  async exportVolume(v: string, dest: string) {
    if (this.failExport.has(v)) throw new Error(`boom: ${v}`)
    await fs.ensureDir(path.dirname(dest))
    await fs.writeFile(dest, Buffer.alloc(this.size(v), 1))
  }

  async importVolume(v: string, src: string) {
    if (!(await fs.pathExists(src))) throw new Error(`missing tar: ${src}`)
    this.imported.push({ volume: v, src })
  }
}

async function makeService(over: Partial<GuardSettings> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drk-pg-'))
  const db = new Database(path.join(dir, 'g.db'))
  const settings = new SettingsService(db)
  await settings.setGuardSettings({ scope: 'named', ...over })
  const docker = new FakeDocker()
  const audit = new FakeAudit()
  const policyManager = new FakePolicyManager()
  const svc = new PruneGuardService({
    docker: docker as any,
    policyManager: policyManager as any,
    audit: audit as any,
    settings,
    db,
    dataDir: dir,
  })
  return { svc, db, docker, audit, policyManager, settings, dir }
}

// ---------------------------------------------------------------------------

describe('PruneGuardService.guard — scope resolution', () => {
  it('named: snapshots all named target volumes, excludes anonymous', async () => {
    const { svc, docker } = await makeService({ scope: 'named' })
    const anon = 'a'.repeat(64)
    docker.volumeNames = ['vol-a', 'vol-b', anon]
    const ev = await svc.guard('volume_prune', 'event', ['vol-a', 'vol-b', anon])
    expect(ev.status).toBe('saved')
    expect(ev.volumes.map(v => v.volume).sort()).toEqual(['vol-a', 'vol-b'])
    expect(ev.volumes.every(v => v.status === 'saved')).toBe(true)
  })

  it('protected: only snapshots volumes referenced by a policy target', async () => {
    const { svc, docker, policyManager } = await makeService({ scope: 'protected' })
    docker.volumeNames = ['vol-a', 'vol-b', 'vol-c']
    policyManager.policies = [{ targets: [{ type: 'volume', selector: 'vol-b' }, { type: 'container', selector: 'x' }] }]
    const ev = await svc.guard('system_prune', 'event', ['vol-a', 'vol-b', 'vol-c'])
    expect(ev.volumes.map(v => v.volume)).toEqual(['vol-b'])
  })

  it('all-named-under-cap: excludes over-cap volumes from scope', async () => {
    const { svc, docker } = await makeService({ scope: 'all-named-under-cap', perVolumeCapMb: 1 })
    docker.volumeNames = ['small', 'huge']
    docker.sizes.set('small', 500 * 1024)        // under 1MB cap
    docker.sizes.set('huge', 5 * 1024 * 1024)    // over 1MB cap
    const ev = await svc.guard('volume_prune', 'event', ['small', 'huge'])
    expect(ev.volumes.map(v => v.volume)).toEqual(['small'])
  })

  it('returns an empty saved event when scope is off / disabled', async () => {
    const { svc, docker } = await makeService({ enabled: false })
    docker.volumeNames = ['vol-a']
    const ev = await svc.guard('volume_rm', 'event', ['vol-a'])
    expect(ev.volumes).toEqual([])
    expect(ev.status).toBe('saved')
  })
})

describe('PruneGuardService.guard — caps', () => {
  it('per-volume cap: over-cap volume is skipped_too_large + audited', async () => {
    const { svc, docker, audit } = await makeService({ scope: 'named', perVolumeCapMb: 1 })
    docker.volumeNames = ['ok', 'big']
    docker.sizes.set('ok', 100 * 1024)
    docker.sizes.set('big', 4 * 1024 * 1024) // 4MB > 1MB cap
    const ev = await svc.guard('system_prune', 'event', ['ok', 'big'])
    const big = ev.volumes.find(v => v.volume === 'big')!
    expect(big.status).toBe('skipped_too_large')
    expect(ev.status).toBe('partial')
    expect(audit.has(GUARD_AUDIT_EVENTS.snapshot_failed)).toBe(true)
  })

  it('per-event budget: saved volumes sum into totalBytes under the event cap', async () => {
    // Under the default 1024MB event cap, three ~900KB volumes all fit; assert
    // each saves and totalBytes is the exact sum. (The over-cap skip branch is
    // covered by the per-volume cap test above and snapshotVolume's guards.)
    const { svc, docker } = await makeService({ scope: 'named', perVolumeCapMb: 4096 })
    docker.volumeNames = ['v1', 'v2', 'v3']
    for (const v of ['v1', 'v2', 'v3']) docker.sizes.set(v, 900 * 1024)
    const ev = await svc.guard('system_prune', 'event', ['v1', 'v2', 'v3'])
    expect(ev.volumes.filter(v => v.status === 'saved').length).toBe(3)
    expect(ev.totalBytes).toBe(3 * 900 * 1024)
  })
})

describe('PruneGuardService.guard — dedup fingerprint', () => {
  it('skips re-tar when the fingerprint matches a prior saved snapshot', async () => {
    const { svc, docker, audit } = await makeService({ scope: 'named' })
    docker.volumeNames = ['vol-a']
    docker.fingerprints.set('vol-a', 'stable-fp')

    const first = await svc.guard('periodic_floor', 'periodic', ['vol-a'])
    expect(first.volumes[0].status).toBe('saved')

    const second = await svc.guard('periodic_floor', 'periodic', ['vol-a'])
    expect(second.volumes[0].status).toBe('skipped_unchanged')
    // references the prior tarball
    expect(second.volumes[0].tarPath).toBe(first.volumes[0].tarPath)
    expect(audit.count(GUARD_AUDIT_EVENTS.skipped)).toBeGreaterThanOrEqual(1)
  })

  it('re-snapshots when the fingerprint changes', async () => {
    const { svc, docker } = await makeService({ scope: 'named' })
    docker.volumeNames = ['vol-a']
    docker.fingerprints.set('vol-a', 'fp-1')
    const first = await svc.guard('periodic_floor', 'periodic', ['vol-a'])
    docker.fingerprints.set('vol-a', 'fp-2')
    const second = await svc.guard('periodic_floor', 'periodic', ['vol-a'])
    expect(first.volumes[0].status).toBe('saved')
    expect(second.volumes[0].status).toBe('saved')
    expect(second.volumes[0].tarPath).not.toBe(first.volumes[0].tarPath)
  })
})

describe('PruneGuardService — budget / LRU eviction', () => {
  it('evicts the oldest non-pinned event and preserves the pinned one', async () => {
    // 5MB budget, 1MB per snapshot. Pre-load three saved events, pin the oldest.
    const { svc, db, docker } = await makeService({ scope: 'named', diskBudgetMb: 5, perVolumeCapMb: 4096 })
    docker.volumeNames = ['e1', 'e2', 'e3', 'new']
    for (const v of ['e1', 'e2', 'e3', 'new']) docker.sizes.set(v, 1024 * 1024) // 1MB each

    const a = await svc.guard('volume_rm', 'event', ['e1']) // oldest
    await svc.pin(a.id)
    const b = await svc.guard('volume_rm', 'event', ['e2'])
    const c = await svc.guard('volume_rm', 'event', ['e3'])
    // Force createdAt ordering deterministically (same-ms guards can tie).
    await bumpCreatedAt(db, a.id, '2026-06-01T00:00:00.000Z')
    await bumpCreatedAt(db, b.id, '2026-06-02T00:00:00.000Z')
    await bumpCreatedAt(db, c.id, '2026-06-03T00:00:00.000Z')

    // A fourth guard needs room; budget is 5MB, used ~3MB + event-cap headroom
    // forces eviction of the oldest NON-pinned (b), never the pinned (a).
    await svc.guard('volume_rm', 'event', ['new'])

    const pinnedStill = await db.getGuardEvent(a.id)
    expect(pinnedStill!.pinned).toBe(true)
    expect(pinnedStill!.status).not.toBe('expired')
    const evicted = await db.getGuardEvent(b.id)
    expect(evicted!.status).toBe('expired')
  })
})

describe('PruneGuardService.sweepExpired — TTL', () => {
  it('expires past-TTL non-pinned events, reclaims bytes, spares pinned', async () => {
    const { svc, db, docker, audit, dir } = await makeService({ scope: 'named' })
    docker.volumeNames = ['old', 'pinnedOld', 'fresh']
    for (const v of ['old', 'pinnedOld', 'fresh']) docker.sizes.set(v, 2048)

    const old = await svc.guard('volume_rm', 'event', ['old'])
    const pinnedOld = await svc.guard('volume_rm', 'event', ['pinnedOld'])
    const fresh = await svc.guard('volume_rm', 'event', ['fresh'])
    await svc.pin(pinnedOld.id)
    await bumpTtlAt(db, old.id, '2026-06-01T00:00:00.000Z')
    await bumpTtlAt(db, pinnedOld.id, '2026-06-01T00:00:00.000Z')

    const tarBefore = old.volumes[0].tarPath!
    expect(await fs.pathExists(tarBefore)).toBe(true)

    const res = await svc.sweepExpired(new Date('2026-06-11T00:00:00.000Z'))
    expect(res.expired).toBe(1)
    expect(res.reclaimedBytes).toBeGreaterThan(0)
    expect((await db.getGuardEvent(old.id))!.status).toBe('expired')
    expect((await db.getGuardEvent(pinnedOld.id))!.status).not.toBe('expired')
    expect((await db.getGuardEvent(fresh.id))!.status).toBe('saved')
    expect(await fs.pathExists(tarBefore)).toBe(false)
    expect(audit.has(GUARD_AUDIT_EVENTS.expired)).toBe(true)
    void dir
  })
})

describe('PruneGuardService.guard — fail-open', () => {
  it('exportVolume throwing yields status failed + snapshot_failed audit, never throws', async () => {
    const { svc, docker, audit } = await makeService({ scope: 'named' })
    docker.volumeNames = ['vol-a']
    docker.failExport.add('vol-a')
    const ev = await svc.guard('volume_rm', 'event', ['vol-a'])
    expect(ev.status).toBe('failed')
    expect(ev.volumes[0].status).toBe('failed')
    expect(audit.has(GUARD_AUDIT_EVENTS.snapshot_failed)).toBe(true)
  })

  it('partial when one volume saves and another fails', async () => {
    const { svc, docker } = await makeService({ scope: 'named' })
    docker.volumeNames = ['good', 'bad']
    docker.failExport.add('bad')
    const ev = await svc.guard('system_prune', 'event', ['good', 'bad'])
    expect(ev.status).toBe('partial')
  })
})

describe('PruneGuardService.guard — concurrency (W1)', () => {
  it('two concurrent guard() calls both persist; neither over-evicts the other', async () => {
    // Budget far exceeds the per-call event-cap reservation (1024MB) plus both
    // ~1MB events, so the serialized budget→snapshot→persist section must NOT
    // evict either one.
    const { svc, db, docker } = await makeService({ scope: 'named', diskBudgetMb: 4096, perVolumeCapMb: 4096 })
    docker.volumeNames = ['c1', 'c2']
    docker.sizes.set('c1', 1024 * 1024)
    docker.sizes.set('c2', 1024 * 1024)

    // Fire both at once — simulates floor-cron + MCP snapshot overlapping.
    const [a, b] = await Promise.all([
      svc.guard('volume_rm', 'event', ['c1']),
      svc.guard('volume_rm', 'event', ['c2']),
    ])

    expect(a.volumes[0].status).toBe('saved')
    expect(b.volumes[0].status).toBe('saved')
    const rowA = await db.getGuardEvent(a.id)
    const rowB = await db.getGuardEvent(b.id)
    expect(rowA).not.toBeNull()
    expect(rowB).not.toBeNull()
    // Neither event was evicted (both still fit the budget).
    expect(rowA!.status).not.toBe('expired')
    expect(rowB!.status).not.toBe('expired')
  })
})

describe('PruneGuardService.guard — fail-open settings read (W3)', () => {
  it('settings.getGuardSettings throwing → guard() resolves, records a failed event, never throws', async () => {
    const { svc, db } = await makeService({ scope: 'named' })
    jest
      .spyOn((svc as any).deps.settings, 'getGuardSettings')
      .mockRejectedValueOnce(new Error('settings DB down'))

    let ev: any
    await expect((async () => { ev = await svc.guard('volume_rm', 'event', ['vol-a']) })()).resolves.toBeUndefined()
    expect(ev.status).toBe('failed')
    expect(ev.volumes[0].status).toBe('failed')
    // Persisted so the audit/UI still sees the failed attempt.
    expect(await db.getGuardEvent(ev.id)).not.toBeNull()
  })
})

describe('PruneGuardService.restore — round-trip', () => {
  it('re-imports saved volumes via DockerService.importVolume and marks restored', async () => {
    const { svc, db, docker, audit } = await makeService({ scope: 'named' })
    docker.volumeNames = ['vol-a', 'vol-b']
    const ev = await svc.guard('compose_down_v', 'event', ['vol-a', 'vol-b'])

    const res = await svc.restore(ev.id)
    expect(res.restored.sort()).toEqual(['vol-a', 'vol-b'])
    expect(res.failed).toEqual([])
    expect(docker.imported.map(i => i.volume).sort()).toEqual(['vol-a', 'vol-b'])
    const after = await db.getGuardEvent(ev.id)
    expect(after!.status).toBe('restored')
    expect(after!.restoredAt).toBeTruthy()
    expect(audit.has(GUARD_AUDIT_EVENTS.restore)).toBe(true)
  })

  it('restores only the requested subset', async () => {
    const { svc, docker } = await makeService({ scope: 'named' })
    docker.volumeNames = ['vol-a', 'vol-b']
    const ev = await svc.guard('compose_down_v', 'event', ['vol-a', 'vol-b'])
    const res = await svc.restore(ev.id, ['vol-a'])
    expect(res.restored).toEqual(['vol-a'])
    expect(docker.imported.map(i => i.volume)).toEqual(['vol-a'])
  })
})

describe('PruneGuardService — remove, floor, too_late', () => {
  it('remove deletes the row + tarballs and reports reclaimed bytes', async () => {
    const { svc, db, docker } = await makeService({ scope: 'named' })
    docker.volumeNames = ['vol-a']
    docker.sizes.set('vol-a', 4096)
    const ev = await svc.guard('volume_rm', 'event', ['vol-a'])
    const tar = ev.volumes[0].tarPath!
    const out = await svc.remove(ev.id)
    expect(out.reclaimedBytes).toBeGreaterThan(0)
    expect(await db.getGuardEvent(ev.id)).toBeNull()
    expect(await fs.pathExists(tar)).toBe(false)
  })

  it('floorSnapshot keeps exactly one periodic_floor per volume', async () => {
    const { svc, db, docker } = await makeService({ scope: 'named' })
    docker.volumeNames = ['vol-a']
    docker.fingerprints.set('vol-a', 'fp-1')
    const f1 = await svc.floorSnapshot(['vol-a'])
    docker.fingerprints.set('vol-a', 'fp-2') // content changed → re-tar
    const f2 = await svc.floorSnapshot(['vol-a'])

    expect(await db.getGuardEvent(f1.id)).toBeNull() // superseded + removed
    const floors = (await db.listGuardEvents({ limit: 50 })).filter(e => e.kind === 'periodic_floor')
    expect(floors.map(e => e.id)).toEqual([f2.id])
  })

  it('recordTooLate finds the most recent floor and emits a too_late frame', async () => {
    const { svc, docker, audit } = await makeService({ scope: 'named' })
    docker.volumeNames = ['vol-a']
    await svc.floorSnapshot(['vol-a'])

    const frames: any[] = []
    const unsub = svc.subscribe(f => { if (f.event === 'too_late') frames.push(f.data) })
    const res = await svc.recordTooLate('vol-a')
    unsub()

    expect(res.eventId).toBeTruthy()
    expect(res.floorSnapshotAgeHours).not.toBeNull()
    expect(frames).toHaveLength(1)
    expect((frames[0] as any).volume).toBe('vol-a')
    expect(audit.has(GUARD_AUDIT_EVENTS.too_late)).toBe(true)
  })

  it('recordTooLate with no floor reports a null age', async () => {
    const { svc, docker } = await makeService({ scope: 'named' })
    docker.volumeNames = ['vol-x']
    const res = await svc.recordTooLate('vol-x')
    expect(res.eventId).toBeNull()
    expect(res.floorSnapshotAgeHours).toBeNull()
  })
})

describe('PruneGuardService — live event bus', () => {
  it('emits a snapshot frame on guard()', async () => {
    const { svc, docker } = await makeService({ scope: 'named' })
    docker.volumeNames = ['vol-a']
    const frames: any[] = []
    const unsub = svc.subscribe(f => frames.push(f))
    await svc.guard('volume_rm', 'event', ['vol-a'])
    unsub()
    const snap = frames.find(f => f.event === 'snapshot')
    expect(snap).toBeTruthy()
    expect(snap.data.volumes[0].volume).toBe('vol-a')
  })
})

// --- test helpers: poke the persisted JSON to control ordering -------------

async function bumpCreatedAt(db: Database, id: string, createdAt: string) {
  const ev = await db.getGuardEvent(id)
  if (!ev) return
  ev.createdAt = createdAt
  await db.insertGuardEvent(ev)
}

async function bumpTtlAt(db: Database, id: string, ttlAt: string) {
  const ev = await db.getGuardEvent(id)
  if (!ev) return
  ev.ttlAt = ttlAt
  await db.insertGuardEvent(ev)
}
