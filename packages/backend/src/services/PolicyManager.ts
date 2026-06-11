import { BackupPolicy, Backup } from '@docker-rescue-kit/shared'
import { Database } from '../db/Database'
import { DockerService } from './DockerService'
import { HookRunner } from './HookRunner'
import { NotificationService } from './NotificationService'
import { DatabaseExporterService } from './DatabaseExporters'
import { StorageFactory } from '../storage/StorageFactory'
import { ConnectorManager } from './ConnectorManager'
import { sha256File } from '../utils/Checksum'
import { safeJoin, safeFilenameFragment } from '../utils/PathSafety'
import path from 'path'
import fs from 'fs-extra'
import { v4 as uuidv4 } from 'uuid'
import { NotFoundError, LicenseRequiredError } from '../errors'
import { LicenseService, FREE_TIER_POLICY_LIMIT } from './LicenseService'
import { logger } from '../utils/logger'

export interface RestoreRequest {
  backupId: string
  targetOverrides?: {
    containers?: Record<string, string>
    volumes?: Record<string, string>
  }
  dryRun?: boolean
}

export class PolicyManager {
  private dockerService: DockerService
  private hookRunner: HookRunner
  private notifier: NotificationService
  private dbExporters: DatabaseExporterService
  private connectorManager: ConnectorManager

  constructor(
    private db: Database,
    private stagingDir: string = path.resolve('data/staging'),
    /** Optional. When omitted, no license gating is applied — existing
     *  installs without the license server wired in continue to behave
     *  as before. Inject from index.ts to enforce Free-tier quotas. */
    private license?: LicenseService,
  ) {
    this.dockerService = new DockerService()
    this.hookRunner = new HookRunner(this.dockerService)
    // Pass the LicenseService through so notifications get gated to Pro
    // when a license is wired in. Without it, the notifier falls back to
    // its no-license-supplied path (always fires) for backward compat.
    this.notifier = new NotificationService(this.license)
    this.dbExporters = new DatabaseExporterService(this.dockerService)
    this.connectorManager = new ConnectorManager(db)
    fs.ensureDirSync(this.stagingDir)
  }

  /**
   * If the policy's storage config references a connector, pull the saved
   * (decrypted) connector config and merge it onto the storage config. This
   * lets users stash S3/SFTP/rclone credentials once and point every policy
   * at a single connector instance.
   *
   * Public so the other consumers of a policy's storage (verify, rehearsal,
   * partial-restore) resolve credentials the same way runBackup/restoreBackup
   * do — without it those flows break for any connector-based policy.
   */
  public async resolveStorageConfig(storage: any): Promise<any> {
    if (!storage?.connectorId) return storage
    const inst = await this.connectorManager.getInstance(storage.connectorId)
    if (!inst) return storage
    return { ...inst.config, ...storage }
  }

  /**
   * Reject storage types the StorageFactory can't actually build an adapter
   * for. ConnectorManager happily saves `proxmox`/`truenas` connectors (they're
   * discovery-only today), but a policy that targets one as a *destination*
   * would only blow up at backup time deep inside StorageFactory.create. We
   * fail fast at policy create/update with an actionable message instead.
   *
   * The supported-type list comes straight from StorageFactory so the two
   * can never drift.
   */
  private assertStorageDestinationSupported(storage: any): void {
    if (!storage?.type) return
    const type = String(storage.type).toLowerCase()
    if (StorageFactory.isSupported(type)) return

    const hint: Record<string, string> = {
      proxmox: `proxmox connectors are discovery-only in v1.3; for Proxmox Backup Server use storage type 'pbs'.`,
      truenas: `truenas connectors are discovery-only in v1.3; back up to a TrueNAS share via storage type 'smb' or 'sftp'.`,
    }
    const detail = hint[type] ||
      `Supported destination types: ${StorageFactory.getAvailableTypes().join(', ')}.`
    throw new Error(`Storage type '${storage.type}' cannot be used as a backup destination. ${detail}`)
  }

  // ----- CRUD -------------------------------------------------------------

  public async listPolicies(): Promise<BackupPolicy[]> {
    return await this.db.getPolicies()
  }

  /**
   * Enforce the Free-tier active-policy cap. Skips silently when no license
   * service was injected (test rigs, pre-license-server installs).
   */
  private async assertPolicyQuotaAvailable(): Promise<void> {
    if (!this.license) return
    const status = await this.license.getStatus()
    if (status.features.includes('unlimited_policies')) return
    const existing = await this.db.getPolicies()
    if (existing.length >= FREE_TIER_POLICY_LIMIT) {
      throw new LicenseRequiredError(
        `Free tier is limited to ${FREE_TIER_POLICY_LIMIT} concurrent policies. Upgrade to Personal Pro ($29 one-time) or Commercial Pro for unlimited policies.`,
        status.tier,
        'unlimited_policies',
      )
    }
  }

  public async getPolicy(id: string): Promise<BackupPolicy | null> {
    return await this.db.getPolicy(id)
  }

  public async createPolicy(policy: Partial<BackupPolicy>): Promise<BackupPolicy> {
    await this.assertPolicyQuotaAvailable()
    if (policy.storage) this.assertStorageDestinationSupported(policy.storage)
    const newPolicy: BackupPolicy = {
      id: uuidv4(),
      name: policy.name || 'New Policy',
      description: policy.description,
      enabled: policy.enabled ?? true,
      targets: policy.targets || [],
      schedule: policy.schedule || '0 0 * * *',
      backupType: policy.backupType || 'full',
      retention: policy.retention || { strategy: 'count', count: 7 },
      storage: policy.storage || { id: uuidv4(), type: 'local', path: 'data/backups' },
      hooks: policy.hooks,
      notifications: policy.notifications,
      verifySchedule: policy.verifySchedule,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    await this.db.savePolicy(newPolicy)
    return newPolicy
  }

  public async updatePolicy(id: string, updates: Partial<BackupPolicy>): Promise<BackupPolicy> {
    const policy = await this.getPolicy(id)
    if (!policy) throw new NotFoundError('Policy', id)
    if (updates.storage) this.assertStorageDestinationSupported(updates.storage)
    const updatedPolicy: BackupPolicy = { ...policy, ...updates, updatedAt: new Date() }
    await this.db.savePolicy(updatedPolicy)
    return updatedPolicy
  }

  public async deletePolicy(id: string): Promise<void> {
    await this.db.deletePolicy(id)
  }

  // ----- Backup -----------------------------------------------------------

  public async runBackup(policyId: string): Promise<Backup> {
    const policy = await this.getPolicy(policyId)
    if (!policy) throw new NotFoundError('Policy', policyId)

    const backupId = uuidv4()
    const startTime = Date.now()
    const stageDir = safeJoin(this.stagingDir, backupId)
    const backup: Backup = {
      id: backupId,
      policyId,
      timestamp: new Date(),
      type: policy.backupType,
      status: 'running',
      size: 0,
      targets: [...policy.targets],
      duration: 0,
      tags: this.computeTags(new Date())
    }

    await fs.ensureDir(stageDir)
    await this.db.saveBackup(backup)

    const adapter = StorageFactory.create(policy.storage.type, await this.resolveStorageConfig(policy.storage))

    try {
      // Typed DB exporters first — they produce files inside the target
      // containers that the filesystem backup step then picks up.
      if (policy.hooks?.databases?.length) {
        for (const exp of policy.hooks.databases) {
          await this.dbExporters.run(exp)
        }
      }

      if (policy.hooks?.pre?.length) {
        await this.hookRunner.runAll(policy.hooks.pre, { phase: 'pre', policy })
      }

      const uploadedFiles: Array<{ remote: string; checksum: string; size: number }> = []

      for (const target of policy.targets) {
        const safe = safeFilenameFragment(target.selector)
        const fileName = `${target.type}_${safe}.tar.gz`
        const localPath = safeJoin(stageDir, fileName)

        if (target.type === 'volume') {
          await this.dockerService.exportVolume(target.selector, localPath)
        } else if (target.type === 'container') {
          await this.dockerService.exportContainer(target.selector, localPath)
        } else if (target.type === 'image') {
          await this.dockerService.exportImage(target.selector, localPath)
        } else if (target.type === 'network') {
          // Network "backup" is just its config as JSON; still packaged as .tar.gz
          // via a temp dir so the storage pipeline doesn't need to special-case it.
          const tmpJson = safeJoin(stageDir, `${safe}.network.json`)
          await this.dockerService.exportNetwork(target.selector, tmpJson)
          await fs.copy(tmpJson, localPath.replace(/\.tar\.gz$/, '.json'))
        } else {
          throw new Error(`Unsupported target type: ${target.type}`)
        }

        const checksum = await sha256File(localPath)
        const stats = await fs.stat(localPath)

        const remotePath = path.posix.join(backupId, fileName)
        await adapter.upload(localPath, remotePath)
        uploadedFiles.push({ remote: remotePath, checksum, size: stats.size })
      }

      // Write a manifest so restore can find files without DB access.
      const manifest = {
        backupId,
        policyId,
        policyName: policy.name,
        timestamp: backup.timestamp.toISOString(),
        type: policy.backupType,
        targets: policy.targets,
        files: uploadedFiles,
        tags: backup.tags
      }
      const manifestLocal = safeJoin(stageDir, 'manifest.json')
      await fs.writeJson(manifestLocal, manifest, { spaces: 2 })
      await adapter.upload(manifestLocal, path.posix.join(backupId, 'manifest.json'))

      if (policy.hooks?.post?.length) {
        await this.hookRunner.runAll(policy.hooks.post, { phase: 'post', policy })
      }

      const totalSize = uploadedFiles.reduce((acc, f) => acc + f.size, 0)
      const combinedChecksum = uploadedFiles.map(f => f.checksum).join(',')

      const finalBackup: Backup = {
        ...backup,
        status: 'success',
        size: totalSize,
        checksum: combinedChecksum,
        duration: Date.now() - startTime,
      }
      await this.db.saveBackup(finalBackup)

      if (policy.notifications) {
        await this.notifier.notify('success', policy, finalBackup)
      }

      return finalBackup
    } catch (error: any) {
      logger.error({ policyId, err: error }, '[Backup] policy run failed')
      const failedBackup: Backup = {
        ...backup,
        status: 'failed',
        error: error.message,
        duration: Date.now() - startTime,
      }
      await this.db.saveBackup(failedBackup)

      if (policy.notifications) {
        await this.notifier.notify('failure', policy, failedBackup)
      }

      throw error
    } finally {
      await fs.remove(stageDir).catch(() => {})
    }
  }

  // ----- Restore ----------------------------------------------------------

  public async restoreBackup(req: RestoreRequest): Promise<{ status: string; restored: string[]; dryRun: boolean }> {
    const backup = await this.db.getBackup(req.backupId)
    if (!backup) throw new NotFoundError('Backup', req.backupId)
    if (backup.status !== 'success') {
      throw new Error(`Backup ${req.backupId} is not in a restorable state (status=${backup.status})`)
    }

    const policy = await this.getPolicy(backup.policyId)
    if (!policy) throw new NotFoundError('Policy (parent)', backup.policyId)

    const adapter = StorageFactory.create(policy.storage.type, await this.resolveStorageConfig(policy.storage))
    const stageDir = safeJoin(this.stagingDir, `restore-${safeFilenameFragment(req.backupId)}`)
    await fs.ensureDir(stageDir)

    const restored: string[] = []
    try {
      const manifestRemote = path.posix.join(req.backupId, 'manifest.json')
      const manifestLocalPath = safeJoin(stageDir, 'manifest.json')
      await adapter.download(manifestRemote, manifestLocalPath)
      const manifest = await fs.readJson(manifestLocalPath)

      for (const file of manifest.files as Array<{ remote: string; checksum: string; size: number }>) {
        const localPath = safeJoin(stageDir, safeFilenameFragment(path.basename(file.remote)))
        await adapter.download(file.remote, localPath)

        const actual = await sha256File(localPath)
        if (actual !== file.checksum) {
          throw new Error(`Checksum mismatch for ${file.remote}: expected ${file.checksum}, got ${actual}`)
        }

        if (req.dryRun) {
          restored.push(`[dry-run] would restore ${path.basename(file.remote)}`)
          continue
        }

        // File name convention from backup: {type}_{selector}.tar.gz
        const base = path.basename(file.remote).replace(/\.tar\.gz$/, '')
        const [type, ...rest] = base.split('_')
        const selector = rest.join('_')

        if (type === 'volume') {
          const target = req.targetOverrides?.volumes?.[selector] || selector
          await this.dockerService.importVolume(target, localPath)
          restored.push(`volume:${target}`)
        } else if (type === 'container') {
          await this.dockerService.importImage(localPath)
          restored.push(`container-image:${selector}`)
        } else if (type === 'image') {
          await this.dockerService.importImage(localPath)
          restored.push(`image:${selector}`)
        } else if (type === 'network') {
          const name = await this.dockerService.importNetwork(localPath.replace(/\.tar\.gz$/, '.json'))
          restored.push(`network:${name}`)
        }
      }

      return {
        status: 'success',
        restored,
        dryRun: !!req.dryRun
      }
    } finally {
      await fs.remove(stageDir).catch(() => {})
    }
  }

  // ----- History ----------------------------------------------------------

  public async getBackupHistory(policyId: string): Promise<Backup[]> {
    return await this.db.getBackupHistory(policyId)
  }

  public async getBackup(id: string): Promise<Backup | null> {
    return await this.db.getBackup(id)
  }

  public async listAllBackups(): Promise<Backup[]> {
    return await this.db.listAllBackups()
  }

  /**
   * One-click protect for a compose stack: create a daily policy that
   * targets every container + volume attached to the project.
   * Idempotent: returns the existing policy if one already exists for this stack.
   */
  public async protectStack(
    project: string,
    stack: { containers: any[]; volumes: string[] }
  ): Promise<BackupPolicy & { existing?: boolean }> {
    const policyName = `stack-${project}`
    const policies = await this.listPolicies()
    const existing = policies.find(p => p.name === policyName)
    if (existing) return { ...existing, existing: true }

    const targets: any[] = []
    for (const c of stack.containers || []) {
      const name = (c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : c.Id) as string
      targets.push({ type: 'container', selector: name })
    }
    for (const v of stack.volumes || []) {
      targets.push({ type: 'volume', selector: v })
    }

    return this.createPolicy({
      name: policyName,
      description: `Auto-protect for compose stack ${project}`,
      enabled: true,
      targets,
      schedule: '0 2 * * *',
      backupType: 'full',
      retention: { strategy: 'count', count: 7 },
      storage: { id: `storage-stack-${project}`, type: 'local', path: 'data/backups' },
      verifySchedule: '0 4 * * 0',
    })
  }

  /**
   * Delete a backup from both storage and the DB. Used by retention and
   * by manual deletion from the UI.
   */
  public async deleteBackup(backupId: string): Promise<void> {
    const backup = await this.db.getBackup(backupId)
    if (!backup) return
    const policy = await this.getPolicy(backup.policyId)
    if (policy) {
      try {
        const adapter = StorageFactory.create(policy.storage.type, await this.resolveStorageConfig(policy.storage))
        await adapter.deletePrefix(backupId).catch(async () => {
          // Adapter may not implement deletePrefix — fall back to manifest-driven deletes.
          await adapter.delete(path.posix.join(backupId, 'manifest.json')).catch(() => {})
        })
      } catch (err) {
        logger.error({ backupId, err }, '[Retention] Failed to delete storage')
      }
    }
    await this.db.deleteBackup(backupId)
  }

  // ----- Helpers ----------------------------------------------------------

  private computeTags(when: Date): string[] {
    const tags: string[] = ['daily']
    if (when.getDay() === 0) tags.push('weekly')
    if (when.getDate() === 1) tags.push('monthly')
    if (when.getDate() === 1 && when.getMonth() === 0) tags.push('yearly')
    return tags
  }
}
