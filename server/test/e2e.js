'use strict';

/**
 * 真实链路测试（需要 server/bin 里有 ffmpeg / ffprobe）
 *
 *  1. 用 ffmpeg 现场生成一条 AES-128 加密的 HLS（带显式 IV）
 *  2. 走本地服务下载 → 验证：解密正确、自动转封装成 mp4、ffprobe 能识别时长与音视频流
 *  3. 再用 yt-dlp 引擎下载同一个文件，验证 yt-dlp 路径与 --ffmpeg-location
 *
 * 用法：node test/e2e.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin');
const TMP = path.join(__dirname, 'tmp-e2e');
const FFMPEG = path.join(BIN, 'ffmpeg.exe');
const FFPROBE = path.join(BIN, 'ffprobe.exe');
const PORT = 9100 + Math.floor(Math.random() * 200);

let pass = 0, fail = 0;
const log = (ok, name, extra = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function probe(file) {
  const out = execFileSync(FFPROBE, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ], { encoding: 'utf8' });
  return JSON.parse(out);
}

/* ---------------- 生成加密 HLS ---------------- */

function makeHls() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  const key = crypto.randomBytes(16);
  fs.writeFileSync(path.join(TMP, 'key.bin'), key);

  // keyinfo 第三行是纯 16 进制 IV（不要带 0x，否则 ffmpeg 报 encryption_iv 无效、分片会静默写不出来）
  const iv = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(TMP, 'keyinfo.txt'), ['key.bin', path.join(TMP, 'key.bin'), iv].join('\n'));

  execFileSync(FFMPEG, [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', // 强制每秒一个关键帧，切出多个分片
    '-c:a', 'aac', '-b:a', '64k',
    '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', '-hls_playlist_type', 'vod',
    '-hls_key_info_file', path.join(TMP, 'keyinfo.txt'),
    '-hls_segment_filename', path.join(TMP, 'seg%d.ts'),
    path.join(TMP, 'index.m3u8'),
  ], { cwd: TMP, stdio: 'pipe' });

  const playlist = fs.readFileSync(path.join(TMP, 'index.m3u8'), 'utf8');
  const segs = fs.readdirSync(TMP).filter((f) => f.endsWith('.ts'));
  if (segs.length < 2) throw new Error(`测试素材异常：只生成了 ${segs.length} 个分片`);

  // 再准备一个真实 mp4 给 yt-dlp 测试用
  execFileSync(FFMPEG, [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100',
    '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart',
    path.join(TMP, 'plain.mp4'),
  ], { stdio: 'pipe' });

  return { playlist, segs, encrypted: /#EXT-X-KEY:METHOD=AES-128/.test(playlist) };
}

/* ---------------- 静态服务 / 下载服务 ---------------- */

function startStatic(port) {
  const srv = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
    const file = path.join(TMP, name);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('no'); }
    const stat = fs.statSync(file);
    res.writeHead(200, {
      'Content-Type': name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'application/octet-stream',
      'Content-Length': stat.size,
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

function startWvd() {
  const child = spawn(process.execPath, ['src/server.js', `--port=${PORT}`], {
    cwd: ROOT,
    env: { ...process.env, WVD_DOWNLOAD_DIR: path.join(TMP, 'out') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write('[wvd] ' + d));
  return child;
}

const TOKEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).token;

async function api(pathname, opts = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    headers: { 'Content-Type': 'application/json', 'X-Auth-Token': TOKEN },
    ...opts,
  });
  return res.json();
}

async function waitDone(id, timeout = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const { task } = await api(`/api/tasks/${id}`);
    if (task && ['done', 'error', 'canceled'].includes(task.status)) return task;
    await sleep(300);
  }
  throw new Error('超时');
}

/* ---------------- 主流程 ---------------- */

(async () => {
  console.log('\n网页视频下载器 · 真实链路测试（ffmpeg + yt-dlp）\n');

  if (!fs.existsSync(FFMPEG) || !fs.existsSync(FFPROBE)) {
    console.error('缺少 server/bin/ffmpeg.exe 或 ffprobe.exe');
    process.exit(1);
  }

  const fx = makeHls();
  console.log(`  测试素材：${fx.segs.length} 个加密分片，AES-128=${fx.encrypted}\n`);

  const staticSrv = await startStatic(PORT + 1);
  const staticPort = staticSrv.address().port;
  const wvd = startWvd();
  process.on('exit', () => { try { wvd.kill(); } catch (_) {} });

  try {
    let healthy = null;
    for (let i = 0; i < 60; i++) {
      try { healthy = await api('/api/health'); if (healthy.ok) break; } catch (_) {}
      await sleep(250);
    }
    log(!!(healthy && healthy.ok), '服务启动');
    log(healthy?.tools?.ytdlp?.ok, '检测到 yt-dlp', healthy?.tools?.ytdlp?.version || '');
    log(healthy?.tools?.ffmpeg?.ok, '检测到 ffmpeg');

    /* --- A. 原生引擎：加密 HLS → 解密 → 转封装 MP4 --- */
    const a = await api('/api/download', {
      method: 'POST',
      body: JSON.stringify({
        url: `http://127.0.0.1:${staticPort}/index.m3u8`,
        title: 'e2e-encrypted-hls',
        kind: 'hls',
        mode: 'native',
        referer: 'http://127.0.0.1:1/watch',
      }),
    });
    const ta = await waitDone(a.task.id);
    log(ta.status === 'done', 'A. 加密 HLS 下载完成', ta.status === 'done' ? ta.fileName : ta.error);

    if (ta.status === 'done') {
      log(ta.fileName.endsWith('.mp4'), 'A. 已自动转封装为 MP4', ta.fileName);
      const info = probe(ta.filePath);
      const dur = Number(info.format.duration);
      const hasVideo = info.streams.some((s) => s.codec_type === 'video');
      const hasAudio = info.streams.some((s) => s.codec_type === 'audio');
      log(hasVideo, 'A. 含视频流', info.streams.find((s) => s.codec_type === 'video')?.codec_name || '');
      log(hasAudio, 'A. 含音频流（解密后未损坏）', info.streams.find((s) => s.codec_type === 'audio')?.codec_name || '');
      log(Math.abs(dur - 4) < 1.2, 'A. 时长约 4 秒', dur.toFixed(2) + 's');
    }

    /* --- B. yt-dlp 引擎：直链 mp4 --- */
    const b = await api('/api/download', {
      method: 'POST',
      body: JSON.stringify({
        url: `http://127.0.0.1:${staticPort}/plain.mp4`,
        title: 'e2e-ytdlp',
        kind: 'mp4',
        mode: 'ytdlp',
      }),
    });
    const tb = await waitDone(b.task.id);
    log(tb.status === 'done', 'B. yt-dlp 下载完成', tb.status === 'done' ? tb.fileName : tb.error);
    if (tb.status === 'done') {
      const info = probe(tb.filePath);
      log(Number(info.format.duration) > 1, 'B. yt-dlp 产物可播放', Number(info.format.duration).toFixed(2) + 's');
    }

    /* --- C. 探测接口 --- */
    const c = await api('/api/probe', {
      method: 'POST',
      body: JSON.stringify({ url: `http://127.0.0.1:${staticPort}/plain.mp4` }),
    });
    log(c.ok && c.info, 'C. /api/probe 正常', c.info?.title || '');

    console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('测试异常：', e);
    process.exit(1);
  } finally {
    staticSrv.close();
    wvd.kill();
    setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 400);
  }
})();
