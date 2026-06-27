# DockerRescueKit — UI Guide

A page-by-page tour of the DockerRescueKit (DRK) Docker Desktop extension. Every
page is reachable from the left sidebar. Free and Pro tiers share the same UI;
Pro-gated capabilities are noted inline.

> Screenshots live in [`docs/screenshots/`](screenshots/). Captured from a live
> v1.4.x install.

---

## Dashboard
The home base for your whole Docker environment.

- **Top stats** — Active Policies, Protected Targets, Total Backup Size, and live
  **Docker Status** (Online/Offline).
- **Backup Trends (7 days)** — GB/day and average duration over the last week.
- **Quick Actions** — *Run All Policies*, *Protect a Stack*, and the *New Policy
  Wizard*.
- **Node Telemetry** — live Memory and CPU of the DRK backend container.
- **Recent Backup Runs** — the latest runs with status.

## Backup Policies
Create and manage the policies that drive every backup.

- A card per policy showing: enabled/disabled state, **Active** status, backup
  mode (e.g. `full`), destination (e.g. `local`), and the selected targets
  (`container:…`, `volume:…`, with a `+N` overflow count).
- **Schedule** (e.g. *Daily at 02:00*) and **retention** (e.g. *Keep 7*).
- Per-card **Run now** (▶) and a **⋮ menu** (edit, run, delete).
- A **New Policy** tile to protect more containers & volumes.

## Compose Stacks
One-click protection for Docker Compose projects.

- Auto-detected via `com.docker.compose.project` labels — no manual setup.
- Each stack card shows **container / volume / network** counts and the named
  volumes it owns.
- **Protect this stack** creates a daily backup policy for all of that stack's
  containers and volumes in one click.
- Already-protected stacks show **Protected** + **Last backup OK** and an
  **Edit schedule** control.

## Backup History
Every backup run, searchable and restorable.

- Filter by **status**, **policy**, and **tag**; free-text search by ID, selector,
  or error.
- Columns: **ID**, **Policy**, **When**, **Size**, **Duration**, **Tags**.
- Per-row actions: open the backup **folder**, **verify**, **Restore** (one-click),
  and **delete**.

## Verify History
A log of backup **verifications** — DRK can restore-test a backup in a sandbox and
record whether it passed, so you find out a backup is bad *before* you need it.

## Rehearsals
Scheduled **restore rehearsals**: dry-run restores that prove your backups actually
recover, on a recurring basis, without touching production data.

## Cost Analysis
Compare storage backends before you commit — built-in, source-linked reference
pricing for 15 backends.

- Per-backend cards (Local Disk, SMB/CIFS, SFTP, Proxmox PBS, Hetzner Storage Box,
  AWS S3, and more) showing **monthly cost**, **egress per restore**, **estimated
  restore time**, and a **restore-speed** bar.
- Plain-language notes on durability and trade-offs (e.g. "single disk — no
  redundancy", "no egress fees", "11 nines durability").

## Storage Vault
Your encrypted credential store.

- Saved connector credential sets for cloud and network storage; **sensitive
  fields are encrypted at rest with AES-256-GCM**.
- Shows **Stored Credentials**, the encryption algorithm, and **Unused
  Credentials** (not referenced by any policy).
- **Add Credential** for S3, SFTP, SMB, Proxmox, TrueNAS, or Rclone.

## Integrations (Connectors)
Configure storage backends and remote connectors. Credentials are encrypted at
rest with AES-256-GCM.

- **Rclone cloud remotes** — Google Drive, OneDrive, Dropbox, Backblaze B2,
  WebDAV, S3 and 40+ more (via rclone on the host).
- **Add a connector** — Proxmox VE, TrueNAS SCALE/CORE, S3-compatible object
  storage (AWS S3, Backblaze B2, Wasabi, Cloudflare R2, MinIO), SFTP, Rclone
  remote, Proxmox Backup Server, and SMB/CIFS. Each has an inline "What is this &
  what do I need?" explainer.

## Security Audit
A read-only view of your security posture — surfaces risks like containers running
as root or privileged, and shipped-default secrets that should be rotated.

## Notifications
Outbound alerts for backup outcomes — Slack, email, and webhook sinks, plus a log
of sent notifications. **Pro feature** (Personal Pro and above).

## Settings
- **License** — paste a license token under *About → "Have a license key?"* to
  activate Pro, or set `DRK_LICENSE_KEY`. Shows your current tier and
  encryption-key status (auto-generated vs customer-managed/BYOK).
- **API key** — regenerate the backend API key.
- **Config export / import** — snapshot policies, connectors, settings, and audit
  to disk and restore them (DRK auto-exports a bootstrap snapshot on every start).
- **SMTP / notifications** settings (Pro), update check, build info, and links.

---

### Tiers at a glance
| | Free | Personal Pro ($29 one-time) | Commercial Pro ($99/seat/yr) | Enterprise |
|---|---|---|---|---|
| Concurrent policies | 5 | Unlimited | Unlimited | Unlimited |
| Audit retention | 14 days | 90 days | 365 days | Unlimited |
| Notifications | — | ✅ | ✅ | ✅ |
| Customer-managed key (BYOK) | — | ✅ | ✅ | ✅ |
| AES-256 encryption at rest | ✅ | ✅ | ✅ | ✅ |
| Commercial-use rights | — | — | ✅ | ✅ |
| Multi-host fleet management | — | — | *coming soon* | *coming soon* |

See [`/LICENSE`](../LICENSE) Schedule A for the authoritative terms, and
[gozippy.com/drk](https://gozippy.com/drk) for pricing.
