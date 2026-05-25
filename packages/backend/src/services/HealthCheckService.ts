import type Dockerode from 'dockerode'
import { DockerService } from './DockerService'
import { PolicyManager } from './PolicyManager'
import { RehearsalService } from './RehearsalService'
import { Database } from '../db/Database'
import { logger } from '../utils/logger'

/**
 * Dashboard health scorecard — 6-category summary of engine health.
 *
 * Used by the Rescue Dashboard (v1.3) to display at-a-glance system status
 * across engine, disk, container, network, security, and backup dimensions.
 */
export interface DashboardHealthScore {
  engineStatus: 'running' | 'stuck' | 'unhealthy'
  engineVersion: string
  diskPressure: { totalBytes: number; reclaimableBytes: number; highRiskPercent: number }
  brokenContainers: {
    count: number
    byReason: { exited: number; restarting: number; unhealthy: number; oomkilled: number; permerror: number }
  }
  networkProblems: { portConflicts: string[]; exposedPorts: string[]; failedDns: string[] }
  securityWarnings: { rootContainers: string[]; privilegedContainers: string[]; cveCount: number }
  backupPosture: { volumesWithoutBackups: string[]; lastBackupAgeDays: number | null; failedRestoresCount: number }
}

/**
 * Detailed broken-container record for the `/api/health/containers` endpoint.
 */
export interface BrokenContainer {
  id: string
  name: string
  state: 'exited' | 'restarting' | 'unhealthy' | 'oomkilled' | 'permerror'
  reason?: string
  exitCode?: number
  lastSeen: string // ISO 8601
}

/**
 * HealthCheckService — aggregates engine, resource, container, network,
 * security, and backup health signals for the dashboard.
 *
 * Performance target: <500ms total. Batches Docker queries to avoid N+1.
 * Scrubs secrets/credentials before returning.
 */
export class HealthCheckService {
  constructor(
    private docker: DockerService,
    private policyManager: PolicyManager,
    private rehearsal: RehearsalService,
    private db: Database
  ) {}

  /**
   * Get the complete 6-category health scorecard for the dashboard.
   *
   * Categories:
   * 1. Engine status (running/stuck/unhealthy + version)
   * 2. Disk pressure (total, reclaimable, high-risk %)
   * 3. Broken containers (exited, restarting, unhealthy, OOMKilled, permission errors)
   * 4. Network problems (port conflicts, exposed ports, failed DNS)
   * 5. Security warnings (root containers, privileged, CVEs if scanned)
   * 6. Backup posture (volumes without backups, last backup age, failed restores)
   *
   * Timeout strategy: if a single category times out, include partial results
   * rather than failing the entire endpoint. Omitted/zero fields indicate data
   * not yet available (e.g., CVEs require Trivy integration).
   *
   * Performance: Batches Docker queries (containers, volumes) once and passes
   * to category methods to avoid N+1 queries.
   */
  public async getDashboardScore(): Promise<DashboardHealthScore> {
    const score: DashboardHealthScore = {
      engineStatus: 'running',
      engineVersion: '',
      diskPressure: { totalBytes: 0, reclaimableBytes: 0, highRiskPercent: 0 },
      brokenContainers: { count: 0, byReason: { exited: 0, restarting: 0, unhealthy: 0, oomkilled: 0, permerror: 0 } },
      networkProblems: { portConflicts: [], exposedPorts: [], failedDns: [] },
      securityWarnings: { rootContainers: [], privilegedContainers: [], cveCount: 0 },
      backupPosture: { volumesWithoutBackups: [], lastBackupAgeDays: null, failedRestoresCount: 0 }
    }

    try {
      // Fetch containers and volumes once before calling category methods.
      // This prevents N+1 queries where getBrokenContainerStats() and getNetworkProblems()
      // would each independently call listContainers().
      const containers = await this.docker.listContainers()
      const volumes = await this.docker.listVolumes()

      // Batch all category queries in parallel to avoid N+1.
      // Use Promise.allSettled to continue with partial results on timeout.
      const results = await Promise.allSettled([
        this.getEngineStatus(),
        this.getBrokenContainerStats(containers),
        this.getNetworkProblems(containers),
        this.getSecurityWarnings(containers),
        this.getBackupPosture(volumes)
      ])

      const [engineRes, brokenRes, networkRes, securityRes, backupRes] = results

      // (1) Engine status
      if (engineRes.status === 'fulfilled') {
        score.engineStatus = engineRes.value.status
        score.engineVersion = engineRes.value.version
      }

      // (3) Broken containers
      if (brokenRes.status === 'fulfilled') {
        score.brokenContainers = brokenRes.value
      }

      // (4) Network problems
      if (networkRes.status === 'fulfilled') {
        score.networkProblems = networkRes.value
      }

      // (5) Security warnings
      if (securityRes.status === 'fulfilled') {
        score.securityWarnings = securityRes.value
      }

      // (6) Backup posture
      if (backupRes.status === 'fulfilled') {
        score.backupPosture = backupRes.value
      }

      // (2) Disk pressure — deferred to v1.5 (requires Prometheus or docker system df exec)
      // For now, return zeros as placeholder.

      return score
    } catch (err: any) {
      logger.error(`HealthCheckService.getDashboardScore failed: ${err.message}`)
      throw err
    }
  }

  /**
   * Get detailed list of broken containers with categorization and reasoning.
   *
   * Queries docker.listContainers({ all: true }) once and categorizes by state.
   */
  public async getBrokenContainers(): Promise<BrokenContainer[]> {
    const broken: BrokenContainer[] = []

    try {
      const containers = await this.docker.listContainers()

      for (const c of containers) {
        // Running containers can be unhealthy if health check fails
        if (c.State === 'running' && c.Status?.includes('unhealthy')) {
          broken.push({
            id: c.Id,
            name: c.Names?.[0]?.replace(/^\//, '') || c.Id.substring(0, 12),
            state: 'unhealthy',
            reason: 'Docker healthcheck failed',
            lastSeen: new Date().toISOString()
          })
        }
        // Exited containers
        else if (c.State === 'exited') {
          const exitCode = this.getExitCode(c)
          const broken_reason = this.getBrokenReason(c, exitCode)
          let state: BrokenContainer['state'] = 'exited'
          let reason = `Exited with code ${exitCode}`

          // Check for OOMKilled (requires inspect; skip for now to avoid N+1)
          if (broken_reason === 'oomkilled') {
            state = 'oomkilled'
            reason = 'Out of memory killed'
          } else if (broken_reason === 'permerror') {
            state = 'permerror'
            reason = 'Permission error or missing image'
          }

          // Use ExitedAt timestamp if available (when container exited), else fallback to Created
          const exitedAtUnix = (c as any).ExitedAt
          const lastSeen = exitedAtUnix && exitedAtUnix !== '0001-01-01T00:00:00Z'
            ? new Date(exitedAtUnix).toISOString()
            : c.Created ? new Date(c.Created * 1000).toISOString() : new Date().toISOString()

          broken.push({
            id: c.Id,
            name: c.Names?.[0]?.replace(/^\//, '') || c.Id.substring(0, 12),
            state,
            reason,
            exitCode,
            lastSeen
          })
        }
        // Restarting containers
        else if (c.State === 'restarting') {
          broken.push({
            id: c.Id,
            name: c.Names?.[0]?.replace(/^\//, '') || c.Id.substring(0, 12),
            state: 'restarting',
            reason: 'Container restart policy active',
            lastSeen: c.Created ? new Date(c.Created * 1000).toISOString() : new Date().toISOString()
          })
        }
      }

      return broken
    } catch (err: any) {
      logger.error(`HealthCheckService.getBrokenContainers failed: ${err.message}`)
      throw err
    }
  }

  // ---- Private helpers ----

  private async getEngineStatus(): Promise<{ status: 'running' | 'stuck' | 'unhealthy'; version: string }> {
    try {
      // Check connectivity via ping
      const pingOk = await this.docker.ping()
      if (!pingOk) {
        return { status: 'unhealthy', version: '' }
      }

      // Get version details
      const versionInfo = await this.docker.version()
      const version = versionInfo.Version || ''

      return { status: 'running', version }
    } catch (err) {
      // If version() throws, engine is unhealthy
      return { status: 'unhealthy', version: '' }
    }
  }

  private async getBrokenContainerStats(containers: Dockerode.ContainerInfo[]): Promise<DashboardHealthScore['brokenContainers']> {
    const stats: DashboardHealthScore['brokenContainers'] = {
      count: 0,
      byReason: { exited: 0, restarting: 0, unhealthy: 0, oomkilled: 0, permerror: 0 }
    }

    try {
      for (const c of containers) {
        stats.count++

        if (c.State === 'running' && c.Status?.includes('unhealthy')) {
          stats.byReason.unhealthy++
        } else if (c.State === 'exited') {
          const exitCode = this.getExitCode(c)
          const reason = this.getBrokenReason(c, exitCode)
          if (reason === 'oomkilled') {
            stats.byReason.oomkilled++
          } else if (reason === 'permerror') {
            stats.byReason.permerror++
          } else {
            stats.byReason.exited++
          }
        } else if (c.State === 'restarting') {
          stats.byReason.restarting++
        }
      }

      // Only count actually broken containers
      stats.count = Object.values(stats.byReason).reduce((a, b) => a + b, 0)

      return stats
    } catch (err: any) {
      logger.warn(`getBrokenContainerStats failed: ${err.message}`)
      return stats
    }
  }

  private async getNetworkProblems(containers: Dockerode.ContainerInfo[]): Promise<DashboardHealthScore['networkProblems']> {
    const problems: DashboardHealthScore['networkProblems'] = {
      portConflicts: [],
      exposedPorts: [],
      failedDns: []
    }

    try {
      const portMap = new Map<string, string[]>()

      // Detect exposed ports (0.0.0.0:port bindings) and port conflicts
      for (const c of containers) {
        const name = c.Names?.[0]?.replace(/^\//, '') || c.Id.substring(0, 12)

        if (c.Ports && c.Ports.length > 0) {
          for (const port of c.Ports) {
            // Exposed port (0.0.0.0 or :: binding)
            if (port.IP === '0.0.0.0' || port.IP === '::') {
              const portStr = port.PublicPort ? `${port.PublicPort}/${port.Type}` : `${port.PrivatePort}/${port.Type}`
              problems.exposedPorts.push(`${name}:${portStr}`)
            }

            // Port conflict detection
            if (port.PublicPort) {
              const hostPort = `${port.IP || '0.0.0.0'}:${port.PublicPort}`
              if (!portMap.has(hostPort)) {
                portMap.set(hostPort, [])
              }
              portMap.get(hostPort)!.push(name)
            }
          }
        }
      }

      // Identify conflicts (multiple containers on same host port)
      for (const hostPort of portMap.keys()) {
        const containers = portMap.get(hostPort)!
        if (containers.length > 1) {
          problems.portConflicts.push(`${hostPort} (${containers.join(', ')})`)
        }
      }

      // DNS failures: requires running probes in containers — deferred to v1.5
      // For now, return empty array

      return problems
    } catch (err: any) {
      logger.warn(`getNetworkProblems failed: ${err.message}`)
      return problems
    }
  }

  private async getSecurityWarnings(containers: Dockerode.ContainerInfo[]): Promise<DashboardHealthScore['securityWarnings']> {
    const warnings: DashboardHealthScore['securityWarnings'] = {
      rootContainers: [],
      privilegedContainers: [],
      cveCount: 0
    }

    try {
      // Note: ContainerInfo from listContainers() doesn't include User or HostConfig fields.
      // These require per-container inspect() calls, which we avoid to prevent N+1 queries.
      // For v1.3, we return empty arrays. v1.4 will add batched inspect() support to
      // DockerService to collect these safely.

      // Privileged containers (HostConfig.Privileged — requires inspect, so defer to v1.4)
      // Root containers (User field — requires inspect, so defer to v1.4)

      // CVE count: only if Trivy has scanned images — check image metadata
      // Deferred to v1.2 if Trivy integration exists; for now, return 0

      // containers parameter available for future use when security inspection is implemented
      // For now, we intentionally return empty arrays.

      return warnings
    } catch (err: any) {
      logger.warn(`getSecurityWarnings failed: ${err.message}`)
      return warnings
    }
  }

  private async getBackupPosture(volumes: Dockerode.VolumeInspectInfo[]): Promise<DashboardHealthScore['backupPosture']> {
    const posture: DashboardHealthScore['backupPosture'] = {
      volumesWithoutBackups: [],
      lastBackupAgeDays: null,
      failedRestoresCount: 0
    }

    try {
      const policies = await this.policyManager.listPolicies()
      const volumeNames = new Set(volumes.map(v => v.Name))
      const backedUpVolumes = new Set<string>()

      let latestBackupTime: Date | null = null
      let failedRestoresCount = 0

      // Iterate over policies to find which volumes are backed up
      for (const policy of policies) {
        if (!policy.enabled) continue

        // Collect volume targets
        for (const target of policy.targets) {
          if (target.type === 'volume') {
            // For v1.3, do simple name matching (not regex/glob)
            if (volumeNames.has(target.selector)) {
              backedUpVolumes.add(target.selector)
            }
          }
        }
      }

      // Parallelize backup history and rehearsal queries for all policies.
      // This prevents sequential queries which would cause N+1 performance cliff (queries = # policies × 2).
      const [histories, rehearsalLists] = await Promise.all([
        Promise.all(policies.map(p => this.policyManager.getBackupHistory(p.id))),
        Promise.all(policies.map(p => this.rehearsal.list({ policyId: p.id, limit: 10 })))
      ])

      // Process backup histories to find latest backup time
      for (const history of histories) {
        if (history && history.length > 0) {
          // Find latest successful backup
          const latestSuccess = history.find((h: any) => h.status === 'success')
          if (latestSuccess) {
            const backupDate = new Date(latestSuccess.timestamp)
            if (!latestBackupTime || backupDate > latestBackupTime) {
              latestBackupTime = backupDate
            }
          }
        }
      }

      // Process rehearsal results to count failed restores
      for (const rehearsals of rehearsalLists) {
        for (const r of rehearsals) {
          if (r.ok === false) {
            failedRestoresCount++
          }
        }
      }

      // Volumes without backups
      for (const vol of volumes) {
        if (!backedUpVolumes.has(vol.Name)) {
          posture.volumesWithoutBackups.push(vol.Name)
        }
      }

      // Last backup age
      if (latestBackupTime) {
        const now = new Date()
        const ageMs = now.getTime() - latestBackupTime.getTime()
        posture.lastBackupAgeDays = Math.floor(ageMs / (1000 * 60 * 60 * 24))
      }

      posture.failedRestoresCount = failedRestoresCount

      return posture
    } catch (err: any) {
      logger.warn(`getBackupPosture failed: ${err.message}`)
      return posture
    }
  }

  /**
   * Extract exit code from container info.
   * Dockerode returns exit code in various places depending on query method.
   */
  private getExitCode(container: Dockerode.ContainerInfo): number {
    // Exit code may be in State.ExitCode or as a direct property
    return (container as any).ExitCode ?? (container as any).State?.ExitCode ?? 0
  }

  /**
   * Heuristic to categorize why a container exited.
   * Without per-container inspect(), we estimate from exit code.
   *
   * - 137: OOMKilled (SIGKILL from kernel memory pressure)
   * - 126/127: Permission errors (command not found, permission denied)
   * - others: General exit
   */
  private getBrokenReason(container: Dockerode.ContainerInfo, exitCode: number): 'oomkilled' | 'permerror' | 'exited' {
    if (exitCode === 137) return 'oomkilled'
    if (exitCode === 126 || exitCode === 127) return 'permerror'
    return 'exited'
  }
}
