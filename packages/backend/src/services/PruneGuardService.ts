import fs from 'fs-extra'
import path from 'path'
import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type Dockerode from 'dockerode'
import type {
  GuardEvent,
  GuardOpKind,
  GuardScope,
  GuardSettings,
  GuardVolumeSnapshot,
} from '@docker-rescue-kit/shared'
import { DockerService } from './DockerService'
import { PolicyManager } from './PolicyManager'
import { AuditService } from './AuditService'
import { SettingsService } from './SettingsService'
import { Database } from '../db/Database'
import { GUARD_AUDIT_EVENTS } from './GuardTypes'
import { logger } from '../utils/logger'

/**
 * PruneGuardService — the PG-1.2 core (docs/design/PRUNE_GUARD.md §3, §6, §11).
 *
 * A local "guard cache" of crash-consistent volume tarballs taken *before* a
 * destructive Docker op, so the answer to "the agent just nuked my data" is a
 * one-click undo. Reuses DockerService.exportVolume/importVolume verbatim —
 * this is NOT a parallel backup engine (§6.1 decision B). Disk-bounded with a
 * per-volume cap, per-event cap, global budget + LRU eviction, and a TTL sweep.
 *
 * Interception front-ends (event floor PG-1.3, REST/SSE PG-1.4, proxy PG-2.1)
 * all feed this one engine. This phase ships only the engine + unit tests; it
 * wires no listeners, cron, or routes.
 */

const GUARD_LABEL = 'com.gozippy.drk.guard'
const MB = 1024 * 1024
const DEFAULT_CONCURRENCY = parseInt(process.env.DRK_GUARD_CONCURRENCY || '2', 10)
/** Per-event cap (§6.3). Not user-tunable in MVP; env override for tests/ops. */
const EVENT_CAP_MB = parseInt(process.env.DRK_GUARD_EVENT_CAP_MB || '1024', 10)

export interface PruneGuardServiceDeps {
  docker: DockerService
  policyManager: PolicyManager
  audit: AuditService
  settings: SettingsService
  db: Database
  /** App data dir (process.env.DRK_DATA_DIR || 'data'), same as siblings. The
   *  guard cache lives at `<dataDir>/guard-cache/<event-id>/`. */
  dataDir: string
}

/** A live SSE-style frame for PG-1.4's /api/guard/stream to attach to. */
export interface GuardFrame {
  event: 'snapshot' | 'too_late' | 'warning'
  data: unknown
}

export class PruneGuardService {
  private readonly bus = new EventEmitter()
  private readonly semaphore: { capacity: number; inUse: number; waiters: Array<() => void> }
  private readonly guardCacheDir: string

  constructor(private readonly deps: PruneGuardServiceDeps) {
    this.semaphore = { capacity: Math.max(1, DEFAULT_CONCURRENCY), inUse: 0, waiters: [] }
    this.guardCacheDir = path.join(deps.dataDir, 'guard-cache')
  }

  // -------------------------------------------------------------------------
  // Live event bus (PG-1.4 SSE route attaches here)
  // -------------------------------------------------------------------------

  /** Subscribe to guard frames. Returns an unsubscribe fn. */
  public subscribe(listener: (frame: GuardFrame) => void): () => void {
    const handler = (frame: GuardFrame) => listener(frame)
    this.bus.on('frame', handler)
    return () => this.bus.off('frame', handler)
  }

  private emit(frame: GuardFrame): void {
    this.bus.emit('frame', frame)
  }

  // -------------------------------------------------------------------------
  // (1) guard() — the §3 lifecycle steps 1-3
  // -------------------------------------------------------------------------

  /**
   * Snapshot the in-scope volumes a destructive op is about to destroy, then
   * persist + audit a GuardEvent. NEVER throws (fail-open §7.1): snapshot
   * failures are recorded and the event status degrades to partial/failed.
   *
   * @returns the persisted GuardEvent (status saved | partial | failed).
   */
  public async guard(
    kind: GuardOpKind,
    trigger: GuardEvent['trigger'],
    volumeNames: string[],
  ): Promise<GuardEvent> {
    const settings = await this.deps.settings.getGuardSettings()
    const id = uuidv4()
    const createdAt = new Date()
    const ttlAt = new Date(createdAt.getTime() + settings.ttlHours * 3600_000)

    const event: GuardEvent = {
      id,
      kind,
      trigger,
      scope: settings.scope,
      volumes: [],
      totalBytes: 0,
      createdAt: createdAt.toISOString(),
      ttlAt: ttlAt.toISOString(),
      pinned: false,
      status: 'saved',
    }

    try {
      // STEP 1 — resolve in-scope volumes.
      const inScope = await this.resolveInScope(volumeNames, settings)
      if (inScope.length === 0) {
        // Nothing to do; persist an empty 'saved' event so the audit trail and
        // the toast still fire honestly (0 volumes saved → no-op forward).
        await this.persist(event)
        return event
      }

      const eventDir = path.join(this.guardCacheDir, id)
      await fs.ensureDir(eventDir)

      // STEP 2 — make room under the global budget BEFORE snapshotting. Reserve
      // up to one event-cap of headroom, but never more than the whole budget
      // (a tiny budget can't reserve a full event cap).
      const budgetBytes = settings.diskBudgetMb * MB
      await this.evictForBudget(settings, Math.min(EVENT_CAP_MB * MB, budgetBytes))

      // STEP 3 — snapshot each in-scope volume (semaphore-bounded).
      let eventBytes = 0
      const perVolCap = settings.perVolumeCapMb * MB
      const eventCap = EVENT_CAP_MB * MB

      await Promise.all(
        inScope.map(vol =>
          this.withSemaphore(async () => {
            // Budget exhausted for this event already → skip the rest.
            const snap = await this.snapshotVolume(event, vol, eventDir, perVolCap, () => eventBytes, eventCap, settings)
            event.volumes.push(snap)
            if (snap.status === 'saved' && snap.sizeBytes) eventBytes += snap.sizeBytes
          }),
        ),
      )

      event.totalBytes = eventBytes
      event.status = this.deriveStatus(event.volumes)
    } catch (err: any) {
      // Belt-and-suspenders: resolution/budget errors must not throw out.
      logger.error({ err, eventId: id }, '[Guard] guard() failed unexpectedly')
      if (event.volumes.length === 0) {
        event.volumes.push({ volume: '(resolve)', status: 'failed', sizeBytes: 0, detail: err?.message || String(err) })
      }
      event.status = this.deriveStatus(event.volumes)
    }

    await this.persist(event)

    // STEP 3 (record) — audit + emit the toast frame.
    const saved = event.volumes.filter(v => v.status === 'saved')
    await this.deps.audit.record(GUARD_AUDIT_EVENTS.snapshot, {
      eventId: id,
      kind,
      trigger,
      volumeCount: saved.length,
      totalBytes: event.totalBytes,
    })
    this.emit({
      event: 'snapshot',
      data: { id, kind, volumes: event.volumes.map(v => ({ volume: v.volume, status: v.status, sizeBytes: v.sizeBytes })) },
    })
    return event
  }

  /** Snapshot one volume into the event dir, honoring dedup + the caps. */
  private async snapshotVolume(
    event: GuardEvent,
    volume: string,
    eventDir: string,
    perVolCap: number,
    eventBytesSoFar: () => number,
    eventCap: number,
    settings: GuardSettings,
  ): Promise<GuardVolumeSnapshot> {
    const tarName = `${volume.replace(/[^a-z0-9_.-]/gi, '_')}.tar.gz`
    const tarPath = path.join(eventDir, tarName)
    try {
      // §6.5 dedup — fingerprint and compare to this volume's most recent saved snapshot.
      const fingerprint = await this.deps.docker.fingerprintVolume(volume, event.id).catch(() => undefined)
      if (fingerprint) {
        const prior = await this.findPriorSnapshot(volume, fingerprint)
        if (prior) {
          await this.deps.audit.record(GUARD_AUDIT_EVENTS.skipped, { eventId: event.id, volume, reason: 'unchanged' })
          return { volume, status: 'skipped_unchanged', sizeBytes: prior.sizeBytes, fingerprint, tarPath: prior.tarPath, detail: 'reused prior snapshot' }
        }
      }

      // Cheap pre-tar cap check — skip a known-huge volume without taring it.
      const apparent = await this.deps.docker.volumeSizeBytes(volume)
      if (apparent > 0 && apparent > perVolCap) {
        return this.tooLarge(event, volume, apparent, perVolCap, fingerprint)
      }

      // Per-event budget: if this volume can't possibly fit, skip honestly.
      if (eventBytesSoFar() >= eventCap) {
        const snap: GuardVolumeSnapshot = { volume, status: 'skipped_too_large', sizeBytes: 0, fingerprint, detail: 'per-event cap reached' }
        await this.deps.audit.record(GUARD_AUDIT_EVENTS.skipped, { eventId: event.id, volume, reason: 'per-event cap reached' })
        return snap
      }

      await this.deps.docker.exportVolume(volume, tarPath)
      const sizeBytes = (await fs.stat(tarPath)).size

      // Post-tar cap enforcement (apparent size may have been 0/unavailable).
      if (sizeBytes > perVolCap) {
        await fs.remove(tarPath).catch(() => {})
        return this.tooLarge(event, volume, sizeBytes, perVolCap, fingerprint)
      }
      if (eventBytesSoFar() + sizeBytes > eventCap) {
        await fs.remove(tarPath).catch(() => {})
        await this.deps.audit.record(GUARD_AUDIT_EVENTS.skipped, { eventId: event.id, volume, reason: 'per-event cap reached' })
        return { volume, status: 'skipped_too_large', sizeBytes: 0, fingerprint, detail: 'per-event cap reached' }
      }

      return { volume, status: 'saved', sizeBytes, fingerprint, tarPath }
    } catch (err: any) {
      // Fail-open: record + warn, never throw (§7.1).
      await fs.remove(tarPath).catch(() => {})
      await this.deps.audit.record(GUARD_AUDIT_EVENTS.snapshot_failed, {
        eventId: event.id,
        volume,
        reason: err?.message || String(err),
      })
      this.emit({ event: 'warning', data: { id: event.id, volume, reason: err?.message || String(err) } })
      return { volume, status: 'failed', sizeBytes: 0, detail: err?.message || String(err) }
    }
  }

  private async tooLarge(event: GuardEvent, volume: string, sizeBytes: number, cap: number, fingerprint?: string): Promise<GuardVolumeSnapshot> {
    const detail = `over per-volume cap (${Math.round(sizeBytes / MB)}MB > ${Math.round(cap / MB)}MB)`
    await this.deps.audit.record(GUARD_AUDIT_EVENTS.snapshot_failed, { eventId: event.id, volume, reason: detail })
    this.emit({ event: 'warning', data: { id: event.id, volume, reason: detail } })
    return { volume, status: 'skipped_too_large', sizeBytes: 0, fingerprint, detail }
  }

  // -------------------------------------------------------------------------
  // Scope resolution (§3.5 / §6.4)
  // -------------------------------------------------------------------------

  /** Filter the op's target volumes down to those in-scope per GuardSettings. */
  private async resolveInScope(volumeNames: string[], settings: GuardSettings): Promise<string[]> {
    if (settings.scope === 'off' || !settings.enabled) return []

    // Named (non-anonymous) volumes that actually exist on the host. Anonymous
    // volumes have 64-hex-char names; we exclude them from 'named'/'all-*'.
    const onHost = await this.deps.docker.listVolumes().catch(() => [] as any[])
    const named = new Set<string>(onHost.filter(v => !isAnonymous(v.Name)).map(v => v.Name))
    // Restrict to the op's targets (the caller already resolved which volumes
    // the op destroys; we never snapshot volumes the op won't touch).
    const targets = volumeNames.filter(n => named.has(n))

    if (settings.scope === 'protected') {
      const protectedSet = await this.protectedVolumes()
      return targets.filter(n => protectedSet.has(n))
    }
    if (settings.scope === 'all-named-under-cap') {
      const cap = settings.perVolumeCapMb * MB
      const out: string[] = []
      for (const n of targets) {
        const sz = await this.deps.docker.volumeSizeBytes(n)
        if (sz === 0 || sz <= cap) out.push(n) // over-cap listed as unguarded elsewhere
      }
      return out
    }
    // 'named' — every named target volume.
    return targets
  }

  /** Volumes referenced by any policy target (protectStack writes volume targets). */
  private async protectedVolumes(): Promise<Set<string>> {
    const policies = await this.deps.policyManager.listPolicies().catch(() => [])
    const set = new Set<string>()
    for (const p of policies) {
      for (const t of p.targets || []) {
        if (t.type === 'volume') set.add(t.selector)
      }
    }
    return set
  }

  // -------------------------------------------------------------------------
  // Dedup lookup (§6.5)
  // -------------------------------------------------------------------------

  /** Most recent SAVED snapshot of `volume` whose fingerprint matches, with a
   *  tarball that still exists on disk. */
  private async findPriorSnapshot(volume: string, fingerprint: string): Promise<{ tarPath: string; sizeBytes: number } | undefined> {
    const recent = await this.deps.db.listGuardEvents({ status: 'saved', limit: 200 })
    for (const ev of recent) {
      const v = ev.volumes.find(x => x.volume === volume && x.fingerprint === fingerprint && x.status === 'saved' && x.tarPath)
      if (v && v.tarPath && (await fs.pathExists(v.tarPath))) {
        return { tarPath: v.tarPath, sizeBytes: v.sizeBytes }
      }
    }
    return undefined
  }

  // -------------------------------------------------------------------------
  // Budget + LRU eviction (§6.3)
  // -------------------------------------------------------------------------

  /** Evict oldest non-pinned events until `budget - used >= need` or none remain. */
  private async evictForBudget(settings: GuardSettings, need: number): Promise<void> {
    const budget = settings.diskBudgetMb * MB
    let used = await this.deps.db.sumGuardBytes()
    if (budget - used >= need) return

    // Oldest-first, non-pinned, non-expired candidates.
    const all = await this.deps.db.listGuardEvents({ limit: 500 })
    const candidates = all
      .filter(e => !e.pinned && e.status !== 'expired')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    for (const ev of candidates) {
      if (budget - used >= need) break
      const reclaimed = await this.deleteTarballs(ev)
      await this.deps.db.updateGuardEventStatus(ev.id, 'expired')
      await this.deps.audit.record(GUARD_AUDIT_EVENTS.expired, { eventId: ev.id, reclaimedBytes: reclaimed })
      used = Math.max(0, used - ev.totalBytes)
    }
  }

  // -------------------------------------------------------------------------
  // (2) restore() — re-import via DockerService.importVolume (§3 step 5)
  // -------------------------------------------------------------------------

  public async restore(eventId: string, volumes?: string[]): Promise<{ restored: string[]; failed: string[] }> {
    const event = await this.deps.db.getGuardEvent(eventId)
    if (!event) throw new Error(`guard event not found: ${eventId}`)

    const wanted = volumes && volumes.length ? new Set(volumes) : null
    const restored: string[] = []
    const failed: string[] = []

    for (const v of event.volumes) {
      if (wanted && !wanted.has(v.volume)) continue
      if (!v.tarPath || (v.status !== 'saved' && v.status !== 'skipped_unchanged')) {
        failed.push(v.volume)
        continue
      }
      try {
        await this.deps.docker.importVolume(v.volume, v.tarPath)
        restored.push(v.volume)
      } catch (err: any) {
        logger.error({ err, eventId, volume: v.volume }, '[Guard] restore failed for volume')
        failed.push(v.volume)
      }
    }

    if (restored.length) {
      await this.deps.db.setGuardEventRestoredAt(eventId, new Date().toISOString())
      await this.deps.db.updateGuardEventStatus(eventId, 'restored')
      await this.deps.audit.record(GUARD_AUDIT_EVENTS.restore, { eventId, volumes: restored })
    }
    return { restored, failed }
  }

  // -------------------------------------------------------------------------
  // (3) pin() / (4) remove()
  // -------------------------------------------------------------------------

  /** Mark an event pinned — never auto-evicted (the PolicyManager promotion
   *  bridge is the PG-1.7 follow-up). */
  public async pin(eventId: string): Promise<void> {
    await this.deps.db.setGuardEventPinned(eventId, true)
  }

  /** Drop the row + every tarball immediately (user reclaims disk). */
  public async remove(eventId: string): Promise<{ reclaimedBytes: number }> {
    const event = await this.deps.db.getGuardEvent(eventId)
    let reclaimedBytes = 0
    if (event) {
      reclaimedBytes = await this.deleteTarballs(event)
      await fs.remove(path.join(this.guardCacheDir, eventId)).catch(() => {})
    }
    await this.deps.db.deleteGuardEvent(eventId)
    return { reclaimedBytes }
  }

  // -------------------------------------------------------------------------
  // (5) sweepExpired() — TTL sweep (§6.3). Cron wiring is PG-1.3/1.4.
  // -------------------------------------------------------------------------

  public async sweepExpired(now: Date = new Date()): Promise<{ expired: number; reclaimedBytes: number }> {
    const expired = await this.deps.db.listExpiredGuardEvents(now.toISOString())
    let reclaimedBytes = 0
    for (const ev of expired) {
      const reclaimed = await this.deleteTarballs(ev)
      reclaimedBytes += reclaimed
      await this.deps.db.updateGuardEventStatus(ev.id, 'expired')
      await this.deps.audit.record(GUARD_AUDIT_EVENTS.expired, { eventId: ev.id, reclaimedBytes: reclaimed })
    }
    return { expired: expired.length, reclaimedBytes }
  }

  // -------------------------------------------------------------------------
  // (6) floorSnapshot() — periodic last-known-good, ONE per volume (§6.5)
  // -------------------------------------------------------------------------

  /**
   * Periodic floor: keep exactly one `periodic_floor` event per volume. Each
   * call supersedes the previous floor for the named volumes (deletes the old
   * tarballs + row) so the floor footprint stays bounded by Σ(volume sizes).
   */
  public async floorSnapshot(volumeNames: string[]): Promise<GuardEvent> {
    // Delete prior periodic_floor events that cover any of these volumes.
    const priorFloors = await this.deps.db.listGuardEvents({ limit: 500 })
    for (const ev of priorFloors) {
      if (ev.kind !== 'periodic_floor') continue
      if (ev.volumes.some(v => volumeNames.includes(v.volume))) {
        await this.remove(ev.id)
      }
    }
    return this.guard('periodic_floor', 'periodic', volumeNames)
  }

  // -------------------------------------------------------------------------
  // (8) recordTooLate() — PG-1.3 calls this on a 'volume destroy' event
  // -------------------------------------------------------------------------

  /**
   * The op already destroyed `volume` before we could snapshot. Look up the
   * most recent floor snapshot's age and emit a too_late frame + audit so the
   * UI can offer "restore that stale snapshot".
   */
  public async recordTooLate(volume: string): Promise<{ floorSnapshotAgeHours: number | null; eventId: string | null }> {
    const recent = await this.deps.db.listGuardEvents({ limit: 500 })
    let floor: GuardEvent | undefined
    for (const ev of recent) {
      if (ev.status === 'expired') continue
      if (ev.volumes.some(v => v.volume === volume && (v.status === 'saved' || v.status === 'skipped_unchanged'))) {
        floor = ev
        break // listGuardEvents is newest-first
      }
    }
    const ageHours = floor ? (Date.now() - new Date(floor.createdAt).getTime()) / 3600_000 : null
    await this.deps.audit.record(GUARD_AUDIT_EVENTS.too_late, {
      eventId: floor?.id ?? null,
      volume,
      floorSnapshotAgeHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
    })
    this.emit({ event: 'too_late', data: { id: floor?.id ?? null, volume, floorSnapshotAgeHours: ageHours } })
    return { floorSnapshotAgeHours: ageHours, eventId: floor?.id ?? null }
  }

  // -------------------------------------------------------------------------
  // (7) reapOrphans() — boot reaper, modeled on RehearsalService.reapOrphans
  // -------------------------------------------------------------------------

  /** Remove helper containers left labelled `com.gozippy.drk.guard=*` by a
   *  crash mid-snapshot. Safe at any time; intended for process startup. */
  public async reapOrphans(): Promise<{ containers: number }> {
    const dockerode = (this.deps.docker as any).docker as Dockerode
    let containers = 0
    try {
      const list = await dockerode.listContainers({ all: true, filters: { label: [GUARD_LABEL] } as any })
      for (const ci of list) {
        try {
          const c = dockerode.getContainer(ci.Id)
          try { await c.stop({ t: 1 }) } catch { /* may already be stopped */ }
          await c.remove({ force: true })
          containers++
        } catch { /* best effort */ }
      }
    } catch { /* dockerode missing labeled filter — best effort */ }
    if (containers > 0) logger.info({ containers }, '[Guard] reaped orphan helper containers')
    return { containers }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Delete every tarball this event owns under guard-cache that it doesn't
   *  share (skipped_unchanged references a *prior* event's tar, so we only
   *  delete tarballs physically inside THIS event's dir). Returns bytes freed. */
  private async deleteTarballs(event: GuardEvent): Promise<number> {
    const eventDir = path.join(this.guardCacheDir, event.id)
    let freed = 0
    for (const v of event.volumes) {
      if (!v.tarPath) continue
      // Only delete tarballs that live in this event's own dir (don't clobber a
      // dedup-referenced prior tarball owned by an earlier event).
      if (path.resolve(path.dirname(v.tarPath)) !== path.resolve(eventDir)) continue
      try {
        if (await fs.pathExists(v.tarPath)) {
          freed += (await fs.stat(v.tarPath)).size
          await fs.remove(v.tarPath)
        }
      } catch { /* best effort */ }
    }
    await fs.remove(eventDir).catch(() => {})
    return freed
  }

  private deriveStatus(volumes: GuardVolumeSnapshot[]): GuardEvent['status'] {
    const anySaved = volumes.some(v => v.status === 'saved' || v.status === 'skipped_unchanged')
    const anyBad = volumes.some(v => v.status === 'failed' || v.status === 'skipped_too_large')
    if (anySaved && anyBad) return 'partial'
    if (anySaved) return 'saved'
    if (anyBad) return 'failed'
    return 'saved' // nothing in-scope → benign no-op
  }

  private async persist(event: GuardEvent): Promise<void> {
    await this.deps.db.insertGuardEvent(event)
  }

  // -------------------------------------------------------------------------
  // Concurrency primitives (copied from RehearsalService — §11)
  // -------------------------------------------------------------------------

  private async withSemaphore<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  private async acquire(): Promise<void> {
    if (this.semaphore.inUse < this.semaphore.capacity) {
      this.semaphore.inUse++
      return
    }
    await new Promise<void>(resolve => this.semaphore.waiters.push(resolve))
    this.semaphore.inUse++
  }

  private release(): void {
    this.semaphore.inUse = Math.max(0, this.semaphore.inUse - 1)
    const next = this.semaphore.waiters.shift()
    if (next) next()
  }
}

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------

/** Anonymous Docker volumes are named with a 64-char lowercase hex id. */
function isAnonymous(name: string): boolean {
  return /^[0-9a-f]{64}$/.test(name)
}
