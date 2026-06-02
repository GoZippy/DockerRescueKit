# Connectors

DockerRescueKit ships seven connectors. Each one is a `IConnectorPlugin`
implementation that knows how to talk to one kind of remote system, return
a structured `ConnectorTestResult`, and (when applicable) enumerate
destinations via `discoverDestinations()` or existing contents via
`listContents()`.

This page documents what each connector does, the fields you supply in the
Add Connector wizard, and the security posture applied at the connector
layer.

> **For the design rationale behind the split between destinations and
> contents, see [`docs/decisions/DR-001-connector-discovery-semantic.md`](decisions/DR-001-connector-discovery-semantic.md).**
> **For the SSRF posture (default vs strict), see [`docs/decisions/DR-003-ssrf-posture-default.md`](decisions/DR-003-ssrf-posture-default.md).**

---

## At a glance

| Connector | Purpose | Discovery | Storage engine | Credentials encrypted at rest? |
|---|---|---|---|---|
| **S3** | AWS S3, MinIO, Wasabi, B2, R2 | `discoverDestinations` (buckets + prefixes) | restic | yes |
| **SFTP** | Any SSH server | `discoverDestinations` (remote dirs) | restic | yes |
| **SMB / CIFS** | Windows shares, NAS | — (deferred to v1.4, needs `SYS_ADMIN`) | mount + restic | yes |
| **Rclone** | 40+ providers (GDrive, OneDrive, Dropbox, etc.) | `discoverDestinations` (top-level dirs) | rclone + restic | yes |
| **Proxmox VE** | Proxmox cluster (LXC/VMs) | `discoverDestinations` (storage pools per node) | API + restic | yes |
| **TrueNAS** | TrueNAS SCALE / CORE | `discoverDestinations` (ZFS datasets) | API + restic | yes |
| **PBS** | Proxmox Backup Server | `listContents` (existing snapshots) | `proxmox-backup-client` | yes |

All sensitive fields (passwords, tokens, secret keys, fingerprints) are
encrypted with AES-256-GCM by the `VaultService` before they hit the SQLite
DB. The on-disk record stores ciphertext + a per-field IV; the master key
lives in `data/secrets.json` (created on first boot, gitignored).

---

## SSRF posture

Every connector that exposes a `host` or `endpoint` field is gated by
`SsrfGuard.assertSafe()` inside `ConnectorManager.testInstance` and
`ConnectorManager.discoverResources`. The default posture is **homelab-first**:

- **Always denied:** AWS cloud-metadata IPs (`169.254.169.254`, `fd00:ec2::254`).
- **Allowed by default:** loopback, RFC1918, link-local, ULA — so first-run
  Test Connection against a NAS at `192.168.1.x` works without configuration.

Operators running multi-tenant or hosted deployments should set
`DRK_SSRF_STRICT=1` to switch to the strict deny-list (all private ranges
blocked unless explicitly listed in `DRK_SSRF_ALLOWLIST`).

---

## S3-compatible

Works against AWS S3 and any S3 API: MinIO, Wasabi, Backblaze B2 (S3 API),
Cloudflare R2.

### Fields
| Field | Required | Notes |
|---|---|---|
| `endpoint` | no | Defaults to `s3.amazonaws.com`. Use `minio:9000`, `s3.wasabisys.com`, `s3.us-west-002.backblazeb2.com`, etc. |
| `bucket` | yes | Created beforehand. DRK does not auto-create. |
| `prefix` | no | Optional path inside the bucket, e.g. `drk`. |
| `region` | no | AWS only; defaults to `us-east-1`. |
| `accessKey` | yes | Encrypted at rest. |
| `secretKey` | yes | Encrypted at rest. |
| `password` | yes | **restic repository encryption password** — keep it safe; losing it means losing the backup. |

### Discovery
- No bucket configured → `ListBuckets` (returns buckets visible to the credentials).
- Bucket configured → `ListObjectsV2` with `delimiter=/` (returns top-level
  sub-prefixes for picking a sub-folder).

Path-style URLs (`https://endpoint/bucket/...`) are used for MinIO
compatibility. SigV4 is hand-rolled (no `aws-sdk` dep; see DR-004).

---

## SFTP

Any SSH server you can `ssh` into. Auth priority: `privateKeyPath` →
`sshPassword` → ssh-agent fallback.

### Fields
| Field | Required | Notes |
|---|---|---|
| `host` | yes | Hostname or IP. |
| `port` | no | Defaults to 22. Non-default ports are passed through to restic via `-o sftp.command`. |
| `username` | yes | |
| `privateKeyPath` | no | Path to private key inside the backend container. |
| `sshPassword` | no | Encrypted at rest. |
| `path` | yes | Remote directory for the restic repo. |
| `password` | yes | restic repository encryption password. |

### Discovery
Uses `ssh2.readdir(config.path)` directly. Returns subdirectories the user
could pick as the restic repo. 15s connect / 30s total timeout.

---

## SMB / CIFS

Windows file shares, Samba, NAS mounts. Mounts via cifs-utils on Linux —
requires the backend container to run with `--cap-add SYS_ADMIN`.

### Fields
| Field | Required | Notes |
|---|---|---|
| `host` | yes | SMB server hostname or IP. |
| `share` | yes | Share name (e.g. `backups` for `\\host\backups`). |
| `username` | no | Leave blank for guest access. |
| `password` | no | Encrypted at rest. |
| `domain` | no | Windows domain or workgroup. |

### Discovery
**Not implemented.** Enumerating shares requires a mount, which we will not
do speculatively against an unconfigured target. Deferred to v1.4 when a
privilege-broker model exists. The wizard skips the discovery step
gracefully.

---

## Rclone

Any of the ~40 providers that rclone supports. Requires `rclone` on the host
(bundled in the extension image — see the rclone-build stage in the root
Dockerfile) and a pre-configured remote.

### Fields
| Field | Required | Notes |
|---|---|---|
| `remote` | yes | The rclone remote name (e.g. `gdrive`). |
| `path` | yes | Path under the remote (e.g. `drk-backups`). |
| `rcloneConfig` | no | Path to a non-default `rclone.conf`. |
| `password` | yes | restic repository encryption password. |

### OAuth flow
For OAuth-based providers (GDrive, OneDrive, Dropbox, etc.) DRK uses the
**host-authorize** model — the user runs `rclone authorize` on their host
(outside the container) and pastes the resulting token blob into the
wizard. The token blob is encrypted at rest by VaultService.

Rationale: a container in a Docker Desktop extension cannot bind a port for
the OAuth redirect URI. See [`docs/decisions/DR-002-rclone-oauth-host-authorize.md`](decisions/DR-002-rclone-oauth-host-authorize.md).

### Discovery
`rclone lsjson --max-depth 1 --dirs-only ${remote}:${path}` via
`child_process.execFile` (argv array, never shell — injection-safe).

---

## Proxmox VE

For backing up LXC containers and VMs to a Proxmox cluster's storage pools.

### Fields
| Field | Required | Notes |
|---|---|---|
| `host` | yes | Full URL including scheme + port: `https://pve.lan:8006`. |
| `tokenId` | yes | API token ID, e.g. `root@pam!mytoken`. |
| `tokenSecret` | yes | Token secret, encrypted at rest. |
| `verifySSL` | no | Defaults to **false** for homelab convenience. Set to true for production. |

### Discovery
Calls `/api2/json/nodes` then `/api2/json/nodes/{node}/storage` per node.
Returns a `ConnectorResource[]` where each item is a pool the user can pick
as the backup destination. Includes the node name in the display label so
multi-node clusters are unambiguous.

---

## TrueNAS

For backing up to ZFS datasets on a TrueNAS SCALE or CORE system.

### Fields
| Field | Required | Notes |
|---|---|---|
| `host` | yes | Full URL including scheme: `https://truenas.lan`. |
| `apiKey` | yes | TrueNAS API key, encrypted at rest. |
| `verifySSL` | no | Defaults to **false** for homelab convenience. |

### Discovery
Calls `/api/v2.0/pool/dataset`. Returns every dataset the API key can see.
The wizard surfaces `compression` and `available` so the user can pick a
sensible destination at a glance.

---

## Proxmox Backup Server (PBS)

Direct PBS datastore integration via `proxmox-backup-client`. Provides
PBS-native dedup, compression, and snapshots. Requires
`proxmox-backup-client` on the host (currently not bundled in the extension
image; planned for v1.4).

### Fields
| Field | Required | Notes |
|---|---|---|
| `repo` | yes | Format: `user@realm@host:port:datastore`. Example: `backup@pam@192.168.1.50:8007:docker-backups`. |
| `password` | yes | PBS password, encrypted at rest. |
| `fingerprint` | no | SHA-256 fingerprint of the PBS TLS cert. Required for self-signed certs. |
| `pbsBin` | no | Path to `proxmox-backup-client` if not on PATH. |

### Discovery
PBS has no "destinations" step — the datastore is fully encoded in `repo`,
and PBS exposes no API to enumerate peer datastores from a single
credential. Instead PBS implements `listContents()` for the future
restore-browser / drift dashboard: returns snapshots in the configured
datastore.

---

## Connector contract internals

```ts
interface IConnectorPlugin {
  readonly definition: ConnectorDefinition

  // Returns structured result; never returns a bare boolean.
  testConnection(config): Promise<ConnectorTestResult>

  // Per DR-001: pre-config destination enumeration.
  discoverDestinations?(config): Promise<ConnectorResource[]>

  // Per DR-001: post-config contents enumeration.
  listContents?(config): Promise<ConnectorResource[]>

  // @deprecated v1.4 — kept for S3/SFTP/Rclone back-compat shim only.
  discoverResources?(config): Promise<ConnectorResource[]>
}

type ConnectorTestResult = {
  success: boolean
  error?: string
  latencyMs?: number
  serverInfo?: Record<string, unknown>
}
```

The route layer (`/api/connectors/discover`) accepts an optional
`mode: 'destinations' | 'contents'` and routes through `resolveDiscovery()`,
which falls through `discoverDestinations → listContents → discoverResources
→ []`. Connectors that haven't implemented a given mode degrade gracefully.

---

## Adding a new connector

1. Add the wire shape to `packages/shared/src/types.ts` if a new `type`
   string is needed.
2. Implement `IConnectorPlugin` in `packages/backend/src/connectors/`.
3. Register it in `packages/backend/src/connectors/index.ts` and
   `ConnectorRegistry`.
4. Add unit tests under `packages/backend/src/__tests__/connectors/` that
   cover `testConnection` (success + structured error) and discovery (if
   applicable). Aim for >80% line coverage on the new connector file.
5. If the connector exposes a `host` or `endpoint`, no extra SSRF wiring is
   needed — `ConnectorManager` already guards both methods.
6. Document the new connector in this file (add to the at-a-glance table
   and a per-connector section).
