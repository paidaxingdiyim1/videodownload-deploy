# Register the "wvdplay://" protocol so the browser extension can hand a
# video URL (or local file) to PotPlayer on this computer.
#
#   Install : powershell -ExecutionPolicy Bypass -File install-potplayer-handler.ps1
#   Uninstall: powershell -ExecutionPolicy Bypass -File install-potplayer-handler.ps1 -Uninstall
#   Custom  : ... -PotPlayerPath "C:\path\to\PotPlayerMini64.exe"
#
# After running once, the extension's "PotPlayer" button will open videos here.

param(
  [string]$PotPlayerPath = "",
  [switch]$Uninstall
)

$proto = "wvdplay"
$keyPath = "HKCU:\Software\Classes\$proto"

if ($Uninstall) {
  if (Test-Path $keyPath) {
    Remove-Item -Path $keyPath -Recurse -Force
    Write-Host "Protocol '$proto://' removed."
  } else {
    Write-Host "Protocol '$proto://' not registered."
  }
  $h = Join-Path $env:APPDATA "wvd-play\handler.ps1"
  if (Test-Path $h) { Remove-Item $h -Force }
  exit 0
}

# ---- locate PotPlayer ----
$candidates = @()
if ($PotPlayerPath) { $candidates += $PotPlayerPath }
$candidates += @(
  "$env:ProgramFiles\DAUM\PotPlayer\PotPlayerMini64.exe",
  "${env:ProgramFiles(x86)}\DAUM\PotPlayer\PotPlayerMini.exe",
  "$env:ProgramFiles\DAUM\PotPlayer\PotPlayerMini.exe",
  "$env:LOCALAPPDATA\Programs\PotPlayer\PotPlayerMini64.exe"
)
foreach ($k in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\PotPlayerMini64.exe','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\PotPlayerMini64.exe')) {
  try { $p = (Get-ItemProperty $k -ErrorAction SilentlyContinue).'(default)'; if ($p -and (Test-Path $p)) { $candidates += $p } } catch {}
}

$pp = $null
foreach ($c in $candidates) {
  if ($c -and (Test-Path $c)) { $pp = $c; break }
}
if (-not $pp) {
  Write-Host "PotPlayer not found in common locations."
  Write-Host "Re-run with -PotPlayerPath \"C:\path\to\PotPlayerMini64.exe\""
  exit 1
}
Write-Host "PotPlayer: $pp"

# ---- write a small handler that strips the scheme and launches PotPlayer ----
$dir = Join-Path $env:APPDATA "wvd-play"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$handler = Join-Path $dir "handler.ps1"
$handlerContent = @'
param([string]$arg)
$u = $arg -replace '^wvdplay:', ''
$u = [System.Uri]::UnescapeDataString($u)
if ($u -like 'file:/*') { $u = $u -replace '^file:/', '' -replace '/', '\' }
$pp = 'PPPLACEHOLDER'
Start-Process -FilePath $pp -ArgumentList ('"' + $u + '"')
'@
$handlerContent = $handlerContent -replace 'PPPLACEHOLDER', ($pp -replace '\\', '\\')
Set-Content -Path $handler -Value $handlerContent -Encoding ASCII

# ---- register protocol (HKCU, no admin needed) ----
New-Item -Path $keyPath -Force | Out-Null
Set-ItemProperty -Path $keyPath -Name "(default)" -Value "URL:Web Video Downloader Play Protocol"
Set-ItemProperty -Path $keyPath -Name "URL Protocol" -Value ""
$cmdKey = "$keyPath\shell\open\command"
New-Item -Path $cmdKey -Force | Out-Null
$cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$handler`" `"%1`""
Set-ItemProperty -Path $cmdKey -Name "(default)" -Value $cmd

Write-Host ""
Write-Host "Done. The extension's 'PotPlayer' button will now open videos with PotPlayer."
