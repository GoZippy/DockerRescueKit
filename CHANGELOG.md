# Changelog

All notable changes to DockerRescueKit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/semver-spec/).

---

## [Unreleased]

### Added

**Docker Desktop Extension — Dual-Transport Support (Phase 8)**
- Native Docker Desktop Extension integration via Unix socket transport (`DRK_TRANSPORT=socket`), in addition to the existing TCP path
- Extension UI now served inside Docker Desktop using the socket transport; standalone container deployments continue to use TCP (port 42880) unchanged
- Vite build flag `VITE_TRANSPORT=extension` sets relative `base` path (`./`) required for `file://` serving within Docker Desktop — TCP builds keep `/`
- `import.meta.env.VITE_TRANSPORT` injected at build time so the React UI can select the correct API transport at runtime
- Tailwind CSS via `@tailwindcss/vite` plugin added to the extension build

### Changed

- Docker Hub image namespace updated to `gozippy` across all image tags, CI references, and documentation (`gozippy/dockerrescuekit`)
- CI/CD pipeline (`.github/workflows/docker.yml`) now builds **and pushes** both the standalone backend image (`gozippy/dockerrescuekit:standalone-*`) and the Docker Desktop Extension image (`gozippy/dockerrescuekit:*`) on `v*` tag pushes; previously only one image was published per release

### Fixed

- `metadata.json` updated to satisfy Docker Desktop Marketplace validator requirements: correct icon reference (`drk-icon.svg`), UI tab definition with `root`/`src` fields, and `vm.composefile` pointing to `compose.yaml`

---

## [1.0.0] - 2026-05-11

First public release.

### Added

**WSL Security Updater (`tools/Update-All-WSL.ps1`)**
- Detects all installed WSL distros automatically, skipping Docker-managed distros (`docker-desktop`, `docker-desktop-data`)
- Multi-distro package manager detection: apt/apt-get (Ubuntu, Debian, Kali), dnf/yum (Fedora, RHEL, CentOS, AlmaLinux, Rocky), apk (Alpine), pacman (Arch, Manjaro), zypper (openSUSE)
- Repairs broken package states (interrupted dpkg/apt transactions) before updating
- Per-distro reporting: running kernel version, newest installed kernel, held packages, remaining upgradable packages, reboot-required flag, disk usage before and after
- Automatic retry with WSL reset for transient `HCS_E_CONNECTION_TIMEOUT` failures (common on machines without nested virtualization support)
- Full timestamped log file with per-distro output and final summary
- Parameters: `-LogDir`, `-SkipDockerImages`, `-ForceDockerAll`, `-DryRun`, `-DistroFilter`, `-MaxRetries`, `-RetryDelaySec`, `-AutoElevate`
- Null-byte stripping for WSL UTF-16 LE output on Windows
- PATH translation warning filter (WSL nested virtualization messages demoted to DEBUG)
- WSL engine self-update before distro updates
- Final summary grouped by SUCCESS / FAILED / UNSUPPORTED with actionable tips for failures

**Smart Docker Image Updater (`tools/Invoke-DockerUpdateSafe.ps1`)**
- Image classification engine: LOCAL (no registry digest, skip), PRIVATE (IP/localhost registry, skip), FLOATING (latest/main/edge/etc.), PINNED (version tag), STANDARD
- Built-in security priority list covering 30+ high-CVE repository families (nginx, postgres, redis, node, alpine, ubuntu, debian, python, golang, and more)
- Compose project detection: scans common project directories up to 4 levels deep for `docker-compose.yml` / `compose.yaml` and groups images by project
- Interactive consent menu: security-flagged only, all floating, all pullable, by compose project, custom numbered selection, or skip
- Non-interactive / scheduled task mode: auto-detects `[Environment]::UserInteractive` and falls back to security-only with no prompting
- Post-pull check: identifies running containers whose image was just updated and warns that a restart is needed
- Checkpoint integration: always calls `New-DockerCheckpoint.ps1` before pulling (unless `-SkipCheckpoint`)
- Parameters: `-LogFile`, `-CheckpointDir`, `-DryRun`, `-SecurityOnly`, `-ForceAll`, `-ApproveImages`, `-SkipCheckpoint`

**Rollback Checkpoint (`tools/New-DockerCheckpoint.ps1`)**
- Captures registry digest (`sha256`) for every local image using `docker images --digests` (single fast call, no per-image inspect loop)
- Saves full `docker inspect` snapshot of all containers in a single call
- Generates `Restore-Images.ps1`: a standalone rollback script that pulls each image back to its exact prior digest using `docker pull repo@sha256:...`
- Documents locally-built images (no registry digest) separately with a clear rebuild-from-source note
- Writes `CHECKPOINT_META.json` with timestamp, counts, and restorable vs local-only breakdown
- Parameters: `-CheckpointDir`, `-LogFile`
- Returns checkpoint directory path for use by parent scripts

**Double-click Launcher (`tools/Run-WSL-Updater.bat`)**
- Self-elevating UAC launcher requiring no PowerShell knowledge
- Checks for script existence before launching with a clear error message if missing
- Keeps console window open after completion

**Full Backup (`backup-docker-snapshot.ps1`)**
- Complete point-in-time Docker environment backup: containers, images (saved as .tar), volumes, networks, daemon settings
- Commits running containers as snapshot images before export
- Generates `restore-docker-snapshot.ps1` with full restore instructions
- Parameters: `-BackupPath`, `-BackupName`

**Backup Scheduler (`setup-backup-schedule.ps1`)**
- Registers a Windows Scheduled Task for automated full backups
- Parameters: `-BackupPath`, `-ScriptPath`, `-Schedule`, `-Time`

**Documentation**
- `README.md`: quick-start, requirements, script overview, scheduling guide
- `docs/SCRIPTS.md`: full parameter reference for all scripts
- `ARTICLE.md`: security write-up covering Copy Fail (CVE-2026-31431), Dirty Frag (CVE-2026-43284/43500), and cPanel CVE-2026-41940
- `CONTRIBUTING.md`: contribution guidelines
- `CHANGELOG.md`: this file

### Security

- All PowerShell scripts use ASCII-only characters in executable string literals for compatibility with PowerShell 5.1's CP1252 file encoding (prevents corruption of Unicode characters)
- No credentials, API keys, or personal data in any committed file
- `.gitignore` excludes `.env`, `.local-data/`, log directories, checkpoint archives, and private AI agent configuration
- Docker image updates require explicit user consent before pulling in interactive mode
- Rollback checkpoint is always saved before any image is pulled

### Known Limitations

- WSL distros requiring systemd (Ubuntu 22.04 with default `wsl.conf`) may time out when launched non-interactively on hardware without nested virtualization support. Workaround: set `systemd=false` in `/etc/wsl.conf` inside the affected distro, or update it manually.
- Locally-built Docker images (no registry) cannot be updated or restored via digest — by design.
- Private registries using plain HTTP require `"insecure-registries"` configured in Docker daemon settings for pulls to succeed.
- Compose project names derived from parent directory names may appear as hash strings if Docker Desktop uses temporary directories for compose projects.
