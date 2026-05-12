# Development Guide

## Quick Start

### Prerequisites
- Docker Desktop 4.8+ (or Docker Engine 20.10+ on Linux)
- Node.js 18+
- npm
- Git

### Setup
```bash
git clone https://github.com/<your-org>/DockerRescueKit.git
cd DockerRescueKit
npm install
npm run dev
```

This starts:
- Backend service on `http://localhost:42880`
- Vite dev server (extension UI) with HMR

The backend prints a randomly generated API key on first start. Watch the
log line:

```
[Secrets] API key: <key>
```

The key is persisted at `$DRK_DATA_DIR/secrets.json` (defaults to `data/`)
and reused on subsequent starts.

## Project Structure

```
DockerRescueKit/
├── packages/
│   ├── extension/                  # Docker Desktop Extension UI (React + Vite)
│   │   ├── src/
│   │   │   ├── components/         # Dashboard, Wizard, Editors, Settings
│   │   │   ├── api/                # Typed REST client
│   │   │   └── App.tsx
│   │   └── Dockerfile
│   │
│   ├── backend/
│   │   ├── src/
│   │   │   ├── index.ts                    # Express app + BackupService class + all routes
│   │   │   ├── connectors/                 # External service connectors (PBS, Proxmox,
│   │   │   │                               # Rclone, S3, SFTP, TrueNAS) + ConnectorRegistry
│   │   │   ├── db/
│   │   │   │   └── Database.ts             # better-sqlite3 wrapper, migrations
│   │   │   ├── errors/
│   │   │   │   ├── HttpError.ts            # Status-coded error subclasses
│   │   │   │   └── index.ts
│   │   │   ├── middleware/
│   │   │   │   └── requestId.ts            # X-Request-Id correlation header
│   │   │   ├── scheduler/
│   │   │   │   └── SchedulerEngine.ts      # cron + retention + concurrency control
│   │   │   ├── services/
│   │   │   │   ├── PolicyManager.ts        # CRUD policies + execute backup + restore
│   │   │   │   ├── ConnectorManager.ts     # Persisted connector instances
│   │   │   │   ├── DockerService.ts        # dockerode wrapper
│   │   │   │   ├── DatabaseExporters.ts    # Pre-backup DB dumps (pg, mysql, …)
│   │   │   │   ├── HookRunner.ts           # Pre/post backup hooks
│   │   │   │   ├── MetricsService.ts       # Prometheus metrics renderer
│   │   │   │   ├── NotificationService.ts  # Slack/Discord/email/webhook
│   │   │   │   ├── PartialRestoreService.ts# Browse + extract individual files
│   │   │   │   ├── RcloneService.ts        # rclone OAuth + remote management
│   │   │   │   ├── SecretsService.ts       # API key + master encryption key
│   │   │   │   ├── SettingsService.ts      # User-tunable settings persisted in db
│   │   │   │   ├── TelemetryService.ts     # System stats
│   │   │   │   ├── VaultService.ts         # Encrypted credential storage
│   │   │   │   ├── VerifyService.ts        # Restore-test in scratch container
│   │   │   │   └── AuditService.ts         # Append-only audit log
│   │   │   ├── storage/
│   │   │   │   ├── StorageAdapter.ts       # Abstract base class
│   │   │   │   ├── StorageFactory.ts       # Pluggable factory
│   │   │   │   ├── engines/
│   │   │   │   │   └── ResticEngine.ts     # Restic shell-out
│   │   │   │   └── adapters/
│   │   │   │       ├── LocalStorageAdapter.ts
│   │   │   │       ├── ResticStorageAdapter.ts   # base for restic-backed remotes
│   │   │   │       ├── S3StorageAdapter.ts       # extends restic
│   │   │   │       ├── SFTPStorageAdapter.ts     # extends restic
│   │   │   │       ├── SMBStorageAdapter.ts      # extends restic
│   │   │   │       ├── RcloneStorageAdapter.ts   # rclone-backed (Drive, OneDrive)
│   │   │   │       ├── PBSStorageAdapter.ts      # Proxmox Backup Server
│   │   │   │       └── Adapters.ts
│   │   │   ├── utils/
│   │   │   │   ├── Checksum.ts
│   │   │   │   ├── Encryption.ts            # AES-GCM via EncryptionUtility
│   │   │   │   └── PathSafety.ts            # assertSafeEntryPath()
│   │   │   ├── validation/
│   │   │   │   ├── schemas.ts               # Zod schemas (POST/PUT bodies, params)
│   │   │   │   └── validate.ts              # validate / validateParams / validateQuery
│   │   │   └── __tests__/                   # Jest test suites
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   └── shared/
│       └── src/
│           └── types.ts             # Shared TypeScript types
│
├── docs/                            # Architecture / deployment / quickstart
├── docker-compose.yml               # Dev compose
├── docker-compose.prod.yml          # Production compose
└── Dockerfile                       # Single-image build
```

## Key Components

### BackupService (packages/backend/src/index.ts)
The top-level Express application. Wires up middleware (requestId, helmet
CSP, CORS, JSON parser, rate limiters, API-key auth), constructs every
service, and registers all routes. Exported so tests can import it without
binding the port.

### SchedulerEngine
Runs backup policies on cron schedules and applies retention rules
(simple count-based and tiered daily/weekly/monthly). The retention logic
lives **here** — there is no separate `RetentionEngine.ts` file.

**Key Methods:**
- `start()` - Start scheduler and load all enabled policies
- `schedulePolicy(policy)` - Register a single policy
- `runPolicy(policyId)` - Execute a policy immediately
- `pause()` / `resume()` - Suspend all scheduled runs

### StorageFactory & Adapters
Extensible factory pattern for swappable storage backends. Most cloud
backends are implemented as subclasses of `ResticStorageAdapter`
(restic shell-out) or `RcloneStorageAdapter` (rclone shell-out for Drive
/ OneDrive). Local + PBS have their own implementations.

**Adding a New Storage Type:**
```typescript
// 1. Create adapter class
export class NewStorageAdapter extends StorageAdapter {
  readonly type = 'newstorage'
  async upload(localPath, remotePath) { /* ... */ }
  async download(remotePath, localPath) { /* ... */ }
  // ... implement other methods
}

// 2. Register in factory
StorageFactory.register('newstorage', config => new NewStorageAdapter(config))

// 3. Add a connector definition under connectors/ for the UI to pick up
// 4. Add tests under packages/backend/src/__tests__/
```

### PolicyManager
Manages policy CRUD, executes backups end-to-end, and orchestrates
restores (full + partial).

## Testing

### Running tests

```bash
cd packages/backend
npx jest
```

The backend currently ships **21 jest test suites** covering scheduler
concurrency, retention, path safety, partial-restore safety, encryption,
HTTP error mapping, request-id correlation, connectors, and storage
adapters. Expect all to pass green on a clean checkout.

```bash
# Run a single suite
npx jest pathSafety

# Watch mode
npx jest --watch
```

### End-to-end testing

A puppeteer-based UI smoke harness lives at `k:/tmp/drk-ui-test/test.js`.
It boots a headless Chromium, drives the extension UI against a running
backend, and saves screenshots (`01-policies.png`, `02-settings.png`,
…) for visual diffing.

```bash
cd k:/tmp/drk-ui-test
npm install
node test.js
```

The harness reads the API key from the backend log; make sure
`docker logs drk | grep 'API key'` produces a value before running.

## Debugging

### Backend
```bash
# Verbose logging
DEBUG=* npm run dev --workspace @docker-rescue-kit/backend

# Attach the Node inspector
node --inspect=0.0.0.0:9229 -r ts-node/register packages/backend/src/index.ts
# Then open chrome://inspect
```

### Frontend
Open Docker Desktop → Extensions → Docker Rescue Kit → right-click → Inspect.
Vite source maps are enabled in dev mode, so the React component tree is
fully navigable.

### Docker Daemon
```bash
# View daemon logs (macOS / Windows)
# Docker Desktop → Troubleshoot → View logs

# View daemon logs (Linux)
journalctl -xu docker.service
```

## Performance

### Profiling
```bash
# CPU profiling
node --prof -r ts-node/register packages/backend/src/index.ts
node --prof-process isolate-*.log > profile.txt

# Memory profiling
node --inspect -r ts-node/register packages/backend/src/index.ts
# Use Chrome DevTools → Memory tab
```

### Optimization Guidelines
- Use async/await, not callbacks
- Stream large files instead of buffering
- Implement bandwidth limiting for network transfers (restic flag)
- Cache Docker API queries (with reasonable TTL)
- Profile before/after optimizations

## Code Style

### TypeScript
- Strict mode enabled
- ESLint rules enforced
- Prettier formatting

```bash
# Format code
npm run format

# Fix linting issues
npm run lint -- --fix
```

### Naming Conventions
- Classes: PascalCase (`PolicyManager`)
- Functions: camelCase (`executeBackup`)
- Constants: UPPER_SNAKE_CASE (`MAX_RETRY_COUNT`)
- Files:
  - Classes: PascalCase (`PolicyManager.ts`)
  - Utilities: PascalCase or camelCase (`PathSafety.ts`, `validate.ts`)
  - Types: `types.ts`

### Documentation
- JSDoc comments for public APIs
- Inline comments for complex logic
- README in each package directory

## Release Process

1. **Update Version**
   ```bash
   npm version patch|minor|major
   ```

2. **Update CHANGELOG.md**
   ```
   ## [X.Y.Z] - YYYY-MM-DD

   ### Added
   ### Changed
   ### Fixed
   ### Deprecated
   ### Removed
   ```

3. **Create Release PR**
   ```bash
   git push origin feature/release-x.y.z
   # Open PR, request reviews
   ```

4. **Merge and Tag**
   ```bash
   git tag vX.Y.Z main
   git push origin vX.Y.Z
   ```

5. **Create GitHub Release**
   - Copy CHANGELOG section
   - Attach build artifacts
   - Mark as pre-release if beta

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for detailed guidelines.

---

Happy coding.
