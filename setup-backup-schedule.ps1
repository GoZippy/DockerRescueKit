# Docker Automated Backup Scheduler for Windows Task Scheduler
# Run this once to set up daily backups at 2 AM
# Usage: .\setup-backup-schedule.ps1

param(
    [string]$BackupPath = "C:\docker-backups",
    [string]$ScriptPath = "C:\docker-tools",
    [string]$ScheduleTime = "02:00:00",
    [string]$TaskName = "Docker-Complete-Backup"
)

Write-Host "=== Docker Backup Scheduler Setup ===" -ForegroundColor Cyan

# Ensure paths exist
New-Item -ItemType Directory -Path $BackupPath -Force | Out-Null
New-Item -ItemType Directory -Path $ScriptPath -Force | Out-Null

# Copy backup script
if (-not (Test-Path "$ScriptPath\backup-docker-snapshot.ps1")) {
    Write-Host "ERROR: backup-docker-snapshot.ps1 not found in current directory" -ForegroundColor Red
    exit 1
}
Copy-Item ".\backup-docker-snapshot.ps1" -Destination "$ScriptPath\" -Force

Write-Host "Backup script location: $ScriptPath\backup-docker-snapshot.ps1" -ForegroundColor Green
Write-Host "Backup storage: $BackupPath" -ForegroundColor Green
Write-Host "Schedule: Daily at $ScheduleTime" -ForegroundColor Green

# Create wrapper script that Task Scheduler can run
$WrapperScript = @"
# Task Scheduler wrapper - runs as SYSTEM user
`$BackupPath = "$BackupPath"
& "$ScriptPath\backup-docker-snapshot.ps1" -BackupPath `$BackupPath
"@

$WrapperScript | Out-File -FilePath "$ScriptPath\run-backup.ps1"

# Create scheduled task
Write-Host "`nCreating scheduled task..." -ForegroundColor Yellow

# Remove existing task if present
$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($ExistingTask) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed existing task: $TaskName" -ForegroundColor Yellow
}

# Create task action
$Action = New-ScheduledTaskAction `
    -Execute "PowerShell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath\run-backup.ps1`""

# Create trigger (daily at specified time)
$Trigger = New-ScheduledTaskTrigger `
    -Daily `
    -At $ScheduleTime

# Create task settings
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

# Register task
Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Description "Docker Complete Backup - Automatic daily snapshot" `
    -Force | Out-Null

Write-Host "✓ Scheduled task created: $TaskName" -ForegroundColor Green
Write-Host "✓ Backup directory: $BackupPath" -ForegroundColor Green
Write-Host "`nTo test now: & '$ScriptPath\backup-docker-snapshot.ps1' -BackupPath '$BackupPath'" -ForegroundColor Cyan
Write-Host "To view task: Get-ScheduledTask -TaskName '$TaskName'" -ForegroundColor Cyan
Write-Host "To disable: Disable-ScheduledTask -TaskName '$TaskName'" -ForegroundColor Cyan

# Create retention policy
Write-Host "`nTip: Use this to auto-delete backups older than 30 days:" -ForegroundColor Cyan
Write-Host "Get-ChildItem '$BackupPath' -Directory | Where-Object {`$_.CreationTime -lt (Get-Date).AddDays(-30)} | Remove-Item -Recurse -Force" -ForegroundColor White
