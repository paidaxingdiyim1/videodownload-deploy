# Web Video Downloader - local server launcher (PowerShell)
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  $candidates = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
  )
  $node = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $node) {
  Write-Host "[ERROR] Node.js not found. Install Node.js 18+ from https://nodejs.org/" -ForegroundColor Red
  Read-Host "Press Enter to exit"
  exit 1
}
Write-Host "Starting local download service ..." -ForegroundColor Cyan
& $node.Source "server\src\server.js"
Write-Host ""
Write-Host "Service exited. Read the messages above for details." -ForegroundColor Yellow
Read-Host "Press Enter to exit"
