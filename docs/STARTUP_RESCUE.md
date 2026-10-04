# Startup Rescue Companion

DockerRescueKit runs inside Docker, so it cannot help when Docker Desktop is
stuck before the engine is available. The startup rescue companion is the
outside-Docker tool for that failure mode.

The first implementation targets Windows + Docker Desktop + WSL because that is
where most "Starting the Docker Engine..." hangs happen. The script defaults to
report-only mode and writes a JSON report that a human operator, support ticket,
or AI assistant can read.

## Windows MVP

Script:

```powershell
pwsh ./tools/rescue/Invoke-DrkStartupRescue.ps1
```

Report-only mode checks:

- Docker CLI availability.
- Docker Engine reachability.
- Docker Desktop processes and Windows services.
- WSL distro state.
- `docker-desktop` guest service socket presence.
- Docker Desktop named pipes.
- Docker Desktop settings drift.
- Docker data paths and free space.
- duplicate default-bridge network conflict (see below).
- recent Docker Desktop log signals.
- restart-looping containers.

Optional diagnostics bundle:

```powershell
pwsh ./tools/rescue/Invoke-DrkStartupRescue.ps1 -GatherDiagnostics
```

Conservative rescue:

```powershell
pwsh ./tools/rescue/Invoke-DrkStartupRescue.ps1 -Rescue -StartDocker
```

Full WSL reset rescue:

```powershell
pwsh ./tools/rescue/Invoke-DrkStartupRescue.ps1 -Rescue -FullWslShutdown -StartDocker
```

Clear stale per-distro WSL integration entries:

```powershell
pwsh ./tools/rescue/Invoke-DrkStartupRescue.ps1 -Rescue -ClearWslIntegrationList -StartDocker
```

`-ClearWslIntegrationList` backs up `%APPDATA%\Docker\settings-store.json`
before editing it.

## Duplicate default-bridge network

A stale entry in libnetwork's key-value store can end up owning the default
bridge name. `dockerd` then fails to create the default `bridge` network and
exits 1 on **every** start:

```
failed to start daemon: Error initializing network controller: error creating
default "bridge" network: cannot create network <new-id> (docker0): conflicts
with network <stale-id> (docker0): networks have same bridge name
```

Two things make this hard to find without help:

1. **Docker Desktop reports the wrong error.** The "An unexpected error
   occurred" dialog shows whatever non-fatal warning `dockerd` logged last —
   commonly `enable fsverity failed: operation not supported`, which is a
   capability probe against `/var/lib/docker/plugins/storage` and has nothing
   to do with the failure. The real error appears only in the VM-side
   `%LOCALAPPDATA%\Docker\log\vm\init.log`.
2. **The store does not self-heal.** It is a boltdb file; a hard kill mid-write
   can leave the duplicate behind permanently. The only in-product remedy Docker
   offers is *Reset to factory defaults*, which destroys every image, container
   and volume to fix one stale record.

The scanner detects it from `init.log` and reports `DUPLICATE_BRIDGE_NETWORK`
(critical) when the engine is also unreachable, or
`DUPLICATE_BRIDGE_NETWORK_RESOLVED` (info) when the conflict appears in history
but the engine is healthy now.

To repair:

```powershell
pwsh ./tools/rescue/Invoke-DrkStartupRescue.ps1 -Rescue -FullWslShutdown -RepairNetworkStore -StartDocker
```

The repair is gated on evidence: it refuses unless `init.log` actually shows the
conflict **and** the engine is unreachable, so it cannot fire on a hunch and destroy
networks on a healthy install. `-WhatIf` and `-Confirm` are supported; `-Force`
overrides the gates.

What the repair does, in order: stops the Docker Desktop stack, terminates WSL,
mounts the Docker data VHDX read-write via `wsl --mount`, locates
`*/network/files/local-kv.db`, copies it to a timestamped `.bak` beside the
original, removes it, syncs, and unmounts.

**Scope of the change.** All user-defined networks are erased. Docker rebuilds
`bridge`, `host` and `none` on next start, and compose projects recreate their
own networks on the next `up`. Images, containers, volumes and build cache are
not touched.

`-RepairNetworkStore` requires `-Rescue`; on its own it refuses to run, because
the data disk cannot be safely mounted while the engine holds it. The VHDX is
auto-detected from `CustomWslDistroDir` and the default WSL data directory —
override with `-DataVhdxPath` if detection fails.

## Finding Model

The report uses a simple finding format:

```json
{
  "severity": "warning",
  "code": "WSL_INTEGRATION_DRIFT",
  "title": "WSL integration checkbox is off but individual distros remain integrated",
  "detail": "IntegratedWslDistros contains: Ubuntu-26.04.",
  "recommendation": "Clear the per-distro integration list if you want Docker to stop starting those WSL distros."
}
```

Exit codes:

- `0`: no critical or warning findings.
- `1`: warning findings.
- `2`: critical findings.

## Design Direction

The companion tool should stay separate from the extension runtime:

- **Companion CLI:** Works when Docker does not.
- **Extension UI:** Can import or display companion reports after Docker is back.
- **MCP / agent bridge:** Lets AI assistants run report-only checks, then request
  explicit user approval for rescue actions.
- **Platform modules:** Windows WSL first, then Linux systemd/rootless Docker,
  then macOS Docker Desktop.

Recommended modules:

- `drk-rescue scan`: collect report-only diagnostics.
- `drk-rescue diagnose`: map raw signals to findings.
- `drk-rescue stop`: cleanly stop Docker Desktop or Docker Engine services.
- `drk-rescue reset-vm`: reset Docker Desktop VM/WSL integration state.
- `drk-rescue start`: restart Docker and wait for health.
- `drk-rescue bundle`: gather logs and redact sensitive fields.

## Safety Rules

Rescue tools must avoid destructive actions by default.

- Never unregister WSL distros automatically.
- Never delete Docker Desktop data VHDs automatically.
- Never prune images, volumes, or containers from startup rescue.
- Never remove the network store without an explicit flag, and always leave a
  timestamped backup beside the original.
- Back up settings before edits.
- Keep report-only mode as the default.
- Require explicit flags for service stops, WSL shutdown, and settings edits.
