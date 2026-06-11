import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { VerifyService } from '../services/VerifyService'

describe('VerifyService (happy path, mocked adapter + docker)', () => {
  let stagingDir: string
  let repoDir: string

  beforeEach(async () => {
    stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drk-verify-stage-'))
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drk-verify-repo-'))
  })

  afterEach(async () => {
    await fs.remove(stagingDir)
    await fs.remove(repoDir)
  })

  it('marks a backup ok when manifest + checksums match', async () => {
    // Stage a fake backup tarball.
    const volFile = path.join(repoDir, 'b1', 'volume_demo.tar.gz')
    await fs.ensureDir(path.dirname(volFile))
    await fs.writeFile(volFile, Buffer.from('fake-tar-content'))
    const checksum = crypto.createHash('sha256').update(await fs.readFile(volFile)).digest('hex')

    const manifestFile = path.join(repoDir, 'b1', 'manifest.json')
    await fs.writeJson(manifestFile, {
      backupId: 'b1',
      timestamp: new Date().toISOString(),
      type: 'full',
      files: [{ remote: 'b1/volume_demo.tar.gz', checksum, size: 16 }]
    })

    // Mock adapter.download to copy from repoDir into staging.
    jest.resetModules()
    jest.doMock('../storage/StorageFactory', () => ({
      StorageFactory: {
        create: () => ({
          async download(remote: string, local: string) {
            await fs.copy(path.join(repoDir, remote), local)
          }
        })
      }
    }))

    const policyManager: any = {
      getBackup: jest.fn().mockResolvedValue({
        id: 'b1', policyId: 'p1', status: 'success',
        targets: [{ type: 'volume', selector: 'demo' }],
        timestamp: new Date(), type: 'full', size: 16, duration: 1000
      }),
      getPolicy: jest.fn().mockResolvedValue({ id: 'p1', storage: { type: 'local', path: repoDir } }),
      // No connectorId on this policy's storage, so resolution is a pass-through.
      resolveStorageConfig: jest.fn(async (storage: any) => storage)
    }

    const dockerService: any = {
      importVolume: jest.fn().mockResolvedValue(undefined),
      docker: { getVolume: () => ({ remove: jest.fn().mockResolvedValue(undefined) }) }
    }

    // Re-require after doMock so the module resolves our mocked factory.
    const { VerifyService: Svc } = require('../services/VerifyService')
    const svc = new Svc(policyManager, dockerService, stagingDir)

    const report = await svc.verify('b1')
    expect(report.ok).toBe(true)
    expect(report.steps.some((s: any) => s.label.startsWith('checksum'))).toBe(true)
    expect(dockerService.importVolume).toHaveBeenCalledWith(expect.any(String), expect.any(String))
  })
})
