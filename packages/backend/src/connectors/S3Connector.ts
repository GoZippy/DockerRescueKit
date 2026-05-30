import { IConnectorPlugin } from './base'
import { ConnectorDefinition, ConnectorResource, ConnectorTestResult } from '@docker-rescue-kit/shared'
import { S3StorageAdapter } from '../storage/adapters/S3StorageAdapter'
import crypto from 'crypto'

export class S3Connector implements IConnectorPlugin {
  public readonly definition: ConnectorDefinition = {
    type: 's3',
    displayName: 'S3-compatible object storage',
    description: 'AWS S3, Backblaze B2 (S3 API), Wasabi, Cloudflare R2, MinIO. Uses restic for dedup + encryption.',
    icon: 'cloud',
    fields: [
      { name: 'endpoint', label: 'Endpoint', type: 'text', required: false, placeholder: 's3.amazonaws.com', description: 'Leave blank for AWS' },
      { name: 'bucket', label: 'Bucket', type: 'text', required: true },
      { name: 'prefix', label: 'Path prefix (optional)', type: 'text', required: false, placeholder: 'drk' },
      { name: 'region', label: 'Region (AWS only)', type: 'text', required: false, placeholder: 'us-east-1' },
      { name: 'accessKey', label: 'Access key ID', type: 'password', required: true },
      { name: 'secretKey', label: 'Secret access key', type: 'password', required: true },
      { name: 'password', label: 'Repository encryption password', type: 'password', required: true, description: 'Used by restic to encrypt the repo; keep it safe — losing it means losing the backup.' }
    ]
  }

  public async testConnection(config: Record<string, any>): Promise<ConnectorTestResult> {
    const started = Date.now()
    try {
      const adapter = new S3StorageAdapter({ type: 's3', ...config })
      await adapter.test()
      return { success: true, latencyMs: Date.now() - started }
    } catch (err: any) {
      return {
        success: false,
        error: `S3 repository unreachable: ${err?.message ?? String(err)}`,
        latencyMs: Date.now() - started
      }
    }
  }

  /**
   * D1 (DR-001 + DR-004): list candidate destinations on the configured S3
   * endpoint. Two modes:
   *   - no `config.bucket`: ListBuckets (returns buckets the credentials can see)
   *   - `config.bucket` set: ListObjectsV2 with delimiter='/' (returns top-level
   *     prefixes inside the bucket so the user can pick a sub-folder)
   *
   * Uses path-style URLs (https://endpoint/bucket/...) for MinIO compatibility.
   * SigV4-signed via aws4. SsrfGuard is enforced by ConnectorManager before
   * this method runs (DR-003).
   */
  public async discoverDestinations(config: Record<string, any>): Promise<ConnectorResource[]> {
    if (!config.accessKey || !config.secretKey) {
      throw new Error('S3 discovery requires config.accessKey and config.secretKey')
    }
    const endpoint = (config.endpoint || 's3.amazonaws.com').replace(/^https?:\/\//, '').replace(/\/$/, '')
    const region = config.region || 'us-east-1'

    if (!config.bucket) {
      return await listBuckets(endpoint, region, config.accessKey, config.secretKey)
    }
    return await listPrefixes(endpoint, region, config.bucket, config.prefix, config.accessKey, config.secretKey)
  }

  /** @deprecated Forwarded to discoverDestinations for route-layer back-compat. */
  public async discoverResources(config: Record<string, any>): Promise<ConnectorResource[]> {
    return this.discoverDestinations(config)
  }
}

// ─── S3 helpers (module-local; not exported) ────────────────────────────────
// SigV4 is hand-rolled to avoid the @aws-sdk dep (~840KB minified) AND the
// aws4 npm dep (~6KB but a maintenance-burden third-party). Per DR-004 the
// connector only needs GET requests for ListBuckets + ListObjectsV2; chunked
// uploads / streaming auth are out of scope.
//
// XML parsing is also hand-rolled — both response schemas are tiny and stable
// since 2006. Avoids pulling in an XML library purely for this.

interface SigV4Input {
  host: string         // 's3.amazonaws.com' or 'minio:9000'
  path: string         // '/' or '/{bucket}/?list-type=2&...'
  region: string
  accessKey: string
  secretKey: string
  protocol?: 'http' | 'https'
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex')
}

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest()
}

function signingKey(secretKey: string, date: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secretKey}`, date)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, 's3')
  return hmac(kService, 'aws4_request')
}

/**
 * Sign a GET request for S3 (or S3-compatible) via SigV4 and return the
 * headers + URL ready for fetch.
 */
function signGetRequest(input: SigV4Input): { url: string; headers: Record<string, string> } {
  const { host, path, region, accessKey, secretKey } = input
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '')  // 20260529T192500Z
  const dateStamp = amzDate.slice(0, 8)                                            // 20260529
  const emptyPayloadHash = sha256Hex('')

  // Canonical request
  const [rawPath, rawQuery = ''] = path.split('?')
  const canonicalQuery = rawQuery
    .split('&')
    .filter(Boolean)
    .map(p => {
      const [k, v = ''] = p.split('=')
      return [encodeURIComponent(decodeURIComponent(k)), encodeURIComponent(decodeURIComponent(v))]
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${emptyPayloadHash}\nx-amz-date:${amzDate}\n`
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonicalRequest = [
    'GET',
    rawPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    emptyPayloadHash,
  ].join('\n')

  // String to sign
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n')

  // Signature
  const key = signingKey(secretKey, dateStamp, region)
  const signature = crypto.createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex')

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  const protocol = input.protocol ?? 'https'
  return {
    url: `${protocol}://${host}${path}`,
    headers: {
      Host: host,
      'x-amz-content-sha256': emptyPayloadHash,
      'x-amz-date': amzDate,
      Authorization: authorization,
    },
  }
}

async function s3Get(host: string, path: string, region: string, accessKey: string, secretKey: string): Promise<string> {
  const { url, headers } = signGetRequest({ host, path, region, accessKey, secretKey })
  const res = await fetch(url, {
    method: 'GET',
    headers,
    // 20s deterministic cap; sandboxed Node builds time out silently otherwise.
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`S3 HTTP ${res.status}: ${extractS3Error(text) || res.statusText}`)
  }
  return text
}

function extractS3Error(xml: string): string | null {
  const code = /<Code>([^<]+)<\/Code>/.exec(xml)?.[1]
  const msg = /<Message>([^<]+)<\/Message>/.exec(xml)?.[1]
  if (!code && !msg) return null
  return [code, msg].filter(Boolean).join(': ')
}

async function listBuckets(host: string, region: string, accessKey: string, secretKey: string): Promise<ConnectorResource[]> {
  const xml = await s3Get(host, '/', region, accessKey, secretKey)
  const buckets: ConnectorResource[] = []
  // <Buckets><Bucket><Name>X</Name><CreationDate>...</CreationDate></Bucket>...</Buckets>
  const re = /<Bucket>\s*<Name>([^<]+)<\/Name>\s*<CreationDate>([^<]+)<\/CreationDate>\s*<\/Bucket>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    buckets.push({
      id: `s3-bucket-${host}-${m[1]}`,
      connectorId: '',
      name: m[1],
      type: 's3-bucket',
      path: m[1],
      metadata: { endpoint: host, createdAt: m[2] }
    })
  }
  return buckets
}

async function listPrefixes(
  host: string,
  region: string,
  bucket: string,
  prefix: string | undefined,
  accessKey: string,
  secretKey: string
): Promise<ConnectorResource[]> {
  const cleanPrefix = prefix ? prefix.replace(/^\//, '').replace(/\/?$/, '/') : ''
  const params = new URLSearchParams({
    'list-type': '2',
    delimiter: '/',
  })
  if (cleanPrefix) params.set('prefix', cleanPrefix)
  const path = `/${bucket}/?${params.toString()}`

  const xml = await s3Get(host, path, region, accessKey, secretKey)
  const results: ConnectorResource[] = []

  // CommonPrefixes = "folders" under the current prefix
  const cpRe = /<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>\s*<\/CommonPrefixes>/g
  let m: RegExpExecArray | null
  while ((m = cpRe.exec(xml)) !== null) {
    const fullPath = m[1]
    const name = fullPath.replace(cleanPrefix, '').replace(/\/$/, '')
    results.push({
      id: `s3-prefix-${host}-${bucket}-${fullPath}`,
      connectorId: '',
      name,
      type: 's3-prefix',
      path: fullPath,
      metadata: { endpoint: host, bucket }
    })
  }
  return results
}
