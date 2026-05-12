# Docker Complete Backup Snapshot Script for Windows PowerShell
# Creates timestamped backups of all volumes, containers, images, and settings
# Usage: .\backup-docker-snapshot.ps1 -BackupPath "C:\docker-backups"

param(
    [string]$BackupPath = "C:\docker-backups",
    [string]$BackupName = "docker-snapshot-$(Get-Date -Format 'yyyy-MM-dd_HH-mm-ss')"
)

$SnapshotDir = Join-Path $BackupPath $BackupName
New-Item -ItemType Directory -Path $SnapshotDir -Force | Out-Null

Write-Host "=== Docker Complete Snapshot Backup ===" -ForegroundColor Cyan
Write-Host "Backup location: $SnapshotDir" -ForegroundColor Green

# 1. Export all containers (running and stopped)
Write-Host "`n[1/6] Exporting container configurations..." -ForegroundColor Yellow
$ContainerDir = Join-Path $SnapshotDir "containers"
New-Item -ItemType Directory -Path $ContainerDir -Force | Out-Null

docker ps -a --format "{{json . }}" | ForEach-Object {
    $Container = $_ | ConvertFrom-Json
    $ContainerId = $Container.ID
    $ContainerName = $Container.Names
    
    # Export inspect data
    docker inspect $ContainerId | Out-File -FilePath "$ContainerDir\$ContainerName-inspect.json"
    
    # Export running containers as commit (image snapshot)
    if ($Container.State -eq "running") {
        $ImageName = "backup-$ContainerName-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Write-Host "  Committing running container: $ContainerName -> $ImageName"
        docker commit $ContainerId $ImageName 2>&1 | Out-Null
    }
}
Write-Host "  Exported $($(docker ps -a --format '{{.Names}}' | Measure-Object -Line).Lines) containers" -ForegroundColor Green

# 2. Export all images
Write-Host "`n[2/6] Exporting Docker images..." -ForegroundColor Yellow
$ImagesDir = Join-Path $SnapshotDir "images"
New-Item -ItemType Directory -Path $ImagesDir -Force | Out-Null

docker images --format "table {{.Repository}}:{{.Tag}}\t{{.ID}}" --no-trunc | Select-Object -Skip 1 | ForEach-Object {
    $ImageName = $_.Split("`t")[0]
    $ImageId = $_.Split("`t")[1]
    if ($ImageName -ne "<none>:<none>") {
        Write-Host "  Saving image: $ImageName"
        $SafeName = $ImageName -replace '[/:?*"<>|]', '-'
        docker save $ImageName -o "$ImagesDir\$SafeName.tar" 2>&1 | Out-Null
    }
}

# 3. Backup all volumes
Write-Host "`n[3/6] Backing up all volumes..." -ForegroundColor Yellow
$VolumesDir = Join-Path $SnapshotDir "volumes"
New-Item -ItemType Directory -Path $VolumesDir -Force | Out-Null

docker volume ls --format "{{.Name}}" | ForEach-Object {
    $VolumeName = $_
    Write-Host "  Backing up volume: $VolumeName"
    
    # Create temporary container to access volume
    $TempContainer = "backup-temp-$(New-Guid)"
    docker create --name $TempContainer -v "${VolumeName}:/volume-data" alpine | Out-Null
    
    # Tar the volume contents
    $SafeVolumeName = $VolumeName -replace '[/:?*"<>|]', '-'
    docker cp "${TempContainer}:/volume-data/." "$VolumesDir\$SafeVolumeName" 2>&1 | Out-Null
    
    # Cleanup temp container
    docker rm $TempContainer | Out-Null
}
Write-Host "  Backed up $($(docker volume ls --format '{{.Name}}' | Measure-Object -Line).Lines) volumes" -ForegroundColor Green

# 4. Export Docker networks
Write-Host "`n[4/6] Exporting Docker networks..." -ForegroundColor Yellow
$NetworksDir = Join-Path $SnapshotDir "networks"
New-Item -ItemType Directory -Path $NetworksDir -Force | Out-Null

docker network ls --format "{{json . }}" | ForEach-Object {
    $Network = $_ | ConvertFrom-Json
    $NetworkName = $Network.Name
    docker network inspect $NetworkName | Out-File -FilePath "$NetworksDir\$NetworkName.json"
}
Write-Host "  Exported $($(docker network ls --format '{{.Name}}' | Measure-Object -Line).Lines) networks" -ForegroundColor Green

# 5. Backup Docker daemon settings
Write-Host "`n[5/6] Backing up Docker daemon settings..." -ForegroundColor Yellow
$SettingsDir = Join-Path $SnapshotDir "settings"
New-Item -ItemType Directory -Path $SettingsDir -Force | Out-Null

# Copy Docker Desktop config
$DockerConfigPath = "$env:APPDATA\Docker\settings.json"
if (Test-Path $DockerConfigPath) {
    Copy-Item $DockerConfigPath -Destination "$SettingsDir\docker-settings.json"
}

# Export daemon.json
$DaemonPath = "$env:USERPROFILE\.docker\daemon.json"
if (Test-Path $DaemonPath) {
    Copy-Item $DaemonPath -Destination "$SettingsDir\daemon.json"
}

# Export system info
docker info | Out-File -FilePath "$SettingsDir\docker-info.txt"
Write-Host "  Backed up Docker configuration files" -ForegroundColor Green

# 6. Create metadata and restore script
Write-Host "`n[6/6] Creating restore script and metadata..." -ForegroundColor Yellow

$Metadata = @{
    BackupDate = Get-Date -Format 'o'
    BackupVersion = "1.0"
    DockerVersion = $(docker version --format '{{.Server.Version}}')
    WindowsVersion = [System.Environment]::OSVersion.VersionString
    TotalContainers = $(docker ps -a --format '{{.Names}}' | Measure-Object -Line).Lines
    TotalVolumes = $(docker volume ls --format '{{.Name}}' | Measure-Object -Line).Lines
    TotalImages = $(docker images --format '{{.Repository}}' | Measure-Object -Line).Lines
} | ConvertTo-Json

$Metadata | Out-File -FilePath "$SnapshotDir\BACKUP_METADATA.json"

# Create restore script
$RestoreScript = @'
# Docker Restore Script - Generated automatically
# WARNING: This will restore containers, volumes, and images to the state at backup time
# Usage: .\restore-docker-snapshot.ps1 -SnapshotPath "C:\docker-backups\docker-snapshot-xxx"

param(
    [string]$SnapshotPath = $(throw "SnapshotPath is required"),
    [switch]$DryRun = $false
)

function Log {
    param([string]$Message, [string]$Color = "White")
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $Message" -ForegroundColor $Color
}

Log "=== Docker Restore from Snapshot ===" "Cyan"
Log "Snapshot: $SnapshotPath" "Green"

if ($DryRun) {
    Log "DRY-RUN MODE: No changes will be made" "Yellow"
}

if (-not (Test-Path $SnapshotPath)) {
    Log "ERROR: Snapshot path does not exist: $SnapshotPath" "Red"
    exit 1
}

# Load metadata
$Metadata = Get-Content "$SnapshotPath\BACKUP_METADATA.json" | ConvertFrom-Json
Log "Backup created: $($Metadata.BackupDate)" "Cyan"
Log "Containers: $($Metadata.TotalContainers) | Volumes: $($Metadata.TotalVolumes) | Images: $($Metadata.TotalImages)" "Cyan"

# 1. Restore volumes
if (Test-Path "$SnapshotPath\volumes") {
    Log "`n[1/4] Restoring volumes..." "Yellow"
    Get-ChildItem "$SnapshotPath\volumes" -Directory | ForEach-Object {
        $VolumeName = $_.Name
        Log "  Restoring volume: $VolumeName"
        
        # Create volume if it doesn't exist
        if (-not $DryRun) {
            docker volume create $VolumeName 2>&1 | Out-Null
            
            # Copy data back
            $TempContainer = "restore-temp-$(New-Guid)"
            docker create --name $TempContainer -v "${VolumeName}:/volume-data" alpine | Out-Null
            docker cp "$($_.FullName)/." "${TempContainer}:/volume-data/" 2>&1 | Out-Null
            docker rm $TempContainer | Out-Null
        }
    }
}

# 2. Restore images
if (Test-Path "$SnapshotPath\images") {
    Log "`n[2/4] Restoring Docker images..." "Yellow"
    Get-ChildItem "$SnapshotPath\images" -Filter "*.tar" | ForEach-Object {
        Log "  Loading image: $($_.Name)"
        if (-not $DryRun) {
            docker load -i $_.FullName 2>&1 | Out-Null
        }
    }
}

# 3. Restore networks
if (Test-Path "$SnapshotPath\networks") {
    Log "`n[3/4] Restoring networks..." "Yellow"
    Get-ChildItem "$SnapshotPath\networks" -Filter "*.json" | ForEach-Object {
        $NetworkConfig = Get-Content $_.FullName | ConvertFrom-Json
        $NetworkName = $NetworkConfig.Name
        
        if ($NetworkName -notin @("bridge", "host", "none")) {
            Log "  Creating network: $NetworkName (Driver: $($NetworkConfig.Driver))"
            if (-not $DryRun) {
                docker network create --driver $NetworkConfig.Driver $NetworkName 2>&1 | Out-Null
            }
        }
    }
}

# 4. Restore containers
if (Test-Path "$SnapshotPath\containers") {
    Log "`n[4/4] Container configs restored - manual recreation required" "Yellow"
    Log "  Review container configs in: $SnapshotPath\containers" "White"
    Log "  Use: docker create ... to recreate with same settings" "White"
    Log "  Committed images are available as: backup-<container-name>-*" "White"
}

Log "`n✓ Restore complete!" "Green"
if ($DryRun) {
    Log "DRY-RUN: No actual restore performed" "Yellow"
}
'@

$RestoreScript | Out-File -FilePath "$SnapshotDir\RESTORE.ps1"

# Create index file
$IndexContent = @"
Docker Backup Snapshot Index
=============================
Created: $(Get-Date -Format 'o')
Location: $SnapshotDir

Contents:
  /containers/       - Container configs and committed images (inspect JSON)
  /volumes/          - All volume data directories
  /images/           - Docker image tar archives
  /networks/         - Network configurations
  /settings/         - Docker daemon and Desktop settings
  BACKUP_METADATA.json - Backup details and statistics
  RESTORE.ps1        - Automated restore script

To restore:
  1. Ensure Docker is running
  2. Run: .\RESTORE.ps1 -SnapshotPath "$SnapshotDir"
  3. For dry-run: .\RESTORE.ps1 -SnapshotPath "$SnapshotDir" -DryRun

Disaster Recovery:
  Even if 'docker system prune -a --force' is run, you can:
  1. Restore images from /images/ directory
  2. Restore volumes from /volumes/ directory
  3. Restore networks and configs from JSON files
  4. Recreate containers from /containers/ configs

WARNING: Store this backup in a SAFE location outside Docker's control!
Recommended: External drive, cloud storage, or version control.
"@

$IndexContent | Out-File -FilePath "$SnapshotDir\README.txt"

Write-Host "`n✓ Snapshot backup complete!" -ForegroundColor Green
Write-Host "Backup location: $SnapshotDir" -ForegroundColor Green
Write-Host "`nTo restore: .\RESTORE.ps1 -SnapshotPath `"$SnapshotDir`"" -ForegroundColor Cyan
Write-Host "For dry-run: .\RESTORE.ps1 -SnapshotPath `"$SnapshotDir`" -DryRun" -ForegroundColor Cyan
