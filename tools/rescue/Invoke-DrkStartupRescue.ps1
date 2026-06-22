#Requires -Version 5.1
<#
.SYNOPSIS
    DockerRescueKit companion rescue scanner for Docker Desktop startup issues.

.DESCRIPTION
    Collects a focused Docker Desktop / WSL startup health report and can run
    conservative rescue actions when explicitly requested. The default mode is
    report-only and does not stop processes, alter Docker settings, or start
    Docker Desktop.

    This script is designed to run outside the DockerRescueKit extension, so it
    still works when Docker Desktop or the Docker extension UI cannot load.

.PARAMETER Rescue
    Stop Docker Desktop processes, terminate the docker-desktop WSL distro, and
    optionally start Docker Desktop again. Does not run wsl --shutdown unless
    FullWslShutdown is also supplied.

.PARAMETER FullWslShutdown
    With Rescue, run wsl --shutdown after terminating docker-desktop. This stops
    all WSL distros, including user distros. Use when vmmem/wslrelay remain stuck.

.PARAMETER StartDocker
    Start Docker Desktop after rescue actions, then wait for the engine.

.PARAMETER ClearWslIntegrationList
    Clear Docker Desktop's per-distro IntegratedWslDistros list after backing up
    settings-store.json. Useful when the default WSL integration checkbox is off
    but individual distros are still integrated.

.PARAMETER GatherDiagnostics
    Run com.docker.diagnose.exe gather when available and include the bundle path.

.PARAMETER ReportPath
    Optional path for the JSON report. Defaults to a timestamped file in TEMP.

.PARAMETER WaitSeconds
    Seconds to wait for Docker Engine when StartDocker is supplied.

.EXAMPLE
    pwsh ./tools/rescue/Invoke-DrkStartupRescue.ps1

.EXAMPLE
    pwsh ./tools/rescue/Invoke-DrkStartupRescue.ps1 -GatherDiagnostics

.EXAMPLE
    pwsh ./tools/rescue/Invoke-DrkStartupRescue.ps1 -Rescue -FullWslShutdown -StartDocker

.EXAMPLE
    pwsh ./tools/rescue/Invoke-DrkStartupRescue.ps1 -Rescue -ClearWslIntegrationList -StartDocker
#>

[CmdletBinding()]
param(
    [switch] $Rescue,
    [switch] $FullWslShutdown,
    [switch] $StartDocker,
    [switch] $ClearWslIntegrationList,
    [switch] $GatherDiagnostics,
    [string] $ReportPath = "",
    [int] $WaitSeconds = 180
)

$ErrorActionPreference = "Continue"

function New-DrkFinding {
    param(
        [ValidateSet("info", "warning", "critical", "action")]
        [string] $Severity,
        [string] $Code,
        [string] $Title,
        [string] $Detail,
        [string] $Recommendation = ""
    )

    [PSCustomObject]@{
        severity       = $Severity
        code           = $Code
        title          = $Title
        detail         = $Detail
        recommendation = $Recommendation
    }
}

function Write-DrkLine {
    param(
        [string] $Message,
        [ConsoleColor] $Color = [ConsoleColor]::White
    )

    Write-Host $Message -ForegroundColor $Color
}

function Invoke-External {
    param(
        [string] $FilePath,
        [string[]] $Arguments = @(),
        [int] $TimeoutSeconds = 20
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    foreach ($Arg in $Arguments) {
        [void] $psi.ArgumentList.Add($Arg)
    }
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi

    try {
        [void] $process.Start()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            try { $process.Kill() } catch {}
            return [PSCustomObject]@{
                exitCode = 124
                stdout   = ""
                stderr   = "Timed out after $TimeoutSeconds seconds"
                timedOut = $true
            }
        }

        return [PSCustomObject]@{
            exitCode = $process.ExitCode
            stdout   = $process.StandardOutput.ReadToEnd()
            stderr   = $process.StandardError.ReadToEnd()
            timedOut = $false
        }
    } catch {
        return [PSCustomObject]@{
            exitCode = 127
            stdout   = ""
            stderr   = $_.Exception.Message
            timedOut = $false
        }
    } finally {
        if ($process) { $process.Dispose() }
    }
}

function ConvertFrom-WslText {
    param([string] $Text)
    return (($Text -replace "`0", "") -replace "`r", "").Trim()
}

function Get-CommandPathSafe {
    param([string] $Name)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return ""
}

function Get-DockerDesktopPath {
    $candidates = @(
        "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe",
        "${env:ProgramFiles(x86)}\Docker\Docker\Docker Desktop.exe"
    )

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate -ErrorAction SilentlyContinue)) {
            return $candidate
        }
    }

    return ""
}

function Get-DockerDiagnosePath {
    $desktop = Get-DockerDesktopPath
    if (-not $desktop) { return "" }
    $root = Split-Path $desktop -Parent
    $diag = Join-Path $root "resources\com.docker.diagnose.exe"
    if (Test-Path $diag -ErrorAction SilentlyContinue) { return $diag }
    return ""
}

function Get-DockerProcesses {
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.ProcessName -match '^Docker Desktop$|^com\.docker|^docker$|^docker-agent$|^docker-sandbox$|^dockerd$|^containerd$|^vpnkit|^wsl|^vmmem|^vmcompute$'
        } |
        Select-Object ProcessName, Id, CPU, StartTime, Path
}

function Get-DockerServices {
    $names = @("com.docker.service", "WSLService", "LxssManager", "vmcompute", "hns")
    Get-Service -Name $names -ErrorAction SilentlyContinue |
        Select-Object Name, DisplayName, Status, StartType
}

function Get-DockerSettings {
    $path = Join-Path $env:APPDATA "Docker\settings-store.json"
    if (-not (Test-Path $path -ErrorAction SilentlyContinue)) {
        return [PSCustomObject]@{
            path   = $path
            exists = $false
            data   = $null
            error  = ""
        }
    }

    try {
        $raw = Get-Content $path -Raw -ErrorAction Stop
        return [PSCustomObject]@{
            path   = $path
            exists = $true
            data   = ($raw | ConvertFrom-Json)
            error  = ""
        }
    } catch {
        return [PSCustomObject]@{
            path   = $path
            exists = $true
            data   = $null
            error  = $_.Exception.Message
        }
    }
}

function Get-DockerPipes {
    try {
        Get-ChildItem "\\.\pipe\" -ErrorAction Stop |
            Where-Object { $_.Name -match 'docker' } |
            Select-Object -ExpandProperty Name
    } catch {
        @()
    }
}

function Get-WslStatus {
    $wslPath = Get-CommandPathSafe "wsl.exe"
    if (-not $wslPath) {
        return [PSCustomObject]@{
            available = $false
            status    = ""
            list      = ""
            distros   = @()
            error     = "wsl.exe not found"
        }
    }

    $status = Invoke-External -FilePath $wslPath -Arguments @("--status") -TimeoutSeconds 20
    $list = Invoke-External -FilePath $wslPath -Arguments @("--list", "--verbose") -TimeoutSeconds 20
    $cleanList = ConvertFrom-WslText $list.stdout

    $distros = @()
    foreach ($line in ($cleanList -split "`n")) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed -match '^NAME\s+STATE\s+VERSION') { continue }
        $isDefault = $trimmed.StartsWith("*")
        $row = $trimmed.TrimStart("*").Trim()
        if ($row -match '^(?<name>\S+)\s+(?<state>Running|Stopped|Installing|Uninstalling)\s+(?<version>\d+)') {
            $distros += [PSCustomObject]@{
                name      = $Matches.name
                state     = $Matches.state
                version   = [int] $Matches.version
                isDefault = $isDefault
            }
        }
    }

    return [PSCustomObject]@{
        available = $true
        status    = ConvertFrom-WslText ($status.stdout + $status.stderr)
        list      = $cleanList
        distros   = $distros
        error     = if ($list.exitCode -eq 0) { "" } else { $list.stderr }
    }
}

function Get-DockerDesktopGuestServices {
    $wslPath = Get-CommandPathSafe "wsl.exe"
    if (-not $wslPath) {
        return [PSCustomObject]@{ checked = $false; output = ""; hasSocketForwarder = $false; processSummary = "" }
    }

    $args = @(
        "-d", "docker-desktop",
        "--",
        "sh", "-lc",
        "ps -ef | sed -n '1,80p'; echo '---guest-services---'; ls -la /run/guest-services 2>/dev/null || true"
    )

    $result = Invoke-External -FilePath $wslPath -Arguments $args -TimeoutSeconds 15
    $output = ConvertFrom-WslText ($result.stdout + $result.stderr)
    return [PSCustomObject]@{
        checked            = ($result.exitCode -eq 0)
        output             = $output
        hasSocketForwarder = ($output -match 'socketforwarder-receive-fds\.sock')
        processSummary     = (($output -split "---guest-services---")[0]).Trim()
    }
}

function Get-DockerEngineHealth {
    $dockerPath = Get-CommandPathSafe "docker.exe"
    if (-not $dockerPath) { $dockerPath = Get-CommandPathSafe "docker" }
    if (-not $dockerPath) {
        return [PSCustomObject]@{
            cliFound = $false
            version  = ""
            info     = ""
            ok       = $false
            error    = "docker CLI not found"
        }
    }

    $version = Invoke-External -FilePath $dockerPath -Arguments @("version") -TimeoutSeconds 25
    $info = Invoke-External -FilePath $dockerPath -Arguments @(
        "info",
        "--format",
        "Server={{.ServerVersion}} Containers={{.Containers}} Running={{.ContainersRunning}} Driver={{.Driver}} OSType={{.OSType}}"
    ) -TimeoutSeconds 25

    $combined = ($version.stdout + $version.stderr + $info.stdout + $info.stderr)
    $ok = ($version.exitCode -eq 0 -and $combined -match 'Server:')

    return [PSCustomObject]@{
        cliFound = $true
        version  = ($version.stdout + $version.stderr).Trim()
        info     = ($info.stdout + $info.stderr).Trim()
        ok       = $ok
        error    = if ($ok) { "" } else { $combined.Trim() }
    }
}

function Get-RestartingContainers {
    $dockerPath = Get-CommandPathSafe "docker.exe"
    if (-not $dockerPath) { $dockerPath = Get-CommandPathSafe "docker" }
    if (-not $dockerPath) { return @() }

    $result = Invoke-External -FilePath $dockerPath -Arguments @(
        "ps",
        "-a",
        "--filter",
        "status=restarting",
        "--format",
        "{{.ID}}|{{.Names}}|{{.Status}}|{{.Image}}"
    ) -TimeoutSeconds 30

    if ($result.exitCode -ne 0) { return @() }

    $items = @()
    foreach ($line in ($result.stdout -split "`n")) {
        $clean = $line.Trim()
        if (-not $clean -or $clean -notmatch '\|') { continue }
        $parts = $clean -split '\|'
        if ($parts.Count -lt 4) { continue }
        $items += [PSCustomObject]@{
            id     = $parts[0]
            name   = $parts[1]
            status = $parts[2]
            image  = $parts[3]
        }
    }
    return $items
}

function Get-DockerLogSignals {
    $logRoot = Join-Path $env:LOCALAPPDATA "Docker\log"
    $signals = @()
    $targets = @(
        (Join-Path $logRoot "host\com.docker.backend.exe.log"),
        (Join-Path $logRoot "host\Docker Desktop.exe.log"),
        (Join-Path $logRoot "host\monitor.log"),
        (Join-Path $logRoot "vm\init.log")
    )

    foreach ($target in $targets) {
        if (-not (Test-Path $target -ErrorAction SilentlyContinue)) { continue }
        try {
            $matches = Get-Content $target -Tail 500 -ErrorAction Stop |
                Select-String -Pattern 'still waiting|context deadline exceeded|engine.*_ping|socketforwarder|backend is not running|failed|fatal|panic|exit code|shutdown with exit code' -CaseSensitive:$false |
                Select-Object -Last 30

            foreach ($match in $matches) {
                $signals += [PSCustomObject]@{
                    file = $target
                    line = $match.Line.Trim()
                }
            }
        } catch {
            $signals += [PSCustomObject]@{
                file = $target
                line = "Could not read log: $($_.Exception.Message)"
            }
        }
    }

    return $signals
}

function Get-DockerDataLocations {
    $settings = Get-DockerSettings
    $locations = @()
    if ($settings.exists -and $settings.data) {
        foreach ($property in @("CustomWslDistroDir", "DataFolder")) {
            $value = $settings.data.$property
            if (-not $value) { continue }
            $exists = Test-Path $value -ErrorAction SilentlyContinue
            $drive = ""
            $freeBytes = $null
            try {
                $root = [System.IO.Path]::GetPathRoot($value)
                if ($root) {
                    $driveInfo = Get-PSDrive -PSProvider FileSystem |
                        Where-Object { $_.Root -eq $root } |
                        Select-Object -First 1
                    if ($driveInfo) {
                        $drive = $driveInfo.Name
                        $freeBytes = $driveInfo.Free
                    }
                }
            } catch {}

            $locations += [PSCustomObject]@{
                setting   = $property
                path      = $value
                exists    = $exists
                drive     = $drive
                freeBytes = $freeBytes
            }
        }
    }
    return $locations
}

function Invoke-DockerDiagnosticsGather {
    $diag = Get-DockerDiagnosePath
    if (-not $diag) {
        return [PSCustomObject]@{ attempted = $false; path = ""; output = "com.docker.diagnose.exe not found" }
    }

    $result = Invoke-External -FilePath $diag -Arguments @("gather") -TimeoutSeconds 180
    $text = ($result.stdout + $result.stderr)
    $bundle = ""
    if ($text -match 'Diagnostics Bundle:\s*(?<path>.+\.zip)') {
        $bundle = $Matches.path.Trim()
    } elseif ($text -match 'into\s+(?<path>[A-Za-z]:\\.+?\.zip)') {
        $bundle = $Matches.path.Trim()
    }

    return [PSCustomObject]@{
        attempted = $true
        path      = $bundle
        output    = $text.Trim()
        exitCode  = $result.exitCode
    }
}

function Stop-DockerDesktopStack {
    $stopped = @()
    $patterns = '^Docker Desktop$|^com\.docker|^docker-agent$|^docker-sandbox$|^vpnkit'
    $processes = Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -match $patterns }

    foreach ($process in $processes) {
        try {
            Stop-Process -Id $process.Id -Force -ErrorAction Stop
            $stopped += "$($process.ProcessName):$($process.Id)"
        } catch {
            $stopped += "$($process.ProcessName):$($process.Id):$($_.Exception.Message)"
        }
    }

    try {
        Stop-Service -Name "com.docker.service" -Force -ErrorAction SilentlyContinue
    } catch {}

    return $stopped
}

function Stop-DockerWsl {
    param([switch] $AllWsl)

    $wslPath = Get-CommandPathSafe "wsl.exe"
    if (-not $wslPath) { return @("wsl.exe not found") }

    $actions = @()
    $terminate = Invoke-External -FilePath $wslPath -Arguments @("--terminate", "docker-desktop") -TimeoutSeconds 30
    $actions += "wsl --terminate docker-desktop exit=$($terminate.exitCode) $((ConvertFrom-WslText ($terminate.stdout + $terminate.stderr)))"

    if ($AllWsl) {
        $shutdown = Invoke-External -FilePath $wslPath -Arguments @("--shutdown") -TimeoutSeconds 60
        $actions += "wsl --shutdown exit=$($shutdown.exitCode) $((ConvertFrom-WslText ($shutdown.stdout + $shutdown.stderr)))"
    }

    return $actions
}

function Clear-DockerWslIntegration {
    $settings = Get-DockerSettings
    if (-not $settings.exists -or -not $settings.data) {
        return [PSCustomObject]@{
            changed = $false
            backup  = ""
            message = "settings-store.json not available"
        }
    }

    $backup = "$($settings.path).bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    try {
        Copy-Item -LiteralPath $settings.path -Destination $backup -Force -ErrorAction Stop
        $settings.data.EnableIntegrationWithDefaultWslDistro = $false
        $settings.data.IntegratedWslDistros = @()
        $settings.data | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $settings.path -Encoding UTF8
        return [PSCustomObject]@{
            changed = $true
            backup  = $backup
            message = "Cleared IntegratedWslDistros and disabled default WSL integration"
        }
    } catch {
        return [PSCustomObject]@{
            changed = $false
            backup  = $backup
            message = $_.Exception.Message
        }
    }
}

function Start-DockerDesktopAndWait {
    param([int] $TimeoutSeconds)

    $desktop = Get-DockerDesktopPath
    if (-not $desktop) {
        return [PSCustomObject]@{ started = $false; ok = $false; message = "Docker Desktop.exe not found" }
    }

    try {
        Start-Process -FilePath $desktop
    } catch {
        return [PSCustomObject]@{ started = $false; ok = $false; message = $_.Exception.Message }
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $last = $null
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        $health = Get-DockerEngineHealth
        $last = $health
        if ($health.ok) {
            return [PSCustomObject]@{
                started = $true
                ok      = $true
                message = $health.info
            }
        }
    }

    return [PSCustomObject]@{
        started = $true
        ok      = $false
        message = if ($last) { $last.error } else { "Timed out waiting for Docker Engine" }
    }
}

function New-StartupReport {
    param([object] $Diagnostics)

    $findings = @()
    $engine = $Diagnostics.engine
    $processes = @($Diagnostics.processes)
    $services = @($Diagnostics.services)
    $wsl = $Diagnostics.wsl
    $settings = $Diagnostics.settings
    $pipes = @($Diagnostics.pipes)
    $guest = $Diagnostics.guestServices
    $restarting = @($Diagnostics.restartingContainers)

    if (-not $engine.cliFound) {
        $findings += New-DrkFinding -Severity "critical" -Code "DOCKER_CLI_MISSING" -Title "Docker CLI not found" -Detail "docker was not found in PATH." -Recommendation "Install Docker Desktop or add the Docker CLI to PATH."
    } elseif (-not $engine.ok) {
        $findings += New-DrkFinding -Severity "critical" -Code "ENGINE_UNREACHABLE" -Title "Docker Engine is not reachable" -Detail $engine.error -Recommendation "Run rescue mode to stop Docker Desktop, terminate docker-desktop WSL, then restart Docker Desktop."
    } else {
        $findings += New-DrkFinding -Severity "info" -Code "ENGINE_OK" -Title "Docker Engine is reachable" -Detail $engine.info
    }

    $desktopRunning = @($processes | Where-Object { $_.ProcessName -eq "Docker Desktop" }).Count -gt 0
    $enginePipePresent = ($pipes -contains "dockerDesktopLinuxEngine" -or $pipes -contains "docker_engine")
    if ($desktopRunning -and -not $engine.ok -and -not $enginePipePresent) {
        $findings += New-DrkFinding -Severity "critical" -Code "UI_WAITING_FOR_MISSING_ENGINE_PIPE" -Title "Docker Desktop UI is running but engine pipe is absent" -Detail "Docker Desktop processes are running, but the Docker Engine named pipe was not present." -Recommendation "Stop Docker Desktop processes and terminate docker-desktop WSL before restarting."
    }

    $dockerDesktopDistro = @($wsl.distros | Where-Object { $_.name -eq "docker-desktop" } | Select-Object -First 1)
    if ($dockerDesktopDistro -and $dockerDesktopDistro.state -eq "Running" -and $guest.checked -and -not $guest.hasSocketForwarder -and -not $engine.ok) {
        $findings += New-DrkFinding -Severity "critical" -Code "WSL_GUEST_SERVICES_MISSING" -Title "docker-desktop WSL is running without expected guest service socket" -Detail "The docker-desktop distro is running but /run/guest-services/socketforwarder-receive-fds.sock was not found." -Recommendation "Terminate docker-desktop, and if vmmem/wslrelay remain, run wsl --shutdown."
    }

    if ($settings.exists -and $settings.data) {
        $integrated = @($settings.data.IntegratedWslDistros)
        if ($settings.data.EnableIntegrationWithDefaultWslDistro -eq $false -and $integrated.Count -gt 0) {
            $findings += New-DrkFinding -Severity "warning" -Code "WSL_INTEGRATION_DRIFT" -Title "WSL integration checkbox is off but individual distros remain integrated" -Detail "IntegratedWslDistros contains: $($integrated -join ', ')." -Recommendation "Clear the per-distro integration list if you want Docker to stop starting those WSL distros."
        }

        if ($settings.data.AutoStart -eq $true) {
            $findings += New-DrkFinding -Severity "warning" -Code "AUTOSTART_ENABLED" -Title "Docker Desktop autostart is enabled" -Detail "Docker Desktop will start at Windows sign-in." -Recommendation "Disable autostart when diagnosing startup hangs."
        }

        if ($settings.data.AutoDownloadUpdates -eq $true) {
            $findings += New-DrkFinding -Severity "warning" -Code "AUTO_DOWNLOAD_UPDATES_ENABLED" -Title "Automatic Docker Desktop update downloads are enabled" -Detail "Updates can prompt restart while Docker is under load." -Recommendation "Use a safe update workflow: gather diagnostics, checkpoint images, stop containers, then update."
        }
    } elseif ($settings.error) {
        $findings += New-DrkFinding -Severity "warning" -Code "SETTINGS_UNREADABLE" -Title "Could not read Docker Desktop settings" -Detail $settings.error
    }

    $customWslDataLocation = @($Diagnostics.dataLocations | Where-Object {
        $_.setting -eq "CustomWslDistroDir" -and $_.exists
    } | Select-Object -First 1)

    foreach ($location in @($Diagnostics.dataLocations)) {
        if (-not $location.exists) {
            if ($location.setting -eq "DataFolder" -and $customWslDataLocation) {
                $findings += New-DrkFinding -Severity "info" -Code "LEGACY_DATA_LOCATION_MISSING" -Title "$($location.setting) path does not exist" -Detail "$($location.path) is missing, but CustomWslDistroDir exists at $($customWslDataLocation.path)." -Recommendation "No action is usually needed when Docker Desktop is using the custom WSL data directory."
            } else {
                $findings += New-DrkFinding -Severity "warning" -Code "DATA_LOCATION_MISSING" -Title "$($location.setting) path does not exist" -Detail $location.path -Recommendation "Verify the configured Docker data path is mounted and available before Docker Desktop starts."
            }
        } elseif ($null -ne $location.freeBytes -and $location.freeBytes -lt 20GB) {
            $findings += New-DrkFinding -Severity "warning" -Code "LOW_DOCKER_DATA_SPACE" -Title "$($location.setting) drive is low on free space" -Detail "$($location.path) has about $([math]::Round($location.freeBytes / 1GB, 1)) GB free." -Recommendation "Free disk space or move Docker data to a larger local SSD."
        }
    }

    if ($restarting.Count -gt 0) {
        $findings += New-DrkFinding -Severity "warning" -Code "RESTARTING_CONTAINERS" -Title "Containers are restart-looping" -Detail (($restarting | ForEach-Object { "$($_.name) ($($_.status))" }) -join "; ") -Recommendation "Stop unneeded stacks or set restart policy to no before troubleshooting Docker Desktop startup."
    }

    $dockerService = @($services | Where-Object { $_.Name -eq "com.docker.service" } | Select-Object -First 1)
    if ($dockerService -and $dockerService.Status -eq "Stopped" -and $desktopRunning -and -not $engine.ok) {
        $findings += New-DrkFinding -Severity "warning" -Code "DOCKER_SERVICE_STOPPED_DURING_START" -Title "Docker Desktop service is stopped while UI is running" -Detail "com.docker.service is stopped and the engine is not reachable." -Recommendation "A full Docker Desktop process stop plus WSL terminate is usually cleaner than repeated UI restarts."
    }

    return $findings
}

if (-not $ReportPath) {
    $ReportPath = Join-Path $env:TEMP ("drk-startup-rescue-{0}.json" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
}

Write-DrkLine "DockerRescueKit Startup Rescue" Cyan
Write-DrkLine "Mode: $($(if ($Rescue) { 'rescue' } else { 'report-only' }))" DarkCyan

$diagnosticsBundle = $null
if ($GatherDiagnostics) {
    Write-DrkLine "Gathering Docker diagnostics bundle..." Yellow
    $diagnosticsBundle = Invoke-DockerDiagnosticsGather
}

$actions = @()
if ($Rescue) {
    Write-DrkLine "Stopping Docker Desktop processes and service..." Yellow
    $actions += [PSCustomObject]@{ action = "stopDockerDesktop"; result = @(Stop-DockerDesktopStack) }
    Start-Sleep -Seconds 2

    Write-DrkLine "Terminating docker-desktop WSL distro..." Yellow
    $actions += [PSCustomObject]@{ action = "stopDockerWsl"; result = @(Stop-DockerWsl -AllWsl:$FullWslShutdown) }
    Start-Sleep -Seconds 3

    if ($ClearWslIntegrationList) {
        Write-DrkLine "Clearing Docker Desktop WSL integration list..." Yellow
        $actions += [PSCustomObject]@{ action = "clearWslIntegrationList"; result = Clear-DockerWslIntegration }
    }

    if ($StartDocker) {
        Write-DrkLine "Starting Docker Desktop and waiting for engine..." Yellow
        $actions += [PSCustomObject]@{ action = "startDockerDesktop"; result = Start-DockerDesktopAndWait -TimeoutSeconds $WaitSeconds }
    }
}

Write-DrkLine "Collecting health snapshot..." Yellow
$snapshot = [PSCustomObject]@{
    timestampUtc          = (Get-Date).ToUniversalTime().ToString("o")
    host                  = [PSCustomObject]@{
        computerName = $env:COMPUTERNAME
        userName     = $env:USERNAME
        psVersion    = $PSVersionTable.PSVersion.ToString()
        os           = (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Caption)
    }
    paths                 = [PSCustomObject]@{
        dockerDesktop = Get-DockerDesktopPath
        dockerDiagnose = Get-DockerDiagnosePath
        dockerCli     = (Get-CommandPathSafe "docker.exe")
        wsl           = (Get-CommandPathSafe "wsl.exe")
    }
    processes             = @(Get-DockerProcesses)
    services              = @(Get-DockerServices)
    pipes                 = @(Get-DockerPipes)
    wsl                   = Get-WslStatus
    guestServices         = Get-DockerDesktopGuestServices
    engine                = Get-DockerEngineHealth
    restartingContainers  = @(Get-RestartingContainers)
    settings              = Get-DockerSettings
    dataLocations         = @(Get-DockerDataLocations)
    logSignals            = @(Get-DockerLogSignals)
    diagnosticsBundle     = $diagnosticsBundle
    actions               = $actions
}

$findings = @(New-StartupReport -Diagnostics $snapshot)
$report = [PSCustomObject]@{
    schemaVersion = 1
    tool          = "DockerRescueKit.StartupRescue"
    snapshot      = $snapshot
    findings      = $findings
}

$report | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $ReportPath -Encoding UTF8

Write-DrkLine ""
Write-DrkLine "Findings" Cyan
foreach ($finding in $findings) {
    $color = switch ($finding.severity) {
        "critical" { [ConsoleColor]::Red }
        "warning"  { [ConsoleColor]::Yellow }
        "action"   { [ConsoleColor]::Cyan }
        default    { [ConsoleColor]::Gray }
    }
    Write-DrkLine "[$($finding.severity.ToUpper())] $($finding.code): $($finding.title)" $color
    if ($finding.detail) {
        Write-DrkLine "  $($finding.detail)" DarkGray
    }
    if ($finding.recommendation) {
        Write-DrkLine "  Next: $($finding.recommendation)" DarkCyan
    }
}

Write-DrkLine ""
Write-DrkLine "Report: $ReportPath" Green
if ($diagnosticsBundle -and $diagnosticsBundle.path) {
    Write-DrkLine "Docker diagnostics bundle: $($diagnosticsBundle.path)" Green
}

$criticalCount = @($findings | Where-Object { $_.severity -eq "critical" }).Count
if ($criticalCount -gt 0) {
    exit 2
}

$warningCount = @($findings | Where-Object { $_.severity -eq "warning" }).Count
if ($warningCount -gt 0) {
    exit 1
}

exit 0
