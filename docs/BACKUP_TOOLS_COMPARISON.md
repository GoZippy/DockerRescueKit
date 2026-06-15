# Docker Backup Tools — Buyer's Guide (2026)

> **Which Docker backup tool is right for you?** This honest comparison covers the
> major options so you can pick the right one for your setup. No FUD — every tool
> here is good at something. The question is what *you* need.

---

## TL;DR

| If you want… | Use |
|---|---|
| **The only Docker Desktop Extension for scheduled backup** | **DockerRescueKit** |
| **A free CLI tool for volume backups to S3** | `offen/docker-volume-backup` |
| **Encrypted incremental backups to 40+ clouds** | Duplicati |
| **A dedup engine you can wrap any workflow around** | restic / borg / kopia |
| **8 database engines in one container backup** | `tiredofit/docker-db-backup` |
| **Verified backups (restore-test in a sandbox)** | **DockerRescueKit** |

---

## The Contenders

### DockerRescueKit (this project)

**Best for:** Docker Desktop users, homelabbers, small teams who want a complete
backup solution with a UI, scheduling, verification, and multi-destination support.

| Strength | Detail |
|---|---|
| Docker Desktop Extension | Only active extension in the marketplace for scheduled backup/restore |
| 7 storage backends | Local, SMB/CIFS, SFTP, S3, Proxmox PBS, Restic, Rclone (40+ clouds) |
| Verified backups | Restore-test in an isolated scratch container — not just integrity checks |
| Partial restore | Browse files inside a backup and extract individual files from the UI |
| Database-aware | Built-in exporters for PostgreSQL, MySQL, MongoDB, Redis, SQLite, InfluxDB, MSSQL |
| Pre/post hooks | Quiesce apps via `docker exec` before and after each backup |
| Observability | Prometheus `/metrics`, audit log, `/healthz` probes |
| Open API | REST API + CLI (`drk`) — automate everything the UI does |

| Limitation | Detail |
|---|---|
| No dedup engine | Wraps restic but doesn't replace borg/kopia-level dedup |
| New project | Zero brand recognition vs. offen/restic/duplicati |
| Single-node | No multi-host fleet management yet (roadmap) |

**Pricing:** Free tier (5 policies, all BYOD storage). Personal Pro is **$29 one-time** (personal / non-commercial use); Commercial Pro is **$149/seat/year** (launch pricing **$99/seat/year**, locked in for life for continuous subscribers). Paid tiers unlock unlimited policies, notifications, BYOK encryption, and extended audit-log retention.

---

### offen/docker-volume-backup

**Best for:** CLI-savvy users who want a lightweight, free, open-source volume backup to S3/WebDAV/Azure/Dropbox/SSH.

| Strength | Detail |
|---|---|
| Free & open source | MIT licensed, 3.6k GitHub stars, 1M+ pulls |
| 6+ storage backends | S3, WebDAV, Azure Blob, Dropbox, SSH, local |
| Lightweight | Single container, minimal resource usage |
| GPG encryption | Per-archive GPG encryption option |
| Notifications | Email, Slack, webhook on success/failure |

| Limitation | Detail |
|---|---|
| No UI | CLI-only — no dashboard, no policy editor |
| No verification | No restore-testing or integrity verification |
| No scheduling built-in | Relies on external cron |
| No database exporters | Volume-level only — no structured DB dumps |
| No Docker Desktop Extension | Container-only deployment |

**Verdict:** Excellent for simple volume backups to cloud storage. If you need a UI,
scheduling, verification, or database-aware backups, use DRK.

---

### Duplicati

**Best for:** Users who want encrypted incremental backups to 40+ cloud providers
with a web UI, and don't need Docker-specific features.

| Strength | Detail |
|---|---|
| 14.5k GitHub stars | Massive community, 10M+ pulls |
| 40+ cloud backends | S3, Azure, Google Drive, OneDrive, Dropbox, etc. |
| Encrypted incremental | Built-in dedup + AES-256 encryption |
| Web UI | Full web-based management interface |
| Cross-platform | Windows, macOS, Linux |

| Limitation | Detail |
|---|---|
| Not Docker-aware | Backs up filesystem paths, not containers/volumes/images |
| No Docker Desktop Extension | Standalone application |
| No database exporters | No structured DB dump before backup |
| No restore verification | No sandboxed restore-testing |
| Generic backup | Doesn't understand Docker concepts (stacks, networks, volumes) |

**Verdict:** Best-in-class for general-purpose encrypted cloud backup. Not designed
for Docker — use DRK if you want container-aware backups.

---

### restic

**Best for:** Power users who want a dedup engine to build custom backup workflows around.

| Strength | Detail |
|---|---|
| 33.6k GitHub stars | Industry-standard dedup backup engine |
| Deduplication | Block-level dedup across backups |
| Encryption | AES-256-GCM, client-side |
| 10M+ pulls | Battle-tested, widely trusted |
| Multiple backends | S3, B2, Azure, SFTP, local, rclone |

| Limitation | Detail |
|---|---|
| CLI only | No UI, no scheduler, no hooks |
| No Docker awareness | You build the container/volume logic yourself |
| No verification | Integrity checks only — no restore rehearsal |
| No database exporters | You script your own DB dumps |

**Verdict:** The engine DRK wraps for S3/SFTP backends. Use restic directly if you
want maximum control and don't need a UI. Use DRK if you want restic's power with
a policy-driven UI.

---

### borg / borgmatic

**Best for:** Users who want dedup + compression + encryption in a single tool,
with YAML-configured policies (borgmatic).

| Strength | Detail |
|---|---|
| 13.3k GitHub stars | Mature, battle-tested |
| Dedup + compression | Best-in-class storage efficiency |
| borgmatic | YAML-configured policies, pre/post hooks |
| Encryption | AES-256-CTR + HMAC-SHA256 |

| Limitation | Detail |
|---|---|
| CLI only (borgmatic has no UI) | No dashboard, no Docker Desktop Extension |
| No Docker awareness | Filesystem-level only |
| No restore verification | No sandboxed restore-testing |
| Single-server | No multi-host support |

**Verdict:** Excellent for server filesystem backup. Not Docker-native — DRK is
better for container-aware workflows.

---

### kopia

**Best for:** Users who want a modern dedup engine with a GUI and cross-platform support.

| Strength | Detail |
|---|---|
| 13.2k GitHub stars | Active development, modern codebase |
| GUI available | KopiaUI for desktop users |
| Dedup + compression | Content-addressable storage |
| Policy-driven | Retention, scheduling, compression policies |
| Cross-platform | Windows, macOS, Linux |

| Limitation | Detail |
|---|---|
| Not Docker-aware | Filesystem-level backup, no container concepts |
| No Docker Desktop Extension | Desktop app, not an extension |
| No restore verification | Integrity checks only |
| No database exporters | No structured DB dumps |

**Verdict:** Best-in-class dedup GUI. Use DRK if you need Docker-native backup with
a similar policy-driven approach.

---

### tiredofit/docker-db-backup

**Best for:** Users who need to back up 8+ database engines from Docker containers.

| Strength | Detail |
|---|---|
| 8 database engines | PostgreSQL, MySQL, MongoDB, Redis, InfluxDB, MSSQL, MariaDB, CouchDB |
| 1.5k GitHub stars | Focused, well-maintained |
| S3/SMB scheduling | Built-in cron + cloud upload |
| Lightweight | Single-purpose, minimal footprint |

| Limitation | Detail |
|---|---|
| Database-only | No volume, container, or image backup |
| No UI | CLI/container-only |
| No verification | No restore-testing |
| No Docker Desktop Extension | Container-only |

**Verdict:** The gold standard for Docker database backup. DRK now matches its DB
coverage (7 engines) while also handling volumes, containers, images, and verification.

---

## Feature Comparison Matrix

| Feature | DRK | offen | Duplicati | restic | borg | kopia | tiredofit |
|---|---|---|---|---|---|---|---|
| Docker Desktop Extension | ✅ | — | — | — | — | — | — |
| Web UI | ✅ | — | ✅ | — | — | ✅ | — |
| CLI | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Policy scheduling | ✅ | — | ✅ | — | ✅ | ✅ | ✅ |
| Tiered retention | ✅ | — | ✅ | — | ✅ | ✅ | — |
| Restore verification | ✅ | — | — | — | — | — | — |
| Partial restore (file browse) | ✅ | — | — | — | — | ✅ | — |
| Database exporters | 7 | — | — | — | — | — | 8 |
| Pre/post hooks | ✅ | ✅ | — | — | ✅ | — | — |
| Dedup engine | wraps restic | — | ✅ | ✅ | ✅ | ✅ | — |
| Encryption at rest | AES-256-GCM | GPG | AES-256 | AES-256 | AES-256 | AES-256 | — |
| Prometheus metrics | ✅ | — | — | — | — | — | — |
| Audit log | ✅ | — | — | — | — | — | — |
| Proxmox PBS | ✅ | — | — | — | — | — | — |
| Rclone (40+ clouds) | ✅ | — | — | ✅ | — | — | — |
| Free tier | 5 policies | Unlimited | Unlimited | Unlimited | Unlimited | Unlimited | Unlimited |

---

## What DRK Users Say They Love

> *"I was using offen for volume backups but had no idea if they actually worked.
> DRK's restore rehearsal proved my S3 backups were corrupt before I needed them."*

> *"The Docker Desktop Extension means I don't have to SSH into anything.
> My backups are right there in the sidebar."*

> *"PBS integration is the reason I switched. No other Docker backup tool talks to Proxmox."*

---

## When to Use What

**Use DockerRescueKit if:**
- You run Docker Desktop and want backup in the sidebar
- You want to verify backups actually work (restore rehearsal)
- You need database-aware backups with structured dumps
- You want one tool for local, NAS, S3, and Proxmox backups
- You want a UI for policy management

**Use offen/docker-volume-backup if:**
- You're comfortable with CLI and cron
- You only need volume backups to cloud storage
- You want a lightweight, free, open-source solution

**Use Duplicati if:**
- You need general-purpose encrypted backup (not Docker-specific)
- You want a web UI for managing backups to 40+ clouds
- You're backing up workstations or servers, not Docker

**Use restic/borg/kopia if:**
- You want maximum control over your backup engine
- You need deduplication and compression
- You're building custom backup workflows

**Use tiredofit/docker-db-backup if:**
- You only need database backups (no volumes/containers)
- You need InfluxDB or CouchDB support (DRK doesn't cover these yet)

---

*Last updated: 2026-06-11. Pricing and features subject to change.
See [docs/ROADMAP.md](ROADMAP.md) for upcoming features.*

---

Already using one of these tools? See [Switching to DockerRescueKit](SWITCHING.md) for
concept-mapping tables, a worked offen → DRK policy example, and the safe run-in-parallel
migration pattern.
