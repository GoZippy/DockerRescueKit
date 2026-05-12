/**
 * Tests for ConnectorManager.
 *
 * Uses a real Database backed by a temp file so we exercise the full
 * encrypt/decrypt round-trip that VaultService applies.
 */

import os from 'os'
import path from 'path'
import fs from 'fs-extra'
import { Database } from '../db/Database'
import { ConnectorManager } from '../services/ConnectorManager'
import { EncryptionUtility } from '../utils/Encryption'
import { ConnectorType } from '@docker-rescue-kit/shared'

// ---------------------------------------------------------------------------

let db: Database
let cm: ConnectorManager

beforeAll(() => {
  EncryptionUtility.init('connector-test-secret')
})

beforeEach(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'drk-conn-'))
  const dbPath = path.join(tmp, 'test.db')
  db = new Database(dbPath)
  cm = new ConnectorManager(db)
})

// ---------------------------------------------------------------------------

const makeInstance = (overrides: Record<string, any> = {}) => ({
  id: 'inst-1',
  type: 's3' as ConnectorType,
  name: 'My S3 Connector',
  config: { endpoint: 'https://s3.example.com', bucket: 'backups' },
  status: 'untested' as const,
  ...overrides,
})

describe('ConnectorManager.listInstances()', () => {
  it('returns empty array when no instances saved', async () => {
    expect(await cm.listInstances()).toEqual([])
  })

  it('returns all saved instances', async () => {
    await cm.saveInstance(makeInstance({ id: 'a', name: 'First' }))
    await cm.saveInstance(makeInstance({ id: 'b', name: 'Second' }))

    const list = await cm.listInstances()
    expect(list).toHaveLength(2)
    const names = list.map(i => i.name)
    expect(names).toEqual(expect.arrayContaining(['First', 'Second']))
  })
})

describe('ConnectorManager.saveInstance()', () => {
  it('saves an instance and makes it retrievable', async () => {
    const inst = makeInstance()
    await cm.saveInstance(inst)

    const found = await cm.getInstance(inst.id)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(inst.id)
    expect(found!.type).toBe('s3')
    expect(found!.name).toBe('My S3 Connector')
  })

  it('round-trips the config through encrypt/decrypt transparently', async () => {
    const inst = makeInstance({ config: { endpoint: 'https://example.com', bucket: 'mybucket' } })
    await cm.saveInstance(inst)

    const found = await cm.getInstance(inst.id)
    // bucket is not a sensitive key — expect it back verbatim
    expect(found!.config.bucket).toBe('mybucket')
    expect(found!.config.endpoint).toBe('https://example.com')
  })

  it('upserts — saving the same id twice updates the record', async () => {
    await cm.saveInstance(makeInstance({ name: 'Original' }))
    await cm.saveInstance(makeInstance({ name: 'Updated' }))

    const list = await cm.listInstances()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('Updated')
  })
})

describe('ConnectorManager.getInstance()', () => {
  it('returns null for an unknown id', async () => {
    expect(await cm.getInstance('no-such-id')).toBeNull()
  })

  it('returns the instance for a known id', async () => {
    const inst = makeInstance({ id: 'known', name: 'KnownInst' })
    await cm.saveInstance(inst)

    const found = await cm.getInstance('known')
    expect(found).not.toBeNull()
    expect(found!.name).toBe('KnownInst')
  })
})

describe('ConnectorManager.deleteInstance()', () => {
  it('removes the instance from the database', async () => {
    await cm.saveInstance(makeInstance({ id: 'del-me' }))
    await cm.deleteInstance('del-me')
    expect(await cm.getInstance('del-me')).toBeNull()
  })

  it('does not throw when deleting a non-existent id', async () => {
    await expect(cm.deleteInstance('ghost')).resolves.toBeUndefined()
  })
})
