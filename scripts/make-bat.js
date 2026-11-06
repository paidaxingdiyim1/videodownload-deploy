'use strict';

/**
 * 生成 Windows 启动脚本 start.bat / start.ps1。
 *
 * 踩过的坑（双击闪退的根因）：
 *   1. LF 换行 —— cmd 按行读取，LF 会让 if(...) 块、for/f 解析错乱
 *   2. UTF-8 中文（无 BOM）—— cmd 用系统码页(GBK)读文件，中文变乱码还会吞掉
 *      相邻字节，典型症状是 "@echo off" 被吃成 "cho"，整段逻辑失效
 *
 * 所以：bat 只用 ASCII + CRLF，并且刻意用最简单的直线写法
 *      （不用 for/f、不用括号块、不用延迟展开），把解析风险降到最低。
 *      中文提示一律交给 Node 自己打印。
 *
 * 用法：node scripts/make-bat.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const batLines = [
  '@echo off',
  'chcp 65001 >nul',
  'title Web Video Downloader - Local Server',
  'cd /d "%~dp0"',
  '',
  'rem ---- pick node.exe (portable installs first, then PATH) ----',
  'set "NODE_EXE=node"',
  'if exist "%ProgramFiles%\\nodejs\\node.exe" set "NODE_EXE=%ProgramFiles%\\nodejs\\node.exe"',
  'if exist "%ProgramFiles(x86)%\\nodejs\\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\\nodejs\\node.exe"',
  'if exist "%LOCALAPPDATA%\\Programs\\nodejs\\node.exe" set "NODE_EXE=%LOCALAPPDATA%\\Programs\\nodejs\\node.exe"',
  'for /d %%D in ("%USERPROFILE%\\.workbuddy\\binaries\\node\\versions\\*") do if exist "%%D\\node.exe" set "NODE_EXE=%%D\\node.exe"',
  '',
  'rem ---- sanity check ----',
  'if not exist "server\\src\\server.js" echo [ERROR] server\\src\\server.js not found. Keep start.bat in the project root.',
  '',
  '"%NODE_EXE%" "server\\src\\server.js"',
  '',
  'echo.',
  'echo ------------------------------------------------------------------',
  'echo Service exited (code %ERRORLEVEL%).',
  'echo If you saw "node is not recognized" above, install Node.js 18+ :',
  'echo    https://nodejs.org/',
  'echo Read the messages above for the real error.',
  'echo ------------------------------------------------------------------',
  'pause',
  '',
];

const ps1Lines = [
  '# Web Video Downloader - local server launcher (PowerShell)',
  '$ErrorActionPreference = "Stop"',
  'Set-Location -Path $PSScriptRoot',
  '$node = Get-Command node -ErrorAction SilentlyContinue',
  'if (-not $node) {',
  '  $candidates = @(',
  '    "$env:ProgramFiles\\nodejs\\node.exe",',
  '    "$env:LOCALAPPDATA\\Programs\\nodejs\\node.exe"',
  '  )',
  '  $node = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1',
  '}',
  'if (-not $node) {',
  '  Write-Host "[ERROR] Node.js not found. Install Node.js 18+ from https://nodejs.org/" -ForegroundColor Red',
  '  Read-Host "Press Enter to exit"',
  '  exit 1',
  '}',
  'Write-Host "Starting local download service ..." -ForegroundColor Cyan',
  '& $node.Source "server\\src\\server.js"',
  'Write-Host ""',
  'Write-Host "Service exited. Read the messages above for details." -ForegroundColor Yellow',
  'Read-Host "Press Enter to exit"',
  '',
];

function write(file, lines) {
  fs.writeFileSync(file, lines.join('\r\n'), 'latin1');
  const buf = fs.readFileSync(file);
  const ascii = buf.every((b) => b < 0x80);
  const text = buf.toString('latin1');
  const crlf = (text.match(/\r\n/g) || []).length;
  const loneLf = (text.match(/(?<!\r)\n/g) || []).length;
  console.log(`${path.basename(file)}: ${buf.length} 字节 · 纯ASCII=${ascii} · CRLF=${crlf} · 孤立LF=${loneLf}`);
  return ascii && loneLf === 0;
}

const okBat = write(path.join(ROOT, 'start.bat'), batLines);
const okPs1 = write(path.join(ROOT, 'start.ps1'), ps1Lines);

if (!okBat || !okPs1) {
  console.error('校验失败：文件必须同时满足 纯ASCII + CRLF');
  process.exit(1);
}
console.log('OK');
