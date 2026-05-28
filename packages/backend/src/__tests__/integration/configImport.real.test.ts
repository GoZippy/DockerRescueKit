import path from 'path'
import os from 'os'
import fs from 'fs-extra'
import BetterSqlite3 from 'better-sqlite3'

import { Database } from '../../db/Database'
import { ImportService, parseImportAllowlist } from '../../services/ImportService'

/**
 * Real integration test for ImportService A3 — exercises the
 * legacy-sqlite-db mode end-to-end with a freshly built `docker_rescue.db`
 * matching a v1.2.4-shaped schema.
 *
 * Gated on CI_INTEGRATION=1 (matches rehearsalService.real.test.ts pattern).
 * Hermetic Jest runs skip the whole describe so CI doesn't fork into the
 * full sqlite import path on every PR.
 *
 * What this exercises:
 *   1. Build a fake legacy sqlite at {tmp}/legacy.db with policies,
 *      storage_vault, settings, audit_logs populated.
 *   2. ImportService.preview({ mode: 'legacy-sqlite-db', path }) parses
 *      it and returns counts + token.
 *   3. ImportService.apply(token) writes those rows into a fresh
 *      target Database. Counts must match preview.
 *   4. Querying the target DB shows the imported rows.
 */

const ENABLED = process.env.CI_INTEGRATION === '1'
const describeOrSkip = ENABLED ? describe : describe.skip

describeOrSkip('ImportService legacy-sqlite-db (real)', () => {
  let tmp: string
  let legacyDbPath: string
  let targetDbPath: string
  let target: Database
  let svc: ImportService

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'drk-import-real-'))
    legacyDbPath = path.join(tmp, 'legacy.db')
    targetDbPath = path.join(tmp, 'docker_rescue.db')

    // --- Build the legacy DB with the v1.2.4 schema shape. We only create
    // the columns ImportService actually reads, plus a deliberately-missing
    // `verifySchedule` to assert the warning path.
    const legacy = new BetterSqlite3(legacyDbPath)
    legacy.exec(`
      CREATE TABLE policies (
        id TEXT PRIMARY KEY,
        name TEXT,
        description TEXT,
        enabled INTEGER,
        targets TEXT,
        schedule TEXT,
        backupType TEXT,
        retention TEXT,
        storage TEXT,
        hooks TEXT,
        notifications TEXT,
        createdAt TEXT
      );
      CREATE TABLE storage_vault (
        id TEXT PRIMARY KEY,
        type TEXT,
        config TEXT
      );
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE audit_logs (
        id TEXT PRIMARY KEY,
        timestamp TEXT,
        action TEXT,
        details TEXT,
        user TEXT
      );
    `)
    legacy.prepare(
      `INSERT INTO policies (id, name, enabled, targets, schedule, backupType, retention, storage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'p1', 'legacy-policy', 1,
      JSON.stringify([{ type: 'container', id: 'app' }]),
      '0 2 * * *', 'full',
      JSON.stringify({ strategy: 'count', count: 7 }),
      JSON.stringify({ vaultId: 'v1' }),
    )
    legacy.prepare(
      `INSERT INTO storage_vault (id, type, config) VALUES (?, ?, ?)`,
    ).run('v1', 'local', JSON.stringify({ path: '/data/backups' }))
    legacy.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)`,
    ).run('drk.test.key', 'value-from-legacy')
    legacy.prepare(
      `INSERT INTO audit_logs (id, timestamp, action, details, user) VALUES (?, ?, ?, ?, ?)`,
    ).run('a1', new Date().toISOString(), 'policy.create', '{"id":"p1"}', null)
    legacy.close()

    target = new Database(targetDbPath)
    svc = new ImportService(target, parseImportAllowlist(tmp))
  })

  afterEach(async () => {
    try { (target as any).db?.close?.() } catch { /* best-effort */ }
    await fs.remove(tmp).catch(() => { /* best-effort */ })
  })

  it('preview returns counts + warning for missing verifySchedule column', async () => {
    const pv = await svc.preview({ mode: 'legacy-sqlite-db', path: legacyDbPath })
    expect(pv.source).toBe('legacy-sqlite-db')
    expect(pv.counts).toEqual({ policies: 1, vaults: 1, settings: 1, audit: 1 })
    // Legacy schema is missing verifySchedule — expect a warning saying so.
    expect(pv.warnings.some(w => /verifySchedule/.test(w))).toBe(true)
  })

  it('apply writes the legacy rows into the target DB with matching counts', async () => {
    const pv = await svc.preview({ mode: 'legacy-sqlite-db', path: legacyDbPath })
    const result = await svc.apply(pv.confirmationToken)

    expect(result.applied).toBe(true)
    expect(result.counts).toEqual({ policies: 1, vaults: 1, settings: 1, audit: 1 })
    expect(result.errors).toEqual([])

    const settings = await target.getAllSettings()
    expect(settings).toContainEqual({ key: 'drk.test.key', value: 'value-from-legacy' })

    const vaults = await target.getAllVaults()
    expect(vaults).toEqual([{ id: 'v1', type: 'local', config: { path: '/data/backups' } }])

    const policies = await target.getPolicies()
    expect(policies.length).toBe(1)
    expect(policies[0].id).toBe('p1')
  })
})
