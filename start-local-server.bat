@echo off
cd /d "%~dp0"
echo [local download server] starting on http://127.0.0.1:8765 ...
echo [local download server] keep this window open. Press Ctrl+C to stop.
echo.
node server\src\server.js
pause
