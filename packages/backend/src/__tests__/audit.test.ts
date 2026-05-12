import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { Database } from '../db/Database'
import { AuditService } from '../services/AuditService'

describe('AuditService', () => {
  let db: Database
  let svc: AuditService

  beforeEach(async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'drk-audit-'))
    db = new Database(path.join(tmp, 'a.db'))
    svc = new AuditService(db)
  })

  it('persists and reads entries in newest-first order', async () => {
    await svc.record('policy.create', { id: 'p1', name: 'demo' })
    await new Promise(r => setTimeout(r, 5))
    await svc.record('policy.delete', { id: 'p1' })

    const list = await svc.list()
    expect(list.length).toBe(2)
    expect(list[0].action).toBe('policy.delete')
    expect(list[1].action).toBe('policy.create')
  })

  it('serializes object details to JSON', async () => {
    await svc.record('backup.delete', { id: 'b1', size: 42 })
    const [entry] = await svc.list()
    expect(entry.details).toContain('b1')
    expect(entry.details).toContain('42')
  })
})
