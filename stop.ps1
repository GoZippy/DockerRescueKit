#Requires -Version 5.1
<#
.SYNOPSIS
    Stop all DockerRescueKit local dev processes.
#>

$ErrorActionPreference = 'SilentlyContinue'

Write-Host "Stopping RescueKit..." -ForegroundColor Cyan

# ── Kill backend process on 42880 ─────────────────────────────────────────────
Write-Host "  Clearing port 42880 (backend)..."
$pids42880 = netstat -ano | Select-String ':42880\s' | ForEach-Object {
    ($_ -split '\s+')[-1]
} | Sort-Object -Unique
foreach ($pid in $pids42880) {
    if ($pid -match '^\d+$' -and $pid -ne '0') {
        Stop-Process -Id ([int]$pid) -Force -ErrorAction SilentlyContinue
    }
}

# ── Kill any node process matching the backend entry point ────────────────────
Get-WmiObject Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*dist/backend/src/index.js*' -or $_.CommandLine -like '*dist\backend\src\index.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# ── Kill Vite process on 5173 ─────────────────────────────────────────────────
Write-Host "  Clearing port 5173 (Vite)..."
$pids5173 = netstat -ano | Select-String ':5173\s' | ForEach-Object {
    ($_ -split '\s+')[-1]
} | Sort-Object -Unique
foreach ($pid in $pids5173) {
    if ($pid -match '^\d+$' -and $pid -ne '0') {
        Stop-Process -Id ([int]$pid) -Force -ErrorAction SilentlyContinue
    }
}

# ── Clean up any lingering PowerShell background jobs ─────────────────────────
Get-Job | Where-Object { $_.State -in 'Running','Suspended' } | Stop-Job -PassThru | Remove-Job

Write-Host ""
Write-Host "RescueKit stopped." -ForegroundColor Green
