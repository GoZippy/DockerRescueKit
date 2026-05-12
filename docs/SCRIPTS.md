# DockerRescueKit — Script Reference

Complete reference for every script in the `tools/` directory and the root backup utilities.

---

## tools/Update-All-WSL.ps1

**The main orchestrator.** Patches every WSL Linux distribution on the machine and optionally triggers the safe Docker image updater.

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `-LogDir` | string | `~\Desktop\WSL_Update_Logs` | Folder for timestamped log files |
| `-SkipDockerImages` | switch | off | Skip Docker image updates entirely |
| `-ForceDockerAll` | switch | off | Pull all pullable Docker images without the consent menu |
| `-DryRun` | switch | off | Show what would happen without making any changes |
| `-DistroFilter` | string[] | (all) | Limit updates to specific distro names |
| `-MaxRetries` | int | 2 | Retry attempts for transient WSL startup failures |
| `-RetryDelaySec` | int | 15 | Seconds between retry attempts |
| `-AutoElevate` | switch | off | Re-launch as Administrator automatically if not already elevated |

### What it does

1. Stops Docker Desktop processes gracefully
2. Reports WSL engine version and status
3. Updates the WSL engine itself (`wsl --update`)
4. Shuts down all WSL VMs cleanly
5. Detects every installed distro (skips `docker-desktop` and `docker-desktop-data`)
6. For each distro: detects the package manager, repairs any broken package state, runs a full upgrade, reports kernel version, held packages, reboot-required flag, and disk usage
7. Retries distros that fail with `HCS_E_CONNECTION_TIMEOUT` (transient VM startup error)
8. Starts Docker Desktop and calls `Invoke-DockerUpdateSafe.ps1` for image updates
9. Writes a final summary with SUCCESS / FAILED / UNSUPPORTED counts

### Supported package managers

| Distro family | Package manager | Update command |
|---------------|-----------------|----------------|
| Ubuntu, Debian, Kali, Mint | apt / apt-get | `apt full-upgrade` |
| Fedora, RHEL, CentOS, AlmaLinux, Rocky | dnf / yum | `dnf upgrade` |
| Alpine | apk | `apk upgrade` |
| Arch, Manjaro | pacman | `pacman -Syu` |
| openSUSE | zypper | `zypper update` |

### Examples

```powershell
# Basic run — updates all distros and Docker images
.\Update-All-WSL.ps1

# Dry run — preview with no changes
.\Update-All-WSL.ps1 -DryRun

# WSL only, skip Docker
.\Update-All-WSL.ps1 -SkipDockerImages

# Specific distros only
.\Update-All-WSL.ps1 -DistroFilter "Ubuntu-22.04","Debian"

# Automated / scheduled task mode
.\Update-All-WSL.ps1 -AutoElevate -SkipDockerImages -LogDir "C:\Logs\WSL"
```

### Log output location

`%USERPROFILE%\Desktop\WSL_Update_Logs\wsl_update_YYYYMMDD_HHmmss.log`

---

## tools/Invoke-DockerUpdateSafe.ps1

**Intelligent Docker image updater with classification, consent, and rollback.** Called automatically by `Update-All-WSL.ps1` but also works standalone.

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `-LogFile` | string | (console only) | Append log lines to this file (shared with parent script) |
| `-CheckpointDir` | string | `~\Desktop\DockerCheckpoints` | Where to save pre-update rollback checkpoints |
| `-DryRun` | switch | off | Show what would happen without pulling or checkpointing |
| `-SecurityOnly` | switch | off | Non-interactive: pull security-flagged floating images only |
| `-ForceAll` | switch | off | Pull every pullable image without the consent menu |
| `-ApproveImages` | string[] | (none) | Explicit list of images to pull, bypasses the menu |
| `-SkipCheckpoint` | switch | off | Skip the pre-update rollback checkpoint (not recommended) |

### Image classification

Every local image is classified before anything is pulled:

| Class | Meaning | Action |
|-------|---------|--------|
| LOCAL | No registry digest — locally built image | Always skipped |
| PRIVATE | Registry hostname is an IP address, `localhost`, `.local`, or `.internal` | Always skipped |
| FLOATING | Tag is `latest`, `main`, `master`, `edge`, `nightly`, etc. | Pullable — highest drift risk |
| PINNED | Tag looks like a version number (`15.3`, `1.27.0-alpine`) | Pullable — lower risk, maintainer may still update the tag |
| STANDARD | Has a registry digest but tag doesn't match other patterns | Pullable |

### Security priority list

Images from these repository families are flagged with `[!]` regardless of classification:

`nginx`, `httpd`, `apache`, `postgres`, `postgresql`, `mysql`, `mariadb`, `mongo`, `redis`, `memcached`, `alpine`, `ubuntu`, `debian`, `centos`, `fedora`, `python`, `node`, `ruby`, `php`, `golang`, `openjdk`, `eclipse-temurin`, `wordpress`, `drupal`, `jenkins`, `vault`, `consul`, `rabbitmq`, `kafka`

### Interactive menu options

```
[1] Security-flagged only        — recommended for most users
[2] All floating tags            — highest coverage, some drift risk
[3] All pullable (float+pinned)  — maximum update, use carefully
[4] By compose project           — update one stack at a time
[5] Custom selection             — pick images by number
[6] Skip Docker updates
```

### Compose project detection

Scans the following paths up to 4 levels deep for `docker-compose.yml` / `compose.yaml` files:

`~/projects`, `~/dev`, `~/code`, `~/repos`, `~/src`, `~/Documents`, `C:\projects`, `C:\dev`, `C:\code`, `C:\repos`, `C:\src`

Images referenced in detected compose files are grouped by project in the menu.

### Non-interactive / scheduled task mode

When `[Environment]::UserInteractive` is `$false` (scheduled task, CI), or when `-SecurityOnly` is passed, the script automatically selects security-flagged floating images and proceeds without prompting. A checkpoint is still saved.

### Examples

```powershell
# Interactive standalone run
.\Invoke-DockerUpdateSafe.ps1

# Approve specific images directly
.\Invoke-DockerUpdateSafe.ps1 -ApproveImages "nginx:alpine","redis:7-alpine"

# Scheduled task — security images only, no interaction
.\Invoke-DockerUpdateSafe.ps1 -SecurityOnly

# Dry run — show classification and what would be pulled
.\Invoke-DockerUpdateSafe.ps1 -DryRun
```

---

## tools/New-DockerCheckpoint.ps1

**Fast pre-update rollback snapshot.** Saves image digests and container state in seconds. Called automatically by `Invoke-DockerUpdateSafe.ps1` before any pull.

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `-CheckpointDir` | string | `~\Desktop\DockerCheckpoints` | Parent folder for checkpoint subdirectories |
| `-LogFile` | string | (console only) | Append messages to a shared log file |

### What it saves

| File | Contents |
|------|----------|
| `image_digests.json` | Repository, tag, image ID, age, size, and registry digest for every image |
| `container_state.json` | Name, image, status, and ports for every container (running and stopped) |
| `container_inspect.json` | Full `docker inspect` output for all containers |
| `Restore-Images.ps1` | Generated rollback script — pulls each image back to its exact prior digest |
| `CHECKPOINT_META.json` | Summary metadata: timestamp, counts, restorable vs local-only |

### How rollback works

Images pulled from a registry have a content digest (`sha256:...`). The checkpoint records this digest. The generated restore script runs:

```powershell
docker pull "nginx@sha256:abc123..."
docker tag  "nginx@sha256:abc123..." "nginx:alpine"
```

This pulls the exact layer set that existed before the update — not "the version before latest" but the specific, immutable content hash.

Locally-built images have no registry digest and cannot be restored via pull. They are documented in the checkpoint and flagged clearly in the restore script.

### Output location

`%USERPROFILE%\Desktop\DockerCheckpoints\checkpoint_YYYYMMDD_HHmmss\`

### Example

```powershell
# Create a checkpoint right now (no updates — just a snapshot)
.\New-DockerCheckpoint.ps1

# Create with custom output directory
.\New-DockerCheckpoint.ps1 -CheckpointDir "C:\Backups\Docker"

# Restore from a specific checkpoint
cd "$env:USERPROFILE\Desktop\DockerCheckpoints\checkpoint_20260511_075206"
.\Restore-Images.ps1

# Dry run the restore — see what would happen
.\Restore-Images.ps1 -DryRun
```

---

## tools/Run-WSL-Updater.bat

**Double-click launcher.** The easiest entry point for non-technical users. No PowerShell knowledge required.

Checks whether it is already running as Administrator. If not, re-launches itself elevated via a UAC prompt. Then calls `Update-All-WSL.ps1` with `Bypass` execution policy and keeps the window open after the script finishes so you can read the output.

Place this file in the same directory as `Update-All-WSL.ps1`. It uses `%~dp0` to find the script relative to its own location, so it works regardless of where the tools folder is placed.

---

## backup-docker-snapshot.ps1

**Full Docker state backup.** Creates a complete, point-in-time snapshot of your entire Docker environment. Much slower than a checkpoint (copies actual image data) but produces a fully self-contained archive suitable for disaster recovery.

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `-BackupPath` | string | `C:\docker-backups` | Root folder for backup archives |
| `-BackupName` | string | `docker-snapshot-YYYY-MM-DD_HH-mm-ss` | Name of the snapshot subfolder |

### What it backs up

1. All container configurations (`docker inspect` for every container)
2. Commits of running containers as snapshot images
3. All Docker images saved as `.tar` files (`docker save`)
4. All named volumes exported via a temporary Alpine container
5. All Docker networks (`docker network inspect`)
6. Docker Desktop settings (`%APPDATA%\Docker\settings.json`)
7. Daemon configuration (`~\.docker\daemon.json`)
8. A generated `restore-docker-snapshot.ps1` script with full restore instructions

### When to use this vs. a checkpoint

| Scenario | Use |
|----------|-----|
| Before a Docker image update | `New-DockerCheckpoint.ps1` (fast, digest-only) |
| Before a major system change or migration | `backup-docker-snapshot.ps1` (complete, portable) |
| Disaster recovery / moving to new machine | `backup-docker-snapshot.ps1` |

### Example

```powershell
.\backup-docker-snapshot.ps1 -BackupPath "D:\Backups\Docker"
```

---

## setup-backup-schedule.ps1

**Scheduled task installer for the full backup.** Registers a Windows Scheduled Task that runs `backup-docker-snapshot.ps1` on a configurable schedule.

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `-BackupPath` | string | `C:\docker-backups` | Backup destination passed to the backup script |
| `-ScriptPath` | string | `C:\docker-tools` | Folder where `backup-docker-snapshot.ps1` lives |
| `-Schedule` | string | `Daily` | Task frequency: `Daily`, `Weekly`, `Monthly` |
| `-Time` | string | `02:00` | Time of day to run (24-hour format) |

### Example

```powershell
# Set up a weekly backup at 2am using the current script directory
.\setup-backup-schedule.ps1 -ScriptPath $PSScriptRoot -BackupPath "D:\Backups\Docker" -Schedule Weekly
```
