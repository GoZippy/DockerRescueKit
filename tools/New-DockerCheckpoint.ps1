#Requires -Version 5.1
<#
.SYNOPSIS
    Creates a fast pre-update checkpoint of all Docker image digests and container state.

.DESCRIPTION
    Saves the registry digest (sha256) of every Docker image currently on disk,
    plus a full container inspect snapshot. Generates a Restore-Images.ps1 script
    that pulls each image back to the exact layer set it had before an update.

    Runtime is typically 5-15 seconds regardless of image count -- no image data
    is copied, only metadata is captured.

    Images built locally (no registry digest) cannot be restored via pull, but
    their presence is documented so you know what needs rebuilding.

.PARAMETER CheckpointDir
    Parent folder for checkpoint subdirectories.
    Default: $env:USERPROFILE\Desktop\DockerCheckpoints

.PARAMETER LogFile
    Optional path to an existing log file. Checkpoint messages will be appended.
    If empty, output goes to the console only.

.OUTPUTS
    [string] The path to the new checkpoint directory, or empty string on failure.

.EXAMPLE
    # Standalone
    .\New-DockerCheckpoint.ps1

.EXAMPLE
    # Called by the update pipeline with a shared log
    $SnapDir = .\New-DockerCheckpoint.ps1 -CheckpointDir "C:\Logs\checkpoints" -LogFile "C:\Logs\run.log"
#>

[CmdletBinding()]
param(
    [string] $CheckpointDir = "$env:USERPROFILE\Desktop\DockerCheckpoints",
    [string] $LogFile       = ""
)

$ErrorActionPreference = "Continue"

# ---- helpers ----------------------------------------------------------------

function Write-CLog {
    param([string]$Message, [string]$Level = "INFO")
    $Ts   = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $Line = "[$Ts] [$Level] [Checkpoint] $Message"
    Write-Host $Line
    if ($LogFile) {
        Add-Content -Path $LogFile -Value $Line -ErrorAction SilentlyContinue
    }
}

# ---- preflight --------------------------------------------------------------

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-CLog "docker CLI not found in PATH. Cannot create checkpoint." "WARN"
    return ""
}

$null = & docker info 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-CLog "Docker daemon not responding. Cannot create checkpoint." "WARN"
    return ""
}

# ---- initialise checkpoint directory ----------------------------------------

$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$SnapDir   = Join-Path $CheckpointDir "checkpoint_$Timestamp"

try {
    New-Item -ItemType Directory -Force -Path $SnapDir -ErrorAction Stop | Out-Null
} catch {
    Write-CLog "Could not create checkpoint directory '$SnapDir': $($_.Exception.Message)" "ERROR"
    return ""
}

Write-CLog "Creating checkpoint: $SnapDir"

# ---- 1. Image digest manifest -----------------------------------------------
# docker images --digests gives the registry digest inline, avoiding a separate
# docker inspect call per image. Digest is <none> for locally-built images.

Write-CLog "Capturing image digests..."

$ImageData = @()
$RawImages = & docker images --digests `
    --format "{{.Repository}}|{{.Tag}}|{{.Digest}}|{{.ID}}|{{.CreatedSince}}|{{.Size}}" 2>&1

foreach ($RawLine in $RawImages) {
    $Line = ($RawLine -replace "`0", "").Trim()
    if (-not $Line -or $Line -notmatch '\|') { continue }

    $Parts = $Line -split '\|'
    if ($Parts.Count -lt 5) { continue }

    $Repo   = $Parts[0].Trim()
    $Tag    = $Parts[1].Trim()
    $Digest = $Parts[2].Trim()
    $Id     = $Parts[3].Trim()
    $Age    = $Parts[4].Trim()
    $Size   = if ($Parts.Count -gt 5) { $Parts[5].Trim() } else { "" }

    if ($Repo -eq "<none>" -or $Tag -eq "<none>") { continue }

    $FullRef = "${Repo}:${Tag}"

    # Build the pullable digest reference (repo@sha256:...)
    # This is what "docker pull" understands for exact-version restoration.
    $RegistryDigest = ""
    if ($Digest -and $Digest -ne "<none>" -and $Digest -match "sha256:") {
        $RegistryDigest = "${Repo}@${Digest}"
    }

    $ImageData += [PSCustomObject]@{
        FullRef        = $FullRef
        Repository     = $Repo
        Tag            = $Tag
        ImageID        = $Id
        Age            = $Age
        Size           = $Size
        RegistryDigest = $RegistryDigest
        IsLocal        = (-not $RegistryDigest)
    }
}

$ImageData | ConvertTo-Json -Depth 5 |
    Out-File -FilePath "$SnapDir\image_digests.json" -Encoding UTF8

$WithDigest = @($ImageData | Where-Object { -not $_.IsLocal }).Count
$LocalOnly  = @($ImageData | Where-Object { $_.IsLocal }).Count

Write-CLog "Captured $($ImageData.Count) image(s): $WithDigest with registry digest, $LocalOnly local-only."

# ---- 2. Container state snapshot --------------------------------------------

Write-CLog "Capturing container state..."

$ContainerRaw   = & docker ps -a --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}" 2>&1
$ContainerState = @()

foreach ($RawLine in $ContainerRaw) {
    $Line = ($RawLine -replace "`0", "").Trim()
    if (-not $Line -or $Line -notmatch '\|') { continue }
    $Parts = $Line -split '\|'
    if ($Parts.Count -lt 4) { continue }

    $ContainerState += [PSCustomObject]@{
        ID     = $Parts[0].Trim()
        Name   = $Parts[1].Trim()
        Image  = $Parts[2].Trim()
        Status = $Parts[3].Trim()
        Ports  = if ($Parts.Count -gt 4) { $Parts[4].Trim() } else { "" }
    }
}

$ContainerState | ConvertTo-Json -Depth 5 |
    Out-File -FilePath "$SnapDir\container_state.json" -Encoding UTF8

# Full inspect for all containers in a single call
if ($ContainerState.Count -gt 0) {
    $ContainerIds = @($ContainerState | ForEach-Object { $_.ID })
    & docker inspect $ContainerIds 2>&1 |
        Out-File -FilePath "$SnapDir\container_inspect.json" -Encoding UTF8
}

Write-CLog "Captured $($ContainerState.Count) container(s)."

# ---- 3. Generate rollback script --------------------------------------------
# Produces a standalone PowerShell script that, when run, pulls each image
# back to the exact digest it had at checkpoint time.

Write-CLog "Generating rollback script..."

$Lines = @()
$Lines += "#Requires -Version 5.1"
$Lines += "# DockerRescueKit - Image Rollback Script"
$Lines += "# Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$Lines += "#"
$Lines += "# Restores Docker images to the exact versions captured in this checkpoint."
$Lines += "# Images with a registry digest are pulled by digest (bit-for-bit identical)."
$Lines += "# Locally built images are listed but cannot be restored via pull --"
$Lines += "# rebuild them from source."
$Lines += "#"
$Lines += "# Usage:"
$Lines += "#   .\Restore-Images.ps1              - restore all restorable images"
$Lines += "#   .\Restore-Images.ps1 -DryRun      - show what would happen"
$Lines += ""
$Lines += "[CmdletBinding()]"
$Lines += "param([switch]`$DryRun)"
$Lines += ""
$Lines += "`$ErrorActionPreference = 'Continue'"
$Lines += "Write-Host ''"
$Lines += "Write-Host 'DockerRescueKit - Image Rollback'"
$Lines += "Write-Host '-------------------------------------'"
$Lines += "if (`$DryRun) { Write-Host '[DRY RUN] No changes will be made.' }"
$Lines += "Write-Host ''"
$Lines += ""

$RestoredCount = 0
foreach ($Img in $ImageData) {
    if ($Img.IsLocal) {
        $Lines += "# LOCAL BUILD (rebuild from source): $($Img.FullRef)"
        $Lines += "Write-Host 'SKIP (local build): $($Img.FullRef)' -ForegroundColor DarkGray"
    } else {
        $DigestRef = $Img.RegistryDigest
        $FullRef   = $Img.FullRef
        $Lines += "# Restore: $FullRef"
        $Lines += "Write-Host 'Restoring: $FullRef'"
        $Lines += "if (-not `$DryRun) {"
        $Lines += "    docker pull `"$DigestRef`""
        $Lines += "    if (`$LASTEXITCODE -eq 0) {"
        $Lines += "        docker tag `"$DigestRef`" `"$FullRef`""
        $Lines += "        Write-Host '  OK: $FullRef' -ForegroundColor Green"
        $Lines += "    } else {"
        $Lines += "        Write-Host '  FAILED: $FullRef' -ForegroundColor Red"
        $Lines += "    }"
        $Lines += "} else {"
        $Lines += "    Write-Host '  [DRY RUN] Would restore: $FullRef' -ForegroundColor Yellow"
        $Lines += "}"
        $RestoredCount++
    }
    $Lines += ""
}

$Lines += "Write-Host ''"
$Lines += "Write-Host 'Rollback complete. $RestoredCount image(s) can be restored via this script.'"

$Lines | Out-File -FilePath "$SnapDir\Restore-Images.ps1" -Encoding UTF8

# ---- 4. Checkpoint metadata -------------------------------------------------

$Meta = [PSCustomObject]@{
    CheckpointTimestamp    = Get-Date -Format "o"
    ScriptVersion          = "1.0"
    TotalImages            = $ImageData.Count
    TotalContainers        = $ContainerState.Count
    ImagesWithDigest       = $WithDigest
    ImagesLocalOnly        = $LocalOnly
    RestorableImages       = $RestoredCount
    CheckpointDir          = $SnapDir
}

$Meta | ConvertTo-Json |
    Out-File -FilePath "$SnapDir\CHECKPOINT_META.json" -Encoding UTF8

# ---- done -------------------------------------------------------------------

Write-CLog "Checkpoint saved." "SUCCESS"
Write-CLog "  Location:  $SnapDir"
Write-CLog "  Rollback:  $SnapDir\Restore-Images.ps1"
Write-CLog "  Restorable images: $RestoredCount  /  Local-only (not restorable): $LocalOnly"

return $SnapDir
