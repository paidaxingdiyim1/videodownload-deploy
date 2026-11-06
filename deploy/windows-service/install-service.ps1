# Install the downloader backend as a persistent Windows service
# using Task Scheduler (SYSTEM account, starts at boot, no console window).
# Run in an ADMIN PowerShell:  powershell -ExecutionPolicy Bypass -File install-service.ps1
# Logs: logs\server.log under the project directory.

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # deploy/windows-service -> repo root
Write-Host "Project directory: $repo"

# ---- locate node.exe (same lookup order as start.bat) ----
$node = $null
foreach ($p in @(
  "$env:ProgramFiles\nodejs\node.exe",
  "${env:ProgramFiles(x86)}\nodejs\node.exe",
  "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
)) { if (Test-Path $p) { $node = $p; break } }
if (-not $node) {
  $n = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($n) { $node = $n.Source }
}
if (-not $node) {
  Write-Error "node.exe not found. Install Node.js 18+ first."
}
Write-Host "Node: $node"

# ---- firewall rule for the service port (idempotent) ----
netsh advfirewall firewall show rule name="WebVideoDownloader" | Out-Null
if ($LASTEXITCODE -ne 0) {
  netsh advfirewall firewall add rule name="WebVideoDownloader" dir=in action=allow protocol=TCP localport=8765 | Out-Null
  Write-Host "Firewall rule 'WebVideoDownloader' added (TCP 8765)."
}

# ---- register the scheduled task (SYSTEM, at boot, highest privileges) ----
$cmd = 'cmd /c cd /d "{0}" && "{1}" server\src\server.js --host=0.0.0.0 --no-open' -f $repo, $node
schtasks /Create /TN "WebVideoDownloader" /SC ONSTART /RU SYSTEM /RL HIGHEST /TR $cmd /F
if ($LASTEXITCODE -ne 0) { Write-Error "schtasks /Create failed (run as Administrator)." }

# ---- start it right away (no need to reboot) ----
schtasks /Run /TN "WebVideoDownloader"
Start-Sleep -Seconds 3

$health = $null
try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:8765/api/health" -TimeoutSec 5 } catch {}
if ($health -and $health.ok) {
  Write-Host ""
  Write-Host "Service is RUNNING as a persistent background service."
  $cfgPath = Join-Path $repo 'server\config.json'
  if (Test-Path $cfgPath) {
    $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
    Write-Host ("  Token : {0}   <- configure this in the extension" -f $cfg.token)
  }
} else {
  Write-Host ""
  Write-Host "Task registered. Health check did not respond yet."
  Write-Host "Check logs\server.log for the Token and any errors."
}
Write-Host "Uninstall with: uninstall-service.ps1"
