# DockerRescueKit — Competitive Analysis (2026-05-24)

SWOT + gap analysis across three competitive surfaces:
1. Docker Desktop **Extension Marketplace** (where DRK ships)
2. Docker Hub **container images** (DIY/CLI alternatives)
3. **GitHub OSS** projects (the homelab/devops mindshare layer)

---

## 1. Headline finding

**The Docker Desktop Extension Marketplace category for backup/restore is effectively empty.**

- Docker's own `docker/volumes-backup-extension` was **deprecated 2024-09-30** and the GitHub repo was **archived 2024-10-29**. Docker folded a stripped-down "export this volume to a tarball" into Docker Desktop 4.29+'s native Volumes tab.
- Hub search for `backup`, `restore`, `rescue`, `disaster`, `snapshot` with `type=extension` returns **zero competing extensions** today.
- The only general-purpose extension with meaningful adoption is **Portainer CE** (~6,105 pulls/wk, verified publisher) — not a backup tool.

**This is DRK's wedge.** No competitor is currently fighting for the "scheduled, policy-driven, multi-destination backup with restore rehearsal" job inside Docker Desktop itself. We are alone in the marketplace — but only because Docker has not (yet) re-extended the native Volumes tab.

---

## 2. Competitor matrix — Docker Hub images (top 10 by pulls)

| Image | Pulls | Stars | Last update | Purpose | Direct rival? |
|---|---:|---:|---|---|---|
| `linuxserver/duplicati` | **100M+** | 430 | 9d ago | Encrypted incremental backups w/ web UI, ~40 cloud backends | No — generic backup, not Docker-aware |
| `duplicati/duplicati` | 10M+ | 142 | 3d ago | Upstream of LSIO Duplicati | No — same as above |
| `restic/restic` | 10M+ | 51 | 8mo ago | Bare restic CLI binary | Upstream — DRK uses it |
| `instrumentisto/restic` | 10M+ | 5 | mins ago | Restic rebuild tracking upstream | Upstream |
| `itzg/mc-backup` | 10M+ | 48 | 15h ago | Minecraft-server volume side-car | No — vertical niche |
| `databack/mysql-backup` | 10M+ | 129 | 14d ago | MySQL dump + S3/SMB scheduling | Partial — DB only |
| `mazzolino/restic` | 5M+ | 15 | mins ago | Restic + cron wrapper | Partial — no UI |
| `brabholdsa/backup` | **1M+** | 0 | 10mo ago | MariaDB dump + file scripts, single tag | No — stale, no UI, niche |
| **`offen/docker-volume-backup`** | **1M+** | 42 | 10d ago | Recurring volume backups → S3/WebDAV/Azure/Dropbox/SSH, GPG, notifications | **YES — closest direct rival** |
| `docker/volumes-backup-extension` | 100K+ | 4 | 1y ago | Docker's official extension (archived) | Deprecated |

**On the `brabholdsa/backup` 1M-pull figure you flagged:** the image is stale (10 months, 0 stars, single tag, no readme). The 1M+ pulls reflect CI/legacy scripted environments, not active mindshare. It is **not** a meaningful competitor — `offen/docker-volume-backup` is the real Docker-volume backup leader, with the same 1M+ pulls but active maintenance, 42 stars, and a real feature set.

---

## 3. Competitor matrix — GitHub OSS (where mindshare is won)

| Repo | Stars | Latest release | Status | Threat level |
|---|---:|---|---|---|
| restic/restic | 33,657 | 2025-09 | Active engine | Upstream, not rival |
| duplicati/duplicati | 14,562 | 2026-05 (canary) | Active | Generic, not Docker-aware |
| borgbackup/borg | 13,358 | 2026-03 | Active engine | Upstream-class |
| kopia/kopia | 13,261 | 2026-05 | Active w/ UI | Adjacent, not Docker-volume |
| **nicotsx/zerobyte** | **6,401** | 2026-05 | **Hot — 6.4k stars in 4 months** | **HIGH — same archetype as DRK** |
| **offen/docker-volume-backup** | **3,580** | 2026-04 | Very active | **HIGH — incumbent in our niche** |
| borgbase/vorta | 2,458 | 2026-05 | Active desktop GUI | Low — not Docker |
| borgmatic-collective/borgmatic | 2,253 | 2026-04 | Active | Medium — DB hooks overlap |
| tiredofit/docker-db-backup | 1,501 | 2026-03 | Active | Medium — DB engine coverage exceeds DRK |
| prodrigestivill/postgres-backup-local | 1,163 | tags | Active | Low — Postgres only |
| loomchild/volume-backup | 912 | 2025-09 | Stale-ish | Low |
| jareware/docker-volume-backup | 638 | 2023-08 | Stale | Low |
| blacklabelops/volumerize | 562 | 2021-05 | Dead | Low |

---

## 4. SWOT

### Strengths
- **Only meaningful extension in the marketplace** for scheduled backup/restore — uncontested SEO and "first thing users find" in the Docker Desktop catalog.
- **Full stack:** REST API + CLI + React UI + Docker Desktop Extension. None of the OSS rivals ship all four (offen has no UI, kopia has a generic UI, zerobyte has UI but no Desktop extension).
- **7 storage backends behind one schema**, including **Proxmox PBS** — effectively unique among Docker-backup tools and a wedge into the Proxmox/homelab crowd.
- **Backup verification via real restore-test in a scratch container** — neither offen, tiredofit, nor jareware does this. Restic/kopia/borg only do integrity checks, not end-to-end restore rehearsal.
- **Partial restore (file-browse + extract) from the UI** — unique in the Docker-volume niche.
- **First-class observability** baked in: Prometheus metrics, audit log, AES-256-GCM secret vault.

### Weaknesses
- **No mindshare or brand.** `offen` is the default Reddit/Google answer for "docker volume backup." DRK has zero search presence today.
- **License-key/billing/notification stubs are not implemented** — monetization tier is documented but not enforceable. We cannot capture revenue from non-self-hosted users yet.
- **DB engine coverage trails `tiredofit/docker-db-backup`** — they ship PG/MySQL/Mongo/Redis/InfluxDB/MSSQL/CouchDB/MariaDB; we ship 5 (PG/MySQL/Mongo/Redis/SQLite). Missing **InfluxDB + MSSQL** are easy parity wins.
- **No managed/SaaS offering.** Free tier and Pro promise BYOD storage; competitors like Duplicati's commercial sister product (CloudBerry) and the various "backup-as-a-service" plays own the convenience segment.
- **Backup engine is in-house Node** — we don't have the dedup/encryption maturity of restic/borg/kopia. We mitigate by *wrapping* restic, but power users will compare and notice.
- **No documented disaster-recovery rehearsal playbook** — verification is per-job, but we don't ship a "simulate full host loss" workflow.

### Opportunities
- **Empty marketplace.** Capture the "Docker Desktop backup" search slot before anyone else returns.
- **Proxmox PBS integration** is genuinely unique — there's an entire Proxmox subreddit/forum audience that no Docker backup tool currently serves natively.
- **Restore UX is the universal weakness.** Every OSS tool above is backup-heavy and restore-thin. A polished "restore wizard" + "what would I lose right now" dashboard is a real differentiator.
- **Compliance/audit angle for SMBs.** Audit log + encryption + verification + retention policies map cleanly onto SOC2/HIPAA-lite requirements. Worth a marketing page even before RBAC ships.
- **Vertical side-cars.** `itzg/mc-backup` (10M+ pulls) proves vertical, opinionated, app-specific backups beat general-purpose. Stack-template backups for popular dev stacks (n8n, Plex, Home Assistant, Immich, Nextcloud, Vaultwarden) would be high-leverage marketing artifacts.
- **Docker Desktop telemetry** — the extension surface lets us see "your last backup was 14 days ago" and prompt the user. No CLI rival has this UX channel.

### Threats
- **Docker re-extending the native Volumes tab** — same move that killed their own extension. Our moat is anything beyond "export one volume to a tarball": schedules, policies, remote destinations, restore rehearsal, stack-level consistency. Stay clearly above that line.
- **`nicotsx/zerobyte` (6.4k stars in 4 months)** — if they ship Docker-volume awareness and a Desktop Extension, the differentiation gap closes fast. They're moving quickly.
- **`offen/docker-volume-backup` adding a UI** would commoditize a chunk of our wedge overnight. They've stayed CLI-only for years, but they have the install base to flip the switch any time.
- **License-tier discoverability gap** — once we add Pro features, homelab forums (where AGPL/MIT is table stakes) may push back. Need careful framing of free-vs-paid.
- **Docker Desktop extension policy changes** — Docker has tightened verification requirements before; a future shift could de-list non-reviewed extensions.

---

## 5. Gap analysis

### Capabilities competitors have that DRK lacks

| Capability | Who has it | DRK status | Effort | Priority |
|---|---|---|---|---|
| Dedup/CDC backup engine | restic, borg, kopia | We wrap restic only | Hard — wrap kopia/borg too | Medium |
| InfluxDB DB exporter | tiredofit | Missing | Small | High (easy parity) |
| MSSQL DB exporter | tiredofit | Missing | Small | High (easy parity) |
| MariaDB explicit exporter | tiredofit, brabholdsa | MySQL covers it; not branded | Trivial (rename/doc) | Quick win |
| CouchDB exporter | tiredofit | Missing | Small | Low |
| GPG encryption of archives | offen | We have AES-256-GCM vault, but not per-archive GPG | Medium | Low (ours is sufficient) |
| Brand recognition / SEO | offen, duplicati, restic | None | Months of content | **Critical** |
| Managed cloud backend | Duplicati commercial (CloudBerry) | Planned Pro-only | Requires billing first | Medium (Pro story) |
| Mobile-friendly restore UI | None do it well | We have responsive React; not optimized | Small | Differentiator opportunity |

### Capabilities DRK has that competitors lack

| Capability | DRK | Competitor closest equivalent |
|---|---|---|
| Docker Desktop Extension | ✅ | Docker's own (archived); nobody else |
| Proxmox PBS backend | ✅ | None |
| Restore-test in scratch container | ✅ | restic/kopia only do integrity checks |
| Partial restore w/ file browser UI | ✅ | Kopia (generic); offen/tiredofit don't |
| Cron + tiered retention via UI | ✅ | offen has cron, no UI |
| Pre/post `docker exec` hooks | ✅ | offen has container stop-hook; tiredofit limited |
| Prometheus metrics out of the box | ✅ | Rare in this category |
| AES-256-GCM secret vault | ✅ | offen uses env vars |
| 7 storage backends in one tool | ✅ | offen ~6, others 1–3 |

### Capabilities **nobody** in the space ships well — pure greenfield

1. **Disaster-recovery rehearsal workflow** — "restore this stack into a sandbox network and run smoke checks." Verification today is per-archive, not stack-level.
2. **Cross-host backup federation** — back up a Synology Docker host *to* a Proxmox host *to* B2. Rclone gets close but is plumbing, not a workflow.
3. **Drift detection** — alert when a container's bind-mount source changes, or when a volume that has no backup policy starts seeing significant writes.
4. **Stack templates** — one-click "back up my n8n / Plex / Home Assistant / Immich install correctly," including DB quiesce, encryption keys, and config.
5. **Ransomware canary** — append-only / WORM enforcement at the policy level (we have it on the roadmap; nobody else ships it).
6. **Restore-cost dashboard** — show $/GB egress and time-to-restore for each backend so users pick intelligently between Local/SMB/B2/S3 IA.

---

## 6. Strategic recommendations

### Do now (next 2 sprints)
1. **Claim the marketplace slot before anyone else does.** Push extension visibility (verified publisher application, README polish, screenshots in `docs/screenshots/`). The category is empty *today*; this won't last forever.
2. **Ship InfluxDB + MSSQL DB exporters.** Closes the only feature-table loss vs. `tiredofit/docker-db-backup`. Probably 1–2 days work each.
3. **Write `docs/STACK_RECIPES.md`** with copy-pasteable backup policy YAML for the top 5 homelab stacks (Home Assistant, Plex/Jellyfin, Immich, Nextcloud, Vaultwarden, n8n). These pages become SEO landing pages for the exact long-tail queries we don't rank for.
4. **Add a "compare to offen" page in docs.** Honest table — what they do, what we add (UI, restore browser, PBS, verification). This catches the comparison-shopping users currently choosing offen by default.

### Do this quarter
5. **Build the restore-rehearsal workflow** end-to-end — UI button that spins up a sandbox network, restores selected backups, runs configurable smoke checks, tears down. This is the single highest-leverage differentiator nobody else ships.
6. **Implement license-key + Stripe/Lemon Squeezy** so Pro tier can capture revenue. Without this, we have no business model.
7. **Notification delivery** (Slack/email/webhook) — stubs only today. Required for Pro to be sellable.

### Do this year
8. **Vertical side-cars / "DRK for X"** — start with one (Plex or Home Assistant), prove the install velocity, then repeat. `itzg/mc-backup` is the template (10M+ pulls from a single-vertical play).
9. **Wrap kopia in addition to restic** — gives us a story for users who already invested in kopia repos.
10. **Cross-host federation MVP** — back up host A to host B via DRK-to-DRK protocol. Unlocks fleet/multi-host story without needing full enterprise RBAC yet.

### Things NOT to do
- **Don't try to out-engineer restic/borg/kopia on dedup.** Wrap them, don't replace them.
- **Don't compete with LSIO/Duplicati on "generic encrypted cloud backup."** That fight is lost; stay Docker-specific.
- **Don't go after enterprise (RBAC/SSO/HA) before billing works.** Owner has confirmed no team to support it; would burn cycles for $0 revenue.

---

## 7. Watchlist

Re-check quarterly:

- `nicotsx/zerobyte` star velocity and Docker integration
- `offen/docker-volume-backup` — any UI/web component
- Docker Desktop release notes — any expansion of native Volumes tab
- Docker Extension Marketplace search results for backup/restore/rescue — first new entrant matters
- `tiredofit/docker-db-backup` for new DB engines we should match

---

*Sources: Docker Hub search (May 2026), GitHub repo metadata for the 15 OSS competitors above, Docker Extensions Marketplace listings.*
