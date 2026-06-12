# check-rclone.ps1 — detect rclone and, if missing, recommend (or run) the
# right install for this Windows machine. rclone is the third-party tool DRK
# uses to reach cloud storage (Google Drive, OneDrive, Dropbox, S3, B2, ...).
#
# This script touches NOTHING unless you pass -Install. By default it just
# reports what it found and prints the command you'd run.
#
# Usage:
#   pwsh ./tools/check-rclone.ps1            # report only
#   pwsh ./tools/check-rclone.ps1 -Install   # detect a package manager and install
#
# Exit codes: 0 = rclone present (or installed), 1 = missing and not installed.

[CmdletBinding()]
param(
  [switch]$Install
)

$ErrorActionPreference = 'Stop'

function Test-Cmd($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

Write-Host "Checking for rclone..." -ForegroundColor Cyan

if (Test-Cmd 'rclone') {
  $version = (rclone version | Select-Object -First 1)
  Write-Host "[OK] rclone is installed: $version" -ForegroundColor Green
  Write-Host "     You're all set. In DRK: Integrations -> Manage remotes." -ForegroundColor Green
  exit 0
}

Write-Host "[--] rclone was not found on PATH." -ForegroundColor Yellow
Write-Host ""

# Pick the best available installer, in order of preference.
$method = $null
if (Test-Cmd 'winget') { $method = @{ Name = 'winget'; Cmd = 'winget install -e --id Rclone.Rclone' } }
elseif (Test-Cmd 'scoop') { $method = @{ Name = 'scoop'; Cmd = 'scoop install rclone' } }
elseif (Test-Cmd 'choco') { $method = @{ Name = 'choco'; Cmd = 'choco install rclone -y' } }

if ($method) {
  Write-Host "Recommended install ($($method.Name)):" -ForegroundColor Cyan
  Write-Host "    $($method.Cmd)" -ForegroundColor White
} else {
  Write-Host "No supported package manager (winget/scoop/choco) was found." -ForegroundColor Yellow
  Write-Host "Download the Windows zip from https://rclone.org/downloads/ and add it to PATH," -ForegroundColor White
  Write-Host "or install winget from the Microsoft Store ('App Installer') and re-run with -Install." -ForegroundColor White
}
Write-Host ""

if ($Install -and $method) {
  Write-Host "Installing rclone via $($method.Name)..." -ForegroundColor Cyan
  Invoke-Expression $method.Cmd
  if (Test-Cmd 'rclone') {
    Write-Host "[OK] rclone installed: $(rclone version | Select-Object -First 1)" -ForegroundColor Green
    exit 0
  }
  Write-Host "[!!] Install ran but rclone still isn't on PATH — open a new terminal and re-check." -ForegroundColor Yellow
  exit 1
}

if ($Install -and -not $method) {
  Write-Host "[!!] -Install needs winget, scoop, or choco. None were found." -ForegroundColor Yellow
}

Write-Host "Tip: cautious admins can verify the download's SHA-256 against the published" -ForegroundColor DarkGray
Write-Host "     SHA256SUMS on rclone.org before installing. Package managers verify for you." -ForegroundColor DarkGray
exit 1
