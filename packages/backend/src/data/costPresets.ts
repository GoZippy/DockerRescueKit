/**
 * Bundled default cost-comparison dataset for the Cost Analysis page (C-3).
 *
 * This is hand-curated, REPRESENTATIVE reference pricing — not a live quote and
 * not affiliated with or endorsed by any vendor. Cloud storage rates drift, so
 * this dataset is versioned and dated: each cloud row carries a `sourceUrl`
 * pointing at the vendor's official published pricing page, and the UI shows an
 * "as of <date> we believe these are correct — verify with the provider"
 * disclaimer. Bump `COST_PRESETS_UPDATED` (and `COST_PRESETS_SCHEMA_VERSION` on
 * a shape change) whenever you re-check the numbers — typically once per release.
 *
 * Precedence at runtime (see getCostConfig() in index.ts):
 *   1. DRK_COST_CONFIG env var (JSON)  ← user override, always wins
 *   2. these bundled defaults          ← shipped fallback / base comparison
 *
 * Sources last verified 2026-06-12:
 *   - AWS S3 Standard ....... https://aws.amazon.com/s3/pricing/
 *   - AWS Glacier Deep Arch.. https://aws.amazon.com/s3/glacier/pricing/
 *   - Google Cloud Storage .. https://cloud.google.com/storage/pricing
 *   - Azure Blob (Hot) ...... https://azure.microsoft.com/en-us/pricing/details/storage/blobs/
 *   - Cloudflare R2 ......... https://developers.cloudflare.com/r2/pricing/
 *   - Backblaze B2 .......... https://www.backblaze.com/cloud-storage/pricing
 *   - Wasabi ................ https://wasabi.com/pricing
 *   - iDrive e2 ............. https://www.idrive.com/s3-storage-e2/pricing
 *   - DigitalOcean Spaces ... https://www.digitalocean.com/pricing/spaces-object-storage
 *   - Hetzner Storage Box ... https://www.hetzner.com/storage/storage-box/
 *
 * Self-hosted rows (local / SMB / SFTP / Proxmox) and the rclone meta-row have
 * no single vendor price, so they carry no sourceUrl.
 *
 * Known upcoming changes encoded in row notes (so a publish doesn't surprise):
 *   - Wasabi pay-go rises $6.99 → $7.99 / TB-mo on 2026-07-01.
 *   - Storj DELIBERATELY EXCLUDED: its new model (2026-07-01) raises the monthly
 *     minimum from $5 to $50, which would show as "cheap" per-GB while actually
 *     costing a $50/mo floor — misleading for the small-backup audience.
 *
 * Forward-looking (Option B — opt-in "live feed"): a future updater would fetch
 * a newer copy of this exact shape from DRK infra and fall back to these bundled
 * values when offline. Keep the schema stable so that can layer on without
 * touching the UI.
 *
 * Pricing notes: storageType is a display key, not necessarily a distinct DRK
 * backend — R2 / B2 / Wasabi / iDrive e2 / DO Spaces are all reached in practice
 * via the S3 or rclone adapters, and Hetzner via SFTP/SMB/rclone — they are
 * listed separately because their cost profile (notably egress) is what users
 * actually compare.
 */

export interface StorageCostConfig {
  storageType: string
  label: string
  icon: string
  costPerGBMonth: number
  costPerGBDownload: number
  restoreSpeedMBps: number
  durability: string
  notes: string
  /** Official vendor pricing page this row was sourced from (cloud rows only). */
  sourceUrl?: string
}

/** Bump on any breaking change to the StorageCostConfig shape. */
export const COST_PRESETS_SCHEMA_VERSION = 2

/**
 * ISO (YYYY-MM-DD) date this pricing was last reviewed against the vendor
 * sources above. Surfaced in the UI as "Pricing as of …". Update whenever you
 * re-check the numbers below.
 */
export const COST_PRESETS_UPDATED = '2026-06-12'

export const COST_PRESETS: StorageCostConfig[] = [
  // ── Self-hosted / local (no vendor fee) ──────────────────────────────────
  {
    storageType: 'local',
    label: 'Local Disk',
    icon: 'hard-drive',
    costPerGBMonth: 0,
    costPerGBDownload: 0,
    restoreSpeedMBps: 500,
    durability: 'Single disk — no redundancy',
    notes: 'Fastest restore. No cloud egress. Risk: disk failure = total loss.',
  },
  {
    storageType: 'smb',
    label: 'SMB / CIFS (NAS)',
    icon: 'server',
    costPerGBMonth: 0,
    costPerGBDownload: 0,
    restoreSpeedMBps: 100,
    durability: 'Depends on NAS RAID config',
    notes: 'Good for homelab. Speed limited by network. No egress fees.',
  },
  {
    storageType: 'sftp',
    label: 'SFTP / SSH',
    icon: 'lock',
    costPerGBMonth: 0,
    costPerGBDownload: 0,
    restoreSpeedMBps: 50,
    durability: 'Depends on server',
    notes: 'Any SSH server works. Slower than SMB over WAN.',
  },
  {
    storageType: 'proxmox',
    label: 'Proxmox Backup Server',
    icon: 'database',
    costPerGBMonth: 0,
    costPerGBDownload: 0,
    restoreSpeedMBps: 200,
    durability: 'Depends on PBS storage',
    notes: 'Deduplication + compression. No egress. Requires Proxmox infrastructure.',
  },

  // ── Low-cost managed remote (homelab favourite) ──────────────────────────
  {
    storageType: 'hetzner',
    label: 'Hetzner Storage Box',
    icon: 'server',
    costPerGBMonth: 0.004,
    costPerGBDownload: 0,
    restoreSpeedMBps: 80,
    durability: 'RAID-protected (no published durability SLA)',
    notes: '€3.81/mo for 1 TB incl. VAT (~$0.004/GB-mo); larger plans cheaper per GB. Unlimited traffic — no egress fees. EU-based; reach via SFTP/SMB/Borg/rclone.',
    sourceUrl: 'https://www.hetzner.com/storage/storage-box/',
  },

  // ── Hyperscalers ─────────────────────────────────────────────────────────
  {
    storageType: 's3',
    label: 'AWS S3 (Standard)',
    icon: 'cloud',
    costPerGBMonth: 0.023,
    costPerGBDownload: 0.09,
    restoreSpeedMBps: 200,
    durability: '99.999999999% (11 nines, per AWS)',
    notes: 'S3 Standard, us-east-1, first 50 TB ($0.023/GB-mo); egress ~$0.09/GB. Other regions/tiers differ. Egress is the main restore cost.',
    sourceUrl: 'https://aws.amazon.com/s3/pricing/',
  },
  {
    storageType: 'gcs',
    label: 'Google Cloud Storage',
    icon: 'cloud',
    costPerGBMonth: 0.020,
    costPerGBDownload: 0.12,
    restoreSpeedMBps: 200,
    durability: '99.999999999% (11 nines, per Google)',
    notes: 'Standard storage, US region ($0.020/GB-mo). Internet egress tiered $0.12/GB (0–1 TB) down to $0.08/GB (10 TB+); varies by destination.',
    sourceUrl: 'https://cloud.google.com/storage/pricing',
  },
  {
    storageType: 'azure',
    label: 'Azure Blob (Hot)',
    icon: 'cloud',
    costPerGBMonth: 0.018,
    costPerGBDownload: 0.087,
    restoreSpeedMBps: 200,
    durability: '99.999999999% (11 nines, LRS, per Microsoft)',
    notes: 'Hot tier, LRS, first 50 TB (~$0.018/GB-mo). Egress ~$0.087/GB after the first 100 GB/mo free. Region/redundancy change this.',
    sourceUrl: 'https://azure.microsoft.com/en-us/pricing/details/storage/blobs/',
  },

  // ── Low-cost S3-compatible object storage ────────────────────────────────
  {
    storageType: 'r2',
    label: 'Cloudflare R2',
    icon: 'cloud',
    costPerGBMonth: 0.015,
    costPerGBDownload: 0,
    restoreSpeedMBps: 200,
    durability: '99.999999999% (11 nines, per Cloudflare)',
    notes: 'Zero egress fees — restores cost nothing. Storage $0.015/GB-mo, cheaper than S3. S3-compatible API.',
    sourceUrl: 'https://developers.cloudflare.com/r2/pricing/',
  },
  {
    storageType: 'b2',
    label: 'Backblaze B2',
    icon: 'database',
    costPerGBMonth: 0.00695,
    costPerGBDownload: 0.01,
    restoreSpeedMBps: 120,
    durability: '99.999999999% (11 nines, per Backblaze)',
    notes: '$6.95/TB-mo. Egress free up to 3× stored/month, then ~$0.01/GB. S3-compatible.',
    sourceUrl: 'https://www.backblaze.com/cloud-storage/pricing',
  },
  {
    storageType: 'wasabi',
    label: 'Wasabi',
    icon: 'cloud',
    costPerGBMonth: 0.00699,
    costPerGBDownload: 0,
    restoreSpeedMBps: 150,
    durability: '99.999999999% (11 nines, per Wasabi)',
    notes: '$6.99/TB-mo, no egress fees (fair-use: egress ≤ stored). 90-day minimum retention (pay-go). Note: rising to $7.99/TB-mo on 2026-07-01. S3-compatible.',
    sourceUrl: 'https://wasabi.com/pricing',
  },
  {
    storageType: 'idrive-e2',
    label: 'IDrive e2',
    icon: 'database',
    costPerGBMonth: 0.004,
    costPerGBDownload: 0,
    restoreSpeedMBps: 150,
    durability: '99.999999999% (11 nines, per IDrive)',
    notes: '$4/TB-mo pay-go. Egress free up to 3× stored/month, then ~$0.01/GB. S3-compatible.',
    sourceUrl: 'https://www.idrive.com/s3-storage-e2/pricing',
  },
  {
    storageType: 'do-spaces',
    label: 'DigitalOcean Spaces',
    icon: 'cloud',
    costPerGBMonth: 0.02,
    costPerGBDownload: 0.01,
    restoreSpeedMBps: 150,
    durability: 'Replicated within region (no published durability figure)',
    notes: '$5/mo base includes 250 GiB storage + 1 TiB egress; overage $0.02/GiB-mo storage, $0.01/GiB transfer. Small backups effectively flat $5. S3-compatible.',
    sourceUrl: 'https://www.digitalocean.com/pricing/spaces-object-storage',
  },

  // ── Cold / archival (cheapest storage, slow + costly restore) ────────────
  {
    storageType: 'glacier-deep',
    label: 'AWS S3 Glacier Deep Archive',
    icon: 'database',
    costPerGBMonth: 0.00099,
    costPerGBDownload: 0.11,
    restoreSpeedMBps: 40,
    durability: '99.999999999% (11 nines, per AWS)',
    notes: 'Cheapest storage anywhere ($1/TB-mo) BUT restores need a 12–48 h retrieval (“thaw”) before download, plus ~$0.02/GB retrieval + ~$0.09/GB egress. 180-day minimum. Archival only — not fast DR.',
    sourceUrl: 'https://aws.amazon.com/s3/glacier/pricing/',
  },

  // ── Meta backend (pricing depends on the underlying provider) ────────────
  {
    storageType: 'rclone',
    label: 'Rclone (40+ providers)',
    icon: 'globe',
    costPerGBMonth: 0.02,
    costPerGBDownload: 0.08,
    restoreSpeedMBps: 100,
    durability: 'Varies by provider',
    notes: 'Google Drive, OneDrive, Dropbox, B2, etc. Pricing varies by provider — shown as a rough S3-equivalent estimate.',
  },
]
