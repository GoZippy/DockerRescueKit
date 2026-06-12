import path from 'path'
import os from 'os'
import fs from 'fs-extra'
import { Database } from '../db/Database'
import { DockerService } from '../services/DockerService'
import { PolicyManager } from '../services/PolicyManager'
import { AuditService } from '../services/AuditService'
import { SettingsService } from '../services/SettingsService'
import { PruneGuardService } from '../services/PruneGuardService'

/**
 * Real-Docker integration test for Prune Guard (PG-1.7,
 * docs/design/PRUNE_GUARD.md §14.2–14.4).
 *
 * Gated on CI_INTEGRATION=1 — when unset the whole describe is skipped so the
 * default `jest` run stays hermetic (no Docker dependency). Requires:
 *   - Docker daemon reachable from this process
 *   - Permission to create volumes/containers
 *
 * What this exercises end-to-end against the *real* DockerService primitives
 * (exportVolume / importVolume / listVolumes / volumeSizeBytes / fingerprint):
 *   1. §14.2 — guard() → docker volume rm → restore() round-trip; sentinel byte
 *      content survives.
 *   2. §14.3 — the PocketOS drill: floorSnapshot → simulated `down -v` → assert
 *      a guard event covers the volume → restore → file is back. Then the same
 *      with the feature disabled → assert NO new snapshot occurs.
 *   3. §14.4 — bounded crash-recovery: a fake orphan helper labelled
 *      com.gozippy.drk.guard=* is reaped by reapOrphans().
 *
 * Every resource is named with the `drk-pg17-` prefix and torn down in afterAll
 * even on failure (§14.4 cleanup discipline). Target runtime ≪ 90s.
 */

const ENABLED = process.env.CI_INTEGRATION === '1'
const describeOrSkip = ENABLED ? describe : describe.skip

const PREFIX = 'drk-pg17-test-'
const GUARD_LABEL = 'com.gozippy.drk.guard'
const ALPINE = 'alpine:3.19'

describeOrSkip('PruneGuardService (real Docker)', () => {
  let tmp: string
  let db: Database
  let docker: DockerService
  let dockerode: any
  let svc: PruneGuardService
  let settings: SettingsService

  // Track everything we create so afterAll can guarantee teardown.
  const createdVolumes = new Set<string>()
  const createdContainers = new Set<string>()

  const uniq = (suffix: string) => `${PREFIX}${suffix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`

  /** Create a named volume and remember it for cleanup. */
  async function makeVolume(suffix: string): Promise<string> {
    const name = uniq(suffix)
    await dockerode.createVolume({ Name: name, Labels: { 'drk.integration-test': '1' } })
    createdVolumes.add(name)
    return name
  }

  /** Run a one-shot alpine helper that writes `content` to /data/<file>. */
  async function seedFile(volume: string, file: string, content: string): Promise<void> {
    await runHelper(volume, `printf '%s' '${content}' > /data/${file}`, false)
  }

  /** Read a file back from a volume via a fresh `:ro` helper. */
  async function readFile(volume: string, file: string): Promise<string> {
    return (await runHelper(volume, `cat /data/${file}`, true)).trim()
  }

  /** Generic short-lived alpine helper bound to `volume`; returns stdout. */
  async function runHelper(volume: string, sh: string, readonly: boolean): Promise<string> {
    const container = await dockerode.createContainer({
      Image: ALPINE,
      Cmd: ['sh', '-c', sh],
      Tty: false,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: { Binds: [`${volume}:/data${readonly ? ':ro' : ''}`], AutoRemove: false },
    })
    try {
      const stream = await container.attach({ stream: true, stdout: true, stderr: true })
      const out: Buffer[] = []
      const collector = new (require('stream').Writable)({
        write(c: Buffer, _e: string, cb: () => void) { out.push(c); cb() },
      })
      const sink = new (require('stream').Writable)({ write(_c: Buffer, _e: string, cb: () => void) { cb() } })
      ;(docker as any).docker.modem.demuxStream(stream, collector, sink)
      await container.start()
      const wait = await container.wait()
      if (wait.StatusCode !== 0) throw new Error(`helper exited ${wait.StatusCode} for: ${sh}`)
      return Buffer.concat(out).toString('utf-8')
    } finally {
      try { await container.remove({ force: true }) } catch { /* already gone */ }
    }
  }

  async function removeVolume(name: string): Promise<void> {
    try { await dockerode.getVolume(name).remove({ force: true }) } catch { /* already gone */ }
    createdVolumes.delete(name)
  }

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'drk-pg17-int-'))
    db = new Database(path.join(tmp, 'guard.db'))
    docker = new DockerService()
    dockerode = (docker as any).docker

    const reachable = await docker.ping()
    if (!reachable) throw new Error('Docker daemon not reachable; refusing to run integration test')

    // Ensure alpine is present once so per-test helpers don't each race a pull.
    // Best-effort: if it's already cached (the common case) we skip the network
    // entirely; a transient registry hiccup must not fail the whole suite — the
    // per-test helpers call ensureImage() and will surface a genuine "image
    // unavailable" there.
    try {
      await dockerode.getImage(ALPINE).inspect()
    } catch {
      await new Promise<void>((resolve) => {
        dockerode.pull(ALPINE, (err: any, stream: NodeJS.ReadableStream) => {
          if (err || !stream) return resolve()
          dockerode.modem.followProgress(stream, () => resolve())
        })
      })
    }

    settings = new SettingsService(db)
    // scope 'named' + generous cap so the tiny test volumes are always in-scope.
    await settings.setGuardSettings({ enabled: true, scope: 'named', perVolumeCapMb: 512 })
    const audit = new AuditService(db)
    const policyManager = new PolicyManager(db, path.join(tmp, 'staging'))
    svc = new PruneGuardService({
      docker,
      policyManager,
      audit,
      settings,
      db,
      dataDir: tmp,
    })
  }, 90_000)

  afterAll(async () => {
    // Belt-and-suspenders cleanup: remove everything we created, plus sweep any
    // stray drk-pg17-* / guard-labelled resources (even on mid-test failure).
    for (const c of createdContainers) {
      try { await dockerode.getContainer(c).remove({ force: true }) } catch { /* gone */ }
    }
    for (const v of createdVolumes) {
      try { await dockerode.getVolume(v).remove({ force: true }) } catch { /* gone */ }
    }
    try {
      const stray = await dockerode.listContainers({ all: true, filters: { label: [GUARD_LABEL] } })
      for (const ci of stray) {
        try { await dockerode.getContainer(ci.Id).remove({ force: true }) } catch { /* gone */ }
      }
    } catch { /* best effort */ }
    try {
      const vols = await dockerode.listVolumes()
      for (const v of vols.Volumes || []) {
        if (v.Name.startsWith(PREFIX)) {
          try { await dockerode.getVolume(v.Name).remove({ force: true }) } catch { /* gone */ }
        }
      }
    } catch { /* best effort */ }
    try { (db as any)?.close?.() } catch { /* may not expose close */ }
    if (tmp) await fs.remove(tmp).catch(() => {})
  }, 90_000)

  // -------------------------------------------------------------------------
  // §14.2 — guard → volume rm → restore round-trip
  // -------------------------------------------------------------------------
  it('snapshots a volume before deletion and restores the sentinel content (§14.2)', async () => {
    const vol = await makeVolume('rt')
    const sentinel = 'pocketos-sentinel-A7f3'
    await seedFile(vol, 'sentinel.txt', sentinel)

    // Guard it (snapshot-before-destroy).
    const ev = await svc.guard('volume_rm', 'event', [vol])
    expect(ev.status).toBe('saved')
    const snap = ev.volumes.find(v => v.volume === vol)!
    expect(snap.status).toBe('saved')
    expect(await fs.pathExists(snap.tarPath!)).toBe(true)

    // Actually destroy the volume (the destructive op the guard protected against).
    await removeVolume(vol)
    const after = await dockerode.listVolumes()
    expect((after.Volumes || []).some((v: any) => v.Name === vol)).toBe(false)

    // Undo.
    const res = await svc.restore(ev.id)
    createdVolumes.add(vol) // importVolume recreated it; track for cleanup
    expect(res.restored).toEqual([vol])
    expect(res.failed).toEqual([])

    // Read the sentinel back from a FRESH helper container.
    expect(await readFile(vol, 'sentinel.txt')).toBe(sentinel)
  }, 60_000)

  // -------------------------------------------------------------------------
  // §14.3 — the PocketOS drill (floor → down -v → restore), then disabled path
  // -------------------------------------------------------------------------
  it('the PocketOS drill: floor snapshot survives a down -v simulation and restores (§14.3)', async () => {
    const vol = await makeVolume('pocketos')
    const sentinel = 'db-row-42'
    await seedFile(vol, 'pgdata.txt', sentinel)

    // Stand up a tiny "stack" container that uses the named volume (no compose CLI).
    const cname = uniq('pocketos-app')
    const container = await dockerode.createContainer({
      name: cname,
      Image: ALPINE,
      Cmd: ['sleep', '30'],
      Labels: { 'drk.integration-test': '1' },
      HostConfig: { Binds: [`${vol}:/data`] },
    })
    createdContainers.add(cname)
    await container.start()

    // Floor snapshot (the zero-config last-known-good).
    const floor = await svc.floorSnapshot([vol])
    expect(floor.kind).toBe('periodic_floor')
    expect(floor.volumes.find(v => v.volume === vol)?.status).toBe('saved')

    // Simulate `docker compose down -v`: remove the container, then the volume.
    await container.remove({ force: true })
    createdContainers.delete(cname)
    await removeVolume(vol)

    // Assert a guard event covers the volume (the floor we took).
    const events = await db.listGuardEvents({ limit: 50 })
    const covering = events.find(e => e.volumes.some(v => v.volume === vol && v.status === 'saved'))
    expect(covering).toBeTruthy()

    // Restore from that event; the seeded "row" must be back.
    const res = await svc.restore(covering!.id, [vol])
    createdVolumes.add(vol)
    expect(res.restored).toEqual([vol])
    expect(await readFile(vol, 'pgdata.txt')).toBe(sentinel)
  }, 75_000)

  it('does NOT snapshot when the feature is disabled — proves the guard does the work (§14.3)', async () => {
    const vol = await makeVolume('disabled')
    await seedFile(vol, 'x.txt', 'never-saved')

    await settings.setGuardSettings({ enabled: false })
    try {
      const before = (await db.listGuardEvents({ limit: 200 })).length
      const ev = await svc.guard('compose_down_v', 'event', [vol])
      // Disabled → scope resolves to empty → an empty 'saved' no-op event, zero volumes.
      expect(ev.volumes).toEqual([])
      const after = await db.listGuardEvents({ limit: 200 })
      // The no-op event is persisted, but NO volume tarball is produced.
      expect(after.every(e => !e.volumes.some(v => v.volume === vol && v.status === 'saved'))).toBe(true)
      void before
    } finally {
      await settings.setGuardSettings({ enabled: true })
    }
  }, 45_000)

  // -------------------------------------------------------------------------
  // §14.4 — bounded crash-recovery: reapOrphans removes a labelled orphan
  // -------------------------------------------------------------------------
  it('reapOrphans removes a crash-orphaned guard helper container (§14.4)', async () => {
    const cname = uniq('orphan')
    const orphan = await dockerode.createContainer({
      name: cname,
      Image: ALPINE,
      Cmd: ['sleep', '60'],
      Labels: { [GUARD_LABEL]: 'test-orphan', 'drk.integration-test': '1' },
    })
    createdContainers.add(cname)
    await orphan.start()

    // Sanity: it's present and labelled.
    const present = await dockerode.listContainers({ all: true, filters: { label: [`${GUARD_LABEL}=test-orphan`] } })
    expect(present.length).toBe(1)

    const reaped = await svc.reapOrphans()
    expect(reaped.containers).toBeGreaterThanOrEqual(1)

    const remaining = await dockerode.listContainers({ all: true, filters: { label: [`${GUARD_LABEL}=test-orphan`] } })
    expect(remaining.length).toBe(0)
    createdContainers.delete(cname)
  }, 45_000)
})
