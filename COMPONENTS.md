# Docker Rescue Kit — Component Classification

This file is maintained pursuant to Section 22 of the
[Zippy Technologies Source-Available Commercial License](LICENSE) and
classifies every file and directory in this repository as either an **Open
Material** or a **Restricted Material**.

> **Any file or directory not expressly listed below as an Open Material is
> a Restricted Material.** Restricted Materials are proprietary and may only
> be used as described in Sections 4, 5, and 7 of the LICENSE.

---

## Open Materials

The following files and directories are designated as Open Materials. You
may review, modify, and create Derivative Works of these materials subject
to the distribution and disclosure conditions in Sections 6, 8, and 10 of
the LICENSE.

- `LICENSE`
- `COMPONENTS.md` (this file)
- `README.md`
- `CHANGELOG.md`
- `CONTRIBUTING.md`
- `SECURITY.md`
- `THIRD_PARTY_LICENSES.md`
- `docs/` — all documentation, architecture notes, deployment guides,
  roadmap, and tier documentation
- `docs/screenshots/` — product screenshots
- `docker-compose.dev.yml`, `docker-compose.yml`,
  `docker-compose.prod.yml`, `docker-compose.extension.yml` — example
  Docker Compose files for self-hosted deployment
- `start.sh`, `start.ps1`, `stop.sh`, `stop.ps1`,
  `backup-docker-snapshot.ps1`, `setup-backup-schedule.ps1` — example
  shell and PowerShell helpers
- `drk-icon.svg` and `packaging/icon.svg` — product icon (use governed
  by Section 14 trademarks)
- `metadata.json` — Docker Desktop Extension metadata
- `sidecars/` — community-grade side-car templates (Dockerfiles, policy
  YAML/JSON, README) bundling the `drk` CLI with stack-specific
  defaults. Intended to be forked and adapted by users. Each side-car's
  README documents the underlying app and any operator caveats; the
  Restricted `drk` CLI binary it depends on is consumed unmodified
  through the published image and is not redistributed by these
  templates.

## Restricted Materials

All other files and directories in this repository — including but not
limited to:

- `packages/backend/` (Node.js backend service, storage adapters, scheduler,
  vault, API)
- `packages/extension/` (React UI for the Docker Desktop Extension)
- `packages/cli/` (the `drk` command-line interface)
- `packages/shared/` (shared TypeScript types and utilities)
- `packages/mcp/` (`drk-mcp` Model Context Protocol server — exposes safe Docker
  tools to cooperative AI agents; calls the DRK backend over the local REST API)
- `tools/` (internal tooling)
- `Dockerfile`, `Makefile`, build configuration, CI workflows
- `package.json`, `package-lock.json`, all `node_modules/`
- `.autoclaw/`, `.github/`, and any other internal directories
- any binary artifacts, build outputs, or release assets distributed by
  Licensor under the names listed in the Product and Repository Scope
  section of the LICENSE

are **Restricted Materials**. Restricted Materials are exposed in this
repository for inspection only. They may not be modified, adapted, or
incorporated into Derivative Works except as expressly permitted by the
LICENSE.

---

## Notes

- The classifications above apply as of the latest commit to this repository.
  Licensor may add, remove, or reclassify materials in future releases.
- A file appearing in a Restricted directory is itself Restricted even if
  the file extension or filename suggests otherwise (for example, a
  `README.md` inside `packages/backend/` is part of the Restricted backend
  package, not Open documentation).
- Third-party dependencies retain their own licenses as recorded in
  `THIRD_PARTY_LICENSES.md` and the relevant `node_modules/*/LICENSE` files;
  nothing in this classification affects third-party license terms.
- Commercial licensing inquiries: **Support@GoZippy.com**

## Classification audit log

| Release | Date | New files added | Classification |
|---|---|---|---|
| v1.2-rc | 2026-05-24 | `docs/COMPETITIVE_ANALYSIS.md`, `docs/BACKUP_TOOLS_COMPARISON.md`, `docs/STACK_RECIPES.md`, `docs/MARKETPLACE_LISTING_DRAFT.md`, `docs/ROADMAP.md` | Open (covered by `docs/` pattern) |
| v1.2-rc | 2026-05-24 | `packages/extension/src/components/VersionBadge.tsx` | Restricted (covered by `packages/extension/` pattern) |
| v1.2-rc | 2026-05-24 | `packages/shared/src/types.ts` extensions (InfluxDB + MSSQL DatabaseExporter variants), `packages/backend/src/services/DatabaseExporters.ts` extensions, `packages/backend/src/__tests__/dbExporters.test.ts` extensions | Restricted (covered by `packages/` pattern) |
| v1.2-rc | 2026-05-25 | `sidecars/plex/` (V-1 prototype) | **Open** (community-grade side-car templates — see §Open Materials above) |
| v1.2-rc | 2026-05-24 | `.autoclaw/orchestrator/sprints/v1.2-launch.yaml`, `.autoclaw/orchestrator/comms/inboxes/**`, `.autoclaw/internal/marketplace-submission.md`, `.autoclaw/kdream/memory/MEMORY.md` updates | Restricted (covered by `.autoclaw/` pattern; also `.gitignore`d so not redistributed) |
| v1.2-rc | 2026-05-25 | `license-server/` — initially added here, then **extracted to a separate private repository** at `K:\Projects\DRK_LicenseServer\` on 2026-05-25 for security isolation. It is `.gitignore`d in this repo so accidental re-add is blocked. Holds the RS256 JWT signing private key + Square API tokens — must not appear in any source-available distribution. | **Not in this repository** (lives in a separate private repo; explicitly `.gitignore`d here) |
| 2026-05-24 | 2026-05-24 | `LICENSE` switch from MIT to Zippy Technologies Source-Available Commercial License v1.3, `COMPONENTS.md` created | Open (as listed above) |
| v1.4-dev | 2026-06-11 | `packages/mcp/` (`drk-mcp` MCP server, PG-1.6) | **Restricted** (covered by `packages/` pattern — proprietary MCP server that calls the licensed DRK backend API; not redistributable under the source-available terms) |
| v1.4-dev | 2026-06-11 | `docs/PRUNE_GUARD_GUIDE.md`, `docs/SWITCHING.md`, `docs/design/PRUNE_GUARD.md` | Open (covered by `docs/` pattern) |

This audit log is informational; the patterns in §Open Materials and
§Restricted Materials remain the authoritative classification.
