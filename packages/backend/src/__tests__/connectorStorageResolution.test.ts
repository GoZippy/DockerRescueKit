/**
 * Regression test for the connector-credential resolution bug.
 *
 * Verify, PartialRestore (and Rehearsal) used to call
 * `StorageFactory.create(policy.storage, …)` directly, bypassing
 * PolicyManager.resolveStorageConfig — so any policy that stores its
 * credentials behind a `connectorId` broke for those flows even though
 * runBackup/restoreBackup worked.
 *
 * These tests prove the connector config is now merged in before the adapter
 * is constructed. The mocked StorageFactory captures the config it receives so
 * we can assert the decrypted connector creds made it through.
 */

import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

describe('connector-credential resolution (verify + partial-restore)', () => {
  let stagingDir: string
  let repoDir: string

  beforeEach(async () => {
    stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drk-conn-stage-'))
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drk-conn-repo-'))
  })

  afterEach(async () => {
    await fs.remove(stagingDir)
    await fs.remove(repoDir)
    jest.resetModules()
  })

  it('VerifyService merges connector creds into the storage config it builds the adapter from', async () => {
    // Stage a fake backup tarball + manifest.
    const volFile = path.join(repoDir, 'b1', 'volume_demo.tar.gz')
    await fs.ensureDir(path.dirname(volFile))
    await fs.writeFile(volFile, Buffer.from('fake-tar-content'))
    const checksum = crypto.createHash('sha256').update(await fs.readFile(volFile)).digest('hex')
    await fs.writeJson(path.join(repoDir, 'b1', 'manifest.json'), {
      backupId: 'b1',
      timestamp: new Date().toISOString(),
      type: 'full',
      files: [{ remote: 'b1/volume_demo.tar.gz', checksum, size: 16 }]
    })

    // Capture the config StorageFactory.create receives.
    const seen: any[] = []
    jest.resetModules()
    jest.doMock('../storage/StorageFactory', () => ({
      StorageFactory: {
        create: (_type: string, config: any) => {
          seen.push(config)
          return {
            async download(remote: string, local: string) {
              await fs.copy(path.join(repoDir, remote), local)
            }
          }
        }
      }
    }))

    // A connector-based policy: storage carries only the connectorId; the real
    // creds live in the (decrypted) connector instance.
    const policyManager: any = {
      getBackup: jest.fn().mockResolvedValue({
        id: 'b1', policyId: 'p1', status: 'success',
        targets: [{ type: 'volume', selector: 'demo' }],
        timestamp: new Date(), type: 'full', size: 16, duration: 1
      }),
      getPolicy: jest.fn().mockResolvedValue({
        id: 'p1', storage: { type: 's3', connectorId: 'conn-1' }
      }),
      // Mirror PolicyManager.resolveStorageConfig: merge decrypted creds.
      resolveStorageConfig: jest.fn(async (storage: any) => ({
        type: 's3', accessKeyId: 'AKIA-SECRET', secretAccessKey: 'shhh', ...storage
      }))
    }

    const dockerService: any = {
      importVolume: jest.fn().mockResolvedValue(undefined),
      docker: { getVolume: () => ({ remove: jest.fn().mockResolvedValue(undefined) }) }
    }

    const { VerifyService } = require('../services/VerifyService')
    const svc = new VerifyService(policyManager, dockerService, stagingDir)
    const report = await svc.verify('b1')

    expect(report.ok).toBe(true)
    expect(policyManager.resolveStorageConfig).toHaveBeenCalledWith({ type: 's3', connectorId: 'conn-1' })
    expect(seen[0]).toMatchObject({ accessKeyId: 'AKIA-SECRET', secretAccessKey: 'shhh', connectorId: 'conn-1' })
  })

  it('PartialRestoreService resolves connector creds before fetching from storage', async () => {
    const tarFile = path.join(repoDir, 'b1', 'volume_demo.tar.gz')
    await fs.ensureDir(path.dirname(tarFile))
    await fs.writeFile(tarFile, Buffer.from('payload'))

    const seen: any[] = []
    jest.resetModules()
    jest.doMock('../storage/StorageFactory', () => ({
      StorageFactory: {
        create: (_type: string, config: any) => {
          seen.push(config)
          return {
            async download(remote: string, local: string) {
              await fs.copy(path.join(repoDir, remote), local)
            }
          }
        }
      }
    }))

    const policyManager: any = {
      getBackup: jest.fn().mockResolvedValue({ id: 'b1', policyId: 'p1', status: 'success' }),
      getPolicy: jest.fn().mockResolvedValue({
        id: 'p1', storage: { type: 'sftp', connectorId: 'conn-2' }
      }),
      resolveStorageConfig: jest.fn(async (storage: any) => ({
        type: 'sftp', host: 'sftp.example.com', password: 'p@ss', ...storage
      }))
    }

    const { PartialRestoreService } = require('../services/PartialRestoreService')
    const svc = new PartialRestoreService(policyManager, stagingDir)
    // fetchToStaging is private; reach it to drive the storage path without tar.
    const local = await (svc as any).fetchToStaging('b1', 'volume_demo.tar.gz')

    expect(await fs.pathExists(local)).toBe(true)
    expect(policyManager.resolveStorageConfig).toHaveBeenCalledWith({ type: 'sftp', connectorId: 'conn-2' })
    expect(seen[0]).toMatchObject({ host: 'sftp.example.com', password: 'p@ss', connectorId: 'conn-2' })
  })
})
