# Legacy WSL & Docker Desktop Maintenance Tools

The PowerShell scripts under `tools/` and the root-level `backup-docker-snapshot.ps1`
predate the DockerRescueKit backup service. They remain shipped for users who
relied on them in the pre-1.0 timeline and for Windows developers who need
WSL distro patching independent of the container backup service.

If you are looking for the modern backup/restore service (container, volume,
image, and network backups with pluggable storage backends), see the project
[README.md](../README.md). The content below covers only the legacy tooling.

---

## What These Tools Do

**Patches your WSL distros.** Detects every installed WSL distribution,
identifies its package manager (apt, dnf, apk, pacman, zypper), and runs
a full security update. Reports kernel version, held packages, and
reboot-required status for each one.

**Updates Docker images safely.** Classifies every local image — skipping
locally-built images and private registries, flagging security-critical
bases (nginx, postgres, redis, node, alpine), grouping images by compose
project — then asks which ones you want to update before pulling anything.

**Saves a rollback checkpoint first.** Before any Docker image is pulled,
a checkpoint captures the exact registry digest of every image. If
something breaks, one script restores any image to its previous
bit-for-bit identical layers.

---

## Quick Start

**Easiest way — double-click:**

1. Download or clone this repo
2. Open the `tools` folder
3. Double-click `Run-WSL-Updater.bat`
4. Accept the UAC prompt
5. Watch it run

That's it. Logs are saved to `%USERPROFILE%\Desktop\WSL_Update_Logs\`.

**From PowerShell:**

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
cd C:\Path\To\DockerRescueKit\tools

# Full run: WSL updates + interactive Docker image consent menu
.\Update-All-WSL.ps1

# Preview with no changes
.\Update-All-WSL.ps1 -DryRun
```

---

## Requirements

- Windows 10 or 11
- WSL2 with at least one distro installed
- PowerShell 5.1 or later (built into Windows — no install needed)
- Docker Desktop (optional — required for Docker image updates)
- Administrator privileges (the bat launcher handles this automatically)

---

## The Scripts

### `tools/Update-All-WSL.ps1` — Main Orchestrator

Patches every WSL distro and calls the safe Docker updater.

```powershell
# Update all WSL distros + Docker images (interactive menu)
.\Update-All-WSL.ps1

# WSL only — skip Docker images
.\Update-All-WSL.ps1 -SkipDockerImages

# Specific distros only
.\Update-All-WSL.ps1 -DistroFilter "Ubuntu-22.04","Debian"

# Auto-elevate + custom log location
.\Update-All-WSL.ps1 -AutoElevate -LogDir "C:\Logs\WSL"

# Scheduled/automated — no Docker interaction
.\Update-All-WSL.ps1 -AutoElevate -SkipDockerImages
```

### `tools/Invoke-DockerUpdateSafe.ps1` — Smart Docker Updater

Classifies images, detects compose projects, shows a consent menu, saves
a checkpoint, then pulls only what you approved.

```powershell
# Interactive run with full menu
.\Invoke-DockerUpdateSafe.ps1

# Security-flagged images only (no prompt — good for scheduled tasks)
.\Invoke-DockerUpdateSafe.ps1 -SecurityOnly

# Approve specific images directly
.\Invoke-DockerUpdateSafe.ps1 -ApproveImages "nginx:alpine","redis:7-alpine"

# Dry run
.\Invoke-DockerUpdateSafe.ps1 -DryRun
```

**The interactive menu:**

```
  [1] Security-flagged only        (N images) -- recommended
  [2] All floating tags            (N images)
  [3] All pullable (float+pinned)  (N images)
  [4] By compose project           (choose which projects)
  [5] Custom selection             (pick individually)
  [6] Skip Docker updates
```

### `tools/New-DockerCheckpoint.ps1` — Rollback Snapshot

Captures image digests and container state in ~10 seconds. Called
automatically before every Docker update, or run standalone.

```powershell
# Create a checkpoint now
.\New-DockerCheckpoint.ps1

# Restore images to their pre-update state
cd "$env:USERPROFILE\Desktop\DockerCheckpoints\checkpoint_YYYYMMDD_HHmmss"
.\Restore-Images.ps1

# Preview the restore without making changes
.\Restore-Images.ps1 -DryRun
```

### `backup-docker-snapshot.ps1` — Full Disaster Recovery Backup

Creates a complete archive of all images, volumes, containers, networks,
and settings. Slower than a checkpoint but fully portable.

```powershell
.\backup-docker-snapshot.ps1 -BackupPath "D:\Backups\Docker"
```

---

## Setting Up a Weekly Schedule

Run this once in an elevated PowerShell to keep WSL patched automatically:

```powershell
$Action  = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument '-NonInteractive -ExecutionPolicy Bypass -File "C:\Path\To\DockerRescueKit\tools\Update-All-WSL.ps1" -SkipDockerImages'
$Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At "3:00AM"
$Settings = New-ScheduledTaskSettingsSet -RunOnlyIfNetworkAvailable -WakeToRun
Register-ScheduledTask -TaskName "DockerRescueKit - WSL Weekly Update" `
    -Action $Action -Trigger $Trigger -Settings $Settings -RunLevel Highest
```

For Docker images, run `Invoke-DockerUpdateSafe.ps1 -SecurityOnly` on a
separate schedule — it updates security-critical images automatically
with no user interaction.

---

## Why This Exists

WSL2 and Docker Desktop create a Linux environment that nobody patches
by default:

- **Windows Update** handles Windows but ignores Linux distros inside WSL
- **Docker Desktop** updates its own engine but not the Linux base images
  your containers run on
- **WSL distros** accumulate CVEs from the day they are installed until
  someone manually runs `apt upgrade` inside them

Most people never do. These scripts do it for you.

See [../ARTICLE.md](../ARTICLE.md) for the full write-up including the
specific CVEs that motivated this work.

---

## For IT Teams

`Update-All-WSL.ps1` can be deployed via Group Policy, RMM tools, or
Task Scheduler across developer workstations. The timestamped log files
provide an audit trail showing which distros were updated, what kernel
was running, and whether any packages were held back.

`Invoke-DockerUpdateSafe.ps1 -SecurityOnly` runs silently in scheduled
task mode, updates only the highest-priority images, and saves a
checkpoint before every pull — safe for automated deployment.

See [SCRIPTS.md](SCRIPTS.md) for full parameter reference.

---

## File Layout

```
tools/
├── Update-All-WSL.ps1          # Main WSL + Docker orchestrator
├── Invoke-DockerUpdateSafe.ps1 # Smart Docker image updater
├── New-DockerCheckpoint.ps1    # Pre-update rollback snapshot
└── Run-WSL-Updater.bat         # Double-click launcher

backup-docker-snapshot.ps1      # Full disaster recovery backup (repo root)
setup-backup-schedule.ps1       # Scheduled task installer (repo root)
```

---

## License

MIT — see [../LICENSE](../LICENSE). Free to use, share, and modify.
