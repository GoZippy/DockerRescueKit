# DR-001 — Connector discovery interface semantic

**Status**: Proposed (awaiting 2/3 consensus from claude-code, kilocode, antigravity)
**Date**: 2026-05-29
**Author**: claude-code (WA-1)
**Sprint**: v1.3-connectors / Sprint 1 / Task E0
**Blocks**: F2-error-contract, D1-s3-discovery, D2-sftp-discovery, D3-rclone-discovery, U1-discovery-step-ui

## Context

`IConnectorPlugin.discoverResources()` is implemented inconsistently across the existing 6 connectors:

| Connector | What `discoverResources()` returns | Semantic |
|---|---|---|
| `ProxmoxConnector` | Storage pools per node — `pve-storage` | Destinations (where to back up to) |
| `TrueNASConnector` | ZFS datasets — `zfs-dataset` | Destinations |
| `PBSConnector` | Existing PBS snapshots — `pbs-snapshot` | Contents (what's already there) |
| `S3Connector` | `[]` (stub) | Undefined |
| `SFTPConnector` | `[]` (stub) | Undefined |
| `RcloneConnector` | `[]` (stub) | Undefined |
| `SMBConnector` | `[]` (stub, landed in a1e36fe) | Undefined |

Two unrelated operations share one method name. This blocks:
1. Implementing the three stubs — which semantic should they follow?
2. Wiring the UI — `AddConnectorWizard` doesn't call discovery today; before we wire it, we need to know which operation the wizard is asking for.
3. Typing `ConnectorResource['type']` — it's currently `string`; the inconsistency prevents narrowing.

## Decision

**Split `discoverResources()` into two methods**:

```ts
interface IConnectorPlugin {
  readonly definition: ConnectorDefinition

  /**
   * Reachability + auth check. Returns structured result (see F2).
   */
  testConnection(config: Record<string, any>): Promise<ConnectorTestResult>

  /**
   * Enumerate candidate backup destinations on this connector BEFORE
   * the user has committed to a specific bucket/path/dataset. Called by
   * AddConnectorWizard between "Test Connection success" and "Save".
   *
   * Examples:
   *   - S3: ListBuckets (when no bucket set) OR ListObjectsV2 with delimiter='/'
   *   - SFTP: readdir on config.path
   *   - Rclone: rclone lsjson on config.remote
   *   - Proxmox: storage pools per node
   *   - TrueNAS: ZFS datasets
   *
   * Returns [] if the connector does not support pre-config enumeration.
   * UI must degrade gracefully — skip the discovery step.
   */
  discoverDestinations?(config: Record<string, any>): Promise<ConnectorResource[]>

  /**
   * Enumerate what is currently stored in this connector AFTER it is
   * fully configured. Used by future restore-browser + drift dashboard.
   *
   * Examples:
   *   - PBS: list snapshots in the configured datastore
   *   - S3/SFTP/Rclone (restic-backed): list restic snapshots
   *   - Proxmox/TrueNAS: not applicable (returns [])
   *
   * Returns [] if the connector has no listable contents (yet).
   */
  listContents?(config: Record<string, any>): Promise<ConnectorResource[]>

  /**
   * @deprecated Use discoverDestinations or listContents instead.
   * Remains for one release to avoid breaking external consumers of
   * /api/connectors/discover. Default impl forwards to discoverDestinations
   * if present, else listContents, else [].
   */
  discoverResources?(config: Record<string, any>): Promise<ConnectorResource[]>
}
```

Both new methods are optional (`?`) so connectors implement only what makes sense. The default `discoverResources()` shim forwards to whichever the connector implements.

## Mapping per existing connector

| Connector | `discoverDestinations` | `listContents` | Migration |
|---|---|---|---|
| Proxmox | storage pools per node (current behaviour) | — | Move existing body |
| TrueNAS | ZFS datasets (current behaviour) | — | Move existing body |
| PBS | datastores enumerated via PBS API | existing snapshots (current behaviour) | Add destinations; move existing to listContents |
| S3 | ListBuckets / ListObjectsV2 (D1 implements) | restic snapshots via adapter.list() | — |
| SFTP | readdir(config.path) (D2 implements) | restic snapshots via adapter.list() | — |
| Rclone | rclone lsjson (D3 implements) | restic snapshots via adapter.list() | — |
| SMB | mount + readdir(config.share) | restic snapshots via adapter.list() | Deferred to v1.4 (SMB needs mount privilege at discovery time) |

## Route changes (`packages/backend/src/index.ts`)

`POST /api/connectors/discover` keeps its existing path and adds an optional `mode` field:

```
POST /api/connectors/discover
Body: { type, config, mode?: 'destinations' | 'contents' }
```

- `mode === 'destinations'` → calls `discoverDestinations()` (default if mode omitted, for back-compat with the unused frontend hook).
- `mode === 'contents'` → calls `listContents()`.
- Either falls back to the deprecated `discoverResources()` shim if the chosen method is absent.

## ConnectorResource type narrowing

`packages/shared/src/types.ts` adds:

```ts
export type ConnectorResourceType =
  // destinations
  | 'pve-storage'
  | 'zfs-dataset'
  | 'pbs-datastore'
  | 's3-bucket'
  | 's3-prefix'
  | 'sftp-dir'
  | 'rclone-dir'
  | 'smb-share'
  // contents
  | 'pbs-snapshot'
  | 'restic-snapshot'

export interface ConnectorResource {
  id: string
  connectorId: string
  name: string
  type: ConnectorResourceType            // was: string
  path?: string
  size?: number
  available?: number
  metadata?: Record<string, any>
}
```

This change is deferred to E0 subtask 3, which lands after Kilo's PRE-commit-staged-fixes (avoids stomping the staged `pbs`-union edit on `types.ts`).

## Alternatives considered

### A) Keep unified `discoverResources()`, document the ambiguity
- **Pro**: zero interface churn.
- **Con**: ambiguity infects callers forever; UI cannot reliably pick "show me destinations" vs "show me contents" without a side-channel hint per connector.
- **Verdict**: rejected — the inconsistency is the bug; documenting it doesn't fix it.

### B) Add a `mode` parameter to `discoverResources(config, mode)`
- **Pro**: single method, two behaviors.
- **Con**: every connector must implement a switch that always handles one branch trivially; subtle bugs (PBS would have to either reject `mode='destinations'` or invent one).
- **Verdict**: rejected — pretends one operation handles two semantics; the implementations are genuinely different.

### C) Drop pre-config destination enumeration entirely; users always type bucket/path manually
- **Pro**: simplest possible interface.
- **Con**: kills the differentiation in U1 — discovery step in AddConnectorWizard is the marketplace wedge. Also wastes existing Proxmox/TrueNAS impls.
- **Verdict**: rejected.

## Consequences

**Positive**
- Each method has a single, type-narrowable semantic.
- D1/D2/D3 impls become trivial: 5–10 lines each because they only handle one operation.
- U1 (AddConnectorWizard discovery step) can use a typed picker per `ConnectorResourceType`.
- `restic-snapshot` listing unlocks a future restore-browser feature without further interface churn.

**Negative**
- Two interface methods instead of one. Minor cognitive cost.
- PBS gains a `discoverDestinations()` that calls PBS `/api2/json/admin/datastore` — small new API surface to maintain.
- F2-error-contract layered on top means `IConnectorPlugin` gets two changes in two consecutive sprints. Manageable because both are pure additions to a small interface.

**Neutral**
- `/api/connectors/discover` route stays compatible. Frontend doesn't break.
- Deprecated `discoverResources()` removed in v1.4 (one release later).

## Migration plan

1. **Sprint 1 (this task)**: add new methods to interface; default shim preserves `discoverResources()` behavior.
2. **Sprint 2** (F2): error contract change layered on top.
3. **Sprint 2** (D3): RcloneConnector implements `discoverDestinations` directly; drops the stub.
4. **Sprint 3** (D1/D2): S3 + SFTP implement `discoverDestinations` directly.
5. **Sprint 4** (U1): UI calls `/api/connectors/discover?mode=destinations` explicitly.
6. **v1.4**: remove `discoverResources()` shim; bump major in API contract docs.

## Votes (consensus gate)

Threshold: 2 of 3 majority (touches `packages/shared/`).

- [ ] claude-code: PROPOSING
- [ ] kilocode: pending
- [ ] antigravity: pending

Votes land in `.autoclaw/orchestrator/comms/consensus/active/E0-semantic-decision-{agent}.json`.

## References

- [base.ts](../../packages/backend/src/connectors/base.ts) — interface being modified
- [packages/shared/src/types.ts](../../packages/shared/src/types.ts) — `ConnectorResource` type
- [v1.3-connectors manifest](../../.autoclaw/orchestrator/manifests/v1.3-connectors.yaml) — sprint plan
- Critique that surfaced the inconsistency: see prior chat between claude-code and kilocode (2026-05-29)
