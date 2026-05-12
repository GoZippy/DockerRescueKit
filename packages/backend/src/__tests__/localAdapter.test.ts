import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { LocalStorageAdapter } from '../storage/adapters/LocalStorageAdapter'

describe('LocalStorageAdapter', () => {
  let tmp: string
  let srcDir: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'drk-local-'))
    srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drk-src-'))
  })

  afterEach(async () => {
    await fs.remove(tmp)
    await fs.remove(srcDir)
  })

  it('uploads, lists, downloads, and deletes', async () => {
    const adapter = new LocalStorageAdapter({ type: 'local', path: tmp })

    const srcFile = path.join(srcDir, 'hello.txt')
    await fs.writeFile(srcFile, 'world')

    await adapter.upload(srcFile, 'b1/hello.txt')
    expect(await fs.pathExists(path.join(tmp, 'b1/hello.txt'))).toBe(true)

    await fs.writeJson(path.join(tmp, 'b1/manifest.json'), {
      backupId: 'b1',
      timestamp: new Date().toISOString(),
      type: 'full',
      files: [{ checksum: 'x', size: 5 }]
    })

    const listed = await adapter.list()
    expect(listed.map(b => b.id)).toContain('b1')

    const dl = path.join(srcDir, 'out.txt')
    await adapter.download('b1/hello.txt', dl)
    expect(await fs.readFile(dl, 'utf-8')).toBe('world')

    await adapter.deletePrefix('b1')
    expect(await fs.pathExists(path.join(tmp, 'b1'))).toBe(false)
  })

  it('rejects path escapes', async () => {
    const adapter = new LocalStorageAdapter({ type: 'local', path: tmp })
    await expect(adapter.upload('ignored', '../escape.txt')).rejects.toThrow(/escape/i)
  })
})
