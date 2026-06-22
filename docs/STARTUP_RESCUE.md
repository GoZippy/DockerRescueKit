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
- Back up settings before edits.
- Keep report-only mode as the default.
- Require explicit flags for service stops, WSL shutdown, and settings edits.
