import fs from 'fs-extra'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { Backup } from '@docker-rescue-kit/shared'
import { PolicyManager } from './PolicyManager'
import { DockerService } from './DockerService'
import { Database } from '../db/Database'
import { StorageFactory } from '../storage/StorageFactory'
import { sha256File } from '../utils/Checksum'
import { safeJoin, safeFilenameFragment } from '../utils/PathSafety'
import { logger } from '../utils/logger'

/**
 * Prefix for throwaway volumes created by a verify run. Anything carrying this
 * prefix is owned by VerifyService and is safe to reap on startup — verify runs
 * are synchronous within a single process, so a volume with this prefix that
 * survives a restart is by definition orphaned.
 */
export const SCRATCH_VOLUME_PREFIX = 'drk-verify-'

export interface VerifyReport {
  backupId: string
  ok: boolean
  steps: Array<{ label: string; ok: boolean; detail?: string }>
  startedAt: string
  finishedAt: string
  durationMs: number
}

/**
 * Scratch-restore a backup into a throwaway volume to prove that it is
 * actually restorable. The #1 thing real backup products do that hobby
 * scripts don't is prove periodically that the backups work.
 */
export class VerifyService {
  constructor(
    private policyManager: PolicyManager,
    private docker: DockerService,
    private stagingDir: string,
    private db?: Database
  ) {}

  public async verify(backupId: string): Promise<VerifyReport> {
    const start = Date.now()
    const report: VerifyReport = {
      backupId,
      ok: false,
      steps: [],
      startedAt: new Date(start).toISOString(),
      finishedAt: '',
      durationMs: 0
    }

    const backup = await this.policyManager.getBackup(backupId) as Backup | null
    if (!backup) {
      report.steps.push({ label: 'find backup', ok: false, detail: `Backup ${backupId} not found` })
      return this.finish(report, start)
    }
    report.steps.push({ label: 'find backup', ok: true })

    if (backup.status !== 'success') {
      report.steps.push({ label: 'status-check', ok: false, detail: `status=${backup.status}` })
      return this.finish(report, start)
    }
    report.steps.push({ label: 'status-check', ok: true })

    const policy = await this.policyManager.getPolicy(backup.policyId)
    if (!policy) {
      report.steps.push({ label: 'load policy', ok: false })
      return this.finish(report, start)
    }
    report.steps.push({ label: 'load policy', ok: true })

    const adapter = StorageFactory.create(
      policy.storage.type,
      await this.policyManager.resolveStorageConfig(policy.storage)
    )
    const workDir = safeJoin(this.stagingDir, `verify-${safeFilenameFragment(backupId)}`)
    await fs.ensureDir(workDir)

    const scratchVolumes: string[] = []
    try {
      const manifestRemote = path.posix.join(backupId, 'manifest.json')
      const manifestLocal = safeJoin(workDir, 'manifest.json')
      await adapter.download(manifestRemote, manifestLocal)
      report.steps.push({ label: 'download manifest', ok: true })

      const manifest = await fs.readJson(manifestLocal)

      for (const file of manifest.files as Array<{ remote: string; checksum: string }>) {
        const localPath = safeJoin(workDir, safeFilenameFragment(path.basename(file.remote)))
        await adapter.download(file.remote, localPath)
        const actual = await sha256File(localPath)
        if (actual !== file.checksum) {
          report.steps.push({
            label: `checksum ${path.basename(file.remote)}`,
            ok: false,
            detail: `expected ${file.checksum}, got ${actual}`
          })
          return this.finish(report, start)
        }
        report.steps.push({ label: `checksum ${path.basename(file.remote)}`, ok: true })

        const base = path.basename(file.remote).replace(/\.tar\.gz$/, '')
        const [type, ...rest] = base.split('_')
        const selector = rest.join('_')

        if (type === 'volume') {
          const scratchName = `${SCRATCH_VOLUME_PREFIX}${backupId.slice(0, 8)}-${selector}`
            .replace(/[^a-z0-9_.-]/gi, '_')
          // Register before creating. importVolume() creates the volume and then
          // streams a tar into it via a helper container; if that second half
          // throws, the volume already exists. Pushing afterwards would leak it.
          scratchVolumes.push(scratchName)
          await this.docker.importVolume(scratchName, localPath)
          report.steps.push({ label: `restore-to-scratch ${selector}`, ok: true, detail: scratchName })
        } else {
          report.steps.push({
            label: `skip non-volume target ${type}:${selector}`,
            ok: true,
            detail: 'verify only exercises volume restores today'
          })
        }
      }

      report.ok = true
    } catch (err: any) {
      report.steps.push({ label: 'verify', ok: false, detail: err.message })
    } finally {
      await fs.remove(workDir).catch(() => {})
      for (const v of scratchVolumes) {
        try {
          await this.docker.removeVolume(v, true)
        } catch (err: any) {
          // Don't fail the verify over cleanup, but don't swallow it either —
          // silent failures here are exactly how scratch volumes accumulate.
          if (!/no such volume/i.test(err?.message || '')) {
            logger.warn(
              { err, volume: v },
              '[Verify] Failed to remove scratch volume; it will be reaped on next startup'
            )
          }
        }
      }
    }

    return this.finish(report, start)
  }

  /**
   * Remove scratch volumes orphaned by a previous process.
   *
   * The in-run `finally` handles the normal path, but it cannot run if the
   * process is killed mid-verify — which is exactly what happens when the
   * Docker engine dies or the extension container is force-stopped. Those
   * volumes then persist forever with nothing to collect them.
   *
   * Safe to call at startup, before any verify can be in flight. Uses a
   * non-forced remove so a volume unexpectedly in use errors instead of being
   * pulled out from under a running container.
   *
   * @returns the names of the volumes that were removed
   */
  public async reapOrphanedScratchVolumes(): Promise<string[]> {
    const removed: string[] = []
    let volumes: Array<{ Name?: string }>
    try {
      volumes = await this.docker.listVolumes()
    } catch (err) {
      logger.warn({ err }, '[Verify] Could not list volumes to reap scratch leftovers')
      return removed
    }

    const orphans = volumes
      .map(v => v.Name)
      .filter((n): n is string => !!n && n.startsWith(SCRATCH_VOLUME_PREFIX))

    for (const name of orphans) {
      try {
        await this.docker.removeVolume(name, false)
        removed.push(name)
      } catch (err: any) {
        logger.warn({ err, volume: name }, '[Verify] Could not reap orphaned scratch volume')
      }
    }

    if (removed.length > 0) {
      logger.info(
        { count: removed.length, volumes: removed },
        '[Verify] Reaped orphaned scratch volumes from a previous run'
      )
    }
    return removed
  }

  private finish(report: VerifyReport, start: number): VerifyReport {
    const end = Date.now()
    report.finishedAt = new Date(end).toISOString()
    report.durationMs = end - start

    if (this.db) {
      this.persist(report).catch(err => {
        logger.error({ err }, '[Verify] Failed to persist verify record')
      })
    }
    return report
  }

  private async persist(report: VerifyReport): Promise<void> {
    if (!this.db) return
    const backup = await this.policyManager.getBackup(report.backupId)
    await this.db.saveVerifyRecord({
      id: uuidv4(),
      backupId: report.backupId,
      policyId: backup?.policyId || 'unknown',
      ok: report.ok,
      startedAt: new Date(report.startedAt),
      finishedAt: new Date(report.finishedAt),
      durationMs: report.durationMs,
      steps: report.steps
    })
  }
}
