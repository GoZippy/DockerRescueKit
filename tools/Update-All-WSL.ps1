#Requires -Version 5.1
<#
.SYNOPSIS
    DockerRescueKit - WSL & Docker Security Updater

.DESCRIPTION
    Detects all installed WSL distributions, identifies their package manager,
    and runs a full security update. Supports apt (Ubuntu/Debian), dnf/yum
    (Fedora/RHEL/CentOS), apk (Alpine), pacman (Arch), and zypper (openSUSE).

    Also optionally pulls the latest versions of all local Docker images so
    running containers stay patched against recent CVEs (e.g. the May 2025
    Linux kernel privilege-escalation flaws affecting WSL2 and Docker surfaces).

    Designed for home-lab users, open-source developers, and anyone running
    agentic tools such as Open WebUI, Ollama, Hermes, n8n, or similar stacks
    via WSL2 or Docker Desktop on Windows.

.PARAMETER LogDir
    Where to write the timestamped log file.
    Default: $env:USERPROFILE\Desktop\WSL_Update_Logs
    Falls back to $env:TEMP if the Desktop is unavailable.

.PARAMETER SkipDockerImages
    Skip Docker image updates entirely after WSL updates finish.

.PARAMETER ForceDockerAll
    Pull every pullable Docker image without the interactive consent menu.
    Equivalent to running Invoke-DockerUpdateSafe.ps1 with -ForceAll.
    Use only in automated pipelines where you accept the risk of dependency drift.

.PARAMETER DryRun
    Show what would happen without making any changes.

.PARAMETER DistroFilter
    Array of exact WSL distro names to process. If omitted all non-Docker
    distros are updated.  Example: -DistroFilter "Ubuntu-22.04","Debian"

.PARAMETER MaxRetries
    How many times to retry a distro that fails with a transient WSL startup
    error (e.g. HCS_E_CONNECTION_TIMEOUT). Default: 2

.PARAMETER RetryDelaySec
    Seconds to wait between retries. Default: 15

.PARAMETER AutoElevate
    Automatically re-launch the script as Administrator if not already elevated.

.EXAMPLE
    # Basic run
    .\Update-All-WSL.ps1

.EXAMPLE
    # Auto-elevate, custom log folder, skip Docker image pulls
    .\Update-All-WSL.ps1 -AutoElevate -LogDir "C:\Logs\WSL" -SkipDockerImages

.EXAMPLE
    # Dry-run on a specific distro only
    .\Update-All-WSL.ps1 -DryRun -DistroFilter "Ubuntu-22.04"

.NOTES
    Part of DockerRescueKit
    Run with: Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
    Then:     .\Update-All-WSL.ps1 [-AutoElevate]
#>

[CmdletBinding()]
param(
    [string]   $LogDir         = "$env:USERPROFILE\Desktop\WSL_Update_Logs",
    [switch]   $SkipDockerImages,
    [switch]   $ForceDockerAll,
    [switch]   $DryRun,
    [string[]] $DistroFilter   = @(),
    [int]      $MaxRetries     = 2,
    [int]      $RetryDelaySec  = 15,
    [switch]   $AutoElevate
)

$ErrorActionPreference = "Continue"

# Accumulates per-distro results for the final summary
$Script:Results = [System.Collections.Generic.List[PSCustomObject]]::new()

# ─────────────────────────────────────────────────────────────────────────────
# ADMIN ELEVATION
# ─────────────────────────────────────────────────────────────────────────────

function Test-IsAdmin {
    $Id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($Id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($AutoElevate -and -not (Test-IsAdmin)) {
    # Re-launch as admin, forwarding all bound parameters
    $ArgList = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    $PSBoundParameters.Remove("AutoElevate") | Out-Null
    foreach ($kv in $PSBoundParameters.GetEnumerator()) {
        $v = $kv.Value
        if ($v -is [switch]) {
            if ($v.IsPresent) { $ArgList += " -$($kv.Key)" }
        } elseif ($v -is [array]) {
            $ArgList += " -$($kv.Key) " + ($v | ForEach-Object { "`"$_`"" } | Join-String -Separator ",")
        } else {
            $ArgList += " -$($kv.Key) `"$v`""
        }
    }
    Start-Process powershell.exe -ArgumentList $ArgList -Verb RunAs
    exit 0
}

# ─────────────────────────────────────────────────────────────────────────────
# LOGGING
# ─────────────────────────────────────────────────────────────────────────────

$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"

# Graceful fallback if Desktop is absent (headless / server environments)
try {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
} catch {
    $LogDir = $env:TEMP
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}

$LogFile = Join-Path $LogDir "wsl_update_$Timestamp.log"

function Write-Log {
    param(
        [string] $Message,
        [ValidateSet("INFO","WARN","ERROR","SUCCESS","DEBUG")]
        [string] $Level = "INFO"
    )

    $Line = "[{0}] [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message

    $Color = switch ($Level) {
        "WARN"    { "Yellow"   }
        "ERROR"   { "Red"      }
        "SUCCESS" { "Green"    }
        "DEBUG"   { "DarkGray" }
        default   { "Cyan"     }
    }

    Write-Host $Line -ForegroundColor $Color
    Add-Content -Path $LogFile -Value $Line -ErrorAction SilentlyContinue
}

# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

function Remove-NullBytes {
    # WSL outputs UTF-16 LE which PowerShell sometimes reads as null-padded bytes,
    # producing "W S L   v e r s i o n" in the console. Strip them everywhere.
    param([string]$Text)
    return ($Text -replace "`0", "").Trim()
}

function Stop-ProcessSafe {
    param([string]$Name)
    $Procs = Get-Process -Name $Name -ErrorAction SilentlyContinue
    if (-not $Procs) {
        Write-Log "  Process not running: $Name" "DEBUG"
        return
    }
    foreach ($P in $Procs) {
        try {
            Write-Log "  Stopping: $($P.ProcessName) (PID $($P.Id))"
            Stop-Process -Id $P.Id -Force -ErrorAction Stop
        } catch {
            Write-Log "  Could not stop ${Name}: $($_.Exception.Message)" "WARN"
        }
    }
}

function Invoke-WslCommand {
    <#
    .SYNOPSIS Runs a wsl.exe expression, streams cleaned output to log, returns exit code.
    #>
    param(
        [string]      $Description,
        [scriptblock] $Command,
        [string]      $Prefix = ""
    )

    Write-Log "Running: $Description"

    try {
        & $Command 2>&1 | ForEach-Object {
            $Clean = Remove-NullBytes $_.ToString()

            # Filter non-fatal WSL path-translation warnings that come from
            # Windows PATH entries (e.g. Nmap) being visible inside WSL.
            if ($Clean -match "^wsl:\s+(Failed to translate|Nested virtualization)") {
                Write-Log "  [WSL-NOTICE] $Clean" "DEBUG"
                return
            }

            if ($Clean) {
                $Line = if ($Prefix) { "[$Prefix] $Clean" } else { "  $Clean" }
                Write-Host $Line -ForegroundColor Gray
                Add-Content -Path $LogFile -Value $Line -ErrorAction SilentlyContinue
            }
        }

        $EC = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
        Write-Log "Finished: $Description | ExitCode=$EC"
        return $EC
    } catch {
        Write-Log "Failed during '${Description}': $($_.Exception.Message)" "ERROR"
        return 1
    }
}

function Get-WslDistros {
    <# Returns a clean string array of installed WSL distro names. #>
    $Raw = & wsl.exe --list --quiet 2>&1
    return @(
        $Raw | ForEach-Object {
            $n = Remove-NullBytes $_.ToString()
            if ($n) { $n }
        } | Where-Object { $_ }
    )
}

function Show-WslStatus {
    Write-Log "Current WSL distro status:"
    & wsl.exe --list --verbose 2>&1 | ForEach-Object {
        $Clean = Remove-NullBytes $_.ToString()
        if ($Clean) {
            Write-Host "  $Clean" -ForegroundColor DarkGray
            Add-Content -Path $LogFile -Value "  $Clean" -ErrorAction SilentlyContinue
        }
    }
}

function Invoke-WithRetry {
    <#
    .SYNOPSIS
        Runs $Operation (a scriptblock that returns an exit code).
        Retries up to $MaxAttempts times on non-zero exit, resetting WSL between
        each attempt to recover from HCS_E_CONNECTION_TIMEOUT (-1) and similar
        transient VM startup failures.
    #>
    param(
        [string]      $OperationName,
        [scriptblock] $Operation,
        [int]         $MaxAttempts = $MaxRetries,
        [int]         $DelaySec    = $RetryDelaySec
    )

    $LastEC = 0

    for ($i = 1; $i -le ($MaxAttempts + 1); $i++) {
        $LastEC = & $Operation

        if ($LastEC -eq 0) { return 0 }

        if ($i -le $MaxAttempts) {
            $Reason = switch ($LastEC) {
                -1      { "HCS connection timeout (WSL VM failed to start)" }
                default { "exit code $LastEC" }
            }
            Write-Log "Attempt $i of $($MaxAttempts + 1) failed for '$OperationName' ($Reason)." "WARN"
            Write-Log "Resetting WSL and retrying in $DelaySec s..." "WARN"
            & wsl.exe --shutdown | Out-Null
            Start-Sleep -Seconds $DelaySec
        }
    }

    return $LastEC
}

# ─────────────────────────────────────────────────────────────────────────────
# BASH UPDATE SCRIPT  (multi-distro, package-manager aware)
# ─────────────────────────────────────────────────────────────────────────────

function Get-BashUpdateScript {
    # IMPORTANT: This heredoc is explicitly normalized to LF (\n) before being
    # piped to bash. PowerShell here-strings use CRLF on Windows, and bash
    # treats \r as a literal character, which produces:
    #   bash: $'\r': command not found
    #   bash: syntax error: unexpected end of file
    # The -replace at the end of this function is the critical fix.

    $Script = @'
#!/usr/bin/env bash

# Do NOT use "set -e" here. Per-command error handling is safer for a
# maintenance script — individual failures (e.g. nothing to autoremove)
# must not abort the entire run.

export DEBIAN_FRONTEND=noninteractive

sep() { echo; echo "===== $* ====="; echo; }

# ── Detect the available package manager ─────────────────────────────────────
detect_pm() {
    for pm in apt-get dnf yum apk pacman zypper; do
        command -v "$pm" >/dev/null 2>&1 && echo "$pm" && return
    done
    echo "unknown"
}

PM=$(detect_pm)

# ── Distro / kernel info ──────────────────────────────────────────────────────
sep "Distro Info"
if command -v lsb_release >/dev/null 2>&1; then
    lsb_release -a 2>/dev/null || true
elif [ -f /etc/os-release ]; then
    cat /etc/os-release
else
    echo "Unable to determine distro."
fi

sep "Kernel Version"
uname -a

sep "Package Manager Detected: $PM"

sep "Disk Space Before Update"
df -h / 2>/dev/null || true

# ── Run the appropriate updater ───────────────────────────────────────────────
case "$PM" in

    apt-get)
        echo "[apt] Repairing any interrupted dpkg/apt state..."
        dpkg --configure -a 2>/dev/null || true
        apt-get --fix-broken install -y 2>/dev/null || true

        echo "[apt] Refreshing package index..."
        apt-get update -y

        echo "[apt] Running full-upgrade (security + feature packages)..."
        # --force-conf* flags prevent prompts when config files conflict
        apt-get full-upgrade -y \
            -o Dpkg::Options::="--force-confdef" \
            -o Dpkg::Options::="--force-confold"

        echo "[apt] Removing obsolete packages..."
        apt-get autoremove -y || true

        echo "[apt] Cleaning package cache..."
        apt-get autoclean -y || true

        echo "[apt] Packages currently on hold (will NOT be upgraded):"
        apt-mark showhold 2>/dev/null || echo "  (none held)"

        echo "[apt] Remaining upgradable packages (should be empty):"
        apt list --upgradable 2>/dev/null || true
        ;;

    dnf|yum)
        echo "[$PM] Updating all packages..."
        $PM update -y

        echo "[$PM] Cleaning metadata cache..."
        $PM clean packages 2>/dev/null || true
        ;;

    apk)
        echo "[apk] Updating package index..."
        apk update

        echo "[apk] Upgrading all packages..."
        apk upgrade

        echo "[apk] Attempting to fix any broken packages..."
        apk fix 2>/dev/null || true
        ;;

    pacman)
        echo "[pacman] Syncing repos and upgrading all packages..."
        pacman -Syu --noconfirm

        echo "[pacman] Removing orphaned packages..."
        ORPHANS=$(pacman -Qtdq 2>/dev/null)
        if [ -n "$ORPHANS" ]; then
            echo "$ORPHANS" | pacman -Rns --noconfirm - 2>/dev/null || true
        else
            echo "  No orphaned packages found."
        fi
        ;;

    zypper)
        echo "[zypper] Refreshing all repos..."
        zypper --non-interactive refresh

        echo "[zypper] Updating all packages..."
        zypper --non-interactive update

        echo "[zypper] Running distribution upgrade..."
        zypper --non-interactive dist-upgrade
        ;;

    *)
        echo "[WARN] No supported package manager found in this distro."
        echo "  Looked for: apt-get dnf yum apk pacman zypper"
        echo "  Binaries present in /usr/bin:"
        ls /usr/bin/apt* /usr/bin/dnf /usr/bin/yum /usr/bin/apk \
           /usr/bin/pacman /usr/bin/zypper 2>/dev/null || echo "  (none found)"
        exit 2
        ;;
esac

# ── Reboot-required check (Debian/Ubuntu) ────────────────────────────────────
sep "Reboot Required Check"
if [ -f /var/run/reboot-required ]; then
    echo "*** REBOOT REQUIRED ***"
    cat /var/run/reboot-required 2>/dev/null || true
    if [ -f /var/run/reboot-required.pkgs ]; then
        echo "Packages that triggered reboot requirement:"
        cat /var/run/reboot-required.pkgs
    fi
else
    echo "No reboot-required flag found."
fi

# ── Running kernel vs. installed kernel (security sanity check) ───────────────
sep "Kernel Security Check"
RUNNING=$(uname -r)
echo "  Currently running kernel : $RUNNING"
if command -v dpkg >/dev/null 2>&1; then
    NEWEST=$(dpkg --list 2>/dev/null \
        | grep -E '^ii\s+linux-image-[0-9]' \
        | awk '{print $3}' \
        | sort -V \
        | tail -1)
    if [ -n "$NEWEST" ]; then
        echo "  Newest installed kernel pkg: $NEWEST"
        echo "  NOTE: If these differ, restart WSL to load the new kernel."
    fi
fi

sep "Disk Space After Update"
df -h / 2>/dev/null || true

echo
echo "===== Update Complete ====="
'@

    # THE KEY FIX: normalize Windows CRLF -> LF before bash sees the script.
    return $Script -replace "`r`n", "`n"
}

# ─────────────────────────────────────────────────────────────────────────────
# UPDATE A SINGLE WSL DISTRO
# ─────────────────────────────────────────────────────────────────────────────

function Update-WslDistro {
    param([string]$DistroName)

    Write-Log ("-" * 55)
    Write-Log "Updating WSL distro: $DistroName"
    Write-Log ("-" * 55)

    if ($DryRun) {
        Write-Log "[DRY RUN] Would update: $DistroName" "WARN"
        $Script:Results.Add([PSCustomObject]@{
            Distro   = $DistroName
            Status   = "DRY-RUN"
            ExitCode = 0
        })
        return
    }

    $BashScript = Get-BashUpdateScript

    $ExitCode = Invoke-WithRetry -OperationName "Update $DistroName" -Operation {
        $EC = 0
        try {
            $BashScript | & wsl.exe -d $DistroName -u root -- bash -s 2>&1 |
            ForEach-Object {
                $Clean = Remove-NullBytes $_.ToString()

                # Suppress non-fatal WSL infrastructure notices so they don't
                # inflate the signal-to-noise ratio or confuse exit-code logic.
                if ($Clean -match "^wsl:\s+(Nested virtualization|Failed to translate)") {
                    Write-Log "  [WSL-NOTICE] $Clean" "DEBUG"
                    return
                }

                if ($Clean) {
                    $Line = "[$DistroName] $Clean"
                    Write-Host $Line -ForegroundColor White
                    Add-Content -Path $LogFile -Value $Line -ErrorAction SilentlyContinue
                }
            }

            $EC = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
        } catch {
            Write-Log "Exception while updating ${DistroName}: $($_.Exception.Message)" "ERROR"
            $EC = 1
        }
        return $EC
    }

    $Status   = switch ($ExitCode) {
        0       { "SUCCESS"     }
        2       { "UNSUPPORTED" }   # bash exit 2 = unknown PM
        default { "FAILED"      }
    }
    $LogLevel = switch ($Status) {
        "SUCCESS"     { "SUCCESS" }
        "UNSUPPORTED" { "WARN"    }
        default       { "ERROR"   }
    }

    Write-Log "Result for ${DistroName}: $Status (exit code $ExitCode)" $LogLevel

    $Script:Results.Add([PSCustomObject]@{
        Distro   = $DistroName
        Status   = $Status
        ExitCode = $ExitCode
    })

    # Brief reset between distros prevents state contamination and gives
    # the WSL VM time to fully release resources before the next launch.
    Write-Log "Resetting WSL after ${DistroName}..."
    & wsl.exe --shutdown | Out-Null
    Start-Sleep -Seconds 5
}

# ─────────────────────────────────────────────────────────────────────────────
# DOCKER IMAGE UPDATES
# ─────────────────────────────────────────────────────────────────────────────

function Update-DockerImages {
    Write-Log ("-" * 55)
    Write-Log "Updating Docker images"
    Write-Log ("-" * 55)

    if ($DryRun) {
        Write-Log "[DRY RUN] Would pull updated Docker images." "WARN"
        return
    }

    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Log "docker CLI not found in PATH. Skipping image updates." "WARN"
        return
    }

    # Verify the daemon is actually reachable before we try to pull
    $Ping = & docker info 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Log "Docker daemon not responding. Skipping image updates." "WARN"
        Write-Log "  Start Docker Desktop and re-run with -SkipDockerImages removed." "WARN"
        return
    }

    try {
        $Images = @(
            & docker images --format "{{.Repository}}:{{.Tag}}" 2>&1 |
                Where-Object { $_ -and ($_ -notmatch "<none>") }
        )

        if ($Images.Count -eq 0) {
            Write-Log "No Docker images found locally." "WARN"
            return
        }

        Write-Log "Found $($Images.Count) image(s) to check for updates."

        foreach ($Image in $Images) {
            Write-Log "  Pulling: $Image"
            & docker pull $Image 2>&1 | ForEach-Object {
                $Line = "  [docker] $($_.ToString())"
                Write-Host $Line -ForegroundColor DarkCyan
                Add-Content -Path $LogFile -Value $Line -ErrorAction SilentlyContinue
            }
            if ($LASTEXITCODE -ne 0) {
                Write-Log "  Could not pull ${Image} (exit $LASTEXITCODE)" "WARN"
            } else {
                Write-Log "  Pulled: $Image" "SUCCESS"
            }
        }
    } catch {
        Write-Log "Docker image update error: $($_.Exception.Message)" "ERROR"
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# SUMMARY REPORT
# ─────────────────────────────────────────────────────────────────────────────

function Show-Summary {
    Write-Log ("=" * 55)
    Write-Log "FINAL SUMMARY"
    Write-Log ("=" * 55)

    if ($Script:Results.Count -eq 0) {
        Write-Log "No distros were processed." "WARN"
        return
    }

    $Groups = $Script:Results | Group-Object -Property Status

    foreach ($Group in $Groups) {
        $Names = ($Group.Group | ForEach-Object { $_.Distro }) -join ", "
        $Level = switch ($Group.Name) {
            "SUCCESS"     { "SUCCESS" }
            "UNSUPPORTED" { "WARN"    }
            "FAILED"      { "ERROR"   }
            default       { "INFO"    }
        }
        Write-Log "  $($Group.Name) ($($Group.Count)): $Names" $Level
    }

    $Failed = @($Script:Results | Where-Object Status -eq "FAILED")
    if ($Failed.Count -gt 0) {
        Write-Log "" "WARN"
        Write-Log "  Tip: Failed distros may need manual intervention." "WARN"
        Write-Log "  Check the log for HCS_CONNECTION_TIMEOUT errors - these" "WARN"
        Write-Log "  usually mean the WSL VM itself failed to start. Try:" "WARN"
        Write-Log "    wsl --shutdown  then  wsl -d [DistroName]" "WARN"
    }

    Write-Log ("=" * 55)
}

# ─────────────────────────────────────────────────────────────────────────────
# MAIN EXECUTION
# ─────────────────────────────────────────────────────────────────────────────

Write-Log "DockerRescueKit - WSL & Docker Security Updater v1.1"
Write-Log "Log file: $LogFile"

if ($DryRun) {
    Write-Log "*** DRY RUN MODE - no changes will be made ***" "WARN"
}

if (-not (Test-IsAdmin)) {
    Write-Log "Not running as Administrator. Some WSL operations may fail." "WARN"
    Write-Log "Re-run with -AutoElevate or from an elevated PowerShell prompt." "WARN"
}

# Check WSL is present at all
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    Write-Log "wsl.exe not found. Is WSL installed? Run: wsl --install" "ERROR"
    exit 1
}

# ── Step 1: Stop Docker Desktop gracefully ────────────────────────────────────
Write-Log ("-" * 55)
Write-Log "Stopping Docker Desktop processes..."
@(
    "Docker Desktop",
    "com.docker.backend",
    "com.docker.build",
    "docker-agent",
    "docker-sandbox",
    "docker-language-server-windows-amd64"
) | ForEach-Object { Stop-ProcessSafe -Name $_ }

Start-Sleep -Seconds 3

# ── Step 2: Report WSL engine state ──────────────────────────────────────────
Invoke-WslCommand "WSL version"  { & wsl.exe --version }
Invoke-WslCommand "WSL status"   { & wsl.exe --status  }

if (-not $DryRun) {
    Write-Log "Updating WSL engine (requires internet)..."
    Invoke-WslCommand "WSL engine update" { & wsl.exe --update }
}

# ── Step 3: Clean shutdown before touching distros ────────────────────────────
Write-Log "Performing initial WSL shutdown..."
& wsl.exe --shutdown | Out-Null
Start-Sleep -Seconds 5

Show-WslStatus

# ── Step 4: Discover distros ──────────────────────────────────────────────────
$AllDistros = Get-WslDistros
Write-Log "Detected WSL distros: $($AllDistros -join ', ')"

# Always skip Docker-internal distros — they update via Docker Desktop itself
$DockerManagedDistros = @("docker-desktop", "docker-desktop-data")
$TargetDistros = @($AllDistros | Where-Object { $_ -notin $DockerManagedDistros })

foreach ($d in ($AllDistros | Where-Object { $_ -in $DockerManagedDistros })) {
    Write-Log "Skipping Docker-managed distro: $d"
}

# Apply optional user-supplied filter
if ($DistroFilter.Count -gt 0) {
    $TargetDistros = @($TargetDistros | Where-Object { $_ -in $DistroFilter })
    Write-Log "DistroFilter applied. Will update: $($TargetDistros -join ', ')"
}

if ($TargetDistros.Count -eq 0) {
    Write-Log "No distros to update after filtering." "WARN"
} else {
    Write-Log "Distros queued for update: $($TargetDistros -join ', ')"
}

# ── Step 5: Update each distro ────────────────────────────────────────────────
foreach ($Distro in $TargetDistros) {
    Update-WslDistro -DistroName $Distro
}

# ── Step 6: Docker image updates ─────────────────────────────────────────────
if (-not $SkipDockerImages) {
    Write-Log "Attempting to start Docker Desktop for image updates..."

    $DockerDesktopPaths = @(
        "${env:ProgramFiles}\Docker\Docker\Docker Desktop.exe",
        "${env:LOCALAPPDATA}\Programs\Docker\Docker\Docker Desktop.exe"
    )

    $DockerApp = $DockerDesktopPaths | Where-Object { Test-Path $_ } | Select-Object -First 1

    if ($DockerApp) {
        Start-Process -FilePath $DockerApp -WindowStyle Minimized -ErrorAction SilentlyContinue
        Write-Log "Waiting 25 s for Docker daemon to become ready..."
        Start-Sleep -Seconds 25

        # Prefer the safe interactive updater (consent + checkpoint + classify).
        # Falls back to the basic Update-DockerImages function if the script is missing.
        $SafeUpdater   = Join-Path $PSScriptRoot "Invoke-DockerUpdateSafe.ps1"
        $CheckpointDir = Join-Path $LogDir "checkpoints"

        if (Test-Path $SafeUpdater) {
            Write-Log "Using Invoke-DockerUpdateSafe.ps1 (consent + checkpoint mode)."

            $UpdateParams = @{
                LogFile       = $LogFile
                CheckpointDir = $CheckpointDir
                DryRun        = $DryRun
            }
            if ($ForceDockerAll) {
                $UpdateParams["ForceAll"] = $true
                Write-Log "ForceDockerAll: bypassing consent menu." "WARN"
            }

            & $SafeUpdater @UpdateParams

        } else {
            Write-Log "Invoke-DockerUpdateSafe.ps1 not found. Falling back to basic updater." "WARN"
            Write-Log "  Place Invoke-DockerUpdateSafe.ps1 in the same folder for full functionality." "WARN"
            Update-DockerImages
        }

    } else {
        Write-Log "Docker Desktop executable not found. Skipping image updates." "WARN"
        Write-Log "  Checked: $($DockerDesktopPaths -join ' | ')" "WARN"
    }
} else {
    Write-Log "Docker image updates skipped (-SkipDockerImages)."
}

# ── Step 7: Final WSL shutdown and status ─────────────────────────────────────
Write-Log "Performing final WSL shutdown..."
& wsl.exe --shutdown | Out-Null
Start-Sleep -Seconds 3

Show-WslStatus
Show-Summary

Write-Log "DockerRescueKit - WSL Security Updater completed."
Write-Host ""
Write-Host "Log saved to: $LogFile" -ForegroundColor Green
