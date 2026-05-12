#Requires -Version 5.1
<#
.SYNOPSIS
    Start DockerRescueKit locally for development.
    Backend:  http://localhost:42880  (Express, port 42880)
    Frontend: http://localhost:5173   (Vite dev server, proxies /api to backend)
#>

$ErrorActionPreference = 'Stop'
$ROOT   = Split-Path -Parent $PSCommandPath
$DATA   = "$ROOT\.local-data"
$BACKEND_LOG = "$DATA\backend.log"
$VITE_LOG    = "$DATA\vite.log"

# ── Ensure data directory exists ─────────────────────────────────────────────
if (-not (Test-Path $DATA)) {
    New-Item -ItemType Directory -Path $DATA -Force | Out-Null
}

# ── Kill any process already listening on 42880 ───────────────────────────────
Write-Host "[1/5] Clearing port 42880..." -ForegroundColor Cyan
$port42880 = netstat -ano | Select-String ':42880\s' | ForEach-Object {
    ($_ -split '\s+')[-1]
} | Sort-Object -Unique
foreach ($pid in $port42880) {
    if ($pid -match '^\d+$' -and $pid -ne '0') {
        try { Stop-Process -Id ([int]$pid) -Force -ErrorAction SilentlyContinue } catch {}
    }
}

# ── Kill any prior backend node process ───────────────────────────────────────
Write-Host "[2/5] Stopping any existing backend node process..." -ForegroundColor Cyan
Get-WmiObject Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*dist/backend/src/index.js*' -or $_.CommandLine -like '*dist\backend\src\index.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# ── Kill any prior Vite process on 5173 ───────────────────────────────────────
$port5173 = netstat -ano | Select-String ':5173\s' | ForEach-Object {
    ($_ -split '\s+')[-1]
} | Sort-Object -Unique
foreach ($pid in $port5173) {
    if ($pid -match '^\d+$' -and $pid -ne '0') {
        try { Stop-Process -Id ([int]$pid) -Force -ErrorAction SilentlyContinue } catch {}
    }
}

# ── Build backend ─────────────────────────────────────────────────────────────
Write-Host "[3/5] Building backend..." -ForegroundColor Cyan
Push-Location "$ROOT\packages\backend"
try {
    npm run build 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [ERROR] Backend build failed. Check npm run build output manually." -ForegroundColor Red
        exit 1
    }
} finally {
    Pop-Location
}
Write-Host "  Build complete." -ForegroundColor Green

# ── Start backend in background ───────────────────────────────────────────────
Write-Host "[4/5] Starting backend..." -ForegroundColor Cyan
$backendJob = Start-Job -ScriptBlock {
    param($root, $data, $log)
    $env:DRK_DATA_DIR = $data
    $env:PORT         = '42880'
    $env:NODE_ENV     = 'development'
    Set-Location "$root\packages\backend"
    & node dist/backend/src/index.js 2>&1 | Tee-Object -FilePath $log -Append
} -ArgumentList $ROOT, $DATA, $BACKEND_LOG

Write-Host "  Backend job started (log: $BACKEND_LOG)"
Write-Host "  Waiting 2 s for backend to bind..." -ForegroundColor DarkGray
Start-Sleep -Seconds 2

# ── Start Vite dev server in background ───────────────────────────────────────
Write-Host "[5/5] Starting Vite dev server..." -ForegroundColor Cyan
$viteJob = Start-Job -ScriptBlock {
    param($root, $log)
    Set-Location "$root\packages\extension"
    & npx vite --port 5173 2>&1 | Tee-Object -FilePath $log -Append
} -ArgumentList $ROOT, $VITE_LOG

Write-Host "  Vite job started (log: $VITE_LOG)"
Write-Host "  Waiting 2 s for Vite to compile..." -ForegroundColor DarkGray
Start-Sleep -Seconds 2

# ── Open browser ─────────────────────────────────────────────────────────────
Start-Process 'http://localhost:5173'

Write-Host ""
Write-Host "RescueKit started." -ForegroundColor Green
Write-Host "  Backend : http://localhost:42880"
Write-Host "  UI      : http://localhost:5173"
Write-Host ""
Write-Host "Logs:"
Write-Host "  Backend : $BACKEND_LOG"
Write-Host "  Vite    : $VITE_LOG"
Write-Host ""
Write-Host "Run .\stop.ps1 to shut everything down." -ForegroundColor DarkGray
