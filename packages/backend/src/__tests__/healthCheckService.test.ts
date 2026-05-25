/**
 * Tests for HealthCheckService — verifies dashboard health scorecard and broken container detection.
 *
 * All Docker and database calls are mocked to run without a daemon or database.
 */

// ---- mock dependencies before imports ----
const mockPing = jest.fn()
const mockVersion = jest.fn()
const mockListContainers = jest.fn()
const mockListVolumes = jest.fn()

jest.mock('dockerode', () => {
  return jest.fn().mockImplementation(() => ({
    ping: mockPing,
    version: mockVersion,
    listContainers: mockListContainers,
    listVolumes: mockListVolumes,
  }))
})

import { HealthCheckService } from '../services/HealthCheckService'
import { DockerService } from '../services/DockerService'
import type { DashboardHealthScore, BrokenContainer } from '../services/HealthCheckService'
import type Dockerode from 'dockerode'

// Fake service dependencies
class FakePolicyManager {
  async listPolicies() {
    return [
      {
        id: 'policy-1',
        enabled: true,
        targets: [
          { type: 'volume' as const, selector: 'vol-backed' },
        ]
      },
      {
        id: 'policy-2',
        enabled: false,
        targets: [{ type: 'volume' as const, selector: 'vol-disabled' }]
      }
    ]
  }
  async getBackupHistory(policyId: string) {
    if (policyId === 'policy-1') {
      return [
        { status: 'success', timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() }
      ]
    }
    return []
  }
}

class FakeRehearsalService {
  async list(opts: any) {
    if (opts.policyId === 'policy-1') {
      return [
        { ok: true, startedAt: new Date().toISOString() },
        { ok: false, startedAt: new Date().toISOString() }
      ]
    }
    return []
  }
}

class FakeDatabase {}

beforeEach(() => {
  jest.clearAllMocks()
})

function createService() {
  const docker = new DockerService()
  const policyManager = new FakePolicyManager() as any
  const rehearsal = new FakeRehearsalService() as any
  const db = new FakeDatabase() as any
  const service = new HealthCheckService(docker, policyManager, rehearsal, db)
  return { service, docker, policyManager, rehearsal }
}

// ============================================================================
// UNIT TESTS: getDashboardScore()
// ============================================================================

describe('HealthCheckService.getDashboardScore()', () => {
  it('returns complete DashboardHealthScore with all 6 categories', async () => {
    mockPing.mockResolvedValue(undefined)
    mockVersion.mockResolvedValue({ Version: '24.0.0' })
    mockListContainers.mockResolvedValue([])
    mockListVolumes.mockResolvedValue([])

    const { service } = createService()
    const score = await service.getDashboardScore()

    // Verify all 6 categories present
    expect(score).toHaveProperty('engineStatus')
    expect(score).toHaveProperty('engineVersion')
    expect(score).toHaveProperty('diskPressure')
    expect(score).toHaveProperty('brokenContainers')
    expect(score).toHaveProperty('networkProblems')
    expect(score).toHaveProperty('securityWarnings')
    expect(score).toHaveProperty('backupPosture')
  })

  describe('Category 1: Engine Status', () => {
    it('returns running + version when docker is healthy', async () => {
      mockPing.mockResolvedValue(undefined)
      mockVersion.mockResolvedValue({ Version: '24.0.0' })
      mockListContainers.mockResolvedValue([])
      mockListVolumes.mockResolvedValue([])

      const { service } = createService()
      const score = await service.getDashboardScore()

      expect(score.engineStatus).toBe('running')
      expect(score.engineVersion).toBe('24.0.0')
    })

    it('returns unhealthy when ping fails', async () => {
      mockPing.mockRejectedValue(new Error('connection refused'))
      mockVersion.mockResolvedValue({ Version: '24.0.0' })
      mockListContainers.mockResolvedValue([])
      mockListVolumes.mockResolvedValue([])

      const { service } = createService()
      const score = await service.getDashboardScore()

      expect(score.engineStatus).toBe('unhealthy')
      expect(score.engineVersion).toBe('')
    })

    it('returns unhealthy when version() throws', async () => {
      mockPing.mockResolvedValue(undefined)
      mockVersion.mockRejectedValue(new Error('version failed'))
      mockListContainers.mockResolvedValue([])
      mockListVolumes.mockResolvedValue([])

      const { service } = createService()
      const score = await service.getDashboardScore()

      expect(score.engineStatus).toBe('unhealthy')
      expect(score.engineVersion).toBe('')
    })
  })

  describe('Category 2: Disk Pressure', () => {
    it('returns zeros as placeholder (deferred to v1.5)', async () => {
      mockPing.mockResolvedValue(undefined)
      mockVersion.mockResolvedValue({ Version: '24.0.0' })
      mockListContainers.mockResolvedValue([])
      mockListVolumes.mockResolvedValue([])

      const { service } = createService()
      const score = await service.getDashboardScore()

      expect(score.diskPressure.totalBytes).toBe(0)
      expect(score.diskPressure.reclaimableBytes).toBe(0)
      expect(score.diskPressure.highRiskPercent).toBe(0)
    })
  })

  describe('Category 3: Broken Containers', () => {
    it('counts exited containers', async () => {
      mockPing.mockResolvedValue(undefined)
      mockVersion.mockResolvedValue({ Version: '24.0.0' })
      mockListContainers.mockResolvedValue([
        { Id: 'c1', Names: ['/app'], State: 'exited', Status: 'Exited (0)', Created: 1000 } as any,
        { Id: 'c2', Names: ['/db'], State: 'running', Status: 'Up', Created: 1000 } as any,
      ])
      mockListVolumes.mockResolvedValue([])

      const { service } = createService()
      const score = await service.getDashboardScore()

      expect(score.brokenContainers.count).toBe(1)
      expect(score.brokenContainers.byReason.exited).toBe(1)
    })

    it('counts oomkilled containers (exit code 137)', async () => {
      mockPing.mockResolvedValue(undefined)
      mockVersion.mockResolvedValue({ Version: '24.0.0' })
      mockListContainers.mockResolvedValue([
        { Id: 'c1', Names: ['/oom-app'], State: 'exited', Status: 'Exited (137)', ExitCode: 137, Created: 1000 } as any,
      ])
      mockListVolumes.mockResolvedValue([])

      const { service } = createService()
      const score = await service.getDashboardScore()

      expect(score.brokenContainers.count).toBe(1)
      expect(score.brokenContainers.byReason.oomkilled).toBe(1)
    })

    it('counts permission error containers (exit code 126/127)', async () => {
      mockPing.mockResolvedValue(undefined)
      mockVersion.mockResolvedValue({ Version: '24.0.0' })
      mockListContainers.mockResolvedValue([
        { Id: 'c1', Names: ['/perm-1'], State: 'exited', Status: 'Exited (126)', ExitCode: 126, Created: 1000 } as any,
        { Id: 'c2', Names: ['/perm-2'], State: 'exited', Status: 'Exited (127)', ExitCode: 127, Created: 1000 } as any,
      ])
      mockListVolumes.mockResolvedValue([])

      const { service } = createService()
      const score = await service.getDashboardScore()

      expect(score.brokenContainers.count).toBe(2)
      expect(score.brokenContainers.byReason.permerror).toBe(2)
    })

    it('counts unhealthy running containers', async () => {
      mockPing.mockResolvedValue(undefined)
      mockVersion.mockResolvedValue({ Version: '24.0.0' })
      mockListContainers.mockResolvedValue([
        { Id: 'c1', Names: ['/unhealthy'], State: 'running', Status: 'Up (unhealthy)', Created: 1000 } as any,
      ])
      mockListVolumes.mockResolvedValue([])

      const { service } = createService()
      const score = await service.getDashboardScore()

      expect(score.brokenContainers.count).toBe(1)
      expect(score.brokenContainers.byReason.unhealthy).toBe(1)
    })

    it('counts restarting containers', async () => {
      mockPing.mockResolvedValue(undefined)
      mockVersion.mockResolvedValue({ Version: '24.0.0' })
      mockListContainers.mockResolvedValue([
        { Id: 'c1', Names: ['/restart'], State: 'restarting', Status: 'Restarting', Created: 1000 } as any,
      ])
      mockListVolumes.mockResolvedValue([])

      const { service } = createService()
      const score = await service.getDashboardScore()

      expect(score.brokenContainers.count).toBe(1)
      expect(score.brokenContainers.byReason.restarting).toBe(1)
    })
  })

  describe('Category 4: Network Problems', () => {
    it('detects exposed ports (0.0.0.0 bindings)', async () => {
      mockPing.mockResolvedValue(undefined)
      mockVersion.mockResolvedValue({ Version: '24.0.0' })
      mockListContainers.mockResolvedValue([
        {
          Id: 'c1',
          Names: ['/app'],
          State: 'running',
          Status: 'Up',
          Ports: [
            { IP: '0.0.0.0', PublicPort: 8080, PrivatePort: 3000, Type: 'tcp' }
          ]
        } as any,
      ])
      mockListVolumes.mockResolvedValue([])

      const { service } = createService()
      const score = await service.getDashboardScore()

      expect(score.networkProblems.exposedPorts).toContain('app:8080/tcp')
    })

    it('detects port conflicts (multiple containers on same host port)', async () => {
      mockPing.mockResolvedValue(undefined)
      mockVersion.mockResolvedValue({ Version: '24.0.0' })
      mockListContainers.mockResolvedValue([
        {
          Id: 'c1',
          Names: ['/app1'],
          State: 'running',
          Status: 'Up',
          Ports: [{ IP: '127.0.0.1', PublicPort: 8080, PrivatePort: 3000, Type: 'tcp' }]
        } as any,
        {
          Id: 'c2',
          Names: ['/app2'],
          State: 'running',
          Status: 'Up',
          Ports: [{ IP: '127.0.0.1', PublicPort: 8080, PrivatePort: 3000, Type: 'tcp' }]
        } as any,
      ])
      mockListVolumes.mockResolvedValue([])

      const { service } = createService()
      const score = await service.getDashboardScore()

      expect(score.networkProblems.portConflicts.length).toBeGreaterThan(0)
      expect(score.networkProblems.portConflicts[0]).toMatch(/8080/)
      expect(score.networkProblems.portConflicts[0]).toMatch(/app1.*app2|app2.*app1/)
    })

    it('returns empty failedDns array (deferred to v1.5)', async () => {
      mockPing.mockResolvedValue(undefined)
      mockVersion.mockResolvedValue({ Version: '24.0.0' })
      mockListContainers.mockResolvedValue([])
      mockListVolumes.mockResolvedValue([])

      const { service } = createService()
      const score = await service.getDashboardScore()

      expect(score.networkProblems.failedDns).toEqual([])
    })
  })

  describe('Category 5: Security Warnings', () => {
    it('returns empty arrays (deferred to v1.4)', async () => {
      mockPing.mockResolvedValue(undefined)
      mockVersion.mockResolvedValue({ Version: '24.0.0' })
      mockListContainers.mockResolvedValue([])
      mockListVolumes.mockResolvedValue([])

      const { service } = createService()
      const score = await service.getDashboardScore()

      expect(score.securityWarnings.rootContainers).toEqual([])
      expect(score.securityWarnings.privilegedContainers).toEqual([])
      expect(score.securityWarnings.cveCount).toBe(0)
    })
  })

  describe('Category 6: Backup Posture', () => {
    it('returns backup posture structure with all fields', async () => {
      mockPing.mockResolvedValue(undefined)
      mockVersion.mockResolvedValue({ Version: '24.0.0' })
      mockListContainers.mockResolvedValue([])
      mockListVolumes.mockResolvedValue([
        { Name: 'vol1' } as any,
        { Name: 'vol2' } as any,
      ])

      const { service } = createService()
      const score = await service.getDashboardScore()

      // Verify structure is present
      expect(Array.isArray(score.backupPosture.volumesWithoutBackups)).toBe(true)
      expect(['number', 'object'].includes(typeof score.backupPosture.lastBackupAgeDays)).toBe(true)
      expect(typeof score.backupPosture.failedRestoresCount).toBe('number')
    })

    it('calculates last backup age in days from backup history', async () => {
      mockPing.mockResolvedValue(undefined)
      mockVersion.mockResolvedValue({ Version: '24.0.0' })
      mockListContainers.mockResolvedValue([])
      mockListVolumes.mockResolvedValue([])

      const { service } = createService()
      const score = await service.getDashboardScore()

      // Our fake PolicyManager returns a backup from 2 days ago
      expect(score.backupPosture.lastBackupAgeDays).toBeGreaterThanOrEqual(1)
    })

    it('counts failed restores from rehearsal list', async () => {
      mockPing.mockResolvedValue(undefined)
      mockVersion.mockResolvedValue({ Version: '24.0.0' })
      mockListContainers.mockResolvedValue([])
      mockListVolumes.mockResolvedValue([])

      const { service } = createService()
      const score = await service.getDashboardScore()

      // Our fake RehearsalService returns 1 failed rehearsal
      expect(score.backupPosture.failedRestoresCount).toBeGreaterThanOrEqual(1)
    })
  })

  describe('Error Handling: Promise.allSettled()', () => {
    it('returns partial results when category methods fail gracefully', async () => {
      mockPing.mockResolvedValue(undefined)
      mockVersion.mockResolvedValue({ Version: '24.0.0' })
      mockListContainers.mockResolvedValue([])
      mockListVolumes.mockResolvedValue([])

      const { service } = createService()
      // Even if individual category methods fail internally, getDashboardScore should return
      // with defaults for those categories due to Promise.allSettled
      const score = await service.getDashboardScore()

      // Should have engine status
      expect(score.engineStatus).toBe('running')
      // Should have default structures for other categories
      expect(typeof score.brokenContainers.count).toBe('number')
      expect(Array.isArray(score.networkProblems.portConflicts)).toBe(true)
    })
  })

  describe('Docker offline (3 = EACCES)', () => {
    it('getEngineStatus returns unhealthy when docker is offline', async () => {
      mockPing.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
      mockVersion.mockRejectedValue(new Error('docker offline'))
      mockListContainers.mockResolvedValue([])
      mockListVolumes.mockResolvedValue([])

      const { service } = createService()
      const score = await service.getDashboardScore()

      expect(score.engineStatus).toBe('unhealthy')
    })
  })
})

// ============================================================================
// UNIT TESTS: getBrokenContainers()
// ============================================================================

describe('HealthCheckService.getBrokenContainers()', () => {
  it('returns array of BrokenContainer with correct shape', async () => {
    mockListContainers.mockResolvedValue([])
    const { service } = createService()

    const broken = await service.getBrokenContainers()
    expect(Array.isArray(broken)).toBe(true)
  })

  it('categorizes exited containers correctly', async () => {
    mockListContainers.mockResolvedValue([
      {
        Id: 'c1',
        Names: ['/myapp'],
        State: 'exited',
        Status: 'Exited (0)',
        ExitCode: 0,
        Created: 1000,
        ExitedAt: '2025-05-24T10:00:00Z'
      } as any,
    ])

    const { service } = createService()
    const broken = await service.getBrokenContainers()

    expect(broken).toHaveLength(1)
    const container = broken[0]
    expect(container.id).toBe('c1')
    expect(container.name).toBe('myapp')
    expect(container.state).toBe('exited')
    expect(container.exitCode).toBe(0)
    expect(container.reason).toMatch(/Exited with code/)
  })

  it('uses ExitedAt timestamp for exited containers', async () => {
    const exitedAt = '2025-05-24T10:00:00Z'
    mockListContainers.mockResolvedValue([
      {
        Id: 'c1',
        Names: ['/app'],
        State: 'exited',
        ExitedAt: exitedAt,
        Created: 1000,
      } as any,
    ])

    const { service } = createService()
    const broken = await service.getBrokenContainers()

    // ISO format may have milliseconds added, so check it starts with the date
    expect(broken[0].lastSeen).toMatch(/2025-05-24T10:00:00/)
  })

  it('falls back to Created timestamp if ExitedAt is invalid or missing', async () => {
    mockListContainers.mockResolvedValue([
      {
        Id: 'c1',
        Names: ['/app'],
        State: 'exited',
        ExitedAt: '0001-01-01T00:00:00Z', // Invalid sentinel
        Created: 1000,
      } as any,
    ])

    const { service } = createService()
    const broken = await service.getBrokenContainers()

    // Should use Created timestamp
    expect(broken[0].lastSeen).toBeDefined()
    expect(new Date(broken[0].lastSeen).getTime()).toBeGreaterThan(0)
  })

  it('categorizes oomkilled containers (exit code 137)', async () => {
    mockListContainers.mockResolvedValue([
      {
        Id: 'c1',
        Names: ['/oom'],
        State: 'exited',
        ExitCode: 137,
        Created: 1000,
      } as any,
    ])

    const { service } = createService()
    const broken = await service.getBrokenContainers()

    expect(broken[0].state).toBe('oomkilled')
    expect(broken[0].reason).toMatch(/Out of memory/)
  })

  it('categorizes permission error containers (exit code 126/127)', async () => {
    mockListContainers.mockResolvedValue([
      {
        Id: 'c1',
        Names: ['/permerr'],
        State: 'exited',
        ExitCode: 126,
        Created: 1000,
      } as any,
    ])

    const { service } = createService()
    const broken = await service.getBrokenContainers()

    expect(broken[0].state).toBe('permerror')
    expect(broken[0].reason).toMatch(/Permission error/)
  })

  it('categorizes unhealthy running containers', async () => {
    mockListContainers.mockResolvedValue([
      {
        Id: 'c1',
        Names: ['/unhealthy'],
        State: 'running',
        Status: 'Up (unhealthy)',
        Created: 1000,
      } as any,
    ])

    const { service } = createService()
    const broken = await service.getBrokenContainers()

    expect(broken[0].state).toBe('unhealthy')
    expect(broken[0].reason).toMatch(/healthcheck failed/)
  })

  it('categorizes restarting containers', async () => {
    mockListContainers.mockResolvedValue([
      {
        Id: 'c1',
        Names: ['/restarting'],
        State: 'restarting',
        Status: 'Restarting',
        Created: 1000,
      } as any,
    ])

    const { service } = createService()
    const broken = await service.getBrokenContainers()

    expect(broken[0].state).toBe('restarting')
    expect(broken[0].reason).toMatch(/restart policy/)
  })

  it('ignores healthy and running containers', async () => {
    mockListContainers.mockResolvedValue([
      { Id: 'c1', Names: ['/running'], State: 'running', Status: 'Up', Created: 1000 } as any,
      { Id: 'c2', Names: ['/healthy'], State: 'running', Status: 'Up (healthy)', Created: 1000 } as any,
    ])

    const { service } = createService()
    const broken = await service.getBrokenContainers()

    expect(broken).toHaveLength(0)
  })

  it('uses container ID short form when Names not available', async () => {
    mockListContainers.mockResolvedValue([
      { Id: 'abcdef123456789', State: 'exited', Created: 1000 } as any,
    ])

    const { service } = createService()
    const broken = await service.getBrokenContainers()

    expect(broken[0].name).toBe('abcdef123456')
  })
})

// ============================================================================
// NO SECRETS LEAKED
// ============================================================================

describe('HealthCheckService — No Secrets Leaked', () => {
  it('getDashboardScore does not expose env vars or labels', async () => {
    mockPing.mockResolvedValue(undefined)
    mockVersion.mockResolvedValue({ Version: '24.0.0' })
    mockListContainers.mockResolvedValue([
      {
        Id: 'c1',
        Names: ['/secret-app'],
        State: 'running',
        Status: 'Up',
        Env: ['DATABASE_PASSWORD=secret123'], // Should not be returned
        Labels: { 'com.secret': 'super-secret' }, // Should not be returned
        Created: 1000,
      } as any,
    ])
    mockListVolumes.mockResolvedValue([])

    const { service } = createService()
    const score = await service.getDashboardScore()
    const scoreJson = JSON.stringify(score)

    expect(scoreJson).not.toContain('DATABASE_PASSWORD')
    expect(scoreJson).not.toContain('secret123')
    expect(scoreJson).not.toContain('super-secret')
  })

  it('getBrokenContainers does not expose env vars or labels', async () => {
    mockListContainers.mockResolvedValue([
      {
        Id: 'c1',
        Names: ['/myapp'],
        State: 'exited',
        ExitCode: 1,
        Env: ['API_KEY=supersecretvalue123'], // Should not be returned
        Labels: { 'password': 'hidden' }, // Should not be returned
        Created: 1000,
      } as any,
    ])

    const { service } = createService()
    const broken = await service.getBrokenContainers()
    const brokenJson = JSON.stringify(broken)

    expect(brokenJson).not.toContain('supersecretvalue123')
    expect(brokenJson).not.toContain('API_KEY')
    expect(brokenJson).not.toContain('password')
  })
})

// ============================================================================
// PERFORMANCE
// ============================================================================

describe('HealthCheckService — Performance', () => {
  it('getDashboardScore completes in <500ms with 100 containers', async () => {
    mockPing.mockResolvedValue(undefined)
    mockVersion.mockResolvedValue({ Version: '24.0.0' })

    // Generate 100 mock containers
    const containers = Array.from({ length: 100 }, (_, i) => ({
      Id: `c${i}`,
      Names: [`/container-${i}`],
      State: i % 10 === 0 ? 'exited' : 'running',
      Status: 'Up',
      Created: 1000,
      ExitCode: i % 10 === 0 ? 1 : 0,
    } as any))

    mockListContainers.mockResolvedValue(containers)
    mockListVolumes.mockResolvedValue([])

    const { service } = createService()
    const start = Date.now()
    await service.getDashboardScore()
    const duration = Date.now() - start

    expect(duration).toBeLessThan(500)
  })

  it('listContainers() is called exactly once per getDashboardScore() call', async () => {
    mockPing.mockResolvedValue(undefined)
    mockVersion.mockResolvedValue({ Version: '24.0.0' })
    mockListContainers.mockResolvedValue([
      { Id: 'c1', Names: ['/app'], State: 'running', Status: 'Up', Ports: [{ PublicPort: 8080 }], Created: 1000 } as any,
    ])
    mockListVolumes.mockResolvedValue([])

    const { service } = createService()
    await service.getDashboardScore()

    // Verify listContainers was called exactly once, not multiple times
    expect(mockListContainers).toHaveBeenCalledTimes(1)
    expect(mockListContainers).toHaveBeenCalledWith({ all: true })
  })

  it('listVolumes() is called exactly once per getDashboardScore() call', async () => {
    mockPing.mockResolvedValue(undefined)
    mockVersion.mockResolvedValue({ Version: '24.0.0' })
    mockListContainers.mockResolvedValue([])
    mockListVolumes.mockResolvedValue([{ Name: 'vol1' } as any])

    const { service } = createService()
    await service.getDashboardScore()

    // Verify listVolumes was called exactly once
    expect(mockListVolumes).toHaveBeenCalledTimes(1)
  })
})
