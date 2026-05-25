# Docker Backup Tools — Buyer's Guide (2026)

You came here because you typed something like *"docker backup tools 2026"*,
*"docker volume backup compare"*, or *"alternative to X for Docker"*.
This page is the honest answer. We compare DockerRescueKit (the tool that
runs this site) to the five most popular tools people pick when they want
to back up Docker volumes and stacks. No FUD, no trick tables — every
tool below is a good choice for *some* problem. The goal is to help you
pick the right one for *your* problem.

> **TL;DR for the impatient**
>
> | If you want… | Pick |
> |---|---|
> | A graphical Docker Desktop extension with scheduled multi-target backups, restore browser, and verification | **DockerRescueKit** |
> | The simplest "one CLI container that backs up a volume to S3 on a cron" | **offen/docker-volume-backup** |
> | A best-in-class deduplicating *engine* you'll wrap with your own scripts | **restic** (or **kopia**) |
> | A polished general-purpose encrypted-cloud backup with web UI, not specifically Docker | **Duplicati** |
> | Database dumps (Postgres / MySQL / Mongo / InfluxDB / MSSQL) and that's it | **tiredofit/docker-db-backup** |

---

## How to read this guide

Five questions decide which tool is right for you:

1. **Do you want a UI, or are you fine driving a CLI?**
2. **Are you backing up Docker volumes/stacks specifically, or generic files?**
3. **Do you need scheduling and retention policies built in, or do you have your own cron?**
4. **Do you need to *prove* backups are restorable (verification), or is "the file exists" enough?**
5. **Do you need to back up databases consistently, or just plain files?**

Each tool below sits in a different sweet spot for those five questions.

---

## At-a-glance feature matrix

| Capability | DockerRescueKit | offen/docker-volume-backup | kopia | restic | Duplicati | tiredofit/docker-db-backup |
|---|---|---|---|---|---|---|
| **Web UI** | ✅ React UI + Docker Desktop Extension | ❌ CLI only | ✅ Web + desktop UI | ❌ CLI only | ✅ Web UI | ❌ CLI only |
| **Docker Desktop Extension** | ✅ (only one in marketplace) | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Docker-volume-aware** | ✅ first-class | ✅ first-class | ⚠️ generic files | ⚠️ generic files | ⚠️ generic files | ➖ DB-only |
| **Whole-stack snapshots** (containers + volumes + networks together) | ✅ | ❌ per-volume | ❌ | ❌ | ❌ | ❌ |
| **Scheduling built in** | ✅ cron + tiered retention | ✅ cron | ⚠️ via daemon/service | ❌ external cron | ✅ | ✅ |
| **Tiered retention** (daily → weekly → monthly) | ✅ | ⚠️ count/age only | ✅ | ✅ | ✅ | ⚠️ count only |
| **Backends — local / SMB / SFTP / S3** | ✅ all 4 | ✅ S3/SSH/WebDAV/Azure/Dropbox | ✅ many | ✅ many | ✅ many | ⚠️ via restic |
| **Backends — Proxmox PBS** | ✅ native | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Backends — Rclone (~40 providers)** | ✅ wrapped | ❌ | ❌ | ✅ via rclone backend | ❌ | ❌ |
| **Encryption at rest** | ✅ AES-256-GCM credential vault + restic repo encryption | ✅ GPG | ✅ AES-256 | ✅ AES-256 | ✅ AES-256 | ⚠️ via restic backend |
| **Deduplication** | ✅ via restic | ❌ (tar) | ✅ content-defined chunking | ✅ content-defined chunking | ✅ block-level | ⚠️ via restic |
| **DB exporters (PG/MySQL/Mongo/Redis/SQLite)** | ✅ 5 + InfluxDB + MSSQL = 7 | ⚠️ via pre-hook script | ❌ | ❌ | ❌ | ✅ 8 engines |
| **Pre/post `docker exec` hooks** | ✅ | ✅ container stop-hook | ❌ | ❌ | ❌ | ⚠️ container-internal only |
| **Restore-test in scratch container** (proves the backup is actually restorable) | ✅ | ❌ | ❌ (integrity check only) | ❌ (integrity check only) | ❌ | ❌ |
| **File-browse + extract from archive (partial restore UI)** | ✅ | ❌ | ✅ | ⚠️ `restic mount` (FUSE) | ✅ | ❌ |
| **REST API** | ✅ | ❌ | ✅ | ❌ | ⚠️ limited | ❌ |
| **CLI** | ✅ `drk` | ✅ (image entrypoint) | ✅ | ✅ | ✅ | ✅ (env-driven) |
| **Prometheus metrics** | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| **Audit log** | ✅ | ❌ | ❌ | ❌ | ⚠️ basic | ❌ |
| **Notifications (Slack / email / webhook / ntfy)** | 🚧 v1.2 P1 | ✅ webhook/exec | ❌ | ❌ | ✅ email | ✅ email/webhook |
| **License / cost** | Source-available — free for personal & educational use; **commercial use requires paid license** (Personal Pro $29 one-time, Commercial $99–$149/seat/yr — see [LICENSE](../LICENSE)) | MPL-2.0 | Apache-2.0 | BSD-2-Clause | LGPL-2.1 (engine) / MIT | MIT |

✅ = first-class • ⚠️ = partial or via workaround • ❌ = not supported • 🚧 = on the v1.2 roadmap

---

## What each tool does well

### DockerRescueKit
Best when you want **a graphical, policy-driven backup system that lives
inside Docker Desktop or on a homelab host** and treats Docker volumes,
containers, and stacks as first-class citizens. Unique among the tools
on this page:

- Only published Docker Desktop Extension in the backup/restore category
- Native **Proxmox Backup Server** backend (no other Docker-backup tool ships this)
- **Restore-test in scratch container** — actually rehearses the restore,
  not just an integrity hash
- Partial restore browser with file-level extract from any archive
- 7 storage backends (Local, SMB, SFTP, S3, PBS, Restic, Rclone)
- 7 DB exporters (Postgres, MySQL, MongoDB, Redis, SQLite, InfluxDB, MSSQL)

DRK is **source-available under the Zippy Technologies Source-Available
Commercial License**. Personal and educational use is free; commercial
use requires a paid license. See [Schedule A in the LICENSE](../LICENSE)
for the full pricing matrix.

### offen/docker-volume-backup
The de-facto answer if you want **a single container that you set on a
cron and walk away from**. ~1M+ pulls on Docker Hub for a reason: it
does one job and does it cleanly. Backs up Docker volumes to S3,
WebDAV, Azure Blob, Dropbox, or SSH, with GPG encryption and a
container-stop hook so you can pause `postgres` while the tarball is
written. No UI, no policy engine, no restore browser — you `docker run`
it again pointed at a different prefix to bring data back. If your
backup story is "one volume → one bucket → cron job," this is probably
the right tool.

### kopia
A **deduplicating engine in the same league as restic**, with the
advantage of shipping its own web UI and desktop GUI. Excellent for
people who already run a Synology/TrueNAS/homelab host and want a
single tool that backs up *everything* (Docker volumes are just files
to kopia). Content-defined chunking gives strong dedup ratios across
similar VMs/containers. Apache-2.0 licensed. The trade-off vs DRK:
kopia is not Docker-aware — it won't quiesce your `postgres` container
or back up a stack-as-a-unit, and there's no Docker Desktop extension.

### restic
The **CLI primitive everyone wraps**. DRK itself uses restic as a
backend, as does `mazzolino/restic`, `instrumentisto/restic`, and
dozens of homemade scripts. If your backup workflow is already heavily
automated (Ansible, Terraform, GitHub Actions) and you just need a
fast, encrypted, deduplicating archive format with broad backend
support, restic is hard to beat. The trade-off: no scheduler, no UI,
no Docker awareness — you bring those yourself.

### Duplicati
A **polished, general-purpose encrypted-cloud backup tool** with a web
UI on port 8200. ~100M+ pulls on Docker Hub through `linuxserver/duplicati`
because it's the default homelab/Unraid/Synology answer for "encrypted
backups to my Google Drive / OneDrive / Backblaze." Block-level
deduplication, ~40 cloud backends, decent restore UI. The trade-off vs
DRK: Duplicati is not Docker-aware. It backs up `/source` to a remote;
it doesn't know that `/var/lib/docker/volumes/postgres_data/_data`
needs `pg_dumpall` first, doesn't snapshot whole Compose stacks
together, and doesn't restore-test.

### tiredofit/docker-db-backup
The **specialist for "I just need DB dumps."** 8 database engines
(Postgres, MySQL/MariaDB, MongoDB, Redis, InfluxDB, MSSQL, CouchDB,
SQLite) with scheduled dumps to local disk, S3, or a restic
repository. Excellent if your stack is "a database that lives in a
container and nothing else needs backing up." DRK's DB-exporter
coverage now matches the most common 7 of those 8 (we don't ship
CouchDB yet), but DRK adds the volume/container/network half of the
backup story that tiredofit deliberately omits.

---

## How to choose — three quick scenarios

**"I have a homelab on Proxmox + Docker, and I want a real UI."**
→ DockerRescueKit. The Proxmox PBS backend + Docker Desktop Extension
combination is genuinely unique among the tools above.

**"I have one Postgres container in production and I want a 12-line
docker-compose.yml that backs it up to B2 every night."**
→ offen/docker-volume-backup (for the volume) + a Postgres pre-hook,
OR tiredofit/docker-db-backup (if you want the dump, not the volume).
DRK works too — but if a single Compose snippet is the whole
requirement, the lighter tools win on simplicity.

**"I'm a sysadmin with restic muscle memory and I just want to back
up some Docker volumes alongside everything else."**
→ Stay on restic. DRK won't add enough on top of what you already
have. If you ever want a UI for the non-restic users on your team,
revisit DRK — it wraps restic under the covers.

---

## What "restore rehearsal" actually means (and why nobody else ships it)

Most backup tools above offer an **integrity check** — "does the
archive parse, do the hashes match?" Restic, kopia, and borg all do
this well. What none of them do is **end-to-end restore rehearsal**:
spin up a sandbox network, restore the backup into a temp volume,
mount it on a stand-in container, run a smoke test (HTTP probe,
`SELECT 1`, etc.), tear it down, and write a pass/fail report.

That's the difference between "the backup exists" and "we just proved
we can recover from it." It's the moment you find out that:
- The `postgres` major-version mismatch will break the restore
- Your `nextcloud` config volume references a path that no longer exists
- The 6 GB tarball is corrupt at byte 5,832,000,001

DRK's v1.1 already does this per-archive (the **Verify** schedule on
each policy). v1.2 extends it to **stack-level rehearsal** —
the single biggest reason to choose DRK over a wrapper-script approach.

---

## See also

- [docs/COMPETITIVE_ANALYSIS.md](COMPETITIVE_ANALYSIS.md) — internal SWOT + gap analysis behind this page
- [docs/STACK_RECIPES.md](STACK_RECIPES.md) — copy-paste DRK policies for the top homelab apps
- [docs/QUICKSTART_HOMELAB.md](QUICKSTART_HOMELAB.md) — Proxmox / TrueNAS / Unraid setup
- [LICENSE](../LICENSE) — Schedule A pricing and commercial-use terms

*Last reviewed: 2026-05-24. If a tool above has changed materially
since this date, please open a GitHub issue and we'll update the
table.*
