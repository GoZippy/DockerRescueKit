// Centralised, plain-language help content for every storage integration DRK
// supports. Kept as data (not JSX) so the same copy can be reused by the
// rclone wizard, the connector wizard, and the Integrations page without any
// of them owning the wording.
//
// Two audiences, every entry:
//   • newcomers  — "what is this and do I have to install scary software?"
//   • engineers  — "is it safe, what does it touch, can I verify it?"
//
// Keys are either an rclone provider id (drive, onedrive, b2 …) or a DRK
// ConnectorType (proxmox, truenas, pbs, smb, nfs). Look-ups fall back
// gracefully when a key is missing, so adding a provider never crashes the UI.

export interface IntegrationFaq {
  q: string
  a: string
}

export interface IntegrationHelp {
  /** One-liner a non-technical user understands. */
  whatItIs: string
  /** When you'd reach for this backend over the others. */
  whenToUse: string
  /** What the user must have/provide before they start. */
  whatYouNeed: string
  /** Optional reassurance aimed at cautious admins / systems engineers. */
  forEngineers?: string
  /** Official provider/tool documentation. */
  docsUrl?: string
  docsLabel?: string
  /** Integration-specific Q&A. */
  faqs?: IntegrationFaq[]
}

// ── rclone, the tool itself ───────────────────────────────────────────────

/** The top-of-wizard "what even is rclone" explainer. */
export const RCLONE_OVERVIEW_HELP: IntegrationHelp = {
  whatItIs:
    'rclone is a free, open-source "universal adapter" for cloud storage — think of it as a USB hub that lets one tool talk to Google Drive, OneDrive, Dropbox, Backblaze, S3 and ~70 other services using the same plug. DRK uses it so you can back up to almost any cloud without a separate app per provider.',
  whenToUse:
    'Any time you want backups to land in consumer cloud storage (Google Drive, OneDrive, Dropbox) or an object store (Backblaze B2, S3, Cloudflare R2, Wasabi, MinIO). For a plain server or NAS, the SFTP / SMB / WebDAV connectors may be simpler.',
  whatYouNeed:
    'For object stores (S3, B2, WebDAV) you just paste keys — nothing to install. For Google/Microsoft/Dropbox sign-in you run one copy-paste command on a computer that has a web browser. DRK already ships rclone inside itself for the actual transfers.',
  forEngineers:
    'rclone is a single static Go binary, MIT-licensed, ~50k★ on GitHub, no telemetry, no daemon. It runs locally only. DRK invokes it via spawn() (never a shell), validates remote names against [A-Za-z0-9_-], and stores every credential encrypted at rest with AES-256-GCM. Releases are checksummed (SHA256SUMS) and GPG-signed, so you can verify before trusting the binary.',
  docsUrl: 'https://rclone.org/docs/',
  docsLabel: 'rclone documentation',
}

/** FAQ shown in the rclone wizard. Answers the apprehension head-on. */
export const RCLONE_FAQS: IntegrationFaq[] = [
  {
    q: 'Do I have to install rclone? It feels like a lot of extra software.',
    a: 'For most remotes, no. DRK already bundles rclone inside the backend, and it does all the actual uploading. You only install rclone on your own computer for the one-time browser sign-in used by Google Drive, OneDrive and Dropbox — and even then it is a single ~20 MB file, not a background service.',
  },
  {
    q: 'Is rclone safe? Does it phone home?',
    a: 'rclone is open-source (MIT), audited by a large community, and has no telemetry or "call home" behaviour. It only talks to the storage provider you configure. Nothing is sent to DRK\'s authors or to rclone\'s authors.',
  },
  {
    q: 'Where do my cloud passwords / tokens end up?',
    a: 'They are written into DRK\'s rclone config inside the backend and encrypted at rest with AES-256-GCM. They never leave your machine except to authenticate with the storage provider you chose.',
  },
  {
    q: 'Why do I run a command on my own machine instead of clicking a button here?',
    a: 'Cloud sign-in (OAuth) bounces through a browser back to a local address (127.0.0.1:53682). Inside DRK\'s container that address points somewhere else, so the round-trip can never complete there. Running rclone authorize on the machine with the browser is rclone\'s standard "headless setup" — you copy the token it prints back into DRK once and you\'re done.',
  },
  {
    q: 'The token expired or "Add remote" timed out on Google Drive — what now?',
    a: 'Two things: paste the token within a minute or two of generating it, and remember that Google Drive can take 5–10 seconds to respond on the first call, so a slow "Test" is normal, not a failure. If it still fails, re-run the authorize command to mint a fresh token.',
  },
  {
    q: 'How do I verify the rclone binary before installing it (for cautious admins)?',
    a: 'Download the zip from rclone.org/downloads, then check its SHA-256 against the published SHA256SUMS file (and optionally verify the GPG signature) before extracting. The "Verify first" option in the install helper shows the exact commands. Package managers (winget/brew/apt) already verify signatures for you.',
  },
]

/** Field-level tooltips, keyed by the rclone field `name`. */
export const FIELD_HINTS: Record<string, string> = {
  token:
    'The JSON blob rclone printed after you signed in — it starts with {"access_token":". Paste the whole thing, including the braces.',
  account: 'Your Backblaze "keyID" (a.k.a. Account ID / Key ID) from Account → App Keys.',
  key: 'The Backblaze "applicationKey" shown once when you create an app key. Treat it like a password.',
  access_key_id: 'The public half of your S3 credential pair (e.g. AKIA… for AWS, or any key from your provider).',
  secret_access_key: 'The secret half of your S3 credential pair. Shown once at creation — store it safely.',
  region: 'The bucket\'s region, e.g. us-east-1. Leave blank if your provider doesn\'t use regions.',
  endpoint:
    'Only for non-AWS S3 services. Examples: https://s3.wasabisys.com (Wasabi), https://<acct>.r2.cloudflarestorage.com (Cloudflare R2). Leave blank for AWS.',
  provider: 'Tells rclone which S3 dialect to speak: AWS, Wasabi, Cloudflare, Minio, or Other.',
  vendor: 'Optional WebDAV flavour so rclone uses the right quirks: nextcloud, owncloud, sharepoint, or other.',
  url: 'The full WebDAV URL. For Nextcloud it looks like https://host/remote.php/dav/files/<username>/.',
  host: 'Hostname or IP of the server, e.g. backup.example.com or 10.0.0.20.',
  port: 'TCP port. Defaults to 22 for SFTP if left blank.',
  user: 'The login username on the remote server or service.',
  pass: 'Password for the account. For SFTP you can leave this blank and use an SSH key via ssh-agent instead.',
}

/**
 * Field tooltips for the *native* DRK connectors (S3/SFTP/SMB/Proxmox/
 * TrueNAS/PBS/rclone-backend). These are keyed by the connector field `name`,
 * which differs from the rclone wizard's keys — most importantly, `password`
 * here is the restic REPOSITORY ENCRYPTION password, not a login. Keeping a
 * separate map prevents that dangerous mislabelling.
 */
export const CONNECTOR_FIELD_HINTS: Record<string, string> = {
  // The big one — losing this loses the backups.
  password:
    'This is the restic repository ENCRYPTION password, not a login. It encrypts your backups at rest; if you lose it the backups are permanently unrecoverable, so store it somewhere safe (a password manager).',
  // S3
  endpoint: 'Only for non-AWS S3 services (Wasabi, Cloudflare R2, MinIO…). Leave blank for AWS S3.',
  bucket: 'The S3 bucket backups are written to. A dedicated bucket keeps the blast radius small.',
  prefix: 'Optional folder inside the bucket (e.g. "drk") so backups don\'t sit at the root.',
  region: 'The bucket\'s AWS region, e.g. us-east-1. Leave blank for providers that ignore it.',
  accessKey: 'The access key ID — the public half of your S3 credential pair.',
  secretKey: 'The secret access key — shown once at creation. Store it safely.',
  // Network targets
  host: 'Hostname, IP, or URL of the server, e.g. 192.168.1.20 or https://nas:8006.',
  port: 'TCP port. SFTP defaults to 22 if left blank.',
  username: 'The login username on the remote server or share.',
  path: 'Destination directory on the remote, e.g. /srv/backups/drk.',
  // SMB
  share: 'The SMB share name — the "backups" in \\\\host\\backups.',
  domain: 'Windows domain or workgroup. Leave as WORKGROUP if you\'re not sure.',
  // Proxmox
  tokenId: 'Proxmox API token ID, in the form user@realm!tokenname, e.g. root@pam!drk.',
  tokenSecret: 'The secret half of the Proxmox API token — shown once when you create it.',
  // TrueNAS
  apiKey: 'A TrueNAS API key (Credentials → Local Users → API Keys). Preferred over a password.',
  // Proxmox / TrueNAS shared
  verifySSL: 'Off accepts self-signed certificates (common on home labs); On requires a valid TLS cert.',
  // PBS
  repo: 'PBS repository, in the form user@realm@host:datastore, e.g. backup@pbs@10.0.0.5:store1.',
  fingerprint: 'The PBS server\'s TLS fingerprint (SHA-256). Needed when it uses a self-signed cert.',
  pbsBin: 'Path to proxmox-backup-client if it isn\'t on PATH. Leave blank to use the bundled one.',
  // rclone-as-backend connector
  remote: 'The name of an rclone remote you already set up under "Manage remotes" — without the trailing colon.',
  rcloneConfig: 'Path to a specific rclone.conf. Leave blank to use DRK\'s managed config.',
}

// ── Per-integration help (rclone providers + DRK connectors) ──────────────

export const INTEGRATION_HELP: Record<string, IntegrationHelp> = {
  // —— rclone OAuth providers ——
  drive: {
    whatItIs: 'Back up to your personal or Workspace Google Drive.',
    whenToUse: 'You already pay for Google storage and want off-site copies without a new account.',
    whatYouNeed: 'A one-time browser sign-in on a computer with rclone installed. No API keys to create.',
    forEngineers: 'Uses Google\'s OAuth2; the refresh token is stored encrypted. Backups land as ordinary Drive files you can see and revoke access to at any time.',
    docsUrl: 'https://rclone.org/drive/',
    docsLabel: 'rclone Google Drive docs',
  },
  onedrive: {
    whatItIs: 'Back up to Microsoft OneDrive (personal or Business/SharePoint).',
    whenToUse: 'You have Microsoft 365 / OneDrive storage to spare.',
    whatYouNeed: 'A one-time browser sign-in on a computer with rclone installed.',
    docsUrl: 'https://rclone.org/onedrive/',
    docsLabel: 'rclone OneDrive docs',
  },
  dropbox: {
    whatItIs: 'Back up to a Dropbox account.',
    whenToUse: 'You use Dropbox already and want it as a backup target.',
    whatYouNeed: 'A one-time browser sign-in on a computer with rclone installed.',
    docsUrl: 'https://rclone.org/dropbox/',
    docsLabel: 'rclone Dropbox docs',
  },

  // —— rclone key-based providers ——
  b2: {
    whatItIs: 'Backblaze B2 — cheap, pay-as-you-go object storage built for backups.',
    whenToUse: 'You want low-cost off-site storage (often a few $/TB/month) without a Google/Microsoft account.',
    whatYouNeed: 'An Account/Key ID and Application Key from Backblaze → Account → App Keys. No install on your machine.',
    forEngineers: 'S3-style immutable object storage; pair it with a write-only app key scoped to one bucket for a tidy blast radius.',
    docsUrl: 'https://rclone.org/b2/',
    docsLabel: 'rclone Backblaze B2 docs',
  },
  s3: {
    whatItIs: 'Any S3-compatible object store — AWS S3, Cloudflare R2, Wasabi, MinIO, Ceph and more.',
    whenToUse: 'You already run or pay for S3-style storage, or want the cheapest egress (R2/Wasabi).',
    whatYouNeed: 'An access key + secret. For non-AWS services also set the Endpoint and Provider. No install on your machine.',
    forEngineers: 'Standard SigV4. Scope the IAM/credential to a single bucket; set Endpoint for non-AWS and Provider so rclone picks the right dialect (path-style, checksums, etc.).',
    docsUrl: 'https://rclone.org/s3/',
    docsLabel: 'rclone S3 docs',
  },
  webdav: {
    whatItIs: 'WebDAV — the protocol Nextcloud, ownCloud and others expose for file access over HTTPS.',
    whenToUse: 'You self-host Nextcloud/ownCloud or have a WebDAV-capable host and want backups there.',
    whatYouNeed: 'The server URL, a username and password (use an app password if your server supports them).',
    forEngineers: 'Set Vendor (nextcloud/owncloud/sharepoint) so rclone applies the right chunking and etag quirks. App passwords keep your primary credential out of DRK.',
    docsUrl: 'https://rclone.org/webdav/',
    docsLabel: 'rclone WebDAV docs',
  },
  sftp: {
    whatItIs: 'SFTP — secure file copy over SSH to any server you can log into.',
    whenToUse: 'You have a Linux box, VPS or NAS with SSH and want it as a backup target.',
    whatYouNeed: 'Host, username, and either a password or an SSH key loaded in your ssh-agent.',
    forEngineers: 'Prefer key auth via ssh-agent over a stored password. rclone honours your known_hosts; the connector validates host/port before connecting.',
    docsUrl: 'https://rclone.org/sftp/',
    docsLabel: 'rclone SFTP docs',
  },
  local: {
    whatItIs: 'A local folder or an already-mounted network share (NFS/SMB) on the DRK host.',
    whenToUse: 'You want a fast local copy, or you mount your NAS at the OS level and point DRK at the path.',
    whatYouNeed: 'Just a writable path the DRK backend can reach. Nothing to authenticate.',
    docsUrl: 'https://rclone.org/local/',
    docsLabel: 'rclone local docs',
  },

  // —— DRK native connectors ——
  rclone: {
    whatItIs: 'Point a backup policy at an rclone remote you already configured under "Manage remotes".',
    whenToUse: 'You set up a cloud remote (Google Drive, B2, S3…) and now want backups written to it.',
    whatYouNeed: 'The remote name (without the trailing colon), a path under it, and a repository encryption password.',
    forEngineers: 'Wraps the rclone remote as a restic repository. The password is restic\'s repo key — store it safely; losing it makes the backups unrecoverable.',
    docsUrl: 'https://rclone.org/docs/',
    docsLabel: 'rclone documentation',
  },
  proxmox: {
    whatItIs: 'Proxmox VE — connect DRK to your Proxmox hypervisor cluster.',
    whenToUse: 'You run VMs/containers on Proxmox and want DRK to coordinate backups alongside them.',
    whatYouNeed: 'The Proxmox host/URL and either an API token (recommended) or username + password.',
    forEngineers: 'Use a scoped API token (PVEAPIToken) over root@pam creds. DRK\'s SSRF guard validates the host before any API call.',
    docsUrl: 'https://pve.proxmox.com/wiki/Proxmox_VE_API',
    docsLabel: 'Proxmox VE API docs',
  },
  truenas: {
    whatItIs: 'TrueNAS SCALE/CORE — connect DRK to your TrueNAS storage appliance.',
    whenToUse: 'You keep bulk storage on TrueNAS and want DRK to target its datasets/shares.',
    whatYouNeed: 'The TrueNAS host/URL and an API key (Account → API Keys) or username + password.',
    forEngineers: 'Prefer an API key over admin credentials. Host is validated by the SSRF guard before connecting.',
    docsUrl: 'https://www.truenas.com/docs/',
    docsLabel: 'TrueNAS docs',
  },
  pbs: {
    whatItIs: 'Proxmox Backup Server — a dedicated, deduplicating backup store for Proxmox.',
    whenToUse: 'You already run PBS and want DRK\'s backups in the same deduplicated datastore.',
    whatYouNeed: 'The PBS host, a datastore name, and an API token.',
    forEngineers: 'Uses proxmox-backup-client under the hood. Scope the token to the target datastore; transfers are client-side encrypted and deduplicated.',
    docsUrl: 'https://pbs.proxmox.com/docs/',
    docsLabel: 'Proxmox Backup Server docs',
  },
  smb: {
    whatItIs: 'SMB/CIFS — the Windows-style file sharing your NAS almost certainly speaks.',
    whenToUse: 'You have a NAS or Windows share and want backups to land on it.',
    whatYouNeed: 'The server/host, share name, and a username + password with write access.',
    forEngineers: 'DRK mounts the share and runs restic against it. Use a dedicated backup user scoped to one share.',
    docsUrl: 'https://rclone.org/smb/',
    docsLabel: 'SMB reference',
  },
  nfs: {
    whatItIs: 'NFS — Unix-style network file sharing, usually mounted by the host OS.',
    whenToUse: 'You export an NFS share from a NAS/server and want DRK to write to it.',
    whatYouNeed: 'The export path, mounted and writable by the DRK host.',
    docsLabel: 'NFS',
  },
}

/** Safe accessor — returns the help block for a provider id / connector type. */
export function helpFor(key: string | undefined): IntegrationHelp | undefined {
  if (!key) return undefined
  return INTEGRATION_HELP[key]
}
