'use strict';

/**
 * 环境安装脚本（可选增强，服务本身零依赖即可运行）
 *
 *   node scripts/setup.js          检测 + 尝试安装 yt-dlp / ffmpeg
 *   node scripts/setup.js --skip-ffmpeg
 *
 * yt-dlp：优先用 pip 安装；失败则下载独立 exe 到 server/bin/
 * ffmpeg：优先用 winget；失败则提示手动安装
 */

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const config = require('../server/src/config');

const SKIP_FFMPEG = process.argv.includes('--skip-ffmpeg');
const BIN = config.BIN_DIR;

function run(cmd, args, timeout = 300000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' });
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} resolve(1); }, timeout);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code || 0); });
    child.on('error', () => { clearTimeout(timer); resolve(1); });
  });
}

function which(cmd) {
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', [cmd], (e, out) => {
      resolve(!e && String(out).trim() ? String(out).trim().split(/\r?\n/)[0] : null);
    });
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u, redirects = 0) => {
      if (redirects > 5) return reject(new Error('重定向过多'));
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return follow(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

async function main() {
  console.log('\n=== 网页视频下载 · 环境安装 ===\n');
  fs.mkdirSync(BIN, { recursive: true });

  /* ---------- yt-dlp ---------- */
  let ytdlpPath = await which('yt-dlp');
  const pipCandidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];

  if (!ytdlpPath) {
    // 本地 bin 里已有？
    for (const f of fs.readdirSync(BIN)) {
      if (/^yt-dlp(\.exe)?$/i.test(f)) ytdlpPath = path.join(BIN, f);
    }
  }

  if (!ytdlpPath) {
    for (const py of pipCandidates) {
      const hasPip = await new Promise((r) => execFile(py, ['-m', 'pip', '--version'], (e) => r(!e)));
      if (!hasPip) continue;
      console.log(`> 正在用 ${py} -m pip 安装 yt-dlp…`);
      const code = await run(py, ['-m', 'pip', 'install', '--user', '-U', 'yt-dlp']);
      if (code === 0) { ytdlpPath = 'yt-dlp'; break; }
    }
  }

  if (!ytdlpPath) {
    console.log('> pip 不可用，尝试下载独立 yt-dlp.exe 到 server/bin …');
    const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
    const dest = path.join(BIN, 'yt-dlp.exe');
    try {
      await download(url, dest);
      ytdlpPath = dest;
    } catch (e) {
      console.log('  下载失败：' + e.message);
    }
  }

  console.log(ytdlpPath ? '✓ yt-dlp 就绪：' + ytdlpPath : '✗ yt-dlp 未能安装（不影响 HLS/直链下载）');

  /* ---------- ffmpeg ---------- */
  if (!SKIP_FFMPEG) {
    let ff = await which('ffmpeg');
    if (!ff) {
      for (const f of fs.readdirSync(BIN)) {
        if (/^ffmpeg(\.exe)?$/i.test(f)) ff = path.join(BIN, f);
      }
    }
    if (!ff && process.platform === 'win32') {
      const hasWinget = await which('winget');
      if (hasWinget) {
        console.log('> 正在用 winget 安装 ffmpeg（可能需要几分钟）…');
        const code = await run('winget', ['install', '--id', 'Gyan.FFmpeg', '-e', '--accept-source-agreements', '--accept-package-agreements'], 600000);
        if (code === 0) ff = 'ffmpeg';
      }
    }
    console.log(ff ? '✓ ffmpeg 就绪' : '✗ ffmpeg 未安装：HLS 将保存为 .ts（可用 PotPlayer/VLC 播放）');
    if (!ff) {
      console.log('  手动安装：');
      console.log('    Windows: winget install Gyan.FFmpeg  或  https://www.gyan.dev/ffmpeg/builds/');
      console.log('    macOS:   brew install ffmpeg');
      console.log('    Linux:   sudo apt install ffmpeg');
    }
  }

  console.log('\n完成。运行 start.bat 启动服务，然后在浏览器加载 extension 目录即可。\n');
}

main();
