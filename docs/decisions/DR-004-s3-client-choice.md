# DR-004 — S3 client choice for D1-s3-discovery

**Status**: Accepted (no consensus blocker — implementation detail)
**Date**: 2026-05-29
**Author**: claude-code (session cc-vsc-d1d2d3)
**Sprint**: v1.3-connectors / Sprint 3 / D1
**Supersedes**: original G1-aws-sdk-decision slot in [v1.3-connectors manifest](../../.autoclaw/orchestrator/manifests/v1.3-connectors.yaml); was never written because DR-002 was reclaimed for rclone OAuth.

## Context

D1-s3-discovery needs to call S3 `ListBuckets` (when `config.bucket` is empty) or `ListObjectsV2` with `delimiter=/` (when a bucket is set, to browse prefixes). The connector must:

- Sign requests with AWS Signature V4
- Work against any S3-compatible endpoint (AWS, Wasabi, Backblaze B2, Cloudflare R2, MinIO)
- Run inside a Docker Desktop extension where bundle size is observable to users
- Not break the SsrfGuard wiring already in `ConnectorManager.discoverResources()`

## Decision

Use **hand-rolled SigV4 + native `fetch`** (not `@aws-sdk/client-s3`, not `aws4`).

Originally proposed `aws4` (~6KB) but during implementation realized SigV4 for GET-only is ~80 LOC and node already ships `crypto`. Eliminating a third-party dep entirely is cleaner: nothing to audit, nothing to rev, nothing in `THIRD_PARTY_LICENSES.md`. The signing logic lives next to its only caller in [`S3Connector.ts`](../../packages/backend/src/connectors/S3Connector.ts) — `signGetRequest()` + `signingKey()` + `sha256Hex()` + `hmac()`.

```ts
const { url, headers } = signGetRequest({ host, path, region, accessKey, secretKey })
const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(20_000) })
```

Parse the XML response with a tiny regex/string scan (S3 ListBucketResult schema is stable and small). No XML library dep.

## Bundle size comparison

| Option | Minified size | Notes |
|---|---|---|
| `@aws-sdk/client-s3` | ~840KB minified + deps | Full SDK with all S3 ops, smithy client, all middleware |
| `aws4` + native fetch | ~6KB | Sig-only; we ship our own request code |
| **Hand-rolled SigV4 (CHOSEN)** | 0 dep KB | ~80 LOC inline. Doable because we only need GET (no chunked uploads, no virtual-host, no streaming signatures). |

SigV4 for GET is small and stable. The edge cases that make hand-rolling risky (chunked uploads, payload hashes for streams, virtual-host vs path-style) don't apply here — we only call `GET /` and `GET /{bucket}/?list-type=2&...` with empty bodies in path-style. Implementation is in `signGetRequest()` next to its caller in S3Connector.ts.

## Alternatives considered

### A) `@aws-sdk/client-s3`
- **Pro**: blessed by AWS, ergonomic, handles every edge case
- **Con**: ~840KB minified is significant in an extension bundle. Marketplace listings note size; offen/docker-volume-backup is a single tiny binary. DRK's pitch is "lighter than the OSS alternatives" — see `docs/BACKUP_TOOLS_COMPARISON.md`.
- **Verdict**: rejected on bundle size

### B) Hand-rolled SigV4
- **Pro**: zero deps
- **Con**: SigV4 has subtle edge cases (canonical path encoding, query string ordering, payload hash for streamed bodies). aws4 has those baked in.
- **Verdict**: rejected on maintenance cost

### C) `aws-sdk` v2 (legacy)
- **Pro**: smaller than v3 for single-service use (~150KB tree-shaken)
- **Con**: deprecated; AWS announced end-of-support 2025
- **Verdict**: rejected

## Consequences

**Positive**
- ~6KB net add to the backend bundle
- No transient runtime errors from middleware mismatches (the SDK pulls in @smithy/* packages whose versions drift independently)
- We control exactly what request shapes we emit, easier to debug against MinIO

**Negative**
- Hand-rolled XML parsing for the ListBuckets / ListObjectsV2 response. We accept this — both responses have ~5 fields total each, with stable schemas defined in the S3 REST API docs since 2006.
- If we ever need PUT/multipart uploads from the connector layer, we'll need to reimplement. (Today `S3StorageAdapter` delegates to restic which speaks S3 natively, so the connector only needs read-side listing.)

**Neutral**
- Same dependency tier as `ssh2` (added in D2): both are pure-Node, well-maintained-for-their-purpose, low-overhead

## Wire format & path style

S3-compatible endpoints split into two path styles:
- **Virtual-host**: `https://bucket.s3.amazonaws.com/...`
- **Path**: `https://s3.amazonaws.com/bucket/...`

DRK uses **path-style** for compatibility with MinIO and self-hosted endpoints (virtual-host requires DNS wildcards). aws4's `host` + `path` fields support path-style natively.

## Tests

- Unit tests mock fetch to assert correct signing + path construction
- Integration test against MinIO (T0 docker-compose) — `CI_INTEGRATION=1` gated

## References

- aws4: https://github.com/mhart/aws4
- S3 ListBuckets: https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListBuckets.html
- S3 ListObjectsV2: https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html
- [DR-001](DR-001-connector-discovery-semantic.md) — the `discoverDestinations()` contract D1 implements
- [DR-003](DR-003-ssrf-posture-default.md) — SSRF guard runs before any fetch
