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
import crypto from 'crypto'
import { Database } from '../db/Database'
import { PolicyManager } from '../services/PolicyManager'
import { LicenseService } from '../services/LicenseService'
import { EncryptionUtility } from '../utils/Encryption'
import { LicenseRequiredError } from '../errors'

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

// ---------------------------------------------------------------------------
// License gating
// ---------------------------------------------------------------------------

describe('PolicyManager license gating', () => {
  // Generate a real RSA keypair so we can mint Personal Pro tokens for the
  // "unlimited" half of the test pair.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })

  function signProToken(): string {
    const header = { alg: 'RS256', typ: 'JWT' }
    const payload = {
      iss: 'license.gozippy.com', sub: 'lic-test', aud: 'drk',
      tier: 'personal-pro', iat: Math.floor(Date.now() / 1000),
    }
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const signingInput = `${enc(header)}.${enc(payload)}`
    const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url')
    return `${signingInput}.${sig}`
  }

  // Stand-in for SettingsService — keeps the gating tests self-contained.
  class MemorySettings {
    private store = new Map<string, string>()
    async getSetting(key: string, def?: string): Promise<string | undefined> {
      return this.store.has(key) ? this.store.get(key)! : def
    }
    async saveSetting(key: string, value: string): Promise<void> {
      this.store.set(key, value)
    }
    async getBooleanSetting(): Promise<boolean> { return false }
    async saveBooleanSetting(): Promise<void> { /* noop */ }
  }

  beforeEach(() => {
    process.env.DRK_LICENSE_PUBLIC_KEY = publicKey
  })

  afterEach(() => {
    delete process.env.DRK_LICENSE_KEY
    delete process.env.DRK_LICENSE_PUBLIC_KEY
  })

  it('Free tier rejects the 6th policy with LicenseRequiredError', async () => {
    const license = new LicenseService(new MemorySettings() as any)
    const gated = new PolicyManager(db, staging, license)

    // Five policies should succeed.
    for (let i = 1; i <= 5; i++) {
      await gated.createPolicy({ name: `Policy ${i}` })
    }

    // The sixth should be rejected with a typed error.
    await expect(gated.createPolicy({ name: 'Policy 6' }))
      .rejects.toThrow(LicenseRequiredError)
    await expect(gated.createPolicy({ name: 'Policy 6' }))
      .rejects.toMatchObject({ statusCode: 402, code: 'LICENSE_REQUIRED' })

    // And the count is still 5.
    expect((await gated.listPolicies()).length).toBe(5)
  })

  it('Personal Pro lifts the 5-policy cap', async () => {
    process.env.DRK_LICENSE_KEY = signProToken()
    const license = new LicenseService(new MemorySettings() as any)
    const gated = new PolicyManager(db, staging, license)

    for (let i = 1; i <= 7; i++) {
      await gated.createPolicy({ name: `Pro Policy ${i}` })
    }
    expect((await gated.listPolicies()).length).toBe(7)
  })

  it('omitting LicenseService leaves quota enforcement off (backward compat)', async () => {
    // pm from outer beforeEach has no license attached — should accept 6+ policies.
    for (let i = 1; i <= 6; i++) {
      await pm.createPolicy({ name: `Legacy Policy ${i}` })
    }
    expect((await pm.listPolicies()).length).toBe(6)
  })
})

// ---------------------------------------------------------------------------
// Destination guard — reject storage types StorageFactory can't build.
// ConnectorManager lets users save proxmox/truenas connectors, but they are
// discovery-only; a policy targeting them used to fail only at backup time.
// ---------------------------------------------------------------------------

describe('PolicyManager storage-destination guard', () => {
  it('rejects a policy that targets a discovery-only proxmox connector', async () => {
    await expect(
      pm.createPolicy({ name: 'PVE', storage: { id: 's', type: 'proxmox', host: '10.0.0.1' } as any })
    ).rejects.toThrow(/proxmox connectors are discovery-only/)
    expect((await pm.listPolicies()).length).toBe(0)
  })

  it('rejects a truenas destination with a friendly hint', async () => {
    await expect(
      pm.createPolicy({ name: 'NAS', storage: { id: 's', type: 'truenas' } as any })
    ).rejects.toThrow(/truenas connectors are discovery-only/)
  })

  it('rejects an entirely unknown storage type and lists supported ones', async () => {
    await expect(
      pm.createPolicy({ name: 'Weird', storage: { id: 's', type: 'floppy-disk' } as any })
    ).rejects.toThrow(/Supported destination types: .*local/)
  })

  it('accepts a supported destination type (local)', async () => {
    const p = await pm.createPolicy({ name: 'OK', storage: { id: 's', type: 'local', path: 'data/backups' } })
    expect(p.storage.type).toBe('local')
  })

  it('also guards updatePolicy against switching to an unsupported type', async () => {
    const p = await pm.createPolicy({ name: 'Mutate', storage: { id: 's', type: 'local', path: 'data/backups' } })
    await expect(
      pm.updatePolicy(p.id, { storage: { id: 's', type: 'proxmox' } as any })
    ).rejects.toThrow(/cannot be used as a backup destination/)
  })
})

// ---------------------------------------------------------------------------
// resolveStorageConfig — public so verify/rehearsal/partial-restore resolve
// connector creds the same way runBackup/restoreBackup do.
// ---------------------------------------------------------------------------

describe('PolicyManager.resolveStorageConfig()', () => {
  it('returns storage unchanged when no connectorId is present', async () => {
    const storage = { type: 'local', path: 'data/backups' }
    expect(await pm.resolveStorageConfig(storage)).toBe(storage)
  })

  it('merges decrypted connector config under the policy storage overrides', async () => {
    // Inject a fake ConnectorManager that returns a decrypted instance.
    ;(pm as any).connectorManager = {
      getInstance: jest.fn().mockResolvedValue({
        config: { type: 's3', accessKeyId: 'AKIA', secretAccessKey: 'secret', bucket: 'from-connector' }
      })
    }
    const resolved = await pm.resolveStorageConfig({ type: 's3', connectorId: 'c1', bucket: 'from-policy' })
    // connector creds present, policy fields win on conflict (spread order).
    expect(resolved).toMatchObject({
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      bucket: 'from-policy',
      connectorId: 'c1',
    })
  })

  it('falls back to raw storage when the connector instance is missing', async () => {
    ;(pm as any).connectorManager = { getInstance: jest.fn().mockResolvedValue(null) }
    const storage = { type: 's3', connectorId: 'gone' }
    expect(await pm.resolveStorageConfig(storage)).toBe(storage)
  })
})
