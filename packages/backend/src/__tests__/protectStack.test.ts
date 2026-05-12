import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { PolicyManager } from '../services/PolicyManager'
import { Database } from '../db/Database'
import { EncryptionUtility } from '../utils/Encryption'

describe('PolicyManager.protectStack', () => {
  let dbPath: string
  let staging: string
  let pm: PolicyManager

  beforeAll(() => {
    EncryptionUtility.init('stack-test-secret')
  })

  beforeEach(async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'drk-stacks-'))
    dbPath = path.join(tmp, 'test.db')
    staging = path.join(tmp, 'staging')
    const db = new Database(dbPath)
    pm = new PolicyManager(db, staging)
  })

  it('creates a policy with container + volume targets for the stack', async () => {
    const stack = {
      containers: [{ Id: 'abc', Names: ['/app-web'] }, { Id: 'def', Names: ['/app-db'] }],
      volumes: ['app_data', 'app_logs']
    }
    const policy = await pm.protectStack('app', stack as any)

    expect(policy.name).toBe('stack-app')
    expect(policy.enabled).toBe(true)
    expect(policy.verifySchedule).toBe('0 4 * * 0')

    const types = policy.targets.map(t => t.type)
    const selectors = policy.targets.map(t => t.selector)
    expect(types.filter(t => t === 'container')).toHaveLength(2)
    expect(types.filter(t => t === 'volume')).toHaveLength(2)
    expect(selectors).toEqual(expect.arrayContaining(['app-web', 'app-db', 'app_data', 'app_logs']))
  })
})
