# DockerRescueKit — Roadmap & Implementation Status

This document is the authoritative reference for what is implemented today,
what is planned for each release, and how the free/Pro/Enterprise feature
split is intended to work. Tier pricing and terms are set out in the
[LICENSE](../LICENSE).

---

## Current State (v1.2 — May 2026)

### What is fully implemented and working

| Area | Details |
|---|---|
| **Backup engine** | Containers, volumes, images, and networks captured as a coherent unit |
| **Pre/post hooks** | `docker exec` hook runner before and after each backup operation |
| **Database exporters** | PostgreSQL, MySQL, MongoDB, Redis, SQLite, InfluxDB, MSSQL, CouchDB (8 total) |
| **Storage: Local** | Tarball-based filesystem backup |
| **Storage: SMB/CIFS** | Windows shares via cifs-utils mount + restic |
| **Storage: SFTP** | SSH file transfer via restic |
| **Storage: S3** | AWS S3 and S3-compatible (MinIO, Wasabi, Backblaze B2) via restic |
| **Storage: Proxmox PBS** | Native Proxmox Backup Server integration |
| **Storage: Restic** | Generic Restic repository backend |
| **Storage: Rclone** | ~40 cloud providers; OAuth via host-authorize model (DR-002) |
| **Scheduler** | `node-cron`-based policies; pause/resume without losing state |
| **Retention** | Count-based, time-based, or tiered (daily/weekly/monthly) |
| **Verify** | Restore-test in isolated scratch container; results stored in DB |
| **Rehearsal workflow** | Sandbox restore + smoke checks with SSE streaming (DR-001) |
| **Partial restore** | Browse files inside a backup archive; extract individual files |
| **REST API** | All features reachable via `x-api-key`-authenticated HTTP endpoints |
| **CLI (`drk`)** | Full CLI wrapping the REST API; day-0 setup commands shipped in v1.4 |
| **Web UI** | React/Vite dashboard: policies, history, restore, connectors, rehearsals, cost analysis |
| **Docker Desktop Extension** | Socket-transport integration; published on Docker Hub |
| **Connectors** | 7 connector types (S3, SMB, SFTP, Rclone, Proxmox, TrueNAS, PBS) |
| **Connector discovery** | All discovery-capable connectors wired through `AddConnectorWizard` (v1.4); S3 `ListBuckets`/`ListObjectsV2`, SFTP `readdir`, Rclone `lsjson` |
| **SSRF protection** | SsrfGuard blocks loopback/link-local/RFC1918 by default (DR-001) |
| **Observability** | `/healthz`, `/metrics` (Prometheus), Pino logs, `X-Request-Id` |
| **Notification delivery** | Slack, ntfy, SMTP email (nodemailer); webhook support |
| **Import/Export config** | Full config export on boot; import from disk or JSON |
| **Security** | AES-256-GCM vault, API-key auth, rate limiting, Zod validation, audit log, SSRF guard |
| **CI/CD** | GitHub Actions: lint → test → build → Docker build + Trivy scan; push on `v*` tags |

### What is NOT yet implemented (gaps)

| Feature | Notes |
|---|---|
| **RBAC / multi-user** | Single API key only; no role-based access |
| **SSO (SAML/OIDC)** | Enterprise feature; not started |
| **Clustering / HA** | Single-process SQLite model; no multi-node |
| **Immutable backups (WORM)** | Documented; not implemented |
| **Ransomware detection** | Documented; not implemented |
| **Drift detection** | Designed; not implemented |
| **Smart tiering / auto-archive** | Documented; not implemented |
| **Fleet / multi-host inventory** | Documented; not implemented |
| **Test coverage CI gate** | Jest test suites exist; coverage threshold not enforced in CI |
| **Kopia storage engine** | Not implemented; restic-only dedup |
| **Cross-host federation** | P3; designed but not started |
| **Disk-pressure metric** | `/metrics` gauge returns zeros; reliable implementation planned for v1.5 |
| **Prune Guard socket proxy (PG-2)** | Phase-2 full-coverage opt-in proxy (`drk-guard-proxy`); planned post-v1.4 |

---

## Free vs Pro vs Enterprise Split (planned)

The model is: **free extension + external license token**
that unlocks Pro/Enterprise features inside the same image. No separate
paid image; no feature removed from the codebase — just gates.

### Free (Forever)

Suitable for homelab, indie dev, single-machine Docker Desktop users.

- All storage adapters (local, SMB, SFTP, S3, PBS, Rclone)
- All backup and restore features
- Policy scheduling + retention
- Backup verification
- Partial restore / file browsing
- CLI + REST API + Web UI + Docker Desktop Extension
- AES-256 encryption at rest for stored credentials (all tiers)
- Community support (GitHub Discussions)
- **Limit: 5 concurrent active policies**
- **Limit: 14-day audit log retention**
- No managed hosted backup
- No notifications (Slack, email, webhook)

### Pro (planned)

Suitable for small teams, freelancers, small agencies.

Everything in Free, plus:
- **Unlimited concurrent policies**
- **90-day audit log retention**
- Slack, email, webhook, ntfy notifications
- Backup encryption with AES-256 (bring your own key or managed key)
- Priority support queue (best-effort; not a service-level agreement — see LICENSE §5.7)

### Enterprise (planned)

Suitable for large businesses, MSPs, compliance-sensitive environments.

Everything in Pro, plus:
- Multi-user with RBAC (admin / operator / read-only roles)
- SSO via SAML 2.0 or OIDC
- Customer-managed encryption keys (CMEK / HSM)
- Immutable backups (WORM / object lock)
- Tamper-evident audit log (external sink or notarization)
- Multi-host fleet inventory and central policy management
- Managed HA infrastructure (AWS or GCP, dedicated VPC per customer)
- Clustering (active-active backup service nodes)
- Compliance documentation (HIPAA BAA, SOC2, GDPR DPA on request)
- Priority support with dedicated Slack channel (best-effort; not a service-level agreement — see LICENSE §5.7)
- MSP/white-label mode (multi-tenant dashboard, reseller margin)

---

## BYOD Backup Destinations — Current vs Planned

All of these are free for users who bring their own credentials.

| Destination | Status | Notes |
|---|---|---|
| Local filesystem | ✅ Implemented | Tarball to any path |
| SMB/CIFS (NAS, Windows share) | ✅ Implemented | TrueNAS, Synology, Unraid, QNAP |
| SFTP | ✅ Implemented | Any SSH server; advanced users |
| S3 (AWS, MinIO, Wasabi, B2) | ✅ Implemented | Full S3-compatible ecosystem |
| Proxmox Backup Server | ✅ Implemented | Native PBS deduplication |
| Google Drive | ✅ Implemented | Via Rclone |
| Microsoft OneDrive | ✅ Implemented | Via Rclone |
| Dropbox | ✅ Implemented | Via Rclone |
| Backblaze B2 | ✅ Implemented | Via Rclone or direct S3 |
| Azure Blob Storage | ✅ Implemented | Via Rclone |
| Google Cloud Storage | ✅ Implemented | Via Rclone |
| Mega, Box, pCloud, etc. | ✅ Implemented | Via Rclone (~40 providers) |
| NFS mount | ✅ Implemented | Mount locally, use Local adapter |
| WebDAV | ✅ Implemented | Via Rclone |
| FTP / FTPS | ✅ Implemented | Via Rclone |
| Proxmox cluster (BYOD) | ✅ Implemented | PBS adapter or NFS/SMB to Ceph |
| TrueNAS / FreeNAS | ✅ Implemented | SMB or NFS mount |

---

## Technology Stack

| Layer | Technology |
|---|---|
| Backend runtime | Node.js 20, Express, TypeScript |
| Database | SQLite via `better-sqlite3` |
| Scheduler | `node-cron` |
| Docker API | `dockerode` |
| Encryption | AES-256-GCM (`crypto` built-in) |
| Storage tools | Restic (binary), Rclone (binary), Proxmox Backup Client (binary) |
| Validation | Zod |
| Logging | Pino + structured request IDs |
| Rate limiting | `express-rate-limit` |
| Security headers | `helmet` |
| Frontend | React 18, Vite, Tailwind CSS, TypeScript |
| Extension transport | Docker Desktop SDK (socket) + TCP (standalone) |
| CLI | Node.js CLI, talks to REST API |
| Tests | Jest (21 suites), cross-platform (Ubuntu/Windows/macOS in CI) |
| Container | Docker multi-stage build; Restic + Rclone pre-installed |
| CI/CD | GitHub Actions; Trivy vulnerability scan on every PR |

---

## Release status

### v1.4 — shipped / in-flight

| Item | Status |
|---|---|
| CouchDB exporter (D-5 part) | ✅ Shipped |
| Connector discovery UI wiring | ✅ Shipped |
| CLI day-0 setup commands | ✅ Shipped |
| CORS allowlist + `?apiKey` restriction + secrets hardening | ✅ Shipped |
| License gate (notifications route) + tiered audit TTL | ✅ Partially shipped — remaining gates in code, not yet enforced on all paths |
| Prune Guard MVP (PG-1.1/1.2/1.5/1.6; PG-1.3/1.4 in-flight) | ✅ Shipped experimental (`DRK_PRUNE_GUARD=1`, default OFF in v1.4.0) |
| `drk-mcp` MCP server (PG-1.6) | ✅ Shipped experimental |
| Responsive layout + cron humanization | ✅ Shipped |
| SWITCHING.md migration guide | ✅ Shipped |

### v1.5+ queue

- PG-2: Prune Guard socket proxy (`drk-guard-proxy`) — full non-cooperative coverage, opt-in
- F-2: Cross-host backup federation (DRK-to-DRK protocol)
- D-4: Wrap kopia as a 4th engine alongside restic
- D-5 remainder: MariaDB explicit exporter
- Disk-pressure metric (reliable implementation)
- Remaining licence gates — per-feature enforcement for tiers whose routes don't exist yet (BYOK, fleet, RBAC, SSO, WORM). Already enforced: free 5-policy cap, notifications gate, tiered audit retention.

### Restore-rehearsal

Today `restic`/`kopia`/`borg`
all do integrity checks, but nobody in the Docker-volume niche does
end-to-end "restore this stack into a sandbox network and run smoke
checks." DRK's existing per-archive verification is the foundation; R-1
extends it to stack-level rehearsal with configurable HTTP/exec/DB probes
and a downloadable report.

---

## Reference Documents

| Document | Location | Contents |
|---|---|---|
| Architecture | `docs/ARCHITECTURE.md` | Component diagram, data flows, security model |
| Deployment by tier | `docs/DEPLOYMENT_BY_TIER.md` | Docker Compose, K8s, Terraform examples for each tier |
| Homelab quickstart | `docs/QUICKSTART_HOMELAB.md` | Proxmox, TrueNAS, Unraid setup guides |
| Observability | `docs/OBSERVABILITY.md` | Prometheus metrics, Grafana dashboard, alerting |
