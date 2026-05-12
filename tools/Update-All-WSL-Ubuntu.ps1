# Update-All-WSL-Ubuntu.ps1
# Updates Ubuntu WSL distros and skips Docker-managed distros.
# Run from PowerShell as Administrator.

$ErrorActionPreference = "Continue"

$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$LogDir = "$env:USERPROFILE\Desktop\WSL_Update_Logs"
$LogFile = Join-Path $LogDir "wsl_update_$Timestamp.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log {
    param(
        [string]$Message,
        [string]$Level = "INFO"
    )

    $Line = "[{0}] [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
    Write-Host $Line
    Add-Content -Path $LogFile -Value $Line
}

function Test-IsAdmin {
    $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $Principal = New-Object Security.Principal.WindowsPrincipal($Identity)
    return $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Stop-ProcessSafe {
    param([string]$Name)

    $Processes = Get-Process -Name $Name -ErrorAction SilentlyContinue

    if (-not $Processes) {
        Write-Log "Process not running: $Name"
        return
    }

    foreach ($Process in $Processes) {
        try {
            Write-Log "Stopping process: $($Process.ProcessName) PID=$($Process.Id)"
            Stop-Process -Id $Process.Id -Force -ErrorAction Stop
        }
        catch {
            Write-Log "Could not stop ${Name}: $($_.Exception.Message)" "WARN"
        }
    }
}

function Run-AndLog {
    param(
        [string]$Description,
        [scriptblock]$Command
    )

    Write-Log "Running: $Description"

    try {
        & $Command 2>&1 | ForEach-Object {
            $Line = $_.ToString()
            Write-Host $Line
            Add-Content -Path $LogFile -Value $Line
        }

        $ExitCode = $LASTEXITCODE

        if ($null -eq $ExitCode) {
            $ExitCode = 0
        }

        Write-Log "Finished: $Description | ExitCode=$ExitCode"
        return $ExitCode
    }
    catch {
        Write-Log "Failed during ${Description}: $($_.Exception.Message)" "ERROR"
        return 1
    }
}

function Get-WslDistrosClean {
    $Raw = & wsl.exe --list --quiet 2>&1
    $Clean = @()

    foreach ($Line in $Raw) {
        $Name = ($Line -replace "`0", "").Trim()

        if ([string]::IsNullOrWhiteSpace($Name)) {
            continue
        }

        $Clean += $Name
    }

    return $Clean
}

function Show-WslStatus {
    Write-Log "Current WSL status:"

    & wsl.exe --list --verbose 2>&1 | ForEach-Object {
        $Line = $_.ToString()
        Write-Host $Line
        Add-Content -Path $LogFile -Value $Line
    }
}

function Update-UbuntuDistro {
    param([string]$DistroName)

    Write-Log "========================================="
    Write-Log "Updating WSL distro: $DistroName"
    Write-Log "========================================="

    $BashScript = @'
set -e

export DEBIAN_FRONTEND=noninteractive

echo "===== Distro Info ====="
if command -v lsb_release >/dev/null 2>&1; then
    lsb_release -a || true
else
    cat /etc/os-release || true
fi

echo
echo "===== Kernel ====="
uname -a || true

echo
echo "===== Disk Space Before ====="
df -h / || true

echo
echo "===== Repair Interrupted DPKG/APT State If Needed ====="
dpkg --configure -a || true
apt --fix-broken install -y || true

echo
echo "===== APT Update ====="
apt update

echo
echo "===== APT Full Upgrade ====="
apt full-upgrade -y

echo
echo "===== APT Autoremove ====="
apt autoremove -y

echo
echo "===== APT Autoclean ====="
apt autoclean

echo
echo "===== Held Packages ====="
apt-mark showhold || true

echo
echo "===== Upgradable Packages After Update ====="
apt list --upgradable 2>/dev/null || true

echo
echo "===== Reboot Required Check ====="
if [ -f /var/run/reboot-required ]; then
    cat /var/run/reboot-required
    if [ -f /var/run/reboot-required.pkgs ]; then
        echo "Packages requiring reboot:"
        cat /var/run/reboot-required.pkgs
    fi
else
    echo "No reboot required flag found."
fi

echo
echo "===== Disk Space After ====="
df -h / || true

echo
echo "===== Update Complete ====="
'@

    Write-Log "Launching apt maintenance inside ${DistroName} as root."

    try {
        $BashScript | & wsl.exe -d $DistroName -u root -- bash -s 2>&1 | ForEach-Object {
            $Line = "[$DistroName] $($_.ToString())"
            Write-Host $Line
            Add-Content -Path $LogFile -Value $Line
        }

        $ExitCode = $LASTEXITCODE

        if ($ExitCode -eq 0) {
            Write-Log "Update completed successfully for ${DistroName}."
        }
        else {
            Write-Log "Update finished with exit code $ExitCode for ${DistroName}." "WARN"
        }
    }
    catch {
        Write-Log "Failed to update ${DistroName}: $($_.Exception.Message)" "ERROR"
    }
}

Write-Log "WSL Ubuntu update script started."
Write-Log "Log file: $LogFile"

if (-not (Test-IsAdmin)) {
    Write-Log "PowerShell is not running as Administrator. Some commands may fail." "WARN"
}

Write-Log "Stopping Docker Desktop and helper processes."

$ProcessesToStop = @(
    "Docker Desktop",
    "com.docker.backend",
    "com.docker.build",
    "docker-agent",
    "docker-sandbox",
    "docker-language-server-windows-amd64"
)

foreach ($ProcessName in $ProcessesToStop) {
    Stop-ProcessSafe -Name $ProcessName
}

Start-Sleep -Seconds 3

Run-AndLog "Show WSL version" { & wsl.exe --version }
Run-AndLog "Show WSL status" { & wsl.exe --status }
Run-AndLog "Update WSL engine" { & wsl.exe --update }

Write-Log "Attempting clean WSL shutdown."
Run-AndLog "WSL shutdown" { & wsl.exe --shutdown }

Start-Sleep -Seconds 5

Show-WslStatus

$AllDistros = Get-WslDistrosClean

Write-Log "Detected WSL distros: $($AllDistros -join ', ')"

$UbuntuDistros = @()

foreach ($Distro in $AllDistros) {
    if ($Distro -eq "docker-desktop" -or $Distro -eq "docker-desktop-data") {
        Write-Log "Skipping Docker-managed distro: $Distro"
        continue
    }

    if ($Distro -like "Ubuntu*") {
        $UbuntuDistros += $Distro
    }
    else {
        Write-Log "Skipping non-Ubuntu distro: $Distro"
    }
}

if ($UbuntuDistros.Count -eq 0) {
    Write-Log "No Ubuntu distros found to update." "WARN"
}
else {
    Write-Log "Ubuntu distros selected for update: $($UbuntuDistros -join ', ')"
}

foreach ($Distro in $UbuntuDistros) {
    Update-UbuntuDistro -DistroName $Distro

    Write-Log "Shutting down WSL after updating ${Distro}."
    Run-AndLog "WSL shutdown after ${Distro}" { & wsl.exe --shutdown }

    Start-Sleep -Seconds 5
}

Write-Log "Final WSL shutdown."
Run-AndLog "Final WSL shutdown" { & wsl.exe --shutdown }

Show-WslStatus

Write-Log "WSL Ubuntu update script completed."

Write-Host ""
Write-Host "Done. Log saved to:"
Write-Host $LogFile