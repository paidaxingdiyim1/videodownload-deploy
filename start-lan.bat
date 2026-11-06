@echo off
chcp 65001 >nul
title Web Video Downloader - LAN Server
cd /d "%~dp0"

rem ---- pick node.exe (portable installs first, then PATH) ----
set "NODE_EXE=node"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if exist "%%D\node.exe" set "NODE_EXE=%%D\node.exe"

rem ---- open firewall for the service port (idempotent; delete the rule to undo) ----
netsh advfirewall firewall show rule name="WebVideoDownloader" >nul 2>&1
if errorlevel 1 netsh advfirewall firewall add rule name="WebVideoDownloader" dir=in action=allow protocol=TCP localport=8765 >nul 2>&1

rem ---- bind all interfaces so other LAN machines can reach the service ----
echo Starting in LAN mode: http://SERVER-NAME:8765 (token required)
"%NODE_EXE%" "server\src\server.js" --host=0.0.0.0

echo.
echo ------------------------------------------------------------------
echo Service exited (code %ERRORLEVEL%).
echo If the port changed in the log above, update the extension settings.
echo ------------------------------------------------------------------
pause
