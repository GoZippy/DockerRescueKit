import fs from 'fs-extra'
import path from 'path'
import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type Dockerode from 'dockerode'
import {
  RehearsalRequest,
  RehearsalReport,
  RehearsalStatus,
  RehearsalStep,
  SmokeCheck,
  SmokeCheckResult,
  SCRUB_ENV_DEFAULT_PATTERNS,
} from '@docker-rescue-kit/shared'
import { DockerService } from './DockerService'
import { PolicyManager } from './PolicyManager'
import { AuditService } from './AuditService'
import { Database } from '../db/Database'
import { StorageFactory } from '../storage/StorageFactory'
import { safeJoin, safeFilenameFragment } from '../utils/PathSafety'
import { logger } from '../utils/logger'
import { createSmokeCheckRegistry, SmokeCheckContext, SmokeCheckRunner } from './SmokeCheckRunners'

/**
 * RehearsalService — the R-1 restore-rehearsal workflow.
 *
 * Spawns a sandboxed bridge network, restores the requested backups into
 * temporary volumes, brings up stand-in containers, runs operator-supplied
 * smoke checks, and tears down every resource it created. Writes a full
 * `RehearsalReport` to the audit log and to the `rehearsals` table.
 *
 * See `docs/design/R-1_RESTORE_REHEARSAL.md` for the full spec — every
 * section number referenced in comments below points back to that doc.
 */

const REHEARSAL_LABEL = 'com.gozippy.drk.rehearsal'
const DEFAULT_SUBNET = '172.31.255.0/24'
const DEFAULT_TIMEOUT_MS = 30 * 60_000 // 30 minutes
const DEFAULT_CONCURRENCY = parseInt(process.env.DRK_REHEARSAL_CONCURRENCY || '2', 10)

export interface RehearsalServiceDeps {
  docker: DockerService
  policyManager: PolicyManager
  audit: AuditService
  stagingDir: string
  db: Database
}

interface InternalRun {
  id: string
  request: RehearsalRequest
  report: RehearsalReport
  emitter: EventEmitter
  abortController: AbortController
}

export class RehearsalService {
  private readonly registry: Map<SmokeCheck['kind'], SmokeCheckRunner>
  private readonly active = new Map<string, InternalRun>()
  private readonly semaphore: { capacity: number; inUse: number; waiters: Array<() => void> }

  constructor(private readonly deps: RehearsalServiceDeps) {
    this.registry = createSmokeCheckRegistry()
    this.semaphore = { capacity: Math.max(1, DEFAULT_CONCURRENCY), inUse: 0, waiters: [] }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Enqueue a rehearsal. Returns the new rehearsal id immediately; the
   *  actual run is async and observable via {@link getReport} or
   *  {@link subscribe}. */
  public async enqueue(request: RehearsalRequest): Promise<string> {
    this.validateRequest(request)

    const id = uuidv4()
    const startedAt = new Date().toISOString()
    const report: RehearsalReport = {
      id,
      policyId: request.policyId,
      requestedBackupIds: [],
      status: 'pending',
      ok: false,
      steps: [],
      smokeCheckResults: [],
      startedAt,
      finishedAt: '',
      durationMs: 0,
      resources: { containers: [], volumes: [] },
    }

    const run: InternalRun = {
      id,
      request,
      report,
      emitter: new EventEmitter(),
      abortController: new AbortController(),
    }
    this.active.set(id, run)

    // Persist pending state up front so the rehearsal is visible to GET
    // immediately, before the worker has a chance to start.
    await this.persist(report)

    // Fire-and-forget the worker; persist its finalisation via the run loop.
    void this.runWorker(run).catch(err => {
      logger.error({ err, rehearsalId: id }, '[Rehearsal] worker crashed unexpectedly')
    })

    return id
  }

  public async getReport(id: string): Promise<RehearsalReport | null> {
    const active = this.active.get(id)
    if (active) return active.report
    const row = await this.deps.db.getRehearsal(id)
    return row ? (row.report as RehearsalReport) : null
  }

  public async list(opts?: { policyId?: string; limit?: number }): Promise<Array<{ id: string; policyId?: string; status: string; ok: boolean; startedAt: string; finishedAt?: string; durationMs?: number }>> {
    return this.deps.db.listRehearsals(opts)
  }

  public subscribe(id: string, listener: (frame: { event: string; data: unknown }) => void): () => void {
    const run = this.active.get(id)
    if (!run) {
      // If the run is already finished, replay a final 'done' frame so the
      // caller doesn't hang.
      this.getReport(id).then(r => {
        if (r) listener({ event: 'done', data: { ok: r.ok, durationMs: r.durationMs } })
      })
      return () => {}
    }
    const handler = (frame: { event: string; data: unknown }) => listener(frame)
    run.emitter.on('frame', handler)
    return () => run.emitter.off('frame', handler)
  }

  public async abort(id: string): Promise<boolean> {
    const run = this.active.get(id)
    if (!run) return false
    run.abortController.abort()
    return true
  }

  // -------------------------------------------------------------------------
  // Lifecycle internals
  // -------------------------------------------------------------------------

  private async runWorker(run: InternalRun): Promise<void> {
    await this.acquire()
    try {
      await this.executeRun(run)
    } finally {
      this.release()
      this.active.delete(run.id)
      run.emitter.emit('frame', { event: 'done', data: { ok: run.report.ok, durationMs: run.report.durationMs } })
    }
  }

  private async executeRun(run: InternalRun): Promise<void> {
    const { docker, policyManager, audit, stagingDir, db } = this.deps
    const startMs = Date.now()
    const overallTimeoutMs = run.request.options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const overallTimeout = setTimeout(() => run.abortController.abort(), overallTimeoutMs)

    const trackResource = (kind: 'container' | 'volume' | 'network', name: string) => {
      if (kind === 'container') run.report.resources.containers.push(name)
      else if (kind === 'volume') run.report.resources.volumes.push(name)
      else if (kind === 'network') run.report.resources.network = name
    }

    let networkId: string | undefined

    try {
      // (1) PLAN — resolve backup ids
      this.updateStatus(run, 'preparing')
      const backups = await this.resolveBackups(run.request)
      run.report.requestedBackupIds.splice(0, run.report.requestedBackupIds.length, ...backups.map(b => b.id))
      this.recordStep(run, 'plan', true, `${backups.length} backup(s) resolved`)

      if (backups.length === 0) {
        this.recordStep(run, 'plan', false, 'no backups to rehearse')
        await this.finalize(run, 'failed', startMs)
        return
      }

      // (2) PREPARE — create sandbox network
      this.updateStatus(run, 'preparing')
      const networkName = `drk-rehearsal-${run.id.slice(0, 8)}`
      const networkSubnet = run.request.options?.networkSubnet || DEFAULT_SUBNET
      try {
        const dockerode = (docker as any).docker as Dockerode
        const created = await dockerode.createNetwork({
          Name: networkName,
          Driver: 'bridge',
          Internal: true, // §6.1: no external routing — sandbox is isolated
          Attachable: true,
          Labels: { [REHEARSAL_LABEL]: run.id },
          IPAM: { Config: [{ Subnet: networkSubnet }] },
        } as any)
        networkId = (created as any).id || networkName
        trackResource('network', networkName)
        this.recordStep(run, 'prepare-network', true, `${networkName} (${networkSubnet})`)
      } catch (err: any) {
        this.recordStep(run, 'prepare-network', false, err?.message || String(err))
        await this.finalize(run, 'failed', startMs)
        return
      }

      this.checkAbort(run)

      // (3) RESTORE — for each volume backup, restore to a temp volume
      this.updateStatus(run, 'restoring')
      const workDir = safeJoin(stagingDir, `rehearsal-${safeFilenameFragment(run.id)}`)
      await fs.ensureDir(workDir)
      const volumeNameMap: Record<string, string> = {}

      for (const backup of backups) {
        this.checkAbort(run)
        const policy = await policyManager.getPolicy(backup.policyId)
        if (!policy) {
          this.recordStep(run, `restore:${backup.id}`, false, 'policy not found')
          await this.finalize(run, 'failed', startMs)
          return
        }
        const adapter = StorageFactory.create(policy.storage.type, policy.storage)

        const manifestRemote = path.posix.join(backup.id, 'manifest.json')
        const manifestLocal = safeJoin(workDir, `${safeFilenameFragment(backup.id)}-manifest.json`)
        await adapter.download(manifestRemote, manifestLocal)
        const manifest = await fs.readJson(manifestLocal)

        for (const file of manifest.files as Array<{ remote: string; checksum: string }>) {
          const base = path.basename(file.remote).replace(/\.tar\.gz$/, '')
          const [type, ...rest] = base.split('_')
          if (type !== 'volume') continue
          const originalSelector = rest.join('_')
          const localTar = safeJoin(workDir, safeFilenameFragment(path.basename(file.remote)))
          await adapter.download(file.remote, localTar)
          const tempVolume = `drk-reh-${run.id.slice(0, 8)}-${originalSelector}`.replace(/[^a-z0-9_.-]/gi, '_')
          await docker.importVolume(tempVolume, localTar)
          trackResource('volume', tempVolume)
          volumeNameMap[originalSelector] = tempVolume
          this.recordStep(run, `restore-volume:${originalSelector}`, true, tempVolume)
        }
      }

      // Clean up the staging dir — we have the volumes; tarballs no longer needed
      await fs.remove(workDir).catch(() => {})

      this.checkAbort(run)

      // (4) LAUNCH — stand-in containers on the sandbox network
      this.updateStatus(run, 'launching')
      const containerNameMap: Record<string, string> = {}
      const dockerode = (docker as any).docker as Dockerode
      // For the MVP, the request is the source of truth for which containers
      // to bring up: each declared smoke check names a container. We launch
      // one stand-in per unique container referenced by the smoke checks.
      const wantedContainers = unique(run.request.smokeChecks.map(c => c.container))

      for (const logicalName of wantedContainers) {
        this.checkAbort(run)
        const sourceInfo = await this.getSourceContainerSpec(logicalName)
        if (!sourceInfo) {
          this.recordStep(run, `launch:${logicalName}`, false, 'source container/spec not found on host')
          await this.finalize(run, 'failed', startMs)
          return
        }

        const standInName = `drk-reh-${run.id.slice(0, 8)}-${logicalName}`.replace(/[^a-z0-9_.-]/gi, '_')
        const scrubbedEnv = this.scrubEnv(sourceInfo.env, run.request.options?.allowEnvVars)
        const volumeMounts = this.remapMounts(sourceInfo.mounts, volumeNameMap)

        const created = await dockerode.createContainer({
          name: standInName,
          Image: sourceInfo.image,
          Cmd: sourceInfo.cmd,
          Env: scrubbedEnv,
          HostConfig: {
            NetworkMode: networkName,
            Binds: volumeMounts,
            // §6.2/§6.3: never expose ports, never mount the docker socket
            PortBindings: {},
            AutoRemove: false,
          },
          NetworkingConfig: {
            EndpointsConfig: {
              [networkName]: {
                Aliases: [logicalName], // so smoke checks can reach by logical name
              },
            },
          },
          Labels: { [REHEARSAL_LABEL]: run.id },
        } as any)
        await created.start()
        trackResource('container', standInName)
        containerNameMap[logicalName] = standInName
        this.recordStep(run, `launch:${logicalName}`, true, standInName)
      }

      // Give containers a moment to settle before probing. The smoke-check
      // timeouts handle the "still starting" case but a small grace shaves
      // false negatives on the first probe.
      await sleep(2_000)

      // (5) PROBE — run smoke checks in declared order
      this.updateStatus(run, 'probing')
      const ctx: SmokeCheckContext = {
        network: networkName,
        containerNameMap,
        docker,
        signal: run.abortController.signal,
      }
      const stopOnFail = run.request.options?.stopOnFirstCheckFailure ?? true
      let anyCheckFailed = false

      for (const check of run.request.smokeChecks) {
        if (run.abortController.signal.aborted) break
        const runner = this.registry.get(check.kind)
        if (!runner) {
          const failResult: SmokeCheckResult = {
            check,
            ok: false,
            detail: `no runner registered for kind=${check.kind}`,
            attempt: 1,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: 0,
          }
          run.report.smokeCheckResults.push(failResult)
          run.emitter.emit('frame', { event: 'check', data: failResult })
          anyCheckFailed = true
          if (stopOnFail) break
          continue
        }
        const result = await runner.run(check, ctx)
        run.report.smokeCheckResults.push(result)
        run.emitter.emit('frame', { event: 'check', data: result })
        if (!result.ok) {
          anyCheckFailed = true
          if (stopOnFail) break
        }
      }

      // (6) TEARDOWN happens in the finally block below — guaranteed
      await this.finalize(run, anyCheckFailed ? 'failed' : 'success', startMs)
    } catch (err: any) {
      logger.error({ err, rehearsalId: run.id }, '[Rehearsal] run failed mid-flight')
      this.recordStep(run, 'run', false, err?.message || String(err))
      await this.finalize(run, 'failed', startMs)
    } finally {
      clearTimeout(overallTimeout)
      await this.teardown(run, networkId)
    }
  }

  private async finalize(run: InternalRun, status: RehearsalStatus, startMs: number): Promise<void> {
    if (run.abortController.signal.aborted && status !== 'success') {
      status = 'aborted'
    }
    const end = Date.now()
    const mutable = run.report as any
    mutable.status = status
    mutable.ok = status === 'success'
    mutable.finishedAt = new Date(end).toISOString()
    mutable.durationMs = end - startMs

    await this.persist(run.report)
    await this.deps.audit.record('rehearsal.complete', {
      rehearsalId: run.id,
      ok: run.report.ok,
      durationMs: run.report.durationMs,
      smokeFailures: run.report.smokeCheckResults.filter(r => !r.ok).length,
    })
  }

  private async teardown(run: InternalRun, networkId: string | undefined): Promise<void> {
    this.updateStatus(run, 'tearing_down')
    const { docker } = this.deps
    const dockerode = (docker as any).docker as Dockerode
    const lingering: { containers: string[]; volumes: string[]; network?: string } = { containers: [], volumes: [] }

    // Containers first (so volumes can be removed)
    for (const name of run.report.resources.containers) {
      try {
        const c = dockerode.getContainer(name)
        try { await c.stop({ t: 5 }) } catch { /* may already be stopped */ }
        await c.remove({ force: true })
      } catch (err: any) {
        lingering.containers.push(name)
      }
    }

    for (const name of run.report.resources.volumes) {
      try {
        await dockerode.getVolume(name).remove({ force: true })
      } catch (err: any) {
        lingering.volumes.push(name)
      }
    }

    if (run.report.resources.network) {
      try {
        await dockerode.getNetwork(run.report.resources.network).remove()
      } catch (err: any) {
        lingering.network = run.report.resources.network
      }
    }

    if (lingering.containers.length || lingering.volumes.length || lingering.network) {
      await this.deps.audit.record('rehearsal.teardown_failed', {
        rehearsalId: run.id,
        lingeringResources: lingering,
      })
      logger.warn({ rehearsalId: run.id, lingering }, '[Rehearsal] teardown left resources behind')
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private validateRequest(req: RehearsalRequest): void {
    if (!Array.isArray(req.smokeChecks) || req.smokeChecks.length === 0) {
      throw new Error('smokeChecks must be a non-empty array')
    }
    if (!req.policyId && !req.backupIds?.length) {
      throw new Error('Either policyId or backupIds must be supplied')
    }
    if (req.policyId && req.backupIds?.length) {
      throw new Error('policyId and backupIds are mutually exclusive — pick one')
    }
    for (const c of req.smokeChecks) {
      if (!c.container) throw new Error(`smoke check missing container: ${JSON.stringify(c)}`)
    }
  }

  private async resolveBackups(req: RehearsalRequest) {
    if (req.backupIds?.length) {
      const out: any[] = []
      for (const id of req.backupIds) {
        const b = await this.deps.policyManager.getBackup(id)
        if (b) out.push(b)
      }
      return out
    }
    if (req.policyId) {
      const all = await (this.deps.db as any).getBackupsForPolicy?.(req.policyId)
      if (Array.isArray(all)) {
        // pick the latest successful for this policy
        const success = all.filter((b: any) => b.status === 'success')
        return success.slice(0, 1)
      }
      // Fallback to global getBackup if the helper doesn't exist
      const single = await this.deps.policyManager.getBackup(req.policyId).catch(() => null)
      return single ? [single] : []
    }
    return []
  }

  private async getSourceContainerSpec(logicalName: string): Promise<
    | { image: string; cmd?: string[]; env: string[]; mounts: Array<{ Type: string; Source?: string; Name?: string; Destination: string; Mode?: string }> }
    | null
  > {
    try {
      const dockerode = (this.deps.docker as any).docker as Dockerode
      const c = dockerode.getContainer(logicalName)
      const info = await c.inspect()
      return {
        image: info.Config.Image,
        cmd: info.Config.Cmd || undefined,
        env: info.Config.Env || [],
        mounts: (info.Mounts as any[]).map(m => ({
          Type: m.Type,
          Source: m.Source,
          Name: m.Name,
          Destination: m.Destination,
          Mode: m.Mode,
        })),
      }
    } catch {
      return null
    }
  }

  private scrubEnv(env: string[], allowVars?: string[]): string[] {
    const allow = new Set((allowVars || []).map(v => v.toUpperCase()))
    const result: string[] = []
    for (const entry of env) {
      const idx = entry.indexOf('=')
      const name = idx >= 0 ? entry.slice(0, idx) : entry
      const upper = name.toUpperCase()
      if (allow.has(upper)) {
        result.push(entry)
        continue
      }
      const matches = SCRUB_ENV_DEFAULT_PATTERNS.some(re => re.test(name))
      if (!matches) result.push(entry)
    }
    return result
  }

  private remapMounts(
    mounts: Array<{ Type: string; Source?: string; Name?: string; Destination: string; Mode?: string }>,
    volumeNameMap: Record<string, string>
  ): string[] {
    const binds: string[] = []
    for (const m of mounts) {
      if (m.Type === 'volume' && m.Name && volumeNameMap[m.Name]) {
        binds.push(`${volumeNameMap[m.Name]}:${m.Destination}${m.Mode ? ':' + m.Mode : ''}`)
      } else if (m.Type === 'bind') {
        // Bind mounts are intentionally NOT carried into rehearsals — they
        // point at host paths that aren't part of the backup. Smoke checks
        // that need bind-mount content must declare it explicitly via a
        // future request option (out of scope for the MVP).
        continue
      }
      // tmpfs and other types: skip; stand-ins will allocate fresh tmpfs on
      // their own from the source image's defaults.
    }
    return binds
  }

  private updateStatus(run: InternalRun, status: RehearsalStatus): void {
    const mutable = run.report as any
    mutable.status = status
    run.emitter.emit('frame', { event: 'status', data: { status } })
  }

  private recordStep(run: InternalRun, label: string, ok: boolean, detail?: string): void {
    const now = new Date().toISOString()
    const step: RehearsalStep = {
      label,
      ok,
      detail,
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
    }
    run.report.steps.push(step)
    run.emitter.emit('frame', { event: 'step', data: step })
  }

  private checkAbort(run: InternalRun): void {
    if (run.abortController.signal.aborted) {
      throw new Error('rehearsal aborted')
    }
  }

  private async persist(report: RehearsalReport): Promise<void> {
    await this.deps.db.saveRehearsalReport({
      id: report.id,
      policyId: report.policyId,
      requestedBackupIds: report.requestedBackupIds,
      status: report.status,
      ok: report.ok,
      report,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt || undefined,
      durationMs: report.durationMs || undefined,
    })
  }

  // -------------------------------------------------------------------------
  // Concurrency primitives
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Orphan reaper (process-start hook)
  // -------------------------------------------------------------------------

  /** Sweep for resources labelled with this service's REHEARSAL_LABEL whose
   *  rehearsal record is not 'pending'/'preparing'/'restoring'/etc — i.e.,
   *  resources left behind by a previous crashed run. Safe to call at any
   *  time; intended for process startup. */
  public async reapOrphans(): Promise<{ containers: number; volumes: number; networks: number }> {
    const dockerode = (this.deps.docker as any).docker as Dockerode
    const stats = { containers: 0, volumes: 0, networks: 0 }

    try {
      const containers = await dockerode.listContainers({
        all: true,
        filters: { label: [`${REHEARSAL_LABEL}`] } as any,
      })
      for (const ci of containers) {
        const runId = ci.Labels?.[REHEARSAL_LABEL]
        if (runId && this.active.has(runId)) continue // a live run owns it
        try {
          const c = dockerode.getContainer(ci.Id)
          try { await c.stop({ t: 1 }) } catch { /* may already be stopped */ }
          await c.remove({ force: true })
          stats.containers++
        } catch { /* best effort */ }
      }
    } catch { /* dockerode missing labeled filter — best effort */ }

    try {
      const vols: any = await (dockerode as any).listVolumes({ filters: { label: [`${REHEARSAL_LABEL}`] } })
      const volList: any[] = vols?.Volumes || []
      for (const v of volList) {
        const runId = v?.Labels?.[REHEARSAL_LABEL]
        if (runId && this.active.has(runId)) continue
        try { await dockerode.getVolume(v.Name).remove({ force: true }); stats.volumes++ } catch { /* best effort */ }
      }
    } catch { /* best effort */ }

    try {
      const nets: any[] = await (dockerode as any).listNetworks({ filters: { label: [`${REHEARSAL_LABEL}`] } }) || []
      for (const n of nets) {
        const runId = n?.Labels?.[REHEARSAL_LABEL]
        if (runId && this.active.has(runId)) continue
        try { await dockerode.getNetwork(n.Id).remove(); stats.networks++ } catch { /* best effort */ }
      }
    } catch { /* best effort */ }

    if (stats.containers + stats.volumes + stats.networks > 0) {
      logger.info({ stats }, '[Rehearsal] reaped orphans from previous run')
    }
    return stats
  }
}

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------

function unique<T>(xs: T[]): T[] {
  return Array.from(new Set(xs))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
