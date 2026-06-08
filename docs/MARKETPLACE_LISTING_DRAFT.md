# Docker Hub / Docker Desktop Marketplace Listing

**Status:** SHIPPED to Docker Hub on 2026-06-08 as `gozippy/dockerrescuekit:1.3.1`
(`+ :latest, :standalone-v1.3.1, :standalone-latest`). v1.3 sprint added
real storage discovery (S3 ListBuckets/ListObjectsV2, SFTP readdir, Rclone
lsjson) so the AddConnectorWizard now shows a "Discover destinations"
picker after Test Connection succeeds, instead of asking users to type
bucket names blind. Marketplace listing copy still to be pasted into the
Docker Hub overview editor + verified-publisher form.

Earlier publish history: v1.2.0 was the SWOT-merge-complete draft; v1.3.0
was tagged but never published to Docker Hub (CI workflow failures in
`d296d18`-pre + standalone Dockerfile postinstall trap fixed in `211b9b7`).
v1.3.1 supersedes both.

**License compliance:** All copy below uses §11.3-allowed phrasing. Do
not edit to say "open source", "MIT", "Apache", "permissively licensed",
or "free software" — those are forbidden by §11.2 of the
[LICENSE](../LICENSE). Whenever this file is updated, re-verify the
Licensing section copy matches Schedule A of the LICENSE (§5.2). If
they diverge, the LICENSE wins.

---

## Docker Hub repository page (`hub.docker.com/repository/docker/gozippy/dockerrescuekit/general`)

### Short description (the "Add a description" field, ~100 char cap)

**Use this one:**

```
The active backup, scheduled-snapshot, and one-click restore extension for Docker volumes and stacks.
```

(101 chars. The "active" framing leans on the SWOT finding that Docker
archived their own `volumes-backup-extension` on 2024-10-29 — the
category is effectively empty.)

Alternatives kept on file:

```
Automated backup, scheduled snapshots, and one-click restore for Docker volumes, stacks, and databases.
```

```
Back up Docker volumes and Compose stacks to S3, SMB, SFTP, PBS, or 40+ clouds — scheduled, encrypted, verified.
```

### Categories (Docker Hub allows up to 3)

**Locked:** `Databases & storage` + `Developer tools` + `Monitoring & observability`.

Rationale (per SWOT, see [docs/COMPETITIVE_ANALYSIS.md](COMPETITIVE_ANALYSIS.md)):
- `Databases & storage` is the strongest fit and the most underserved
  marketplace category in DRK's space (Docker's archived extension was
  the only one there).
- `Developer tools` broadens reach to the homelab/Docker-Desktop crowd
  that searches by tool type.
- `Monitoring & observability` because Prometheus metrics + audit log
  are first-class — captures the SRE-adjacent audience who also need
  backup hygiene visibility.

`Security` was the alternative third slot. Rejected because users
searching `Security` expect scanners/vault tools, not backups; we'd
underperform discovery in that category. Revisit if WORM /
ransomware-canary features ship in v1.3+.

---

## Public-facing extension page overview (`hub.docker.com/r/gozippy/dockerrescuekit` — the "No overview available" editor)

```markdown
<p align="center">
  <img src="https://license.gozippy.com/assets/logo.png" alt="Zippy Technologies LLC" width="280">
</p>

# Docker Rescue Kit

**The active backup, scheduled-snapshot, and one-click restore extension for Docker volumes, containers, images, networks, and databases.**

Docker Rescue Kit (DRK) protects your Docker data with policy-driven backups to the storage of your choice — local, SMB/CIFS, SFTP, S3, Proxmox Backup Server, Restic, or any of 40+ cloud providers via Rclone (Google Drive, OneDrive, Backblaze, Dropbox, and more). Snapshots are container-aware: a single policy captures volumes, container config, and Compose stack context together, so a restore brings the whole application back — not just a tarball.

## Why DRK

Docker's own *Volumes Backup & Share* extension was deprecated on September 30, 2024 and folded into the basic Volumes tab — which only does manual single-volume export/import. DRK is the active, multi-backend, scheduling-and-encryption alternative — and as of mid-2026, the only published Docker Desktop Extension in the backup/restore category.

What you get that the bundled Volumes tab does not:

- **Scheduled, policy-driven backups** — cron + tiered retention (count, time, daily/weekly/monthly)
- **Multi-target snapshots** — back up a whole Compose stack as one unit, not one volume at a time
- **7 storage backends** — including Proxmox Backup Server (unique among Docker-backup tools) and ~40 cloud providers via Rclone
- **Browse-to-pick destinations** — once a connector tests OK, DRK shows the actual buckets, prefixes, SFTP directories, or rclone remotes available to that credential. No more typing a bucket name blind and finding out later you misspelled it.
- **Backup verification** — every snapshot can be restore-tested in a scratch container before you trust it (not just an integrity hash)
- **Partial restore browser** — browse archives and extract individual files, or restore the full stack
- **7 typed database exporters** — Postgres, MySQL, MongoDB, Redis, SQLite, InfluxDB, and MSSQL — consistent dumps without pre-quiescing by hand
- **Pre/post hooks** — quiesce apps via `docker exec` before and after each backup
- **SSRF guard on remote endpoints** — cloud instance-metadata (169.254.169.254, IMDSv6) is denied by default; `DRK_SSRF_STRICT=1` extends to the full private/internal set for hosted deployments.

## Features

- 7 storage backends: Local, SMB/CIFS, SFTP, S3-compatible, Proxmox Backup Server, Restic, Rclone (40+ cloud providers)
- Storage discovery: connector wizard enumerates buckets/prefixes (S3), directories (SFTP), and remote folders (Rclone) post-credentials. See [docs/CONNECTORS.md](CONNECTORS.md).
- Safe upgrades: auto-export of database and config on every backend start, plus one-click export and import-from-disk for portable migrations. See [docs/UPGRADE.md](UPGRADE.md).
- Cron-based scheduling with tiered retention
- Backup verification in scratch container
- Partial restore down to individual files
- 7 typed database exporters
- Pre/post hooks via `docker exec`
- AES-256-GCM encrypted credential vault, SSRF guard on remote endpoints (cloud-metadata default-deny; `DRK_SSRF_STRICT=1` for full private-range deny)
- REST API + CLI (`drk`) + embedded React UI
- Prometheus `/metrics`, audit log, `/healthz` probes

## Compared to alternatives

| If you want… | Pick |
|---|---|
| Graphical Docker Desktop extension with policies, restore browser, and verification | **DockerRescueKit** |
| The simplest CLI container that backs up one volume to S3 on a cron | `offen/docker-volume-backup` |
| Best-in-class deduplicating engine you'll wrap with your own scripts | `restic` or `kopia` |
| Polished general-purpose encrypted-cloud backup, not Docker-specific | Duplicati |
| Database dumps and only database dumps | `tiredofit/docker-db-backup` |

Full feature matrix and decision guide: see the [Backup Tools Buyer's Guide](https://github.com/gozippy/DockerRescueKit/blob/main/docs/BACKUP_TOOLS_COMPARISON.md) on GitHub.

## Ready-made recipes for common stacks

Copy-paste DRK policies for [Home Assistant, Plex/Jellyfin, Immich, Nextcloud, Vaultwarden, and n8n](https://github.com/gozippy/DockerRescueKit/blob/main/docs/STACK_RECIPES.md) — each with the right pre/post hooks and restore notes.

## Licensing

Docker Rescue Kit is **source-available under the Zippy Technologies Source-Available Commercial License**. Personal and educational use is free within the documented limits; commercial use requires a paid license from Zippy Technologies LLC.

| Tier | Price | Use case |
|---|---|---|
| Free / Community | $0 | Personal & educational. 5 policies, 14-day audit, all 7 BYOD storage backends |
| Personal Pro Upgrade | **$29 one-time** | Unlimited policies, notifications, 90-day audit, BYOK encryption. Lifetime updates within the current major version. Personal/educational only. |
| Commercial Pro | **$149 / Seat / year — launch price $99 locked in for life** (first 1,000 Seats or through 2026-12-31, whichever first) | Multi-host fleet, 1-year audit, commercial use rights. 3-Seat minimum. |
| Enterprise | Custom — $5,000 minimum / year | RBAC, SSO, WORM, tamper-proof audit, compliance docs, MSP/white-label, managed cloud backup included |
| Priority Queue Add-on | $750 / year | Optional 48-hour best-effort email response window, capped at 25 active subscribers per quarter. Not an SLA. |

Community help is provided on a best-effort basis through public GitHub Discussions. No tier includes a service level agreement or committed support response time.

## Requirements

- Docker Desktop 4.10 or higher

## Links

- GitHub: https://github.com/gozippy/DockerRescueKit
- Issues / feature requests: https://github.com/gozippy/DockerRescueKit/issues
- Backup Tools Buyer's Guide: https://github.com/gozippy/DockerRescueKit/blob/main/docs/BACKUP_TOOLS_COMPARISON.md
- Stack Recipes: https://github.com/gozippy/DockerRescueKit/blob/main/docs/STACK_RECIPES.md
- Commercial licensing: Support@GoZippy.com
```

---

## SWOT findings already merged into the listing copy above

For full analysis, see [docs/COMPETITIVE_ANALYSIS.md](COMPETITIVE_ANALYSIS.md).

- **Empty-marketplace framing in short description** ("The active backup… extension"). Captures DRK's uncontested position.
- **Deprecated-Volumes-Backup hook** in the "Why DRK" section. SWOT confirmed this is high-conviction (Docker archived the repo on 2024-10-29; the bundled Volumes tab only does single-volume tarball export).
- **Three unique-to-the-space wedges** lifted into the Why DRK bullets: Proxmox Backup Server (no other Docker-backup tool ships it), restore-test in scratch container (others do integrity checks only), partial restore browser.
- **Compared-to-alternatives section** added — pulls the buyer's-guide table inline so comparison shoppers don't bounce. Links to the full doc for the long version.
- **Stack recipes call-out** added so the long-tail SEO queries (`backup Plex with DRK`, `backup Home Assistant with DRK`) land on a useful page.
- **DB exporter count bumped to 7** (was 5) to reflect the v1.2 InfluxDB + MSSQL additions that closed the `tiredofit/docker-db-backup` parity gap.
- **Categories locked** at `Databases & storage` + `Developer tools` + `Monitoring & observability` per SWOT category-fit analysis.

## Open items before publish

1. Operator review of this final draft.
2. Capture screenshots from the v1.3.1 image (`gozippy/dockerrescuekit:1.3.1`):
   - `04-restore-browser.png` — partial-restore file browser
   - `05-storage-vault.png` — vault list with multiple connectors saved
   - `06-discover-step.png` — **new for v1.3.1** — the AddConnectorWizard
     "Discover destinations" step showing a list of buckets/dirs picked
     from a live connector
3. ~~Tag `v1.2.0` to trigger Docker Hub build~~ — superseded; `v1.3.1` is live as of 2026-06-08.
4. Paste this listing copy into the Docker Hub repository overview editor
   and the Docker Desktop Marketplace submission form.
5. Submit verified-publisher application using the packet documented in
   `.autoclaw/internal/marketplace-submission.md`.

## Pricing/feature drift watch

These items must stay in sync across three places. If you edit one,
update the others or you will mislead users / fail compliance:

| Item | This file | LICENSE §5.2 / Schedule A | docs/ROADMAP.md |
|---|---|---|---|
| Free tier limits (5 policies, 14-day audit) | ✓ | ✓ | ✓ |
| Personal Pro price ($29 one-time) | ✓ | ✓ | ✓ |
| Commercial Pro list ($149/Seat/yr) | ✓ | ✓ | ✓ |
| Launch lock-in ($99, 1k Seats or 2026-12-31) | ✓ | ✓ | ✓ |
| Priority Queue Add-on ($750/yr, capped, not an SLA) | ✓ | ✓ | ✓ |
| Storage backend count (7) | ✓ | n/a | ✓ |
| DB exporter count (7 after v1.2: PG/MySQL/Mongo/Redis/SQLite/InfluxDB/MSSQL) | ✓ | n/a | n/a |

Re-run this checklist before every tag.
