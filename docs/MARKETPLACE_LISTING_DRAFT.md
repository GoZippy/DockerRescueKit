# Docker Hub / Docker Desktop Marketplace Listing — DRAFT

**Status:** DRAFT — do not publish to Docker Hub until competitive SWOT research (in progress in a parallel Claude Code session as of 2026-05-24) is incorporated. Pricing and feature-tier gates in [LICENSE](../LICENSE) and [ROADMAP](ROADMAP.md) may move based on those findings; re-validate this file against the LICENSE before publishing.

**License compliance:** All copy below uses the §11.3-allowed phrasing. Do not edit to say "open source", "MIT", "Apache", "permissively licensed", or "free software" — those are forbidden by §11.2 of the [LICENSE](../LICENSE).

---

## Docker Hub repository page (`hub.docker.com/repository/docker/gozippy/dockerrescuekit/general`)

### Short description (the "Add a description" field, ~100 char cap)

Primary recommendation:

```
Automated backup, scheduled snapshots, and one-click restore for Docker volumes, stacks, and databases.
```

Alternatives:

```
Back up Docker volumes and Compose stacks to S3, SMB, SFTP, PBS, or 40+ clouds — scheduled, encrypted, verified.
```

```
The active successor to Volumes Backup & Share: scheduled, encrypted, multi-backend backups for Docker.
```

### Categories (Docker Hub allows up to 3)

Pending final decision between two options:

- **Recommended:** `Databases & storage` + `Developer tools` + `Monitoring & observability`
- **Alternative:** `Databases & storage` + `Developer tools` + `Security`

`Databases & storage` is the strongest fit (underserved category, real audience overlap). `Developer tools` broadens reach. Third slot is a judgment call — see notes in conversation history.

---

## Public-facing extension page overview (`hub.docker.com/r/gozippy/dockerrescuekit` — the "No overview available" editor)

```markdown
# Docker Rescue Kit

**Automated backup, scheduled snapshots, and one-click restore for Docker volumes, containers, images, networks, and databases.**

Docker Rescue Kit (DRK) protects your Docker data with policy-driven backups to the storage of your choice — local, SMB/CIFS, SFTP, S3, Proxmox Backup Server, Restic, or any of 40+ cloud providers via Rclone (Google Drive, OneDrive, Backblaze, Dropbox, and more). Snapshots are container-aware: a single policy captures volumes, container config, and Compose stack context together, so a restore brings the whole application back — not just a tarball.

## Features

- **7 storage backends** — Local, SMB/CIFS, SFTP, S3-compatible, Proxmox Backup Server, Restic, Rclone (40+ cloud providers)
- **Scheduled policies** — cron-based with tiered retention (count, time, or daily/weekly/monthly tags)
- **Verified backups** — every snapshot can be restore-tested in a scratch container before you trust it
- **Partial restore** — browse a backup and extract individual files, or restore the full stack
- **Database-aware** — built-in exporters for Postgres, MySQL, MongoDB, Redis, and SQLite
- **Pre/post hooks** — quiesce apps via `docker exec` before and after each backup
- **Encrypted credential vault** — AES-256-GCM at rest for every connector secret
- **REST API + CLI (`drk`)** — automate everything the UI does
- **Observability** — Prometheus `/metrics`, audit log, `/healthz` probes

## Why DRK

Docker's own *Volumes Backup & Share* extension was deprecated in September 2024 and folded into the basic Volumes tab — which only does manual export/import. DRK is the active, multi-backend, scheduling-and-encryption successor.

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
- Commercial licensing: Support@GoZippy.com
```

---

## Notes for the SWOT session merging into this draft

- Pricing numbers above mirror Schedule A of the [LICENSE](../LICENSE) as committed 2026-05-24. If SWOT findings indicate a different price, update **both** this file and the LICENSE — they must stay in sync. The grandfather clause in §23 of the LICENSE protects pre-effective-date copies; subsequent pricing changes need a new LICENSE version bump.
- Feature-tier gates above mirror [docs/ROADMAP.md](ROADMAP.md). Same sync rule applies.
- If SWOT recommends adding a Team SKU (the previous research suggested $249/5 seats), insert a row between Personal Pro and Commercial Pro and update Schedule A in the LICENSE to match.
- If SWOT recommends an unbundled "managed cloud only" tier (separate from Enterprise), add it.
- The "Why DRK" deprecated-Volumes-Backup framing is high-conviction (Docker really did kill it Sept 2024) — keep that hook regardless of pricing shifts.
- The §11.3 phrasing rule is absolute — do not "improve" the license sentence to read like open-source marketing.
