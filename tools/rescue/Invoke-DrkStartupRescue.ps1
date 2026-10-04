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

.PARAMETER RepairNetworkStore
    With Rescue, back up and remove libnetwork's key-value store (local-kv.db)
    from the Docker data disk. Use when the report shows DUPLICATE_BRIDGE_NETWORK:
    a stale network owns the default bridge name, so dockerd exits 1 on every
    start and Docker Desktop reports an unrelated warning instead.

    DESTRUCTIVE: erases all user-defined networks. Images, containers and volumes
    are untouched; compose recreates its networks on the next up. A timestamped
    .bak is left beside the original.

    Gated: refuses unless init.log actually shows a duplicate-bridge conflict and
    the engine is unreachable. Supports -WhatIf and -Confirm. Override the gates
    with -Force.

.PARAMETER Force
    Bypass the safety gates on RepairNetworkStore. Only use this when you have
    confirmed the network store is the problem by other means.

.PARAMETER DataVhdxPath
    Explicit path to the Docker data VHDX. Only needed when auto-detection from
    CustomWslDistroDir and the default WSL data directory fails.

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

.EXAMPLE
    # Engine will not start and the report shows DUPLICATE_BRIDGE_NETWORK
    pwsh ./tools/rescue/Invoke-DrkStartupRescue.ps1 -Rescue -FullWslShutdown -RepairNetworkStore -StartDocker
#>

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [switch] $Rescue,
    [switch] $Force,
    [switch] $FullWslShutdown,
    [switch] $StartDocker,
    [switch] $ClearWslIntegrationList,
    [switch] $GatherDiagnostics,
    [switch] $RepairNetworkStore,
    [string] $DataVhdxPath = "",
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

    # NOT $args — that shadows the PowerShell automatic argument array.
    $wslArgs = @(
        "-d", "docker-desktop",
        "--",
        "sh", "-lc",
        "ps -ef | sed -n '1,80p'; echo '---guest-services---'; ls -la /run/guest-services 2>/dev/null || true"
    )

    $result = Invoke-External -FilePath $wslPath -Arguments $wslArgs -TimeoutSeconds 15
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
            # NOT $matches — that is a PowerShell automatic variable and
            # clobbering it breaks any later -match in this scope.
            $logMatches = Get-Content $target -Tail 500 -ErrorAction Stop |
                Select-String -Pattern 'still waiting|context deadline exceeded|engine.*_ping|socketforwarder|backend is not running|failed|fatal|panic|exit code|shutdown with exit code' -CaseSensitive:$false |
                Select-Object -Last 30

            foreach ($match in $logMatches) {
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

function Get-DockerBridgeConflict {
    <#
        Detects the failure mode where a stale entry in libnetwork's key-value
        store already owns the default bridge name, so dockerd cannot create
        the default "bridge" network and exits 1 during startup.

        Docker Desktop does NOT surface this. The dialog reports whatever
        non-fatal warning dockerd logged last (commonly "enable fsverity
        failed: operation not supported"), which sends people chasing
        filesystem features instead of one stale network record. The real
        error only appears in the VM-side init.log.
    #>
    $initLog = Join-Path $env:LOCALAPPDATA "Docker\log\vm\init.log"
    $result = [PSCustomObject]@{
        detected    = $false
        bridgeName  = ""
        conflictId  = ""
        attemptedId = ""
        timestamp   = ""
        logPath     = $initLog
    }

    if (-not (Test-Path $initLog -ErrorAction SilentlyContinue)) { return $result }

    $pattern = 'cannot create network (?<attempted>[0-9a-f]{12,64}) \((?<bridge>[^)]+)\): conflicts with network (?<conflict>[0-9a-f]{12,64})'
    try {
        $match = Get-Content $initLog -Tail 4000 -ErrorAction Stop |
            Select-String -Pattern $pattern |
            Select-Object -Last 1
    } catch {
        return $result
    }

    if (-not $match) { return $result }

    $groups = $match.Matches[0].Groups
    $result.detected    = $true
    $result.attemptedId = $groups['attempted'].Value
    $result.bridgeName  = $groups['bridge'].Value
    $result.conflictId  = $groups['conflict'].Value

    $timeMatch = [regex]::Match($match.Line, '"time":"(?<ts>[^"]+)"')
    if ($timeMatch.Success) { $result.timestamp = $timeMatch.Groups['ts'].Value }

    return $result
}

function Import-DrkCatalogue {
    <#
        Load the generated fatal-error catalogue if it shipped alongside this
        script. Generated from packages/shared/src/dockerFatalErrors.ts so the
        table has a single source of truth — see tools/gen-catalogue.js.

        Absence is not an error: the bespoke bridge-conflict detector below works
        standalone, which keeps this script useful when run straight from a repo
        checkout with nothing built.
    #>
    $candidates = @(
        (Join-Path $PSScriptRoot "generated\drk-catalogue.ps1"),
        (Join-Path $PSScriptRoot "..\..\host\generated\drk-catalogue.ps1")
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate -ErrorAction SilentlyContinue)) {
            try {
                . $candidate
                return $true
            } catch {
                Write-DrkLine "Could not load catalogue at ${candidate}: $($_.Exception.Message)" DarkYellow
            }
        }
    }
    return $false
}

function Get-DockerFatalErrors {
    <#
        Scan the VM init log against the generated catalogue. Returns at most one
        match per code, newest first. Catalogue order is significant: specific
        patterns precede the generic `failed to start daemon:` fallback, so a
        specific finding is never masked by the generic one.
    #>
    $results = @()
    if (-not $script:DrkFatalPatterns) { return $results }

    $initLog = Join-Path $env:LOCALAPPDATA "Docker\log\vm\init.log"
    if (-not (Test-Path $initLog -ErrorAction SilentlyContinue)) { return $results }

    try {
        $tail = Get-Content $initLog -Tail 4000 -ErrorAction Stop
    } catch {
        return $results
    }

    # FIRST match wins, then stop. Catalogue order puts specific patterns ahead
    # of the generic `failed to start daemon:` fallback, and both match the SAME
    # log line — without the break the user is shown their exact diagnosis
    # immediately followed by a critical finding reading "this failure is not in
    # DRK's catalogue yet", which contradicts it.
    foreach ($entry in $script:DrkFatalPatterns) {
        $hit = $tail | Select-String -Pattern $entry.Pattern | Select-Object -Last 1
        if (-not $hit) { continue }

        $timestamp = ""
        $timeMatch = [regex]::Match($hit.Line, '"time":"(?<ts>[^"]+)"')
        if ($timeMatch.Success) { $timestamp = $timeMatch.Groups['ts'].Value }

        $results += [PSCustomObject]@{
            code           = $entry.Code
            title          = $entry.Title
            recommendation = $entry.Recommendation
            repairable     = $entry.Repairable
            repairImpact   = $entry.RepairImpact
            timestamp      = $timestamp
            line           = $hit.Line.Trim()
        }
        break
    }

    return $results
}

function Get-RepairDistro {
    <#
        Pick a WSL distro to run repair commands in. Never docker-desktop —
        that distro is Docker's own and may be mid-teardown. Any other distro
        can see the mounted disk at /mnt/wsl/<name>.
    #>
    $status = Get-WslStatus
    $candidate = @($status.distros |
        Where-Object { $_.name -and $_.name -notlike "docker-desktop*" } |
        Select-Object -First 1)
    if ($candidate) { return $candidate[0].name }
    return ""
}

function Get-DockerDataVhdxPath {
    if ($DataVhdxPath) { return $DataVhdxPath }

    $candidates = @()
    $settings = Get-DockerSettings
    if ($settings.exists -and $settings.data -and $settings.data.CustomWslDistroDir) {
        $candidates += (Join-Path $settings.data.CustomWslDistroDir "disk\docker_data.vhdx")
    }
    $candidates += (Join-Path $env:LOCALAPPDATA "Docker\wsl\disk\docker_data.vhdx")
    $candidates += (Join-Path $env:LOCALAPPDATA "Docker\wsl\data\ext4.vhdx")

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate -ErrorAction SilentlyContinue)) { return $candidate }
    }
    return ""
}

function Repair-DockerNetworkStore {
    <#
        Back up and remove libnetwork's key-value store from the Docker data
        disk while the engine is stopped.

        DESTRUCTIVE: every user-defined network is erased. Docker rebuilds
        bridge/host/none on next start; compose projects recreate their own
        networks on the next `up`. Images, containers and volumes are NOT
        touched. A timestamped .bak is left beside the original.

        Requires Docker Desktop stopped and WSL shut down first, which is what
        the -Rescue path does before calling this.
    #>
    param([string] $VhdxPath)

    $mountName = "drk-netrepair"
    $result = [PSCustomObject]@{
        attempted  = $true
        ok         = $false
        vhdx       = $VhdxPath
        distro     = ""
        storePath  = ""
        backupPath = ""
        message    = ""
    }

    if (-not $VhdxPath) {
        $result.message = "Could not locate the Docker data VHDX. Pass -DataVhdxPath explicitly."
        return $result
    }

    $wslExe = Get-CommandPathSafe "wsl.exe"
    if (-not $wslExe) {
        $result.message = "wsl.exe not found."
        return $result
    }

    $distro = Get-RepairDistro
    if (-not $distro) {
        $result.message = "No non-docker-desktop WSL distro available to run repair commands in."
        return $result
    }
    $result.distro = $distro

    $mount = Invoke-External -FilePath $wslExe -Arguments @(
        "--mount", "--vhd", $VhdxPath, "--name", $mountName, "--type", "ext4"
    ) -TimeoutSeconds 120
    if ($mount.exitCode -ne 0) {
        $result.message = "Mount failed: $(ConvertFrom-WslText ($mount.stderr + $mount.stdout))"
        return $result
    }

    try {
        $root = "/mnt/wsl/$mountName"

        $find = Invoke-External -FilePath $wslExe -Arguments @(
            "-d", $distro, "-u", "root", "--", "bash", "-lc",
            "find $root -maxdepth 6 -path '*/network/files/local-kv.db' 2>/dev/null | head -n 1"
        ) -TimeoutSeconds 180
        $storePath = ConvertFrom-WslText $find.stdout

        if (-not $storePath) {
            $result.message = "No network store (local-kv.db) found on the mounted disk. Nothing to repair."
            return $result
        }
        $result.storePath = $storePath

        $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $backupPath = "$storePath.drk-$stamp.bak"

        $repair = Invoke-External -FilePath $wslExe -Arguments @(
            "-d", $distro, "-u", "root", "--", "bash", "-lc",
            "cp -a '$storePath' '$backupPath' && rm -f '$storePath' && sync && echo DRK_REPAIR_OK"
        ) -TimeoutSeconds 180

        if ((ConvertFrom-WslText $repair.stdout) -notmatch "DRK_REPAIR_OK") {
            $result.message = "Repair command failed: $(ConvertFrom-WslText ($repair.stderr + $repair.stdout))"
            return $result
        }

        $result.backupPath = $backupPath
        $result.ok = $true
        $result.message = "Removed $storePath (backup at $backupPath). Docker rebuilds bridge/host/none on next start; user-defined networks must be recreated with docker compose up."
        return $result
    } finally {
        $unmount = Invoke-External -FilePath $wslExe -Arguments @("--unmount", $VhdxPath) -TimeoutSeconds 120
        if ($unmount.exitCode -ne 0) {
            # WSL sometimes only accepts the \\?\ device form for --unmount.
            [void] (Invoke-External -FilePath $wslExe -Arguments @("--unmount", "\\?\$VhdxPath") -TimeoutSeconds 120)
        }
    }
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

    $bridgeConflict = $Diagnostics.bridgeConflict
    if ($bridgeConflict -and $bridgeConflict.detected -and -not $engine.ok) {
        $findings += New-DrkFinding -Severity "critical" -Code "DUPLICATE_BRIDGE_NETWORK" `
            -Title "Docker daemon cannot start: a stale network already owns the default bridge" `
            -Detail "dockerd failed to create the default `"$($bridgeConflict.bridgeName)`" network because network $($bridgeConflict.conflictId) already uses that bridge name$(if ($bridgeConflict.timestamp) { " (last seen $($bridgeConflict.timestamp))" }). Docker Desktop reports an unrelated warning for this failure, so the dialog text will not mention networking." `
            -Recommendation "Run with -Rescue -RepairNetworkStore to back up and clear libnetwork's key-value store. This erases user-defined networks only; images, containers and volumes are untouched, and compose recreates networks on the next up."
    } elseif ($bridgeConflict -and $bridgeConflict.detected -and $engine.ok) {
        $findings += New-DrkFinding -Severity "info" -Code "DUPLICATE_BRIDGE_NETWORK_RESOLVED" `
            -Title "A duplicate bridge conflict appears in the logs but the engine is healthy" `
            -Detail "Network $($bridgeConflict.conflictId) previously blocked the default `"$($bridgeConflict.bridgeName)`" network. The engine is reachable now, so this is historical." `
            -Recommendation "No action needed."
    }

    # Catalogue-driven fatal errors. DUPLICATE_BRIDGE_NETWORK is skipped because
    # the bespoke finding above carries the conflicting network ID and the repair
    # instruction, which the generic table cannot.
    foreach ($fatal in @($Diagnostics.fatalErrors)) {
        if ($fatal.code -eq "DUPLICATE_BRIDGE_NETWORK") { continue }
        if ($engine.ok) { continue }

        $detail = $fatal.line
        if ($detail.Length -gt 400) { $detail = $detail.Substring(0, 400) + "..." }
        if ($fatal.timestamp) { $detail = "$detail (logged $($fatal.timestamp))" }

        $findings += New-DrkFinding -Severity "critical" -Code $fatal.code `
            -Title $fatal.title `
            -Detail $detail `
            -Recommendation $fatal.recommendation
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

$script:DrkCatalogueLoaded = Import-DrkCatalogue
if (-not $script:DrkCatalogueLoaded) {
    Write-DrkLine "Fatal-error catalogue not found; using built-in checks only." DarkGray
}

$diagnosticsBundle = $null
if ($GatherDiagnostics) {
    Write-DrkLine "Gathering Docker diagnostics bundle..." Yellow
    $diagnosticsBundle = Invoke-DockerDiagnosticsGather
}

if ($RepairNetworkStore -and -not $Rescue) {
    Write-DrkLine "-RepairNetworkStore requires -Rescue (the engine and WSL must be stopped first). Skipping repair." Red
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

    if ($RepairNetworkStore) {
        # Runs only after the stack is down and WSL is terminated, so nothing
        # holds the data disk open when we mount it.
        #
        # Gated on evidence. This erases every user-defined network, so it must
        # not fire on a hunch — the diagnosis is re-read here (before the main
        # snapshot, which is collected later) specifically so the destructive
        # action can require a matching finding.
        $preRepairConflict = Get-DockerBridgeConflict
        $engineHealth = Get-DockerEngineHealth

        if (-not $preRepairConflict.detected -and -not $Force) {
            Write-DrkLine "Skipping network-store repair: no duplicate-bridge conflict found in init.log." Yellow
            Write-DrkLine "  Re-run with -Force only if you are certain the network store is the problem." DarkGray
            $actions += [PSCustomObject]@{
                action = "repairNetworkStore"
                result = [PSCustomObject]@{ attempted = $false; ok = $false; message = "skipped: no DUPLICATE_BRIDGE_NETWORK finding" }
            }
        }
        elseif ($engineHealth.ok -and -not $Force) {
            Write-DrkLine "Skipping network-store repair: the Docker engine is reachable." Yellow
            Write-DrkLine "  Repairing a healthy install would destroy networks for no reason. Use -Force to override." DarkGray
            $actions += [PSCustomObject]@{
                action = "repairNetworkStore"
                result = [PSCustomObject]@{ attempted = $false; ok = $false; message = "skipped: engine is healthy" }
            }
        }
        elseif (-not $PSCmdlet.ShouldProcess("Docker network store (local-kv.db)", "Back up and remove — erases all user-defined networks")) {
            $actions += [PSCustomObject]@{
                action = "repairNetworkStore"
                result = [PSCustomObject]@{ attempted = $false; ok = $false; message = "skipped: declined at confirmation" }
            }
        }
        else {
            $vhdx = Get-DockerDataVhdxPath
            Write-DrkLine "Repairing Docker network store (this erases user-defined networks)..." Yellow
            Write-DrkLine "  Data disk: $(if ($vhdx) { $vhdx } else { '<not found>' })" DarkGray
            $repairResult = Repair-DockerNetworkStore -VhdxPath $vhdx
            $actions += [PSCustomObject]@{ action = "repairNetworkStore"; result = $repairResult }
            Write-DrkLine "  $($repairResult.message)" $(if ($repairResult.ok) { [ConsoleColor]::Green } else { [ConsoleColor]::Red })
        }
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
    bridgeConflict        = Get-DockerBridgeConflict
    catalogueLoaded       = $script:DrkCatalogueLoaded
    fatalErrors           = @(Get-DockerFatalErrors)
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
