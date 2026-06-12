import cron from 'node-cron'
import type Dockerode from 'dockerode'
import type { DockerService } from './DockerService'
import type { SettingsService } from './SettingsService'
import type { PruneGuardService } from './PruneGuardService'
import { logger } from '../utils/logger'

/**
 * GuardMonitor — PG-1.3 event-reactive floor (docs/design/PRUNE_GUARD.md §4d, §5).
 *
 * Self-contained so SchedulerEngine stays untouched: it owns its own Docker
 * events subscription, the periodic-floor cron, and the daily TTL sweep, and
 * feeds them all into the already-landed `PruneGuardService` core. Keeping it
 * out of SchedulerEngine avoids coupling the guard's lifecycle to the
 * policy-scheduler's `start()/stop()` and keeps SchedulerEngine's diff zero —
 * the spec (§4d/§5) describes the floor as an independent subsystem, and the
 * guard ships behind its own kill-switch.
 *
 * Three jobs, all best-effort and crash-proof:
 *   1. Docker events stream → on `container die/destroy` opportunistically
 *      snapshot the container's named volumes (before the reap race closes);
 *      on `volume destroy` record a too_late (data already gone, §4d).
 *   2. Periodic floor cron (GuardSettings.periodicCron) → floorSnapshot() over
 *      the in-scope named volume set. Re-reads settings each tick so the
 *      scope/budget apply live; cadence changes follow the restart caveat the
 *      ExportService cron documents (SchedulerEngine.ts:54-60).
 *   3. Daily TTL sweep (setInterval(...).unref()) → sweepExpired().
 */

export interface GuardMonitorDeps {
  docker: DockerService
  settings: SettingsService
  guard: PruneGuardService
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Events-stream reconnect backoff (ms): 1s → 2s → … → 30s cap. */
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30_000

export class GuardMonitor {
  private eventStream: NodeJS.ReadableStream | null = null
  private floorJob: cron.ScheduledTask | null = null
  private sweepTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempt = 0
  private stopped = false
  private currentCron: string | null = null
  /** Guards against a floor pass outlasting the cron interval and being
   *  re-entered by the next tick (N8, mirrors SchedulerEngine). */
  private runningFloor = false

  constructor(private readonly deps: GuardMonitorDeps) {}

  /** Start all three jobs. Idempotent-ish; call once on boot when enabled. */
  public async start(): Promise<void> {
    this.stopped = false
    this.subscribeEvents()
    await this.scheduleFloor()
    this.scheduleSweep()
    logger.info('[GuardMonitor] started (events + periodic floor + TTL sweep)')
  }

  /** Stop every job + tear down the events stream. Safe to call repeatedly. */
  public stop(): void {
    this.stopped = true
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.floorJob) { this.floorJob.stop(); this.floorJob = null }
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null }
    this.destroyStream()
  }

  // -------------------------------------------------------------------------
  // (1) Docker events stream
  // -------------------------------------------------------------------------

  private get dockerode(): Dockerode {
    return (this.deps.docker as any).docker as Dockerode
  }

  private subscribeEvents(): void {
    if (this.stopped) return
    // Only the destructive events we react to (keeps the stream cheap).
    const filters = { event: ['die', 'destroy'], type: ['container', 'volume'] }
    this.dockerode.getEvents({ filters: filters as any }, (err, stream) => {
      if (err || !stream) {
        logger.warn({ err }, '[GuardMonitor] failed to open Docker events stream; will retry')
        this.scheduleReconnect()
        return
      }
      this.reconnectAttempt = 0
      this.eventStream = stream

      let buffer = ''
      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8')
        // Docker streams newline-delimited JSON; parse complete lines only.
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (line) this.handleEvent(line)
        }
      })
      stream.on('error', e => {
        logger.warn({ err: e }, '[GuardMonitor] Docker events stream error; reconnecting')
        this.scheduleReconnect()
      })
      stream.on('close', () => {
        if (!this.stopped) {
          logger.warn('[GuardMonitor] Docker events stream closed; reconnecting')
          this.scheduleReconnect()
        }
      })
      logger.info('[GuardMonitor] subscribed to Docker events')
    })
  }

  /** Parse + dispatch one events-stream JSON line. Never throws. */
  private async handleEvent(line: string): Promise<void> {
    let ev: any
    try {
      ev = JSON.parse(line)
    } catch {
      return // partial/garbage line — ignore
    }
    const type: string = ev?.Type
    const action: string = ev?.Action

    try {
      if (type === 'container' && (action === 'die' || action === 'destroy')) {
        const vols = await this.resolveContainerVolumes(ev?.Actor?.ID || ev?.id)
        if (vols.length) {
          // Best-effort, never blocks the daemon (§5, §11).
          await this.deps.guard.guard('container_die', 'event', vols)
        }
      } else if (type === 'volume' && action === 'destroy') {
        // Data already gone — record too_late + point at the floor (§4d/§5).
        const name = ev?.Actor?.ID || ev?.id
        if (name) await this.deps.guard.recordTooLate(String(name))
      }
    } catch (err) {
      logger.warn({ err, type, action }, '[GuardMonitor] event handling failed (best-effort)')
    }
  }

  /** Inspect a container BEFORE the reap race and resolve its NAMED volumes. */
  private async resolveContainerVolumes(containerId?: string): Promise<string[]> {
    if (!containerId) return []
    try {
      const info: any = await this.dockerode.getContainer(String(containerId)).inspect()
      const mounts: any[] = info?.Mounts || []
      const names = mounts
        .filter(m => m?.Type === 'volume' && typeof m?.Name === 'string' && m.Name)
        .map(m => m.Name as string)
      // De-dup.
      return Array.from(new Set(names))
    } catch {
      // Container already gone — we lost the race (§7.3). guard() no-ops on [].
      return []
    }
  }

  private scheduleReconnect(): void {
    this.destroyStream()
    if (this.stopped || this.reconnectTimer) return
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt)
    this.reconnectAttempt++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.subscribeEvents()
    }, delay)
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref()
  }

  private destroyStream(): void {
    if (this.eventStream) {
      try { (this.eventStream as any).destroy?.() } catch { /* best effort */ }
      this.eventStream = null
    }
  }

  // -------------------------------------------------------------------------
  // (2) Periodic floor cron
  // -------------------------------------------------------------------------

  private async scheduleFloor(): Promise<void> {
    const settings = await this.deps.settings.getGuardSettings().catch(() => null)
    const cronExpr = settings?.periodicCron
    if (!cronExpr || !cron.validate(cronExpr)) {
      logger.error({ cronExpr }, '[GuardMonitor] invalid periodic floor cron; floor disabled')
      return
    }
    this.currentCron = cronExpr
    this.floorJob = cron.schedule(cronExpr, () => {
      this.runFloorTick().catch(err =>
        logger.error({ err }, '[GuardMonitor] periodic floor tick failed'),
      )
    })
    logger.info({ cron: cronExpr }, '[GuardMonitor] periodic floor job registered')
  }

  /** One floor tick: re-read settings, resolve the in-scope named volume set,
   *  call floorSnapshot(). Re-reading settings means scope/budget apply live;
   *  a changed cron *cadence* still needs a restart (documented caveat). */
  public async runFloorTick(): Promise<void> {
    // Re-entrancy guard: skip if a prior pass is still in flight so a slow floor
    // (slower than the cron interval) never overlaps itself mid-write (N8).
    if (this.runningFloor) {
      logger.warn('[GuardMonitor] floor tick still running; skipping this tick')
      return
    }
    this.runningFloor = true
    try {
      const settings = await this.deps.settings.getGuardSettings()
      if (!settings.enabled || settings.scope === 'off') return
      const onHost = await this.deps.docker.listVolumes().catch(() => [] as any[])
      const named = onHost
        .map(v => v?.Name)
        .filter((n: any): n is string => typeof n === 'string' && !isAnonymous(n))
      if (named.length === 0) return
      // PruneGuardService.floorSnapshot re-applies the scope filter internally.
      await this.deps.guard.floorSnapshot(named)
    } finally {
      this.runningFloor = false
    }
  }

  // -------------------------------------------------------------------------
  // (3) Daily TTL sweep (mirrors index.ts:255-293 cleanup pattern)
  // -------------------------------------------------------------------------

  private scheduleSweep(): void {
    this.sweepTimer = setInterval(() => {
      this.deps.guard.sweepExpired().catch(err =>
        logger.error({ err }, '[GuardMonitor] TTL sweep failed'),
      )
    }, DAY_MS)
    // Don't keep the process alive just for this timer.
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref()
  }
}

/** Anonymous Docker volumes are named with a 64-char lowercase hex id. */
function isAnonymous(name: string): boolean {
  return /^[0-9a-f]{64}$/.test(name)
}
