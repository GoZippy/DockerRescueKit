/**
 * D1-s3-discovery unit tests.
 *
 * Mocks `fetch` so we can assert request shape (SigV4 headers, path style,
 * query params) and parse the canonical S3 XML responses without a real
 * S3 endpoint. Integration tests against MinIO are gated CI_INTEGRATION=1.
 */
import { S3Connector } from '../../connectors/S3Connector'

const realFetch = global.fetch

afterAll(() => { global.fetch = realFetch })

function mockFetchOk(body: string) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: () => Promise.resolve(body),
  }) as any
}

function mockFetchErr(status: number, body: string) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: 'Forbidden',
    text: () => Promise.resolve(body),
  }) as any
}

describe('S3Connector.discoverDestinations', () => {
  const connector = new S3Connector()
  const creds = { accessKey: 'AKIATEST', secretKey: 'secretval' }

  it('requires credentials', async () => {
    await expect(connector.discoverDestinations({ bucket: 'x' })).rejects.toThrow(/accessKey/)
  })

  describe('ListBuckets (no bucket configured)', () => {
    it('parses bucket list XML into ConnectorResource[]', async () => {
      mockFetchOk(`<?xml version="1.0" encoding="UTF-8"?>
        <ListAllMyBucketsResult>
          <Buckets>
            <Bucket><Name>drk-prod</Name><CreationDate>2024-01-01T00:00:00Z</CreationDate></Bucket>
            <Bucket><Name>drk-test</Name><CreationDate>2024-06-01T00:00:00Z</CreationDate></Bucket>
          </Buckets>
        </ListAllMyBucketsResult>`)

      const results = await connector.discoverDestinations({ ...creds })

      expect(results).toHaveLength(2)
      expect(results[0]).toMatchObject({
        name: 'drk-prod',
        type: 's3-bucket',
        path: 'drk-prod',
      })
      expect(results[0].metadata).toMatchObject({ createdAt: '2024-01-01T00:00:00Z' })
    })

    it('returns empty array when no buckets', async () => {
      mockFetchOk(`<?xml version="1.0"?><ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>`)

      const results = await connector.discoverDestinations({ ...creds })

      expect(results).toEqual([])
    })

    it('hits the configured endpoint, defaults to s3.amazonaws.com', async () => {
      mockFetchOk(`<ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>`)

      await connector.discoverDestinations({ ...creds, endpoint: 'minio:9000' })

      const url = (global.fetch as jest.Mock).mock.calls[0][0] as string
      expect(url).toMatch(/^https:\/\/minio:9000\//)
    })

    it('strips https?:// prefix and trailing / from endpoint', async () => {
      mockFetchOk(`<ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>`)

      await connector.discoverDestinations({ ...creds, endpoint: 'https://s3.us-east-1.amazonaws.com/' })

      const url = (global.fetch as jest.Mock).mock.calls[0][0] as string
      expect(url).toBe('https://s3.us-east-1.amazonaws.com/')
    })
  })

  describe('ListObjectsV2 (bucket configured)', () => {
    it('uses path-style URL + delimiter=/', async () => {
      mockFetchOk(`<ListBucketResult></ListBucketResult>`)

      await connector.discoverDestinations({ ...creds, bucket: 'drk-prod' })

      const url = (global.fetch as jest.Mock).mock.calls[0][0] as string
      expect(url).toMatch(/\/drk-prod\/\?/)
      expect(url).toContain('list-type=2')
      expect(url).toContain('delimiter=%2F')
    })

    it('includes prefix when set', async () => {
      mockFetchOk(`<ListBucketResult></ListBucketResult>`)

      await connector.discoverDestinations({ ...creds, bucket: 'drk-prod', prefix: 'staging/' })

      const url = (global.fetch as jest.Mock).mock.calls[0][0] as string
      expect(url).toContain('prefix=staging%2F')
    })

    it('parses CommonPrefixes into ConnectorResource[]', async () => {
      mockFetchOk(`<ListBucketResult>
        <CommonPrefixes><Prefix>app1/</Prefix></CommonPrefixes>
        <CommonPrefixes><Prefix>app2/</Prefix></CommonPrefixes>
      </ListBucketResult>`)

      const results = await connector.discoverDestinations({ ...creds, bucket: 'drk-prod' })

      expect(results).toHaveLength(2)
      expect(results[0]).toMatchObject({
        name: 'app1',
        type: 's3-prefix',
        path: 'app1/',
      })
    })

    it('normalizes name when prefix is set', async () => {
      mockFetchOk(`<ListBucketResult>
        <CommonPrefixes><Prefix>staging/app1/</Prefix></CommonPrefixes>
      </ListBucketResult>`)

      const results = await connector.discoverDestinations({ ...creds, bucket: 'drk-prod', prefix: 'staging/' })

      expect(results[0].name).toBe('app1')
      expect(results[0].path).toBe('staging/app1/')
    })
  })

  describe('SigV4 signing', () => {
    it('sends required AWS headers', async () => {
      mockFetchOk(`<ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>`)

      await connector.discoverDestinations({ ...creds })

      const headers = (global.fetch as jest.Mock).mock.calls[0][1].headers as Record<string, string>
      expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATEST\//)
      expect(headers.Authorization).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date')
      expect(headers.Authorization).toMatch(/Signature=[0-9a-f]{64}$/)
      expect(headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/)
      expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/)
      expect(headers.Host).toBeTruthy()
    })

    it('uses configured region in credential scope', async () => {
      mockFetchOk(`<ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>`)

      await connector.discoverDestinations({ ...creds, region: 'eu-central-1' })

      const headers = (global.fetch as jest.Mock).mock.calls[0][1].headers as Record<string, string>
      expect(headers.Authorization).toMatch(/Credential=AKIATEST\/\d{8}\/eu-central-1\/s3\/aws4_request/)
    })
  })

  describe('error handling', () => {
    it('surfaces S3 XML error <Code>+<Message>', async () => {
      mockFetchErr(403, `<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code><Message>Bad sig</Message></Error>`)

      await expect(connector.discoverDestinations({ ...creds })).rejects.toThrow(/SignatureDoesNotMatch.*Bad sig/)
    })

    it('falls back to statusText when no XML error', async () => {
      mockFetchErr(500, '')

      await expect(connector.discoverDestinations({ ...creds })).rejects.toThrow(/S3 HTTP 500/)
    })
  })

  it('forwards via deprecated discoverResources() for route-layer back-compat', async () => {
    mockFetchOk(`<ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>`)
    const results = await connector.discoverResources({ ...creds })
    expect(results).toEqual([])
  })
})
