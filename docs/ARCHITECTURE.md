# Architecture & Design

## System Overview

Docker Backup Service is a comprehensive disaster recovery platform for Docker environments. It provides:

1. **Intelligent Backup Scheduling** - Cron-based policies with smart retention
2. **Multi-Destination Storage** - Local, NAS, cloud, object storage, managed services
3. **Granular Recovery** - Full or partial restore to any point-in-time
4. **User Management** - Docker Desktop Extension UI for intuitive policy management
5. **Enterprise Features** - Encryption, hooks, notifications, metrics

## Core Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                Docker Desktop (Host Machine)                 │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────────┐          ┌──────────────────┐        │
│  │  Docker Engine   │          │  Docker Desktop  │        │
│  │  (dockerd)       │◄────────►│  UI & Extensions │        │
│  └──────────────────┘          └──────────────────┘        │
│           ▲                              ▲                   │
│           │                              │                   │
│           │ Docker API (Unix socket)     │ IPC               │
│           │                              │                   │
│  ┌────────┴──────────────────────────────┴──────────────┐  │
│  │                                                        │  │
│  │   ┌──────────────────────────────────────────────┐   │  │
│  │   │  Docker Backup Extension UI (React)          │   │  │
│  │   ├──────────────────────────────────────────────┤   │  │
│  │   │ - Dashboard (policy status, next backup)      │   │  │
│  │   │ - Policy Editor (targets, schedule, retention)│   │  │
│  │   │ - Storage Config (credentials, testing)       │   │  │
│  │   │ - Restore Wizard (point-in-time selection)    │   │  │
│  │   │ - Backup History (timeline, details)          │   │  │
│  │   └──────────────────────────────────────────────┘   │  │
│  │                         │                              │  │
│  │                    HTTP REST API                       │  │
│  │                    (localhost:42880)                   │  │
│  │                         ▼                              │  │
│  │   ┌──────────────────────────────────────────────┐   │  │
│  │   │  Backend Service (Node.js/Express)           │   │  │
│  │   ├──────────────────────────────────────────────┤   │  │
│  │   │ ┌────────────────────────────────────────┐   │   │  │
│  │   │ │ Docker Client                          │   │   │  │
│  │   │ │ - List containers/volumes/images       │   │   │  │
│  │   │ │ - Create/commit/export                 │   │   │  │
│  │   │ │ - Execute hooks                        │   │   │  │
│  │   │ └────────────────────────────────────────┘   │   │  │
│  │   │                                               │   │  │
│  │   │ ┌────────────────────────────────────────┐   │   │  │
│  │   │ │ Scheduler Engine                       │   │   │  │
│  │   │ │ - Parse/validate cron expressions      │   │   │  │
│  │   │ │ - Execute backups on schedule          │   │   │  │
│  │   │ │ - Apply retention policies             │   │   │  │
│  │   │ │ - Tag backups (daily/weekly/monthly)   │   │   │  │
│  │   │ └────────────────────────────────────────┘   │   │  │
│  │   │                                               │   │  │
│  │   │ ┌────────────────────────────────────────┐   │   │  │
│  │   │ │ Policy Manager                         │   │   │  │
│  │   │ │ - CRUD policies                        │   │   │  │
│  │   │ │ - Validate targets/retention           │   │   │  │
│  │   │ │ - Track backup history                 │   │   │  │
│  │   │ └────────────────────────────────────────┘   │   │  │
│  │   │                                               │   │  │
│  │   │ ┌────────────────────────────────────────┐   │   │  │
│  │   │ │ Storage Adapter Factory                │   │   │  │
│  │   │ │ - Pluggable storage backends           │   │   │  │
│  │   │ │ - Local, SMB, S3, SFTP, Drive, etc     │   │   │  │
│  │   │ │ - Most cloud backends use restic       │   │   │  │
│  │   │ │   or rclone under the hood             │   │   │  │
│  │   │ └────────────────────────────────────────┘   │   │  │
│  │   │                                               │   │  │
│  │   │ ┌────────────────────────────────────────┐   │   │  │
│  │   │ │ ConnectorManager + ConnectorRegistry   │   │   │  │
│  │   │ │ - Persisted connector instances        │   │   │  │
│  │   │ │ - PBS, Proxmox, Rclone, S3, SFTP,      │   │   │  │
│  │   │ │   TrueNAS plugins                      │   │   │  │
│  │   │ └────────────────────────────────────────┘   │   │  │
│  │   │                                               │   │  │
│  │   │ ┌────────────────────────────────────────┐   │   │  │
│  │   │ │ Verify / PartialRestore Services       │   │   │  │
│  │   │ │ - Restore-test in scratch container    │   │   │  │
│  │   │ │ - Browse + extract individual files    │   │   │  │
│  │   │ └────────────────────────────────────────┘   │   │  │
│  │   │                                               │   │  │
│  │   │ ┌────────────────────────────────────────┐   │   │  │
│  │   │ │ PruneGuardService + GuardMonitor       │   │   │  │
│  │   │ │ (experimental: DRK_PRUNE_GUARD=1)      │   │   │  │
│  │   │ │ - Event-reactive floor (dockerode      │   │   │  │
│  │   │ │   getEvents subscription)              │   │   │  │
│  │   │ │ - Periodic last-known-good snapshots   │   │   │  │
│  │   │ │ - guard-cache I/O (exportVolume reuse) │   │   │  │
│  │   │ │ - LRU disk-budget eviction + TTL sweep │   │   │  │
│  │   │ │ - /api/guard/* REST + SSE stream       │   │   │  │
│  │   │ │ - guard_events table (SQLite)          │   │   │  │
│  │   │ └────────────────────────────────────────┘   │   │  │
│  │   │                                               │   │  │
│  │   │ ┌────────────────────────────────────────┐   │   │  │
│  │   │ │ drk-mcp (packages/mcp)                 │   │   │  │
│  │   │ │ (experimental: DRK_PRUNE_GUARD=1)      │   │   │  │
│  │   │ │ - MCP server for cooperative agents    │   │   │  │
│  │   │ │ - safe_prune / snapshot_volumes tools  │   │   │  │
│  │   │ │ - Calls /api/guard/* over local API    │   │   │  │
│  │   │ └────────────────────────────────────────┘   │   │  │
│  │   │                                               │   │  │
│  │   │ ┌────────────────────────────────────────┐   │   │  │
│  │   │ │ GuardProxy (opt-in: DRK_GUARD_PROXY=1) │   │   │  │
│  │   │ │ - Docker Engine-API reverse proxy      │   │   │  │
│  │   │ │ - snapshot-first on destructive calls  │   │   │  │
│  │   │ │ - failClosed gate (503) / fail-open    │   │   │  │
│  │   │ │ - feeds the same PruneGuardService.guard│   │   │  │
│  │   │ └────────────────────────────────────────┘   │   │  │
│  │   │                                               │   │  │
│  │   │ ┌────────────────────────────────────────┐   │   │  │
│  │   │ │ Metrics + Audit Services               │   │   │  │
│  │   │ │ - Prometheus /metrics renderer         │   │   │  │
│  │   │ │ - Append-only audit log                │   │   │  │
│  │   │ └────────────────────────────────────────┘   │   │  │
│  │   │                                               │   │  │
│  │   │ ┌────────────────────────────────────────┐   │   │  │
│  │   │ │ Secrets / Vault / Encryption           │   │   │  │
│  │   │ │ - SecretsService (api key + master key)│   │   │  │
│  │   │ │ - VaultService (encrypted credentials) │   │   │  │
│  │   │ │ - AES-256-GCM via EncryptionUtility    │   │   │  │
│  │   │ │ - rclone-backed OAuth2 token storage   │   │   │  │
│  │   │ └────────────────────────────────────────┘   │   │  │
│  │   │                                               │   │  │
│  │   └──────────────────────────────────────────────┘   │  │
│  │                         │                              │  │
│  │                    SQL Queries                         │  │
│  │                         ▼                              │  │
│  │   ┌──────────────────────────────────────────────┐   │  │
│  │   │  SQLite Database                            │   │  │
│  │   ├──────────────────────────────────────────────┤   │  │
│  │   │ - Policies (with JSON retention config)     │   │  │
│  │   │ - Backup history (metadata, checksums)      │   │  │
│  │   │ - Storage configs (encrypted credentials)   │   │  │
│  │   │ - Audit log (all operations)                │   │  │
│  │   │ - Credentials vault (AES-256 encrypted)     │   │  │
│  │   │ - guard_events (Prune Guard — experimental) │   │  │
│  │   └──────────────────────────────────────────────┘   │  │
│  │                                                        │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│                  ┌────────────────────────┐                 │
│                  │  Local Filesystem      │                 │
│                  │  /docker-backups       │                 │
│                  │  - metadata.json       │                 │
│                  │  - volume data (tar)   │                 │
│                  │  - images (tar)        │                 │
│                  │  - container configs   │                 │
│                  │  data/guard-cache/     │                 │
│                  │  - <event-id>/         │                 │
│                  │    manifest.json       │                 │
│                  │    <vol>.tar.gz        │                 │
│                  └────────────────────────┘                 │
│                                                               │
└─────────────────────────────────────────────────────────────┘
         │                           │
         │ Local Storage             │ Network/Cloud Storage
         ▼                           ▼
    ┌─────────────┐            ┌──────────────────┐
    │ SSD/HDD     │            │ Network Storage  │
    │ (fast)      │            │ & Cloud Services │
    │ (short-term)│            │ (long-term)      │
    └─────────────┘            └──────────────────┘
```

**Prune Guard interception front-ends.** Prune Guard (experimental,
`DRK_PRUNE_GUARD=1`) is a single snapshot engine (`PruneGuardService.guard()`)
fed by three independent front-ends: the zero-config event-reactive floor
(`GuardMonitor`), the cooperative-agent MCP server (`drk-mcp`), and the opt-in
`GuardProxy` (`DRK_GUARD_PROXY=1`). The proxy is a dependency-free Docker
Engine-API reverse proxy: agents point at its unix socket (or `127.0.0.1` TCP)
instead of `/var/run/docker.sock`, so every destructive call — `volume rm`,
`volume prune`, `container rm -v`, `container prune`, even from a non-cooperative
or raw-socket client — is snapshotted before being forwarded to the real daemon.
Non-destructive traffic (including streaming logs and `exec`/`attach` HTTP
upgrades) passes through untouched. It is the full-coverage, defense-in-depth
tier; with `failClosed` it can return a 503 and block a destroy it could not
protect, otherwise it is fail-open and never breaks tooling. See
[`docs/PRUNE_GUARD_GUIDE.md`](PRUNE_GUARD_GUIDE.md) and design spec §4b/§5/§7.1.

## Data Flow: Backup Execution

```
1. Scheduler triggers at scheduled time
   └─> SchedulerEngine.runPolicy(policyId)

2. Policy Manager loads policy from database
   └─> Database.getPolicy(policyId)

3. Docker Client discovers targets (containers, volumes, images)
   └─> Docker API: GET /containers/json, /volumes, /images

4. Pre-backup hooks executed (if configured)
   └─> Docker API: POST /containers/{id}/exec

5. Backup executor creates snapshots:
   - Containers: docker commit → image tar
   - Volumes: mount temp container → tar contents
   - Images: docker save → tar archive

6. Storage adapter uploads to destination
   └─> LocalStorageAdapter | S3Adapter | CloudAdapter | etc.

7. Backup metadata written (path, size, checksum, tags)
   └─> Database: INSERT INTO backups

8. Retention policy applied
   └─> SchedulerEngine.applyRetention()
   └─> Delete old backups based on policy

9. Post-backup hooks executed (if configured)
   └─> Notification sent (Slack/email)

10. History updated in UI
    └─> Frontend refreshes backup list
```

## Data Flow: Restore Operation

```
1. User selects backup in UI
   └─> Dashboard → History → Select backup → "Restore"

2. RestoreWizard opens with options:
   - Full restore vs partial (select containers/volumes)
   - Dry-run verification
   - Restore to existing or new names

3. Backend loads backup metadata
   └─> Database.getBackupHistory()

4. Dry-run validation (if enabled)
   └─> Verify backup integrity, check space

5. Storage adapter downloads from destination
   └─> Download backup tar files

6. Restoration begins:
   - Load images: docker load -i image.tar
   - Create volumes: docker volume create
   - Copy volume data: mount container → restore
   - Create containers: docker create + docker start

7. Post-restore hooks (if configured)
   └─> Verification scripts

8. Restore report shown to user
   └─> Success/partial/failed status
```

## Backup Types

### Full Snapshot
- **Containers:** `docker commit` to frozen image + tar export
- **Volumes:** All volume contents tar'd
- **Images:** All images exported as tar
- **Use:** Initial backup, monthly archives
- **Time:** Slow (full size)
- **Size:** Large

### Incremental Backup
- **Volumes:** Only changed blocks since last full backup
- **Images:** Layer-based (only new layers)
- **Containers:** Export changes to committed image
- **Use:** Daily/weekly backups for efficiency
- **Time:** Fast
- **Size:** Small
- **Support:** Local, SMB, Proxmox, S3 (via multipart)

### Snapshot
- **Fast point-in-time capture (metadata only)**
- **Use:** Frequent backups, low overhead
- **Storage:** Just metadata pointers
- **Restore:** Full backup + snapshots to restore

## Retention Policy Engine

### Simple Retention
```
Keep last N backups (default: 7)
```

### Time-based Retention
```
Keep all backups from last N days/weeks/months
Examples:
  - Keep 7 days locally
  - Keep 30 days on NAS
  - Keep 6 months in cloud
```

### Tiered Retention (Recommended)
```
Schedule tagging:
  0 2 * * *     → daily     (keep 7)
  0 4 * * 0     → weekly    (keep 4)
  0 5 1 * *     → monthly   (keep 12)

Result: 7 daily + 4 weekly + 12 monthly = granular history
```

### Example: Aggressive Enterprise Policy
```
Local Tier:
  - 6-hour snapshots, keep 28 (7 days)
  
NAS Tier:
  - Daily full backups, keep 30 days
  - Weekly backups (Sundays), keep 12 weeks
  
Cloud Tier:
  - Monthly full backups, keep 18 months
  - Encrypted, with versioning
```

## Storage Adapters

### Local (fs)
- **Pros:** Fastest, no network latency
- **Cons:** Takes up disk space, must be managed manually
- **Use:** Short-term (3-7 days), primary backup
- **Config:** `{ type: 'local', path: '/docker-backups' }`

### SMB/CIFS (Network Share)
- **Pros:** Standard Windows/Linux, low setup, NAS support
- **Cons:** Slower than local, requires credentials
- **Use:** Medium-term (1-4 weeks), NAS backup
- **Config:** 
  ```json
  {
    "type": "smb",
    "host": "192.168.1.100",
    "share": "docker-backups",
    "username": "admin",
    "credentialsId": "vault-key-123"
  }
  ```

### S3 / Object Storage
- **Pros:** Cheap, durable, versioning, region replication
- **Cons:** Slower restore, API costs
- **Use:** Long-term archive (6+ months)
- **Support:** AWS S3, DigitalOcean Spaces, Backblaze B2, MinIO

### Google Drive / OneDrive
- **Pros:** Free quota, automatic sync, accessible from anywhere
- **Cons:** API rate limits, not designed for large backups
- **Use:** Lite backups, small projects
- **Auth:** OAuth2 (no passwords stored)

### Proxmox Backup Server
- **Pros:** Enterprise-grade, deduplication, compression
- **Cons:** Requires Proxmox infrastructure
- **Use:** Enterprise environments with Proxmox
- **Integration:** Native Proxmox backup protocol

### SFTP / FTP
- **Pros:** Universal, SSH auth, widely available
- **Cons:** Slower than SMB, less reliable than S3
- **Use:** Fallback, legacy systems

## Hybrid Backup Strategy

Recommended multi-tier approach:

```
Tier 1: LOCAL (Docker host)
├─ Schedule: Every 6 hours
├─ Retention: Keep 28 snapshots (7 days)
├─ Storage: /docker-backups (50GB SSD)
└─ Purpose: Fast recovery, development/testing

Tier 2: NAS (Local network)
├─ Schedule: Daily full backup at 2 AM
├─ Retention: Keep 30 daily backups
├─ Storage: CIFS share on NAS (1TB)
├─ Offload: Auto-move old local backups to NAS weekly
└─ Purpose: Medium-term protection, local recovery

Tier 3: CLOUD (Long-term archive)
├─ Schedule: Monthly on 1st day at midnight
├─ Retention: Keep 18 full monthly backups
├─ Storage: S3 with encryption & versioning
├─ Compression: Enabled (zstd)
└─ Purpose: Disaster recovery, regulatory compliance, offsite

Daily workflow:
  6:00 AM → Local snapshot (fast, low storage)
  12:00 PM → Local snapshot
  6:00 PM → Local snapshot
  2:00 AM → Local full → Auto-push to NAS
  1st of month → Full → Auto-push to S3
```

## Security Model

### Credential Management
```
User input credentials
        ↓
Argon2 key derivation
        ↓
AES-256-GCM encryption
        ↓
Store in SQLite vault table
        ↓
Only accessible by backend service
        ↓
OAuth2 credentials stored as refresh tokens
```

### Backup Encryption
```
Optional end-to-end encryption for remote storage:
  Local backup → AES-256-GCM encrypt → Upload to cloud
  Download from cloud → AES-256-GCM decrypt → Restore
  
Key management:
  - Per-policy encryption key option
  - Master key derived from Docker config
  - Key rotation support
```

### Access Control
```
Backend service runs with minimal privileges:
  - Can read Docker socket (limited API access)
  - Can read/write Docker volumes (via containers)
  - Cannot modify daemon config
  - Cannot access host filesystem outside volumes
```

## Performance Considerations

### Backup Performance
```
Bottlenecks:
  1. Docker commit (container → image) - CPU/disk I/O bound
  2. Tar creation (volume contents) - Disk I/O bound
  3. Network upload (SMB/S3) - Network bound
  4. Compression (zstd) - CPU bound

Optimizations:
  - Parallel uploads (multiple storage backends)
  - Streaming tar (don't buffer full contents)
  - Bandwidth limiting (user configurable)
  - Compression level tuning (fast vs ratio)
  - Incremental backups (only changed data)
```

### Retention Cleanup Performance
```
For 1000s of backups:
  - Database query with indexes on (policy_id, timestamp)
  - Batch delete operations
  - Async deletion (don't block scheduler)
  - Cleanup notification on completion
```

### Storage Space Management
```
Local disk strategy:
  - Monitor free space before backup
  - Warn if < 10% remaining
  - Auto-offload to NAS if low
  - Emergency cleanup (delete oldest) if critical

Database:
  - Audit log cleanup (keep 30 days)
  - Backup history: keep metadata indefinitely
  - Credential cache: purge every 24 hours
```

## Disaster Scenario: Complete Docker Loss

**Scenario:** User runs `docker system prune -a --force`

**Without backup service:** Total loss. Months/years of work gone.

**With backup service:**

```
1. Docker backup files are on separate storage
   - Local: /docker-backups/ on different partition
   - NAS: Separate network storage (immune to host wipe)
   - Cloud: S3 (completely independent)

2. Recovery process:
   a. Restore Docker (fresh install)
   b. Deploy backup service
   c. Run restore wizard:
      docker backup restore my-backup --timestamp 2025-01-15T14:30:00Z
   d. All containers, volumes, networks recreated
   e. State restored to specific point-in-time

3. Time to recovery: 30 minutes to 2 hours
   (depending on backup size and restore source)
```

---

## Security Hardening

### API Key Auth
Every `/api/*` route requires a presented API key — either via the
`x-api-key` HTTP header (preferred) or `?apiKey=` query parameter
(fallback for `<img>`/`<a>` URLs). The key is generated on first start
and persisted at `$DRK_DATA_DIR/secrets.json` (default `data/secrets.json`).
It can be regenerated from the UI Settings panel or by invoking
`SecretsService.regenerateApiKey()` — the file is rewritten and the next
request must use the new value. No restart required; the auth middleware
re-resolves the current key on each request.

### Rate Limiting
Two layers, both per IP:

- **General API limit:** 100 requests / 15 minutes against `/api/*`. Hits
  surface as `429 Too Many Requests` with `RateLimit-*` standard headers.
- **Brute-force limit:** 10 *failed-auth* requests / minute. Implemented
  with `express-rate-limit`'s `skipSuccessfulRequests` so the bucket only
  fills when the API key is wrong. Legitimate dashboard traffic firing
  many parallel calls will never trip it.

### Input Validation
- **Body validation:** Every `POST` / `PUT` route runs the request body
  through a Zod schema (see `src/validation/schemas.ts`). Failures return
  `400 Bad Request` with field-level error details before any handler logic.
- **Param validation:** Routes containing `:id` apply `validateParams(idParamSchema)`
  which enforces a UUID-shape — eliminating SQL-injection-shaped IDs and
  obviously bogus paths.
- **Query caps:** File-listing/extract endpoints cap `?name=` and `?path=`
  length and shape via `fileQuerySchema`.

### Path Safety
`utils/PathSafety.assertSafeEntryPath()` rejects any tar entry path that:

- Contains parent-traversal segments (`..`)
- Is absolute (starts with `/` or a drive letter)
- Contains a null byte (`\0`)
- Begins with `-` (would otherwise be parsed as a CLI flag by tar/restic)

Called before every partial-restore extraction, so a maliciously crafted
backup cannot escape the staging directory or smuggle CLI options into
the underlying tar/restic invocation.

### Encryption at Rest
Connector credentials (S3 secret keys, SFTP passwords, SMB shares,
Rclone OAuth tokens) are encrypted with AES-256-GCM via `EncryptionUtility`
before being persisted to the database. The master key lives in
`secrets.json` alongside the API key and is generated on first run; it
is *not* rotated by the API-key regenerate flow (rotating it would
invalidate every stored credential).

### CSP
Helmet ships a strict Content-Security-Policy with `default-src 'self'`.
The only cross-origin allowances are Google Fonts (`fonts.googleapis.com`
for stylesheets, `fonts.gstatic.com` for the font binaries themselves).
`object-src 'none'`, `frame-ancestors 'none'`. Inline scripts/styles are
permitted because Vite injects a small inline bootstrap.

---

## Health & Observability

- **`GET /healthz`** — Unauthenticated liveness probe registered before
  the auth middleware. Returns `{ status: 'ok', uptime: <seconds> }`.
  Suitable for Docker `HEALTHCHECK`, Kubernetes liveness probes, Uptime
  Kuma, etc.
- **`GET /api/status`** — Authenticated. Returns backend state including a
  `securityWarnings` array surfacing any detected configuration issues (e.g.
  default API key in use, secrets file permission anomalies).
- **`GET /metrics`** — Unauthenticated Prometheus exposition format
  (`text/plain; version=0.0.4`). Renders backup counts, scheduler state,
  policy outcomes, verify pass/fail, and storage usage. **Note:** the
  disk-pressure gauge currently returns zeros; a reliable implementation
  is planned for v1.5.
- **`X-Request-Id` header** — A correlation id is stamped on every
  inbound request by the `requestId` middleware, echoed back on the
  response, included in every structured log line, and embedded in error
  responses (`{ error, code, requestId }`). Pass your own header value
  through and it is preserved end-to-end.
- **Structured stdout logs** — Request log line format:
  `[<iso-timestamp>] [<request-id>] <method> <path> key=<presented-key>`.
  Errors above 500 log full stack; 4xx errors log a single warn line.
  No log files; ship stdout to your aggregator of choice.

---

## Future Enhancements

- **Backup Deduplication:** Content-addressable storage to detect duplicate blocks
- **Compression Profiles:** User-selectable trade-offs (fast, balanced, aggressive)
- **Incremental Snapshots:** Block-level change tracking
- **Distributed Backups:** Backup to multiple destinations simultaneously
- **Backup Verification:** Periodic integrity checks
- **Migration Tools:** Export backups for Docker Swarm/K8s migration
- **Analytics:** Backup statistics, trends, recommendations
- **Mobile App:** Restore & monitoring on the go
- **Kubernetes Integration:** CRDs for policy management in K8s

---

## References

- [Docker API Documentation](https://docs.docker.com/engine/api/)
- [Node.js docker library](https://www.npmjs.com/package/docker-modem)
- [Cron expression format](https://crontab.guru/)
- [SQLite3 for Node.js](https://www.npmjs.com/package/better-sqlite3)
- [AWS SDK for JavaScript](https://aws.amazon.com/sdk-for-javascript/)
