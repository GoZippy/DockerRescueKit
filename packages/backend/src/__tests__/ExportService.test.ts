import path from 'path'
import os from 'os'
import fs from 'fs-extra'

import {
  ExportService,
  DEFAULT_EXPORT_CRON,
  DEFAULT_EXPORT_RETENTION_DAYS,
  EXPORT_SETTING_CRON,
  EXPORT_SETTING_RETENTION_DAYS,
} from '../services/ExportService'

/**
 * Unit tests for ExportService A2 surface: writeSnapshot + pruneSnapshots +
 * getRetentionConfig + getLastExportAt.
 *
 * No real Database is needed — ExportService talks to it only via
 * `snapshotAll()`, and the methods under test here are exercised with a
 * stub `db` that returns predictable empty rows. The retention math runs
 * against real files in a tmpdir so we exercise the mtime ordering and
 * filename-pattern filter.
 */

// Bare minimum Database surface that snapshotAll() touches. Each method
// resolves to an empty array — we don't care about content here, just that
// writeSnapshot produces a parseable file with the expected filename shape.
function makeStubDb(): any {
  return {
    getPolicies: async () => [],
    getAllVaults: async () => [],
    getAllSettings: async () => [],
    getAuditEntries: async () => [],
  }
}

// SettingsService stub backed by an in-memory map. The methods returning
// `Promise<string | undefined>` mirror the real SettingsService contract
// closely enough for ExportService — we only use getSetting().
function makeStubSettings(initial: Record<string, string> = {}): any {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    getSetting: async (key: string, defaultValue?: string): Promise<string | undefined> => {
      const v = store.get(key)
      return v !== undefined ? v : defaultValue
    },
    saveSetting: async (key: string, value: string): Promise<void> => {
      store.set(key, value)
    },
  }
}

// Minimal pino-compatible logger that buffers messages so failures show
// useful context without polluting Jest output on green runs.
function makeBufferedLogger(): any {
  const buf: any[] = []
  return {
    info: (...args: any[]) => buf.push(['info', ...args]),
    warn: (...args: any[]) => buf.push(['warn', ...args]),
    error: (...args: any[]) => buf.push(['error', ...args]),
    debug: (...args: any[]) => buf.push(['debug', ...args]),
    child: () => makeBufferedLogger(),
  }
}

describe('ExportService A2 surface', () => {
  let tmp: string
  let svc: ExportService

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'drk-export-test-'))
    svc = new ExportService(makeStubDb(), makeStubSettings(), tmp, makeBufferedLogger())
  })

  afterEach(async () => {
    await fs.remove(tmp).catch(() => { /* best-effort cleanup */ })
  })

  describe('writeSnapshot', () => {
    it('produces a snap-{ISO}.json file with colons replaced for Windows compat', async () => {
      const result = await svc.writeSnapshot()

      // Path lives under {dataDir}/exports/
      expect(result.path.startsWith(path.join(tmp, 'exports'))).toBe(true)
      expect(result.bytes).toBeGreaterThan(0)

      const basename = path.basename(result.path)
      // Pattern: snap-YYYY-MM-DDTHH-MM-SS.sssZ.json — colons replaced with dashes.
      expect(basename).toMatch(/^snap-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.json$/)
      // Defense in depth: filename must not contain `:` even on platforms
      // where it would be technically legal.
      expect(basename).not.toContain(':')

      // File on disk is a parseable JSON SnapshotBundle.
      const parsed = await fs.readJson(result.path)
      expect(parsed.schemaVersion).toBe('1')
      expect(Array.isArray(parsed.policies)).toBe(true)
      expect(Array.isArray(parsed.vaults)).toBe(true)
      expect(Array.isArray(parsed.settings)).toBe(true)
      expect(Array.isArray(parsed.audit)).toBe(true)
    })

    it('returns sentinel bytes=-1 when snapshotAll throws', async () => {
      const failingDb: any = {
        getPolicies: () => Promise.reject(new Error('db down')),
        getAllVaults: () => Promise.reject(new Error('db down')),
        getAllSettings: () => Promise.reject(new Error('db down')),
        getAuditEntries: () => Promise.reject(new Error('db down')),
      }
      // snapshotAll catches each source individually and returns [], so the
      // happy-path write still succeeds. To exercise the failure sentinel
      // we force fs.writeJson to fail by pointing dataDir at a *file* (not
      // a directory) — fs.ensureDir then throws.
      const blocker = path.join(tmp, 'blocker')
      await fs.writeFile(blocker, 'not a dir')
      const blocked = new ExportService(failingDb, makeStubSettings(), blocker, makeBufferedLogger())
      const result = await blocked.writeSnapshot()
      expect(result.bytes).toBe(-1)
    })
  })

  describe('pruneSnapshots', () => {
    /**
     * Helper: drop N files into {tmp}/exports/snap-*.json with mtimes
     * spread `daySpacing` days apart, newest first.
     *
     * Filenames intentionally diverge from real ISO timestamps because
     * pruneSnapshots sorts by mtime, not by filename — using a counter
     * makes the test failure messages easier to read.
     */
    async function seedSnapshots(count: number, daySpacing = 0.5): Promise<string[]> {
      const dir = path.join(tmp, 'exports')
      await fs.ensureDir(dir)
      const now = Date.now()
      const paths: string[] = []
      for (let i = 0; i < count; i++) {
        const p = path.join(dir, `snap-${String(i).padStart(4, '0')}.json`)
        await fs.writeJson(p, { idx: i })
        const mtimeMs = now - i * daySpacing * 24 * 60 * 60 * 1000
        await fs.utimes(p, mtimeMs / 1000, mtimeMs / 1000)
        paths.push(p)
      }
      return paths
    }

    it('returns kept=0 deleted=0 when no exports directory exists', async () => {
      const result = await svc.pruneSnapshots()
      expect(result).toEqual({ kept: 0, deleted: 0 })
    })

    it('keeps newest 56 when the rolling window would prune more aggressively', async () => {
      // 100 fake snapshots over 50 days (0.5 days apart). With the default
      // 14-day window, files older than 14 days fall outside the window —
      // but the count floor of 56 must still hold.
      await seedSnapshots(100, 0.5)

      const result = await svc.pruneSnapshots()
      // 14-day window at 0.5-day spacing covers 28 files; floor pins us to
      // 56. Deleted = 100 - 56 = 44.
      expect(result.kept).toBe(56)
      expect(result.deleted).toBe(44)

      // Verify on-disk: only the 56 newest remain.
      const remaining = (await fs.readdir(path.join(tmp, 'exports')))
        .filter(n => n.startsWith('snap-'))
      expect(remaining.length).toBe(56)
    })

    it('keeps all snapshots within the retention window even when count would allow more deletes', async () => {
      // 30 fake snapshots, 1 day apart. Under default 14-day window, the
      // newest ~15 are inside the window, the rest outside. Count floor
      // of 56 would keep all 30 anyway, so this asserts the floor.
      await seedSnapshots(30, 1)

      const result = await svc.pruneSnapshots()
      expect(result.kept).toBe(30)
      expect(result.deleted).toBe(0)
    })

    it('never deletes latest-bootstrap.json or other foreign files', async () => {
      // 100 fake snapshots to force deletion.
      await seedSnapshots(100, 1)
      const exportsDir = path.join(tmp, 'exports')
      const bootstrap = path.join(exportsDir, 'latest-bootstrap.json')
      const foreign = path.join(exportsDir, 'README.txt')
      await fs.writeJson(bootstrap, { sentinel: true })
      await fs.writeFile(foreign, 'manual user file')

      await svc.pruneSnapshots()

      expect(await fs.pathExists(bootstrap)).toBe(true)
      expect(await fs.pathExists(foreign)).toBe(true)
    })

    it('honours a non-default retention_days from SettingsService', async () => {
      // Override retention to 90 days. With 100 snapshots 0.5 days apart,
      // the window covers all 100 → nothing gets deleted (floor irrelevant).
      const settings = makeStubSettings({
        [EXPORT_SETTING_RETENTION_DAYS]: '90',
      })
      const customSvc = new ExportService(makeStubDb(), settings, tmp, makeBufferedLogger())
      await seedSnapshots(100, 0.5)

      const result = await customSvc.pruneSnapshots()
      expect(result.deleted).toBe(0)
      expect(result.kept).toBe(100)
    })
  })

  describe('getRetentionConfig', () => {
    it('returns defaults when no settings rows exist', async () => {
      const cfg = await svc.getRetentionConfig()
      expect(cfg.cron).toBe(DEFAULT_EXPORT_CRON)
      expect(cfg.retentionDays).toBe(DEFAULT_EXPORT_RETENTION_DAYS)
    })

    it('reads overrides from SettingsService', async () => {
      const settings = makeStubSettings({
        [EXPORT_SETTING_CRON]: '*/30 * * * *',
        [EXPORT_SETTING_RETENTION_DAYS]: '7',
      })
      const customSvc = new ExportService(makeStubDb(), settings, tmp, makeBufferedLogger())
      const cfg = await customSvc.getRetentionConfig()
      expect(cfg.cron).toBe('*/30 * * * *')
      expect(cfg.retentionDays).toBe(7)
    })

    it('falls back to defaults when retention_days is unparseable', async () => {
      const settings = makeStubSettings({
        [EXPORT_SETTING_RETENTION_DAYS]: 'not a number',
      })
      const customSvc = new ExportService(makeStubDb(), settings, tmp, makeBufferedLogger())
      const cfg = await customSvc.getRetentionConfig()
      expect(cfg.retentionDays).toBe(DEFAULT_EXPORT_RETENTION_DAYS)
    })
  })

  describe('getLastExportAt', () => {
    it('returns null when latest-bootstrap.json is missing', async () => {
      expect(await svc.getLastExportAt()).toBeNull()
    })

    it('returns ISO mtime when latest-bootstrap.json exists', async () => {
      const exportsDir = path.join(tmp, 'exports')
      await fs.ensureDir(exportsDir)
      const target = path.join(exportsDir, 'latest-bootstrap.json')
      await fs.writeJson(target, { sentinel: true })
      const value = await svc.getLastExportAt()
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    })
  })
})
