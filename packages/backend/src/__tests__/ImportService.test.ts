import path from 'path'
import os from 'os'
import fs from 'fs-extra'

import {
  ImportService,
  isPathAllowed,
  parseImportAllowlist,
} from '../services/ImportService'
import { Database } from '../db/Database'

/**
 * Non-integration unit tests for ImportService A3.
 *
 * Covers:
 *   - path allowlist normalization + traversal defence
 *   - mode=json preview + apply round-trip
 *   - mode=bind-mount-json with a real tmp file
 *   - apply with an unknown token returns applied=false (not a throw)
 *
 * Legacy-SQLite mode is exercised in the gated real integration test at
 * __tests__/integration/configImport.real.test.ts (requires CI_INTEGRATION=1).
 */

describe('parseImportAllowlist', () => {
  it('defaults to /data/imports/ when env unset', () => {
    const list = parseImportAllowlist(undefined)
    expect(list.length).toBe(1)
    expect(list[0].endsWith(path.sep)).toBe(true)
  })

  it('splits colon-separated values and resolves each', () => {
    // Use forward slashes that work on both POSIX and win32. path.resolve
    // normalizes them either way.
    const list = parseImportAllowlist('/data/imports:/var/drk/inbox')
    expect(list.length).toBe(2)
    for (const item of list) {
      expect(item.endsWith(path.sep)).toBe(true)
    }
  })

  it('drops empty segments from accidental ::', () => {
    const list = parseImportAllowlist('::/data/imports::')
    expect(list.length).toBe(1)
  })
})

describe('isPathAllowed', () => {
  const allowlist = parseImportAllowlist('/data/imports')

  it('accepts a direct child of the allowlist root', () => {
    expect(isPathAllowed(path.resolve('/data/imports/foo.json'), allowlist)).toBe(true)
  })

  it('accepts a nested file under the allowlist root', () => {
    expect(isPathAllowed(path.resolve('/data/imports/subdir/foo.json'), allowlist)).toBe(true)
  })

  it('rejects paths outside the allowlist', () => {
    expect(isPathAllowed(path.resolve('/etc/passwd'), allowlist)).toBe(false)
  })

  it('rejects prefix-match attacks (/data/imports-private/...)', () => {
    expect(isPathAllowed(path.resolve('/data/imports-private/foo.json'), allowlist)).toBe(false)
  })

  it('rejects empty and non-string input', () => {
    expect(isPathAllowed('', allowlist)).toBe(false)
    expect(isPathAllowed(undefined as any, allowlist)).toBe(false)
  })
})

describe('ImportService — JSON mode', () => {
  let tmp: string
  let dbPath: string
  let drkDb: Database
  let svc: ImportService

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'drk-import-test-'))
    dbPath = path.join(tmp, 'docker_rescue.db')
    drkDb = new Database(dbPath)
    // Allowlist scoped to tmp so bind-mount-json tests can use a real file.
    svc = new ImportService(drkDb, parseImportAllowlist(tmp))
  })

  afterEach(async () => {
    try { (drkDb as any).db?.close?.() } catch { /* best-effort */ }
    await fs.remove(tmp).catch(() => { /* best-effort */ })
  })

  it('preview(mode=json) returns a confirmation token + counts, never mutates the DB', async () => {
    const payload = {
      schemaVersion: '1',
      appVersion: '1.2.5',
      capturedAt: new Date().toISOString(),
      policies: [],
      vaults: [{ id: 'v1', type: 'local', config: { path: '/tmp/x' } }],
      settings: [{ key: 'foo', value: 'bar' }],
      audit: [],
    }
    const pv = await svc.preview({ mode: 'json', payload })
    expect(pv.confirmationToken).toMatch(/^[0-9a-f-]{36}$/i)
    expect(pv.counts).toEqual({ policies: 0, vaults: 1, settings: 1, audit: 0 })
    expect(pv.source).toBe('json')

    // DB is untouched.
    expect(await drkDb.getAllSettings()).toEqual([])
    expect(await drkDb.getAllVaults()).toEqual([])
  })

  it('apply(token) writes the previewed bundle to the DB', async () => {
    const payload = {
      schemaVersion: '1',
      appVersion: '1.2.5',
      capturedAt: new Date().toISOString(),
      policies: [],
      vaults: [{ id: 'v1', type: 'local', config: { path: '/tmp/x' } }],
      settings: [{ key: 'foo', value: 'bar' }],
      audit: [],
    }
    const pv = await svc.preview({ mode: 'json', payload })
    const result = await svc.apply(pv.confirmationToken)
    expect(result.applied).toBe(true)
    expect(result.counts.settings).toBe(1)
    expect(result.counts.vaults).toBe(1)

    expect(await drkDb.getAllSettings()).toEqual([{ key: 'foo', value: 'bar' }])
    const vaults = await drkDb.getAllVaults()
    expect(vaults).toEqual([{ id: 'v1', type: 'local', config: { path: '/tmp/x' } }])
  })

  it('apply(token) consumes the stash so the token cannot be reused', async () => {
    const payload = {
      schemaVersion: '1',
      appVersion: '1.2.5',
      capturedAt: new Date().toISOString(),
      policies: [],
      vaults: [],
      settings: [{ key: 'once', value: 'only' }],
      audit: [],
    }
    const pv = await svc.preview({ mode: 'json', payload })
    const first = await svc.apply(pv.confirmationToken)
    expect(first.applied).toBe(true)
    const second = await svc.apply(pv.confirmationToken)
    expect(second.applied).toBe(false)
    expect(second.errors[0]).toMatch(/unknown or expired token/)
  })

  it('apply(unknown token) returns applied=false (does not throw)', async () => {
    const r = await svc.apply('not-a-real-token')
    expect(r.applied).toBe(false)
    expect(r.errors[0]).toMatch(/unknown or expired token/)
  })

  it('preview accepts the legacy v1.2.4 envelope shape', async () => {
    const legacy = {
      version: '1.2.4',
      exportedAt: new Date().toISOString(),
      data: {
        settings: [{ key: 'legacy.key', value: 'legacy.value' }],
        policies: [],
        storageVaults: [{ id: 'lv1', type: 'local', config: { path: '/tmp/legacy' } }],
        backupHistory: [],
        auditLog: [],
      },
    }
    const pv = await svc.preview({ mode: 'json', payload: legacy })
    expect(pv.warnings.length).toBeGreaterThan(0)
    expect(pv.counts.vaults).toBe(1)
    expect(pv.detectedAppVersion).toBe('1.2.4')
  })

  it('preview rejects garbage payloads', async () => {
    await expect(svc.preview({ mode: 'json', payload: 'not an object' as any })).rejects.toThrow()
    await expect(svc.preview({ mode: 'json', payload: { random: true } })).rejects.toThrow()
  })

  it('preview(mode=bind-mount-json) reads a file inside the allowlist', async () => {
    const filePath = path.join(tmp, 'good-import.json')
    await fs.writeJson(filePath, {
      schemaVersion: '1',
      appVersion: '1.2.5',
      capturedAt: new Date().toISOString(),
      policies: [],
      vaults: [],
      settings: [{ key: 'k', value: 'v' }],
      audit: [],
    })
    const pv = await svc.preview({ mode: 'bind-mount-json', path: filePath })
    expect(pv.source).toBe('bind-mount-json')
    expect(pv.counts.settings).toBe(1)
  })

  it('preview(mode=bind-mount-json) rejects paths outside the allowlist', async () => {
    const outside = path.join(os.tmpdir(), 'drk-outside-allowlist.json')
    await fs.writeJson(outside, { schemaVersion: '1' }).catch(() => {})
    await expect(
      svc.preview({ mode: 'bind-mount-json', path: outside }),
    ).rejects.toThrow(/path not allowed/)
    await fs.remove(outside).catch(() => { /* best-effort */ })
  })
})
