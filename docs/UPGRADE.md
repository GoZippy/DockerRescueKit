# Upgrade guide — DockerRescueKit

## Safe upgrade paths

### Extension: Hub tag → Hub tag (SAFE)
When upgrading between Hub-published versions (e.g. `:1.2.1` → `:1.2.2`), Docker Desktop preserves the extension's data volume. All policies, settings, and history are retained.

```bash
docker extension update gozippy/dockerrescuekit:1.2.2
```

### Extension: Sideload → Hub (DATA LOSS RISK)
`docker extension rm <sideload-id>` **deletes the data volume**. To migrate:

1. Export config from the old install: Settings → Danger zone → Export config
2. Install from Hub: `docker extension install gozippy/dockerrescuekit:latest`
3. Import the downloaded JSON: Settings → Danger zone → Import config

### Standalone container (SAFE)
Standalone containers mount volumes explicitly (`-v drk-data:/data`). Re-creating the container with the same volume preserves all state:

```bash
docker pull gozippy/dockerrescuekit:standalone-latest
docker stop drk && docker rm drk
docker run -d --name drk -v drk-data:/data -p 42880:42880 gozippy/dockerrescuekit:standalone-latest
```

## Upgrade matrix

| From → To | Data preserved? | Notes |
|-----------|----------------|-------|
| Sideload → Sideload (same ID) | ✅ | Docker Desktop preserves volume |
| Hub tag → Hub tag | ✅ | Same extension ID, volume kept |
| Sideload → Hub | ❌ | Different extension ID, volume deleted on `rm` |
| Hub → Sideload | ❌ | Different extension ID, volume deleted on `rm` |
| Standalone → Standalone | ✅ | Explicit volume binding |
| Extension → Standalone | ⚠️ | Different data layout; use export/import |

## Known broken versions

- **v1.2.0** — Container crash at startup (`MODULE_NOT_FOUND` for `@docker-rescue-kit/shared/dist/types.ts`). Do not use.
- **v1.2.1** — Same crash as v1.2.0. Do not use.
- **v1.2.2** — Fixes both crashes. Minimum recommended version.

## Rollback

Docker Desktop caches the previous image tag. To roll back:

```bash
docker extension update gozippy/dockerrescuekit:1.1.0
```

Your data volume is preserved across tag switches.
