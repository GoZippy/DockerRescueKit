import type { GuardEvent } from '@docker-rescue-kit/shared'
import {
  listGuardSnapshots,
  snapshotVolumes,
  safePrune,
  safeComposeDown,
  undoLast,
  type ToolDeps,
} from '../tools'
import type { DrkGuardClient } from '../drkClient'
import type { DockerOps, PruneResult } from '../docker'

// ---------------------------------------------------------------------------
// Test doubles. A shared `calls` array records the ORDER of side-effecting
// calls so we can assert snapshot-strictly-before-prune.
// ---------------------------------------------------------------------------
function makeEvent(over: Partial<GuardEvent> = {}): GuardEvent {
  return {
    id: 'evt-1',
    kind: 'system_prune',
    trigger: 'mcp',
    scope: 'named',
    volumes: [{ volume: 'pg-data', status: 'saved', sizeBytes: 1024 }],
    totalBytes: 1024,
    createdAt: '2026-06-11T00:00:00.000Z',
    ttlAt: '2026-06-14T00:00:00.000Z',
    pinned: false,
    status: 'saved',
    ...over,
  }
}

interface Harness {
  deps: ToolDeps
  calls: string[]
  drk: {
    listEvents: jest.Mock
    getEvent: jest.Mock
    snapshotNow: jest.Mock
    restore: jest.Mock
  }
  docker: {
    volumesForComposeProject: jest.Mock
    prune: jest.Mock
    composeDown: jest.Mock
  }
}

function harness(opts: { snapshotNow?: jest.Mock } = {}): Harness {
  const calls: string[] = []
  const drk = {
    listEvents: jest.fn(async () => [] as GuardEvent[]),
    getEvent: jest.fn(async () => makeEvent()),
    snapshotNow:
      opts.snapshotNow ??
      jest.fn(async (vols: string[]) => {
        calls.push('snapshot')
        return makeEvent({ volumes: vols.map(v => ({ volume: v, status: 'saved' as const, sizeBytes: 1024 })) })
      }),
    restore: jest.fn(async () => ({ restored: ['pg-data'] })),
  }
  if (opts.snapshotNow) {
    const orig = opts.snapshotNow
    drk.snapshotNow = jest.fn(async (...a: unknown[]) => {
      calls.push('snapshot')
      return (orig as any)(...a)
    })
  }
  const docker = {
    volumesForComposeProject: jest.fn(async () => ['pg-data', 'redis-data']),
    prune: jest.fn(async (scope: string): Promise<PruneResult> => {
      calls.push('prune')
      return { scope: scope as any, spaceReclaimed: 2048, deleted: ['pg-data'], raw: {} }
    }),
    composeDown: jest.fn(async () => {
      calls.push('composeDown')
      return { stdout: 'Removing', stderr: '' }
    }),
  }
  return {
    calls,
    drk,
    docker,
    deps: { drk: drk as unknown as DrkGuardClient, docker: docker as unknown as DockerOps },
  }
}

// ---------------------------------------------------------------------------
describe('list_guard_snapshots', () => {
  it('calls GET events with limit 20 and summarizes', async () => {
    const h = harness()
    h.drk.listEvents.mockResolvedValueOnce([makeEvent(), makeEvent({ id: 'evt-2' })])
    const r = await listGuardSnapshots(h.deps)
    expect(h.drk.listEvents).toHaveBeenCalledWith({ limit: 20 })
    expect(r.structured).toHaveLength(2)
    expect(r.text).toContain('evt-1')
  })

  it('handles the empty case', async () => {
    const h = harness()
    const r = await listGuardSnapshots(h.deps)
    expect(r.text).toMatch(/No guard snapshots/)
    expect(r.structured).toEqual([])
  })
})

describe('snapshot_volumes', () => {
  it('snapshots the deduped volume list', async () => {
    const h = harness()
    const r = await snapshotVolumes(h.deps, { volumes: ['pg-data', 'pg-data', ' redis '] })
    expect(h.drk.snapshotNow).toHaveBeenCalledWith(['pg-data', 'redis'], 'periodic_floor')
    expect(r.structured.id).toBe('evt-1')
  })

  it('rejects an empty volume list', async () => {
    const h = harness()
    await expect(snapshotVolumes(h.deps, { volumes: [] })).rejects.toThrow(/at least one volume/)
  })
})

describe('safe_prune — snapshot strictly before prune', () => {
  it('snapshots THEN prunes for scope=system', async () => {
    const h = harness()
    const r = await safePrune(h.deps, { scope: 'system', volumes: ['pg-data'] })
    expect(h.calls).toEqual(['snapshot', 'prune'])
    expect(h.drk.snapshotNow).toHaveBeenCalledWith(['pg-data'], 'system_prune')
    expect(r.structured.snapshotted).toEqual(['pg-data'])
    expect(r.structured.guardEventId).toBe('evt-1')
    expect(r.structured.warnings).toEqual([])
  })

  it('snapshots THEN prunes for scope=volumes', async () => {
    const h = harness()
    await safePrune(h.deps, { scope: 'volumes', volumes: ['v1'] })
    expect(h.calls).toEqual(['snapshot', 'prune'])
    expect(h.drk.snapshotNow).toHaveBeenCalledWith(['v1'], 'volume_prune')
  })

  it('does NOT snapshot for scope=images (no volume data destroyed)', async () => {
    const h = harness()
    const r = await safePrune(h.deps, { scope: 'images' })
    expect(h.drk.snapshotNow).not.toHaveBeenCalled()
    expect(h.calls).toEqual(['prune'])
    expect(r.structured.guardEventId).toBeNull()
  })

  it('FAIL-OPEN: still prunes and emits a prominent warning when the snapshot throws', async () => {
    const failingSnap = jest.fn(async () => {
      throw new Error('disk full')
    })
    const h = harness({ snapshotNow: failingSnap })
    const r = await safePrune(h.deps, { scope: 'system', volumes: ['pg-data'] })
    // Prune STILL happened (fail-open), after the failed snapshot attempt.
    expect(h.calls).toEqual(['snapshot', 'prune'])
    expect(h.docker.prune).toHaveBeenCalledTimes(1)
    expect(r.structured.warnings.join(' ')).toMatch(/WARNING: guard snapshot FAILED/)
    expect(r.structured.warnings.join(' ')).toMatch(/disk full/)
  })

  it('surfaces per-volume skip warnings without failing the prune', async () => {
    const partial = jest.fn(async (vols: string[]) =>
      makeEvent({
        status: 'partial',
        volumes: [
          { volume: vols[0], status: 'saved', sizeBytes: 10 },
          { volume: 'big', status: 'skipped_too_large', sizeBytes: 0, detail: 'over cap' },
        ],
      }),
    )
    const h = harness({ snapshotNow: partial })
    const r = await safePrune(h.deps, { scope: 'volumes', volumes: ['v1'] })
    expect(r.structured.snapshotted).toEqual(['v1'])
    expect(r.structured.skipped).toEqual(['big'])
    expect(r.structured.warnings.join(' ')).toMatch(/skipped_too_large/)
    expect(h.calls).toEqual(['snapshot', 'prune'])
  })
})

describe('safe_compose_down', () => {
  it('resolves project volumes, snapshots, THEN composes down -v', async () => {
    const h = harness()
    const r = await safeComposeDown(h.deps, { project: 'pocketos', removeVolumes: true })
    expect(h.docker.volumesForComposeProject).toHaveBeenCalledWith('pocketos')
    expect(h.drk.snapshotNow).toHaveBeenCalledWith(['pg-data', 'redis-data'], 'compose_down_v')
    expect(h.calls).toEqual(['snapshot', 'composeDown'])
    expect(h.docker.composeDown).toHaveBeenCalledWith('pocketos', true)
    expect(r.structured.resolvedVolumes).toEqual(['pg-data', 'redis-data'])
    expect(r.structured.snapshotted).toEqual(['pg-data', 'redis-data'])
  })

  it('does NOT snapshot when removeVolumes=false', async () => {
    const h = harness()
    await safeComposeDown(h.deps, { project: 'pocketos', removeVolumes: false })
    expect(h.drk.snapshotNow).not.toHaveBeenCalled()
    expect(h.calls).toEqual(['composeDown'])
    expect(h.docker.composeDown).toHaveBeenCalledWith('pocketos', false)
  })

  it('FAIL-OPEN: composes down with a warning when snapshot throws', async () => {
    const failingSnap = jest.fn(async () => {
      throw new Error('daemon hiccup')
    })
    const h = harness({ snapshotNow: failingSnap })
    const r = await safeComposeDown(h.deps, { project: 'pocketos', removeVolumes: true })
    expect(h.calls).toEqual(['snapshot', 'composeDown'])
    expect(r.structured.warnings.join(' ')).toMatch(/snapshot FAILED before "compose down -v"/)
  })

  it('warns when the project has no named volumes', async () => {
    const h = harness()
    h.docker.volumesForComposeProject.mockResolvedValueOnce([])
    const r = await safeComposeDown(h.deps, { project: 'empty', removeVolumes: true })
    expect(h.drk.snapshotNow).not.toHaveBeenCalled()
    expect(r.structured.warnings.join(' ')).toMatch(/No named volumes found/)
    expect(h.calls).toEqual(['composeDown'])
  })

  it('rejects a blank project name', async () => {
    const h = harness()
    await expect(safeComposeDown(h.deps, { project: '  ', removeVolumes: true })).rejects.toThrow(/project name/)
  })
})

describe('undo_last', () => {
  it('finds the latest saved event then restores it', async () => {
    const h = harness()
    h.drk.listEvents.mockResolvedValueOnce([makeEvent({ id: 'evt-9' })])
    const r = await undoLast(h.deps)
    expect(h.drk.listEvents).toHaveBeenCalledWith({ limit: 1, status: 'saved' })
    expect(h.drk.restore).toHaveBeenCalledWith('evt-9')
    expect(r.structured.eventId).toBe('evt-9')
    expect(r.structured.restored).toEqual(['pg-data'])
  })

  it('is a no-op with a clear message when nothing is restorable', async () => {
    const h = harness()
    h.drk.listEvents.mockResolvedValueOnce([])
    const r = await undoLast(h.deps)
    expect(h.drk.restore).not.toHaveBeenCalled()
    expect(r.structured.eventId).toBeNull()
    expect(r.text).toMatch(/No restorable/)
  })
})
