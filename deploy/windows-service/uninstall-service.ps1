# Stop and remove the WebVideoDownloader persistent service (Task Scheduler).
# Run in an ADMIN PowerShell:  powershell -ExecutionPolicy Bypass -File uninstall-service.ps1

schtasks /End /TN "WebVideoDownloader" 2>$null
schtasks /Delete /TN "WebVideoDownloader" /F
if ($LASTEXITCODE -eq 0) {
  Write-Host "Service 'WebVideoDownloader' removed."
} else {
  Write-Host "Task not found (already removed?)."
}

# Optional: remove the firewall rule too. Uncomment to apply.
# netsh advfirewall firewall delete rule name="WebVideoDownloader" | Out-Null
