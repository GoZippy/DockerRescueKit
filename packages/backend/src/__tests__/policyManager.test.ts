/**
 * Tests for PolicyManager CRUD flows.
 *
 * We use a real in-memory SQLite database (better-sqlite3 accepts ':memory:')
 * and a real Database wrapper. DockerService is never called by the pure CRUD
 * methods so the constructor's implicit `new DockerService()` is fine — it
 * won't actually try to connect to Docker.
 */

import os from 'os'
import path from 'path'
import fs from 'fs-extra'
import { Database } from '../db/Database'
import { PolicyManager } from '../services/PolicyManager'
import { EncryptionUtility } from '../utils/Encryption'

// DockerService constructor tries to connect to dockerode; mock to prevent
// any accidental side-effects from the PolicyManager constructor.
jest.mock('dockerode', () => {
  return jest.fn().mockImplementation(() => ({
    ping: jest.fn(),
    listContainers: jest.fn(),
    listVolumes: jest.fn(),
    listNetworks: jest.fn(),
    listImages: jest.fn(),
  }))
})

// ---------------------------------------------------------------------------

let db: Database
let pm: PolicyManager
let staging: string

beforeAll(() => {
  EncryptionUtility.init('pm-test-secret')
})

beforeEach(async () => {
  // better-sqlite3 supports ':memory:' but the Database wrapper resolves the
  // path with path.resolve(). We use a real temp file to keep things simple
  // and portable.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'drk-pm-'))
  const dbPath = path.join(tmp, 'test.db')
  staging = path.join(tmp, 'staging')
  db = new Database(dbPath)
  pm = new PolicyManager(db, staging)
})

// ---------------------------------------------------------------------------

describe('PolicyManager.createPolicy()', () => {
  it('creates a policy and returns it with a generated id', async () => {
    const policy = await pm.createPolicy({ name: 'My Policy' })

    expect(policy.id).toBeTruthy()
    expect(policy.name).toBe('My Policy')
    expect(policy.enabled).toBe(true)
    expect(policy.targets).toEqual([])
    expect(policy.schedule).toBe('0 0 * * *')
    expect(policy.backupType).toBe('full')
    expect(policy.retention).toMatchObject({ strategy: 'count', count: 7 })
    expect(policy.createdAt).toBeInstanceOf(Date)
    expect(policy.updatedAt).toBeInstanceOf(Date)
  })

  it('applies partial overrides supplied by the caller', async () => {
    const policy = await pm.createPolicy({
      name: 'Custom',
      enabled: false,
      schedule: '0 3 * * *',
      backupType: 'incremental',
    })

    expect(policy.name).toBe('Custom')
    expect(policy.enabled).toBe(false)
    expect(policy.schedule).toBe('0 3 * * *')
    expect(policy.backupType).toBe('incremental')
  })
})

describe('PolicyManager.listPolicies()', () => {
  it('returns empty array when no policies exist', async () => {
    expect(await pm.listPolicies()).toEqual([])
  })

  it('returns all created policies', async () => {
    await pm.createPolicy({ name: 'Alpha' })
    await pm.createPolicy({ name: 'Beta' })

    const list = await pm.listPolicies()
    expect(list).toHaveLength(2)
    const names = list.map(p => p.name)
    expect(names).toEqual(expect.arrayContaining(['Alpha', 'Beta']))
  })
})

describe('PolicyManager.getPolicy()', () => {
  it('returns null for an unknown id', async () => {
    expect(await pm.getPolicy('does-not-exist')).toBeNull()
  })

  it('returns the policy for a known id', async () => {
    const created = await pm.createPolicy({ name: 'Findme' })
    const found = await pm.getPolicy(created.id)

    expect(found).not.toBeNull()
    expect(found!.id).toBe(created.id)
    expect(found!.name).toBe('Findme')
  })
})

describe('PolicyManager.updatePolicy()', () => {
  it('patches the specified fields and persists the change', async () => {
    const original = await pm.createPolicy({ name: 'Before' })
    const updated = await pm.updatePolicy(original.id, { name: 'After', enabled: false })

    expect(updated.id).toBe(original.id)
    expect(updated.name).toBe('After')
    expect(updated.enabled).toBe(false)

    // Verify the change is durable
    const fetched = await pm.getPolicy(original.id)
    expect(fetched!.name).toBe('After')
    expect(fetched!.enabled).toBe(false)
  })

  it('throws when the policy does not exist', async () => {
    await expect(pm.updatePolicy('no-such-id', { name: 'X' })).rejects.toThrow(/Policy 'no-such-id' not found/)
  })
})

describe('PolicyManager.deletePolicy()', () => {
  it('removes the policy from the database', async () => {
    const p = await pm.createPolicy({ name: 'ToDelete' })
    await pm.deletePolicy(p.id)
    expect(await pm.getPolicy(p.id)).toBeNull()
  })

  it('does not throw when deleting a non-existent id', async () => {
    await expect(pm.deletePolicy('ghost')).resolves.toBeUndefined()
  })
})

describe('PolicyManager.getBackupHistory()', () => {
  it('returns empty array for a new policy with no backups', async () => {
    const p = await pm.createPolicy({ name: 'NoBackups' })
    expect(await pm.getBackupHistory(p.id)).toEqual([])
  })
})
