@echo off
chcp 65001 >nul
title Web Video Downloader - Local Server
cd /d "%~dp0"

rem ---- pick node.exe (portable installs first, then PATH) ----
set "NODE_EXE=node"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if exist "%%D\node.exe" set "NODE_EXE=%%D\node.exe"

rem ---- sanity check ----
if not exist "server\src\server.js" echo [ERROR] server\src\server.js not found. Keep start.bat in the project root.

"%NODE_EXE%" "server\src\server.js"

echo.
echo ------------------------------------------------------------------
echo Service exited (code %ERRORLEVEL%).
echo If you saw "node is not recognized" above, install Node.js 18+ :
echo    https://nodejs.org/
echo Read the messages above for the real error.
echo ------------------------------------------------------------------
pause
