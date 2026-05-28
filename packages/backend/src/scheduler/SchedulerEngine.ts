import cron from 'node-cron'
import { PolicyManager } from '../services/PolicyManager'
import { VerifyService } from '../services/VerifyService'
import { ExportService } from '../services/ExportService'
import { BackupPolicy, Backup, RetentionPolicy, BackupTier } from '@docker-rescue-kit/shared'

export interface ScheduledJob {
  policyId: string
  job: cron.ScheduledTask
}

export class SchedulerEngine {
  private jobs: Map<string, ScheduledJob> = new Map()
  private verifyJobs: Map<string, ScheduledJob> = new Map()
  /** Periodic ExportService snapshot job (A2). At most one — registered on
   *  start(), unregistered on stop(). */
  private exportJob: cron.ScheduledTask | null = null
  /** Tracks policies whose backup is currently in flight. Used to skip
   *  overlapping cron fires ("if a Friday backup runs long, Saturday doesn't
   *  pile on top of it"). */
  private inFlight: Set<string> = new Set()
  /** When true, cron triggers are silently skipped. Manual API runs still
   *  work. Used for upgrades / planned maintenance. */
  private paused = false
  private isRunning = false

  constructor(
    private policyManager: PolicyManager,
    private verifyService?: VerifyService,
    // Optional so existing tests (retention.test, schedulerConcurrency.test)
    // that instantiate SchedulerEngine with `{} as any` keep compiling. When
    // omitted the periodic-snapshot job is silently skipped — the boot-time
    // bootstrap snapshot in BackupService.start() still runs.
    private exportService?: ExportService,
  ) {}

  public pause(): void { this.paused = true }
  public resume(): void { this.paused = false }
  public isPaused(): boolean { return this.paused }
  public isInFlight(policyId: string): boolean { return this.inFlight.has(policyId) }
  public runningPolicyIds(): string[] { return Array.from(this.inFlight) }

  public async start() {
    if (this.isRunning) return
    this.isRunning = true

    const policies = await this.policyManager.listPolicies()
    for (const policy of policies) {
      if (policy.enabled) this.schedulePolicy(policy)
    }

    // A2 — periodic timestamped exports + rolling retention.
    //
    // Reads cron + retention from SettingsService via ExportService. Config
    // changes do NOT live-reload — a backend restart picks them up. We
    // accepted that tradeoff in v1.2.5 because (a) settings-UI editing of
    // the cron expression is an admin operation done at most a handful of
    // times per install, and (b) live-reload would require unschedule +
    // re-schedule with a versioned config token, which is more risk than
    // value for sprint-2 scope.
    if (this.exportService) {
      try {
        const { cron: cronExpr } = await this.exportService.getRetentionConfig()
        if (!cron.validate(cronExpr)) {
          console.error(`[Scheduler] Invalid export cron "${cronExpr}"; periodic export disabled.`)
        } else {
          this.exportJob = cron.schedule(cronExpr, async () => {
            if (this.paused) {
              console.log('[Scheduler] Paused — skipping periodic export snapshot')
              return
            }
            try {
              await this.exportService!.writeSnapshot()
              // writeSnapshot runs prune internally — no need to call it
              // again here. Keeping the surface single-call also matches
              // the manual-trigger path if we add one later.
            } catch (err) {
              console.error('[Scheduler] Periodic export snapshot failed:', err)
            }
          })
          console.log(`\x1b[34m[Scheduler]\x1b[0m Periodic export job registered (cron="${cronExpr}")`)
        }
      } catch (err) {
        console.error('[Scheduler] Failed to register periodic export job:', err)
      }
    }
  }

  public stop() {
    this.jobs.forEach(j => j.job.stop())
    this.jobs.clear()
    this.verifyJobs.forEach(j => j.job.stop())
    this.verifyJobs.clear()
    if (this.exportJob) {
      this.exportJob.stop()
      this.exportJob = null
    }
    this.isRunning = false
  }

  public schedulePolicy(policy: BackupPolicy) {
    this.unschedulePolicy(policy.id)

    if (!cron.validate(policy.schedule)) {
      console.error(`[Scheduler] Invalid cron "${policy.schedule}" on policy ${policy.name}; skipping.`)
      return
    }

    const job = cron.schedule(policy.schedule, async () => {
      if (this.paused) {
        console.log(`[Scheduler] Paused — skipping scheduled run of ${policy.name}`)
        return
      }
      if (this.inFlight.has(policy.id)) {
        console.log(`[Scheduler] Previous run of ${policy.name} still in flight — skipping this tick`)
        return
      }
      try {
        await this.runPolicy(policy.id)
      } catch (error) {
        console.error(`[Scheduler] Backup failed for policy ${policy.id}:`, error)
      }
    })

    this.jobs.set(policy.id, { policyId: policy.id, job })

    // Schedule verify job (if configured)
    if (policy.verifySchedule && this.verifyService) {
      if (!cron.validate(policy.verifySchedule)) {
        console.error(`[Scheduler] Invalid verify cron "${policy.verifySchedule}" on policy ${policy.name}; skipping.`)
      } else {
        const vjob = cron.schedule(policy.verifySchedule, async () => {
          await this.runVerifyForPolicy(policy.id)
        })
        this.verifyJobs.set(policy.id, { policyId: policy.id, job: vjob })
      }
    }
  }

  public unschedulePolicy(policyId: string) {
    const existing = this.jobs.get(policyId)
    if (existing) {
      existing.job.stop()
      this.jobs.delete(policyId)
    }
    const ev = this.verifyJobs.get(policyId)
    if (ev) {
      ev.job.stop()
      this.verifyJobs.delete(policyId)
    }
  }

  /**
   * Find the most-recent successful backup for a policy and run VerifyService
   * against it. Used by the scheduled verify job.
   */
  public async runVerifyForPolicy(policyId: string): Promise<void> {
    if (!this.verifyService) return
    try {
      const history = await this.policyManager.getBackupHistory(policyId)
      const latest = history.find(b => b.status === 'success')
      if (!latest) {
        console.log(`[Verify] No successful backup for policy ${policyId}; skipping verify.`)
        return
      }
      const report = await this.verifyService.verify(latest.id)
      if (!report.ok) {
        console.error(`[Verify] Policy ${policyId} backup ${latest.id} failed verification.`)
      }
    } catch (err) {
      console.error(`[Verify] Scheduled verify failed for policy ${policyId}:`, err)
    }
  }

  public async runPolicy(policyId: string): Promise<Backup> {
    if (this.inFlight.has(policyId)) {
      throw new Error(`Policy ${policyId} already has a backup in flight`)
    }
    this.inFlight.add(policyId)
    try {
      const backup = await this.policyManager.runBackup(policyId)
      if (backup.status === 'success') {
        const policy = await this.policyManager.getPolicy(policyId)
        if (policy) await this.applyRetention(policy)
      }
      return backup
    } finally {
      this.inFlight.delete(policyId)
    }
  }

  /**
   * Compute which backups to keep/delete and actually delete them.
   * Called only after a successful backup, so retention math sees the new
   * backup in the history.
   */
  public async applyRetention(policy: BackupPolicy): Promise<void> {
    const history = await this.policyManager.getBackupHistory(policy.id)
    const successful = history.filter(b => b.status === 'success')
    const toDelete = this.calculateRetention(successful, policy.retention)

    for (const backupId of toDelete) {
      try {
        await this.policyManager.deleteBackup(backupId)
        console.log(`[Retention] Deleted backup ${backupId} for policy ${policy.name}`)
      } catch (err) {
        console.error(`[Retention] Failed to delete ${backupId}:`, err)
      }
    }
  }

  /**
   * Pure, testable retention calculation.
   *
   *  - count:   keep N most-recent, drop the rest.
   *  - time:    drop anything older than the configured window.
   *  - tiered:  per-tier tag retention (daily/weekly/monthly/yearly). A backup
   *             is kept if ANY tier that matches one of its tags would keep it.
   */
  public calculateRetention(backups: Backup[], retention: RetentionPolicy): string[] {
    const sorted = [...backups].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())

    if (retention.strategy === 'count' && retention.count != null) {
      return sorted.slice(retention.count).map(b => b.id)
    }

    if (retention.strategy === 'time') {
      const now = Date.now()
      const windowMs = this.computeTimeWindow(retention)
      if (!windowMs) return []
      return sorted.filter(b => now - b.timestamp.getTime() > windowMs).map(b => b.id)
    }

    if (retention.strategy === 'tiered' && retention.tiers?.length) {
      const keep = new Set<string>()
      for (const tier of retention.tiers) {
        const matching = sorted.filter(b => (b.tags || []).includes(tier.tag))
        for (const id of this.keepByTier(matching, tier)) keep.add(id)
      }
      return sorted.filter(b => !keep.has(b.id)).map(b => b.id)
    }

    return []
  }

  private keepByTier(backups: Backup[], tier: BackupTier): string[] {
    const now = Date.now()
    let kept = backups
    if (tier.maxAge != null) {
      const maxMs = tier.maxAge * 24 * 60 * 60 * 1000
      kept = kept.filter(b => now - b.timestamp.getTime() <= maxMs)
    }
    if (tier.maxCount != null) {
      kept = kept.slice(0, tier.maxCount)
    }
    return kept.map(b => b.id)
  }

  private computeTimeWindow(retention: RetentionPolicy): number {
    const day = 24 * 60 * 60 * 1000
    let ms = 0
    if (retention.days) ms += retention.days * day
    if (retention.weeks) ms += retention.weeks * 7 * day
    if (retention.months) ms += retention.months * 30 * day
    return ms
  }
}
