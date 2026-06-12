import os from 'os'
import path from 'path'
import fs from 'fs-extra'
import { RcloneService } from '../services/RcloneService'

describe('RcloneService', () => {
  let tmpDir: string
  let svc: RcloneService

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drk-rclone-'))
    svc = new RcloneService(tmpDir)
  })

  afterEach(async () => {
    await fs.remove(tmpDir)
  })

  it('getProviders returns known providers', () => {
    const providers = svc.getProviders()
    const names = providers.map(p => p.id)
    expect(names).toEqual(expect.arrayContaining(['drive', 'onedrive', 'b2', 'webdav', 'sftp', 's3']))
  })

  it('creates an empty rclone.conf on construction', () => {
    expect(fs.existsSync(svc.getConfigPath())).toBe(true)
  })

  it('getProviders marks OAuth providers correctly', () => {
    const oauthProviders = svc.getProviders().filter(p => p.authType === 'oauth')
    expect(oauthProviders.map(p => p.id)).toEqual(expect.arrayContaining(['drive', 'onedrive', 'dropbox']))
  })

  it('getProviders marks key-based providers correctly', () => {
    const keyProviders = svc.getProviders().filter(p => p.authType === 'key')
    const ids = keyProviders.map(p => p.id)
    expect(ids).toEqual(expect.arrayContaining(['b2', 's3', 'sftp', 'webdav']))
  })

  it('checkInstall returns a well-formed result regardless of rclone presence', async () => {
    const result = await svc.checkInstall()
    expect(typeof result.installed).toBe('boolean')
    // version is the parsed string when present, otherwise null
    expect(result.version === null || typeof result.version === 'string').toBe(true)
    expect(result.configPath).toBe(svc.getConfigPath())
    // When rclone is missing we must report installed=false with a null version,
    // never throw — the UI relies on this to render the install helper.
    if (!result.installed) {
      expect(result.version).toBeNull()
    }
  })

  it('checkInstall points at a configured but missing rclone binary safely', async () => {
    const prev = process.env.RCLONE_BIN
    process.env.RCLONE_BIN = path.join(tmpDir, 'definitely-not-rclone')
    try {
      const probe = new RcloneService(tmpDir)
      const result = await probe.checkInstall()
      expect(result.installed).toBe(false)
      expect(result.version).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.RCLONE_BIN
      else process.env.RCLONE_BIN = prev
    }
  })
})
