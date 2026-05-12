@echo off
:: ============================================================
::  DockerRescueKit - WSL ^& Docker Security Updater Launcher
::  Double-click this file to run Update-All-WSL.ps1
::  It will automatically request Administrator privileges.
:: ============================================================

:: Check if already running as admin
net session >nul 2>&1
if %errorLevel% == 0 (
    goto :run
)

:: Not admin - re-launch elevated via PowerShell UAC prompt
echo Requesting Administrator privileges...
powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b

:run
:: Set the script directory (same folder as this .bat file)
set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%Update-All-WSL.ps1"

if not exist "%PS_SCRIPT%" (
    echo ERROR: Could not find Update-All-WSL.ps1 in:
    echo   %SCRIPT_DIR%
    echo.
    echo Make sure this .bat file is in the same folder as Update-All-WSL.ps1
    pause
    exit /b 1
)

echo.
echo ============================================================
echo  DockerRescueKit - WSL ^& Docker Security Updater
echo ============================================================
echo  Script : %PS_SCRIPT%
echo  Running as Administrator
echo ============================================================
echo.

:: Run the PowerShell script with bypass execution policy
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"

echo.
echo ============================================================
echo  Script finished. Press any key to close this window.
echo ============================================================
pause >nul
