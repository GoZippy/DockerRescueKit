#Requires -Version 5.1
<#
.SYNOPSIS
    DockerRescueKit - Safe Docker Image Updater with user consent and rollback.

.DESCRIPTION
    Replaces the brute-force "docker pull everything" approach with a workflow
    that protects your project dependencies:

    1. CLASSIFY   - Separates images into local builds (skip), private registries
                    (skip), pinned version tags (warn), and floating tags (update).
    2. FLAG       - Marks images from a curated list of security-critical repos
                    (nginx, postgres, redis, node, etc.) for priority attention.
    3. DETECT     - Scans common directories for docker-compose files and groups
                    images by the project they belong to.
    4. CONSENT    - In interactive sessions shows a menu; you choose what to update.
                    In scheduled/non-interactive sessions only security-flagged
                    floating images are pulled automatically.
    5. CHECKPOINT - Saves current image digests and container state before pulling.
                    Generates a Restore-Images.ps1 rollback script.
    6. PULL       - Pulls only the images you approved.

.PARAMETER LogFile
    Append log output to this file (shared with parent Update-All-WSL.ps1 log).

.PARAMETER CheckpointDir
    Where to save pre-update checkpoints.
    Default: $env:USERPROFILE\Desktop\DockerCheckpoints

.PARAMETER DryRun
    Show what would happen without pulling or saving a checkpoint.

.PARAMETER SecurityOnly
    Non-interactive mode: pull security-flagged floating images only.
    Implied when the session is detected as non-interactive (scheduled task).

.PARAMETER ForceAll
    Pull every pullable image without prompting (skips classification menu).
    Still saves a checkpoint first. Use with care.

.PARAMETER ApproveImages
    Explicit list of image full refs (repo:tag) to pull. Skips the menu.
    Example: -ApproveImages "nginx:alpine","redis:7-alpine"

.PARAMETER SkipCheckpoint
    Skip the pre-update checkpoint. Not recommended -- you lose rollback ability.

.EXAMPLE
    # Interactive run from PowerShell
    .\Invoke-DockerUpdateSafe.ps1

.EXAMPLE
    # Called by Update-All-WSL.ps1 with shared log
    .\Invoke-DockerUpdateSafe.ps1 -LogFile $LogFile -CheckpointDir "C:\Logs\checkpoints"

.EXAMPLE
    # Scheduled task: auto-update security-critical images only
    .\Invoke-DockerUpdateSafe.ps1 -SecurityOnly

.EXAMPLE
    # Approve specific images by name
    .\Invoke-DockerUpdateSafe.ps1 -ApproveImages "nginx:alpine","postgres:16-alpine"
#>

[CmdletBinding()]
param(
    [string]   $LogFile        = "",
    [string]   $CheckpointDir  = "$env:USERPROFILE\Desktop\DockerCheckpoints",
    [switch]   $DryRun,
    [switch]   $SecurityOnly,
    [switch]   $ForceAll,
    [string[]] $ApproveImages  = @(),
    [switch]   $SkipCheckpoint
)

$ErrorActionPreference = "Continue"

# =============================================================================
# CONFIGURATION
# =============================================================================

# Repositories known to carry frequent CVEs or to be security-critical.
# Any image whose base name matches one of these (substring) will be flagged.
$SecurityPriorityRepos = @(
    "nginx", "httpd", "apache",
    "postgres", "postgresql", "mysql", "mariadb", "mongo",
    "redis", "memcached",
    "alpine", "ubuntu", "debian", "centos", "fedora", "rhel",
    "python", "node", "ruby", "php", "golang", "openjdk", "eclipse-temurin",
    "openssh", "openssl",
    "wordpress", "drupal", "joomla",
    "jenkins", "gitlab",
    "vault", "consul",
    "rabbitmq", "kafka"
)

# Tags that mean "give me the current build" -- highest drift and breakage risk.
$FloatingTags = @(
    "latest", "main", "master", "edge", "nightly",
    "stable", "release", "prod", "dev", "next", "canary", "beta"
)

# Directories to scan for docker-compose files (4 levels deep).
$ComposeScanPaths = @(
    $env:USERPROFILE,
    "$env:USERPROFILE\Documents",
    "$env:USERPROFILE\projects",
    "$env:USERPROFILE\dev",
    "$env:USERPROFILE\code",
    "$env:USERPROFILE\repos",
    "$env:USERPROFILE\src",
    "C:\projects",
    "C:\dev",
    "C:\code",
    "C:\repos",
    "C:\src"
)

# =============================================================================
# HELPERS
# =============================================================================

function Write-SLog {
    param(
        [string]       $Message,
        [string]       $Level = "INFO",
        [ConsoleColor] $Color = [ConsoleColor]::White
    )
    $Ts   = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $Line = "[$Ts] [$Level] $Message"
    Write-Host $Line -ForegroundColor $Color
    if ($LogFile) {
        Add-Content -Path $LogFile -Value $Line -ErrorAction SilentlyContinue
    }
}

function Write-SRaw {
    # Write a line to both console and log without a timestamp prefix.
    param([string]$Line, [ConsoleColor]$Color = [ConsoleColor]::White)
    Write-Host $Line -ForegroundColor $Color
    if ($LogFile) {
        Add-Content -Path $LogFile -Value $Line -ErrorAction SilentlyContinue
    }
}

# =============================================================================
# IMAGE INVENTORY
# =============================================================================

function Get-ImageInventory {
    <#
    Returns an array of PSCustomObjects, one per image, with:
      FullRef        - "repo:tag"
      Repository     - image repository path
      Tag            - image tag
      ImageID        - full image ID (sha256:...)
      Age            - human-readable age string from Docker
      Size           - human-readable size from Docker
      RegistryDigest - "repo@sha256:..." if pulled from a registry, else ""
      Class          - LOCAL | PRIVATE | FLOATING | PINNED | STANDARD
      ClassReason    - human-readable explanation of the class
      IsSecPriority  - $true if the image is in the security priority list
      Approved       - starts as $false; set to $true for selected images
    #>

    $Inventory = @()

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

        # --- Registry digest ------------------------------------------------
        $RegistryDigest = ""
        if ($Digest -and $Digest -ne "<none>" -and $Digest -match "sha256:") {
            $RegistryDigest = "${Repo}@${Digest}"
        }

        # --- Extract registry hostname (part before first slash, if it looks like a hostname) ---
        $RegHost = ""
        if ($Repo -match "^([^/]+)/") {
            $Candidate = $Matches[1]
            # A registry hostname contains a dot or a colon (port), or is "localhost"
            if ($Candidate -match "\." -or $Candidate -match ":" -or $Candidate -eq "localhost") {
                $RegHost = $Candidate
            }
        }

        # --- Classification -------------------------------------------------
        $Class  = "STANDARD"
        $Reason = ""

        if (-not $RegistryDigest) {
            $Class  = "LOCAL"
            $Reason = "locally built image (no registry digest)"
        } elseif (
            $RegHost -match "^(\d{1,3}\.){3}\d{1,3}" -or
            $RegHost -eq "localhost" -or
            $RegHost -match "\.local$" -or
            $RegHost -match "\.internal$"
        ) {
            $Class  = "PRIVATE"
            $Reason = "private/local registry ($RegHost)"
        } elseif ($Tag -in $FloatingTags -or $Tag -match "-latest$" -or $Tag -match "^latest-") {
            $Class  = "FLOATING"
            $Reason = "floating tag -- drifts with upstream"
        } elseif ($Tag -match "^\d+(\.\d+){1,3}(-\S+)?$") {
            # Looks like a version: 15.3, 1.27.0, 8.0-alpine, etc.
            $Class  = "PINNED"
            $Reason = "pinned version tag (tag may still be updated by maintainer)"
        } else {
            # Has a digest but is not obviously floating or version-pinned
            $Class  = "FLOATING"
            $Reason = "non-pinned non-version tag"
        }

        # --- Security priority flag -----------------------------------------
        # Match against the last path segment of the repository name.
        $BaseRepo       = $Repo.Split("/")[-1]
        $IsSecPriority  = $false
        foreach ($PrioName in $SecurityPriorityRepos) {
            if ($BaseRepo -like "*${PrioName}*") {
                $IsSecPriority = $true
                break
            }
        }

        $Inventory += [PSCustomObject]@{
            FullRef        = $FullRef
            Repository     = $Repo
            Tag            = $Tag
            ImageID        = $Id
            Age            = $Age
            Size           = $Size
            RegistryDigest = $RegistryDigest
            Class          = $Class
            ClassReason    = $Reason
            IsSecPriority  = $IsSecPriority
            Approved       = $false
        }
    }

    return $Inventory
}

# =============================================================================
# COMPOSE PROJECT DETECTION
# =============================================================================

function Get-ComposeProjects {
    param([string[]] $ImageFullRefs)

    $Projects = @{}

    $ComposeFilenames = @(
        "docker-compose.yml",
        "docker-compose.yaml",
        "compose.yml",
        "compose.yaml"
    )

    $ComposeFiles = @()
    foreach ($ScanPath in $ComposeScanPaths) {
        if (-not (Test-Path $ScanPath -ErrorAction SilentlyContinue)) { continue }
        foreach ($Fname in $ComposeFilenames) {
            $Found = Get-ChildItem -Path $ScanPath -Recurse -Depth 4 `
                -Filter $Fname -ErrorAction SilentlyContinue
            if ($Found) { $ComposeFiles += $Found }
        }
    }

    foreach ($File in $ComposeFiles) {
        $ProjectDir  = Split-Path $File.FullName -Parent
        $ProjectName = Split-Path $ProjectDir -Leaf
        $Content     = Get-Content $File.FullName -ErrorAction SilentlyContinue
        if (-not $Content) { continue }

        # Extract values of "image:" keys via regex.
        # Handles both "  image: nginx:alpine" and "  image: 'nginx:alpine'"
        $ImageLines = $Content | Select-String -Pattern '^\s+image:\s*[''"]?([^''"\s]+)[''"]?'
        $ProjectImages = @()

        foreach ($Match in $ImageLines) {
            $ImgRef = $Match.Matches[0].Groups[1].Value.Trim()
            # Normalise: add :latest if no tag present
            if ($ImgRef -and $ImgRef -notmatch ":") { $ImgRef += ":latest" }
            if ($ImgRef -and $ImageFullRefs -contains $ImgRef) {
                $ProjectImages += $ImgRef
            }
        }

        if ($ProjectImages.Count -gt 0) {
            $Key = $ProjectName
            # Avoid key collision if two compose files share a parent directory name
            if ($Projects.ContainsKey($Key)) {
                $Key = "$ProjectName ($($File.Name))"
            }
            $Projects[$Key] = @($ProjectImages | Select-Object -Unique)
        }
    }

    return $Projects
}

# =============================================================================
# INTERACTIVE MENU
# =============================================================================

function Show-ImageMenu {
    param(
        [object[]]   $Inventory,
        [hashtable]  $ComposeProjects
    )

    $Local    = @($Inventory | Where-Object { $_.Class -eq "LOCAL"   })
    $Private  = @($Inventory | Where-Object { $_.Class -eq "PRIVATE" })
    $Pinned   = @($Inventory | Where-Object { $_.Class -eq "PINNED"  })
    $Floating = @($Inventory | Where-Object { $_.Class -eq "FLOATING" })
    $Pullable = @($Inventory | Where-Object { $_.Class -notin @("LOCAL", "PRIVATE") })
    $SecFlags = @($Inventory | Where-Object { $_.IsSecPriority -and $_.Class -notin @("LOCAL", "PRIVATE") })

    $Sep  = "=" * 62
    $Sep2 = "-" * 58

    Write-Host ""
    Write-SRaw $Sep ([ConsoleColor]::Cyan)
    Write-SRaw "  DockerRescueKit - Smart Docker Image Updater" ([ConsoleColor]::Cyan)
    Write-SRaw $Sep ([ConsoleColor]::Cyan)
    Write-Host ""

    # -- Classification summary -----------------------------------------------
    Write-SRaw "  CLASSIFICATION  ($($Inventory.Count) images total)" ([ConsoleColor]::Yellow)
    Write-SRaw ("  " + $Sep2) ([ConsoleColor]::DarkGray)

    Write-SRaw "  Cannot update (will be skipped):" ([ConsoleColor]::DarkGray)
    if ($Local.Count -gt 0) {
        Write-SRaw "    Local builds:       $($Local.Count)" ([ConsoleColor]::DarkGray)
        foreach ($Img in $Local | Select-Object -First 4) {
            Write-SRaw "      $($Img.FullRef)" ([ConsoleColor]::DarkGray)
        }
        if ($Local.Count -gt 4) {
            Write-SRaw "      ...and $($Local.Count - 4) more" ([ConsoleColor]::DarkGray)
        }
    }
    if ($Private.Count -gt 0) {
        Write-SRaw "    Private registry:   $($Private.Count)" ([ConsoleColor]::DarkGray)
        foreach ($Img in $Private | Select-Object -First 3) {
            Write-SRaw "      $($Img.FullRef)  [$($Img.ClassReason)]" ([ConsoleColor]::DarkGray)
        }
    }

    Write-Host ""
    Write-SRaw "  Pullable images:" ([ConsoleColor]::Green)
    Write-SRaw "    Floating tags (latest/main/etc):  $($Floating.Count)" ([ConsoleColor]::Green)
    Write-SRaw "    Pinned version tags (caution):    $($Pinned.Count)" ([ConsoleColor]::White)
    Write-SRaw "    Total pullable:                   $($Pullable.Count)" ([ConsoleColor]::Green)

    # -- Security flags -------------------------------------------------------
    if ($SecFlags.Count -gt 0) {
        Write-Host ""
        Write-SRaw "  SECURITY PRIORITY FLAGS" ([ConsoleColor]::Red)
        Write-SRaw ("  " + $Sep2) ([ConsoleColor]::DarkGray)
        Write-SRaw "  These images are known to carry frequent CVEs:" ([ConsoleColor]::Red)
        foreach ($Img in $SecFlags) {
            $Tag  = $Img.Class
            $Mark = "[!] $($Img.FullRef.PadRight(45)) $Tag"
            Write-SRaw "  $Mark" ([ConsoleColor]::Red)
        }
    }

    # -- Compose projects -----------------------------------------------------
    $Letters = @()
    if ($ComposeProjects.Count -gt 0) {
        Write-Host ""
        Write-SRaw "  COMPOSE PROJECTS DETECTED" ([ConsoleColor]::Yellow)
        Write-SRaw ("  " + $Sep2) ([ConsoleColor]::DarkGray)

        $LetterCode = 65  # ASCII 'A'
        # Sort keys so the letter assignment is deterministic and matches Resolve-UserSelection.
        foreach ($ProjectKey in ($ComposeProjects.Keys | Sort-Object)) {
            $L      = [char]$LetterCode
            $Imgs   = $ComposeProjects[$ProjectKey]
            $Letters += $L
            Write-SRaw "  [$L] $($ProjectKey.PadRight(30)) $($Imgs.Count) image(s)" ([ConsoleColor]::White)
            foreach ($Img in $Imgs | Select-Object -First 3) {
                Write-SRaw "       $Img" ([ConsoleColor]::DarkGray)
            }
            if ($Imgs.Count -gt 3) {
                Write-SRaw "       ...and $($Imgs.Count - 3) more" ([ConsoleColor]::DarkGray)
            }
            $LetterCode++
        }
    }

    # -- Pinned tag warning ---------------------------------------------------
    if ($Pinned.Count -gt 0) {
        Write-Host ""
        Write-SRaw "  NOTE: Pinned-tag images (e.g. postgres:15.3) may still receive" ([ConsoleColor]::Yellow)
        Write-SRaw "  updated layers if the maintainer republishes the same tag. Pulling" ([ConsoleColor]::Yellow)
        Write-SRaw "  them is generally safe but can change underlying behaviour." ([ConsoleColor]::Yellow)
    }

    # -- Options --------------------------------------------------------------
    Write-Host ""
    Write-SRaw "  UPDATE OPTIONS" ([ConsoleColor]::Yellow)
    Write-SRaw ("  " + $Sep2) ([ConsoleColor]::DarkGray)
    Write-SRaw "  [1] Security-flagged only        ($($SecFlags.Count) images) -- recommended" ([ConsoleColor]::White)
    Write-SRaw "  [2] All floating tags            ($($Floating.Count) images)" ([ConsoleColor]::White)
    Write-SRaw "  [3] All pullable (float+pinned)  ($($Pullable.Count) images)" ([ConsoleColor]::White)
    if ($ComposeProjects.Count -gt 0) {
        Write-SRaw "  [4] By compose project           (choose which projects)" ([ConsoleColor]::White)
    }
    Write-SRaw "  [5] Custom selection             (pick individually)" ([ConsoleColor]::White)
    Write-SRaw "  [6] Skip Docker updates" ([ConsoleColor]::DarkGray)
    Write-Host ""
    Write-SRaw $Sep ([ConsoleColor]::Cyan)

    return @{
        Local    = $Local
        Private  = $Private
        Pinned   = $Pinned
        Floating = $Floating
        Pullable = $Pullable
        SecFlags = $SecFlags
        Letters  = $Letters
    }
}

function Resolve-UserSelection {
    param(
        [hashtable]  $MenuData,
        [hashtable]  $ComposeProjects,
        [object[]]   $Inventory
    )

    $Choice = (Read-Host "  Enter choice (1-6)").Trim()

    switch ($Choice) {
        "1" {
            return @($MenuData.SecFlags)
        }
        "2" {
            return @($MenuData.Floating)
        }
        "3" {
            return @($MenuData.Pullable)
        }
        "4" {
            if ($ComposeProjects.Count -eq 0) {
                Write-Host "  No compose projects detected. Defaulting to option 1." -ForegroundColor Yellow
                return @($MenuData.SecFlags)
            }
            # Sort keys to match the order used by Show-ImageMenu when assigning letters.
            $ProjectKeys = @($ComposeProjects.Keys | Sort-Object)
            Write-Host ""
            Write-Host "  Enter project letters to update (e.g. A,C):" -ForegroundColor Cyan
            $LetterInput = (Read-Host "  Letters").ToUpper()

            $Selected = @()
            foreach ($L in ($LetterInput -split ",")) {
                $L = $L.Trim()
                if (-not $L) { continue }
                $Idx = [int][char]$L - 65
                if ($Idx -ge 0 -and $Idx -lt $ProjectKeys.Count) {
                    $ProjImages    = $ComposeProjects[$ProjectKeys[$Idx]]
                    $ProjFiltered  = @($Inventory | Where-Object {
                        $_.FullRef -in $ProjImages -and $_.Class -notin @("LOCAL", "PRIVATE")
                    })
                    $Selected += $ProjFiltered
                } else {
                    Write-Host "  Unknown project letter: $L (ignored)" -ForegroundColor Yellow
                }
            }
            return $Selected
        }
        "5" {
            $Pullable = @($MenuData.Pullable)
            Write-Host ""
            for ($i = 0; $i -lt $Pullable.Count; $i++) {
                $Flag = if ($Pullable[$i].IsSecPriority) { "[!]" } else { "   " }
                $Line = "  [{0,2}] {1} {2}" -f ($i + 1), $Flag, $Pullable[$i].FullRef
                Write-Host $Line
            }
            Write-Host ""
            Write-Host "  Enter image numbers to update, comma-separated (e.g. 1,3,5)," -ForegroundColor Cyan
            $NumInput = (Read-Host "  or 'all'").Trim()

            if ($NumInput.ToLower() -eq "all") {
                return $Pullable
            }

            $Selected = @()
            foreach ($Token in ($NumInput -split ",")) {
                $Token = $Token.Trim()
                if ($Token -match "^\d+$") {
                    $Idx = [int]$Token - 1
                    if ($Idx -ge 0 -and $Idx -lt $Pullable.Count) {
                        $Selected += $Pullable[$Idx]
                    }
                }
            }
            return $Selected
        }
        "6" {
            return @()
        }
        default {
            Write-Host "  Invalid choice. Skipping Docker updates." -ForegroundColor Yellow
            return @()
        }
    }
}

# =============================================================================
# MAIN EXECUTION
# =============================================================================

Write-SLog ("-" * 55)
Write-SLog "DockerRescueKit - Safe Docker Image Updater"
Write-SLog ("-" * 55)

if ($DryRun) {
    Write-SLog "DRY RUN MODE - no changes will be made." "WARN" ([ConsoleColor]::Yellow)
}

# -- Preflight ----------------------------------------------------------------

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-SLog "docker CLI not found in PATH. Skipping image updates." "WARN"
    exit 0
}

$null = & docker info 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-SLog "Docker daemon not responding. Is Docker Desktop running?" "WARN"
    exit 0
}

# -- Inventory ----------------------------------------------------------------

Write-SLog "Inventorying Docker images..."
$Inventory = @(Get-ImageInventory)

if ($Inventory.Count -eq 0) {
    Write-SLog "No Docker images found locally. Nothing to do." "WARN"
    exit 0
}

Write-SLog "Found $($Inventory.Count) image(s)."

# -- Compose project detection ------------------------------------------------

Write-SLog "Scanning for compose projects..."
$AllRefs        = @($Inventory | ForEach-Object { $_.FullRef })
$ComposeProjects = Get-ComposeProjects -ImageFullRefs $AllRefs

if ($ComposeProjects.Count -gt 0) {
    Write-SLog "Detected $($ComposeProjects.Count) compose project(s) referencing local images."
} else {
    Write-SLog "No compose projects detected in common search paths."
}

# -- Determine update set -----------------------------------------------------

$IsInteractive = [Environment]::UserInteractive -and
                 (-not $ForceAll) -and
                 (-not $SecurityOnly) -and
                 ($ApproveImages.Count -eq 0)

$ToUpdate = @()

if ($ApproveImages.Count -gt 0) {
    # Explicit list passed by caller
    $ToUpdate = @($Inventory | Where-Object {
        $_.FullRef -in $ApproveImages -and $_.Class -notin @("LOCAL", "PRIVATE")
    })
    Write-SLog "Explicit approval list: $($ToUpdate.Count) image(s) queued."

} elseif ($ForceAll) {
    $ToUpdate = @($Inventory | Where-Object { $_.Class -notin @("LOCAL", "PRIVATE") })
    Write-SLog "ForceAll: queuing all $($ToUpdate.Count) pullable image(s)." "WARN"

} elseif ($SecurityOnly -or (-not [Environment]::UserInteractive)) {
    if (-not [Environment]::UserInteractive) {
        Write-SLog "Non-interactive session detected. Auto-selecting security-priority images." "WARN"
    }
    $ToUpdate = @($Inventory | Where-Object {
        $_.IsSecPriority -and $_.Class -notin @("LOCAL", "PRIVATE")
    })
    Write-SLog "Security-only mode: $($ToUpdate.Count) image(s) queued."
    foreach ($Img in $ToUpdate) {
        Write-SLog "  + $($Img.FullRef)  [$($Img.Class)]"
    }

} else {
    # Full interactive menu
    $MenuData = Show-ImageMenu -Inventory $Inventory -ComposeProjects $ComposeProjects
    $ToUpdate = @(Resolve-UserSelection -MenuData $MenuData -ComposeProjects $ComposeProjects -Inventory $Inventory)
}

if ($ToUpdate.Count -eq 0) {
    Write-SLog "No images selected. Skipping Docker image updates."
    exit 0
}

# -- Confirm selection --------------------------------------------------------

Write-Host ""
Write-SRaw "  Selected for update ($($ToUpdate.Count) image(s)):" ([ConsoleColor]::Cyan)
foreach ($Img in $ToUpdate) {
    $Flag = if ($Img.IsSecPriority) { "[!]" } else { "   " }
    Write-SRaw "    $Flag $($Img.FullRef)  [$($Img.Class)]" ([ConsoleColor]::White)
}
Write-Host ""

if ($IsInteractive) {
    $Confirm = Read-Host "  Save a rollback checkpoint and pull these images? [Y/N]"
    if ($Confirm.Trim().ToUpper() -ne "Y") {
        Write-SLog "Update cancelled by user."
        exit 0
    }
}

# -- Pre-update checkpoint ----------------------------------------------------

$CheckpointPath = ""

if (-not $SkipCheckpoint -and -not $DryRun) {
    Write-SLog "Saving pre-update checkpoint (rollback will be available if something breaks)..."

    $CheckpointScript = Join-Path $PSScriptRoot "New-DockerCheckpoint.ps1"

    if (Test-Path $CheckpointScript) {
        $CheckpointPath = & $CheckpointScript -CheckpointDir $CheckpointDir -LogFile $LogFile
        if ($CheckpointPath) {
            Write-SLog "Checkpoint saved: $CheckpointPath" "SUCCESS"
        } else {
            Write-SLog "Checkpoint failed to save. Proceeding without rollback capability." "WARN"
        }
    } else {
        Write-SLog "New-DockerCheckpoint.ps1 not found at: $CheckpointScript" "WARN"
        Write-SLog "Proceeding without checkpoint. Place New-DockerCheckpoint.ps1 in the same folder." "WARN"
    }
} elseif ($SkipCheckpoint) {
    Write-SLog "Checkpoint skipped (-SkipCheckpoint)." "WARN"
} elseif ($DryRun) {
    Write-SLog "[DRY RUN] Would create checkpoint in: $CheckpointDir"
}

# -- Pull approved images -----------------------------------------------------

$Pulled  = @()
$Failed  = @()
$Skipped = @()

foreach ($Img in $ToUpdate) {
    if ($DryRun) {
        Write-SLog "  [DRY RUN] Would pull: $($Img.FullRef)" "WARN" ([ConsoleColor]::Yellow)
        $Skipped += $Img.FullRef
        continue
    }

    Write-SLog "  Pulling: $($Img.FullRef)"
    & docker pull $Img.FullRef 2>&1 | ForEach-Object {
        $Line = "  [docker] $($_.ToString())"
        Write-Host $Line -ForegroundColor DarkCyan
        if ($LogFile) {
            Add-Content -Path $LogFile -Value $Line -ErrorAction SilentlyContinue
        }
    }

    if ($LASTEXITCODE -eq 0) {
        $Pulled += $Img.FullRef
        Write-SLog "  Updated: $($Img.FullRef)" "SUCCESS" ([ConsoleColor]::Green)
    } else {
        $Failed += $Img.FullRef
        Write-SLog "  Could not pull $($Img.FullRef) (exit $LASTEXITCODE)" "WARN" ([ConsoleColor]::Yellow)
    }
}

# -- Check for running containers that use updated images ---------------------

if ($Pulled.Count -gt 0) {
    $RunningOnUpdated = @()
    $RunningRaw = & docker ps --format "{{.Names}}|{{.Image}}" 2>&1
    foreach ($RawLine in $RunningRaw) {
        $Parts = ($RawLine -replace "`0", "").Trim() -split '\|'
        if ($Parts.Count -lt 2) { continue }
        $CName  = $Parts[0].Trim()
        $CImage = $Parts[1].Trim()
        # Normalise: add :latest if no tag
        if ($CImage -notmatch ":") { $CImage += ":latest" }
        if ($Pulled -contains $CImage) {
            $RunningOnUpdated += "$CName (uses $CImage)"
        }
    }

    if ($RunningOnUpdated.Count -gt 0) {
        Write-Host ""
        Write-SLog "  ATTENTION: Running containers using updated images:" "WARN" ([ConsoleColor]::Yellow)
        Write-SLog "  These containers are still running on the OLD image layer." "WARN" ([ConsoleColor]::Yellow)
        Write-SLog "  Restart them to pick up the update." "WARN" ([ConsoleColor]::Yellow)
        foreach ($C in $RunningOnUpdated) {
            Write-SLog "    $C" "WARN" ([ConsoleColor]::Yellow)
        }
    }
}

# -- Summary ------------------------------------------------------------------

Write-Host ""
Write-SLog ("=" * 55)
Write-SLog "DOCKER UPDATE SUMMARY"
Write-SLog ("=" * 55)
Write-SLog "  Pulled (updated):   $($Pulled.Count)"
Write-SLog "  Failed:             $($Failed.Count)"
Write-SLog "  Skipped (dry-run):  $($Skipped.Count)"

if ($Failed.Count -gt 0) {
    Write-SLog "  Failed images:" "WARN"
    foreach ($F in $Failed) {
        Write-SLog "    $F" "WARN"
    }
    Write-SLog "  Common causes: registry unreachable, private registry HTTP/HTTPS" "WARN"
    Write-SLog "  mismatch, or images that no longer exist upstream." "WARN"
}

if ($CheckpointPath) {
    Write-SLog "  Rollback: $CheckpointPath\Restore-Images.ps1"
    Write-SLog "  Run the rollback script if you need to revert to prior image versions."
}

Write-SLog ("=" * 55)
