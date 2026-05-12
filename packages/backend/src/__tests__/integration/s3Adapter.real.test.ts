import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { S3StorageAdapter } from '../../storage/adapters/S3StorageAdapter'

/**
 * Real-S3 integration test, gated on CI_INTEGRATION=1.
 *
 * Expects a MinIO container reachable at http://localhost:9000 with bucket
 * `drk-test` pre-created (see packages/backend/docker-compose.test.yml and the
 * `make test-integration` target). When CI_INTEGRATION is unset we skip the
 * whole describe so the default `jest` run stays hermetic.
 *
 * The S3StorageAdapter wraps restic, so the host must have a `restic` binary
 * on PATH. Failure to find restic surfaces as a clear error message inside
 * the test, not as a Jest framework crash.
 */
const ENABLED = process.env.CI_INTEGRATION === '1'
const describeOrSkip = ENABLED ? describe : describe.skip

describeOrSkip('S3StorageAdapter (real MinIO)', () => {
  let tmp: string
  let adapter: S3StorageAdapter
  const remoteName = 'integration-test/sample.bin'

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'drk-s3-int-'))
    adapter = new S3StorageAdapter({
      type: 's3',
      bucket: 'drk-test',
      endpoint: 'http://localhost:9000',
      accessKey: 'minioadmin',
      secretKey: 'minioadmin',
      region: 'us-east-1',
      // restic repo encryption password — value is arbitrary for tests.
      password: 'drk-test-password'
    })
  }, 60_000)

  afterAll(async () => {
    if (tmp) await fs.remove(tmp).catch(() => {})
  })

  it('uploads, lists, downloads, and deletes a blob', async () => {
    // 1. Upload — write a small payload to a temp file, then push it through
    // the adapter. The adapter handles restic repo init implicitly.
    const srcFile = path.join(tmp, 'sample.bin')
    const payload = Buffer.from('docker-rescue-kit integration test\n'.repeat(64))
    await fs.writeFile(srcFile, payload)
    await adapter.upload(srcFile, remoteName)

    // 2. List — at least one snapshot should be tagged with our remoteName.
    const listed = await adapter.list(remoteName)
    expect(listed.length).toBeGreaterThanOrEqual(1)

    // 3. Download — restore the snapshot back to disk and verify byte equality.
    const dlFile = path.join(tmp, 'roundtrip.bin')
    await adapter.download(remoteName, dlFile)
    const roundtrip = await fs.readFile(dlFile)
    expect(roundtrip.equals(payload)).toBe(true)

    // 4. Delete — forget the snapshot and confirm list() no longer returns it.
    await adapter.delete(remoteName)
    const afterDelete = await adapter.list(remoteName)
    expect(afterDelete.length).toBe(0)
  }, 120_000)
})
