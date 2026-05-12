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
})
