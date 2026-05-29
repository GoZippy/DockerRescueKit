# DockerRescueKit — Roadmap & Implementation Status

This document is the authoritative reference for what is implemented today,
what is planned for each release, and how the free/Pro/Enterprise feature
split is intended to work. Internal business-plan detail lives in
`.autoclaw/internal/`.

---

## Current State (v1.2 — May 2026)

### What is fully implemented and working

| Area | Details |
|---|---|
| **Backup engine** | Containers, volumes, images, and networks captured as a coherent unit |
| **Pre/post hooks** | `docker exec` hook runner before and after each backup operation |
| **Database exporters** | PostgreSQL, MySQL, MongoDB, Redis, SQLite, InfluxDB, MSSQL (7 total) |
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
| **CLI (`drk`)** | Full CLI wrapping the REST API |
| **Web UI** | React/Vite dashboard: policies, history, restore, connectors, rehearsals, cost analysis |
| **Docker Desktop Extension** | Socket-transport integration; published on Docker Hub |
| **Connectors** | 7 connector types (S3, SMB, SFTP, Rclone, Proxmox, TrueNAS, PBS) |
| **Connector discovery** | Proxmox/TrueNAS/PBS have real discovery; S3/SFTP/Rclone stubs (v1.3) |
| **SSRF protection** | SsrfGuard blocks loopback/link-local/RFC1918 by default (DR-001) |
| **Observability** | `/healthz`, `/metrics` (Prometheus), Pino logs, `X-Request-Id` |
| **Notification delivery** | Slack, ntfy, SMTP email (nodemailer); webhook support |
| **Import/Export config** | Full config export on boot; import from disk or JSON |
| **Security** | AES-256-GCM vault, API-key auth, rate limiting, Zod validation, audit log, SSRF guard |
| **CI/CD** | GitHub Actions: lint → test → build → Docker build + Trivy scan; push on `v*` tags |

### What is NOT yet implemented (gaps)

| Feature | Notes |
|---|---|
| **S3/SFTP/Rclone discovery** | Stubs return []; real discovery needs deps decision (AWS SDK vs raw HTTP, ssh2 vs openssh) |
| **License key / feature gating** | LicenseService exists (RS256 JWT); 5-policy free gate middleware wired but not enforced |
| **Per-policy limits** | Free tier is documented as 5 concurrent policies; gate exists but not strict |
| **Stripe / billing integration** | Square webhooks in LicenseService; Stripe/Lemon Squeezy not integrated |
| **Managed hosted S3 (Pro backend)** | Architecture documented; no cloud backend deployed |
| **Docker account OAuth2** | Planned for Pro sign-in; not started |
| **RBAC / multi-user** | Single API key only; no role-based access |
| **SSO (SAML/OIDC)** | Enterprise feature; not started |
| **Clustering / HA** | Single-process SQLite model; no multi-node |
| **Immutable backups (WORM)** | Documented; not implemented |
| **Ransomware detection** | Documented; not implemented |
| **Drift detection** | Designed; not implemented |
| **Smart tiering / auto-archive** | Documented; not implemented |
| **Fleet / multi-host inventory** | Documented; not implemented |
| **Compliance certifications** | HIPAA/SOC2/GDPR roadmap exists; no audits started |
| **Public website / landing page** | No marketing site exists |
| **Test coverage CI gate** | 21+ Jest test suites exist; coverage threshold not enforced in CI |
| **Connector discovery UI** | AddConnectorWizard has no discovery step; needs C-1/C-2 backend first |
| **Kopia storage engine** | Not implemented; restic-only dedup |
| **CouchDB exporter** | Not implemented; tiredofit parity gap |
| **Cross-host federation** | P3; designed but not started |

---

## Free vs Pro vs Enterprise Split (planned)

The billing model is: **free open-source extension + external license token**
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
- Community support (GitHub Discussions)
- **Limit: 5 concurrent active policies**
- **Limit: 30-day audit log retention**
- No managed hosted backup
- No notifications (Slack, email, webhook)

### Pro (~$15–$25/month — planned)

Suitable for small teams, freelancers, small agencies.

Everything in Free, plus:
- **Unlimited concurrent policies**
- **90-day audit log retention**
- Slack, email, webhook, ntfy notifications
- Backup encryption with AES-256 (bring your own key or managed key)
- Priority support (24-hour response SLA)
- Optional: managed hosted S3 backend (100 GB included, ~$25/month)
  - User's data goes to a dedicated S3 bucket you own or we provision
  - No vendor lock-in: export your bucket credentials any time

Implementation required:
- License token validation service (lightweight, JWT-based)
- Stripe integration for subscription management
- `NotificationService` delivery wiring (Slack webhook, SMTP)
- Feature-flag middleware checking license scope on each request
- Website + upgrade flow

### Enterprise (~$5K–$50K/year — planned)

Suitable for large businesses, MSPs, compliance-sensitive environments.

Everything in Pro, plus:
- Multi-user with RBAC (admin / operator / read-only roles)
- SSO via SAML 2.0 or OIDC
- Customer-managed encryption keys (CMEK / HSM)
- Immutable backups (WORM / object lock)
- Tamper-proof audit log (external sink or notarization)
- Multi-host fleet inventory and central policy management
- Managed HA infrastructure (AWS or GCP, dedicated VPC per customer)
- Clustering (active-active backup service nodes)
- Compliance documentation (HIPAA BAA, SOC2, GDPR DPA on request)
- Dedicated account manager + quarterly business reviews
- 1-hour support SLA + dedicated Slack channel
- MSP/white-label mode (multi-tenant dashboard, reseller margin)

---

## Implementation Priority for Monetization

These are the minimum pieces needed to start charging for Pro:

1. **License validation service** (Days 1–5)
   - Lightweight Node.js microservice or Supabase edge function
   - Issues JWT tokens on subscription activation
   - `/license/verify` endpoint returns feature flags
   - 7–30 day offline grace period baked into the extension

2. **Feature-flag middleware in backend** (Days 3–7)
   - Read license token from `DRK_LICENSE_KEY` env var or settings DB
   - Middleware checks flags before policy creation (enforce 5-policy limit)
   - Middleware enables/disables notification routes

3. **Stripe integration** (Days 5–10)
   - Stripe Checkout for subscription signup
   - Webhook handler for `customer.subscription.updated` / `deleted`
   - License service stores subscription state + issues/revokes tokens

4. **Notification delivery** (Days 5–10, can run in parallel)
   - Wire `NotificationService` to Slack incoming webhook (simplest first)
   - SMTP via Nodemailer for email
   - Generic webhook POST for any HTTP receiver

5. **Landing page / upgrade flow** (Days 1–14, can run in parallel)
   - Simple static site (Next.js, Astro, or even plain HTML)
   - Pricing page, feature comparison table, Stripe Checkout links
   - "Upgrade" button in the extension UI points to the site

6. **Managed S3 backend** (Weeks 3–6, after billing works)
   - Terraform module: S3 bucket + IAM role + KMS key per customer
   - API endpoint to provision a customer bucket and return credentials
   - Extension: "Connect to DockerRescueKit Cloud" option in connector setup

---

## BYOD Backup Destinations — Current vs Planned

All of these are **free** for users who bring their own credentials.
The managed hosted option is the paid differentiator.

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
| Hosted S3 (DockerRescueKit managed) | ⏳ Planned (Pro) | Provisioned per subscriber |
| Hosted HA backend (AWS/GCP tenant) | ⏳ Planned (Enterprise) | Dedicated VPC per customer |

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

## Monetization Decision: What ChatGPT Got Right

The ChatGPT analysis in the project conversation is accurate and aligns with
the internal strategy documents:

- Docker Hub/Marketplace is **distribution**, not billing
- The right model is: **free extension + external paid service/license**
- License token unlocks features; Stripe handles subscriptions
- Managed hosted backup (S3 per subscriber) is the clearest paid differentiator
- BYOD storage (Rclone, SMB, SFTP, PBS) stays free to build trust
- No enterprise support tier until there is capacity to staff it

**Recommended billing stack for solo operator:**

| Component | Choice | Reason |
|---|---|---|
| Payments | Lemon Squeezy or Paddle | Merchant of record; handles VAT/GST automatically; simpler than Stripe for solo |
| License records | Supabase (Postgres + Auth) | Managed; free tier covers early stage |
| Token format | JWT, signed with RS256 | Verifiable offline during grace period |
| Device limits | Activation table in Supabase | Seat count per subscription |
| Feature flags | Returned from `/license/verify` | Easy to add new gates without redeploy |
| Offline grace | 30 days | Extension caches last-known-good token |

**Final initial tiers (committed in [LICENSE](../LICENSE) v1.3, effective 2026-05-24):**

| Tier | Price | Gate |
|---|---|---|
| Free / Community | $0 | 5 concurrent policies, 14-day audit log, all 7 BYOD storage backends, no notifications |
| **Personal Pro Upgrade** | **$29 one-time** | Unlimited policies, 90-day audit, notifications, BYOK encryption. Lifetime updates within current Major Version. Personal/educational use only. |
| **Commercial Pro** | **$149/Seat/yr list — $99 launch** | Personal Pro features + multi-host fleet + 1-yr audit + commercial rights. 3-Seat minimum. Launch lock-in: $99/Seat/yr locked for life while continuously subscribed, through first 1,000 Seats or 2026-12-31. |
| **Enterprise** | **Custom — $5,000 minimum annually** | Commercial Pro + RBAC + SSO + WORM + tamper-proof audit + compliance docs (HIPAA/SOC2/GDPR) + MSP/white-label + managed cloud backup included. |
| **Priority Queue Add-on** | **$750/yr** | 48-hour best-effort response window via private email. Capped at 25 active subscribers/quarter. Stackable on any paid tier. No SLA. |
| **Managed Cloud Backup** | **Waitlist** | Target: $5/mo for 100 GB + $0.02/GB/mo thereafter, free egress up to 2× monthly stored size. Built after billing is stable. |

**No support contracts.** Per LICENSE §5.7, no tier — including Commercial
Pro and the Priority Queue Add-on — constitutes a service level agreement
or support contract. Community help via public GitHub Discussions only.
The Priority Queue Add-on provides a best-effort response *window*, not a
guarantee.

**Sequencing:** ship Free + Personal Pro + Commercial Pro first. Add the
Priority Queue Add-on once there are paying commercial customers asking
for it. Build Managed Cloud Backup last, only after billing has been
stable for a quarter. Pursue Enterprise deals only when the scope can
fund delivery (per LICENSE §5.2: $5K minimum, custom-quoted).

---

## v1.2 — Competitive Response Sprint (in progress)

Driven by `docs/COMPETITIVE_ANALYSIS.md` (2026-05-24). Full task breakdown in
`.autoclaw/orchestrator/sprints/v1.2-launch.yaml`. Three-way pressure:

- **Empty marketplace**: Docker Desktop Extension category for backup/restore
  has no real competitors since Docker archived their own extension
  Oct 2024. Must claim the slot before anyone else.
- **OSS feature gap**: `tiredofit/docker-db-backup` (1.5k★) ships 8 DB engines
  vs DRK's 5 — close it with InfluxDB + MSSQL parity.
- **SEO incumbent**: `offen/docker-volume-backup` (3.6k★, 1M+ pulls) owns
  "docker volume backup" search — need stack recipes + honest comparison page.

### v1.2 P0 scope (ship-this-sprint)

| ID | Task | Owner | Estimate |
|---|---|---|---|
| D-1 | InfluxDB DB exporter | claude-code | 1h |
| D-2 | MSSQL DB exporter | claude-code | 1h |
| D-3 | Wire D-1/D-2 into PolicyWizard UI | kilocode | 1.5h |
| C-1 | docs/STACK_RECIPES.md for 6 homelab stacks | antigravity | 2h |
| C-2 | docs/COMPARE_TO_OFFEN.md | antigravity | 1h |
| M-1 | Marketplace polish + verified-publisher checklist | antigravity | 2h |

### v1.2 P1 scope (slip-to-v1.2.1 OK)

| ID | Task | Owner | Estimate |
|---|---|---|---|
| R-1 | Restore-rehearsal backend MVP (sandbox + smoke checks) | claude-code | 6h |
| R-2 | Restore-rehearsal UI wizard | kilocode | 4h |
| N-1 | Notification delivery (Slack/ntfy/email) | claude-code | 4h |
| B-1 | License-key validation + 5-policy free gate | claude-code | 6h |

### v1.2 P2 (next sprint)

- V-1: First vertical side-car image (`gozippy/drk-plex`) — `itzg/mc-backup`
  template (10M+ pulls from one vertical)
- F-1: Drift detection — alert when unpolicy'd volume gains significant writes
- C-3: Restore-cost dashboard ($/GB egress + time-to-restore per backend)

### v1.3+ queue

- F-2: Cross-host backup federation (DRK-to-DRK protocol)
- B-2: Lemon Squeezy / Paddle integration + Supabase license records
- D-4: Wrap kopia as a 4th engine alongside restic
- D-5: MariaDB explicit exporter + CouchDB exporter

### Restore-rehearsal — the differentiator nobody else ships

The single highest-leverage feature in v1.2. Today `restic`/`kopia`/`borg`
all do integrity checks, but nobody in the Docker-volume niche does
end-to-end "restore this stack into a sandbox network and run smoke
checks." DRK's existing per-archive verification is the foundation; R-1
extends it to stack-level rehearsal with configurable HTTP/exec/DB probes
and a downloadable report. This is the moat that makes the marketplace
claim defensible.

---

## Reference Documents

| Document | Location | Contents |
|---|---|---|
| **Competitive analysis** | `docs/COMPETITIVE_ANALYSIS.md` | SWOT + gap analysis vs Docker Hub images, GH OSS, extension marketplace |
| **Sprint plan v1.2** | `.autoclaw/orchestrator/sprints/v1.2-launch.yaml` | Task IDs, owners, acceptance criteria, dependencies |
| Monetization strategy | `.autoclaw/internal/MONETIZATION_STRATEGY.md` | Full tier definitions, pricing psychology, revenue projections |
| Business plan | `.autoclaw/internal/BUSINESS_PLAN.md` | TAM, competitive analysis, financial model |
| Complete strategy | `.autoclaw/internal/COMPLETE_STRATEGY.md` | Executive summary, go-to-market, success metrics |
| Architecture | `docs/ARCHITECTURE.md` | Component diagram, data flows, security model |
| Deployment by tier | `docs/DEPLOYMENT_BY_TIER.md` | Docker Compose, K8s, Terraform examples for each tier |
| Homelab quickstart | `docs/QUICKSTART_HOMELAB.md` | Proxmox, TrueNAS, Unraid setup guides |
| Observability | `docs/OBSERVABILITY.md` | Prometheus metrics, Grafana dashboard, alerting |
