'use strict';

/**
 * 端到端自测：
 *  1. 本地生成一个加密 HLS 流（AES-128，序列号默认 IV）
 *  2. 启动下载服务（随机端口 + 临时下载目录）
 *  3. 通过 API 下单 → 等待完成 → 校验输出与原文一致
 *  4. 顺便验证直链 MP4 下载
 *
 * 用法：node test/selftest.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(__dirname, 'tmp');
const PORT = 8899 + Math.floor(Math.random() * 100);

let pass = 0, fail = 0;
const log = (ok, name, extra = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

/* ---------------- 生成加密 HLS 测试流 ---------------- */

function makeFixture() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  const key = crypto.randomBytes(16);
  fs.writeFileSync(path.join(TMP, 'key.bin'), key);

  const segs = [];
  const N = 4;
  for (let i = 0; i < N; i++) {
    const plain = crypto.randomBytes(64 * 1024 + i * 777); // 非对齐长度，考验 PKCS7
    segs.push(plain);

    // 与播放器/我们的实现一致：默认 IV = 大端序的媒体序号
    const iv = Buffer.alloc(16);
    iv.writeUInt32BE(i, 12);
    const c = crypto.createCipheriv('aes-128-cbc', key, iv);
    fs.writeFileSync(path.join(TMP, `seg${i}.ts`), Buffer.concat([c.update(plain), c.final()]));
  }

  fs.writeFileSync(path.join(TMP, 'media.m3u8'),
    ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
      ...segs.map((_, i) => `#EXTINF:4.0,\nseg${i}.ts`), '#EXT-X-ENDLIST', ''].join('\n'));

  fs.writeFileSync(path.join(TMP, 'master.m3u8'),
    ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720', 'media.m3u8', ''].join('\n'));

  return { segs, expectedSha: sha256(Buffer.concat(segs)) };
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/* ---------------- 静态文件服务 ---------------- */

function startStatic(port) {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
    const file = path.join(TMP, name);
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(fs.readFileSync(file));
    }
    res.writeHead(404); res.end('no');
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

/* ---------------- 下载服务控制 ---------------- */

function startWvd(port) {
  const child = spawn(process.execPath, ['src/server.js', `--port=${port}`], {
    cwd: ROOT, // ROOT 即 server 目录
    env: { ...process.env, WVD_DOWNLOAD_DIR: path.join(TMP, 'out') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write('[wvd] ' + d.toString()));
  return child;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const configPath = path.join(ROOT, 'config.json');
const TOKEN = JSON.parse(fs.readFileSync(configPath, 'utf8')).token;

async function wvdFetch(pathname, opts = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    headers: { 'Content-Type': 'application/json', 'X-Auth-Token': TOKEN },
    ...opts,
  });
  return res.json();
}

async function waitDownload(id, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const { task } = await wvdFetch(`/api/tasks/${id}`);
    if (task && ['done', 'error', 'canceled'].includes(task.status)) return task;
    await sleep(300);
  }
  throw new Error('超时');
}

/* ---------------- 主流程 ---------------- */

(async () => {
  console.log('\n网页视频下载器 · 端到端自测\n');
  fs.rmSync(TMP, { recursive: true, force: true });

  const fx = makeFixture();
  const staticSrv = await startStatic(8890 + Math.floor(Math.random() * 50));
  const staticPort = staticSrv.address().port;
  const wvd = startWvd(PORT);
  process.on('exit', () => { try { wvd.kill(); } catch (_) {} });

  try {
    // 等服务起来
    let healthy = null;
    for (let i = 0; i < 40; i++) {
      try { healthy = await wvdFetch('/api/health'); if (healthy.ok) break; } catch (_) {}
      await sleep(250);
    }
    log(healthy && healthy.ok, '本地服务启动', healthy ? `port=${healthy.port}` : '');

    // 1. 加密 HLS（走 master 播放列表）
    const r1 = await wvdFetch('/api/download', {
      method: 'POST',
      body: JSON.stringify({
        url: `http://127.0.0.1:${staticPort}/master.m3u8`,
        title: '自测-加密HLS',
        kind: 'hls',
        referer: 'http://127.0.0.1:1/page',
      }),
    });
    log(r1.ok && r1.task, '创建 HLS 下载任务', r1.error || '');
    const t1 = await waitDownload(r1.task.id);
    log(t1.status === 'done', 'HLS(AES-128) 解密下载完成', t1.status === 'done' ? t1.fileName : t1.error);
    if (t1.status === 'done') {
      const got = sha256(fs.readFileSync(t1.filePath));
      log(got === fx.expectedSha, '解密结果与原文逐字节一致');
    }

    // 2. 直链 MP4
    const mp4 = Buffer.from('fake-mp4-bytes-'.repeat(5000));
    fs.writeFileSync(path.join(TMP, 'movie.mp4'), mp4);
    const r2 = await wvdFetch('/api/download', {
      method: 'POST',
      body: JSON.stringify({
        url: `http://127.0.0.1:${staticPort}/movie.mp4`,
        title: '自测-直链MP4',
        kind: 'mp4',
        referer: 'http://127.0.0.1:1/page',
      }),
    });
    const t2 = await waitDownload(r2.task.id);
    log(t2.status === 'done', '直链下载完成', t2.status === 'done' ? t2.fileName : t2.error);
    if (t2.status === 'done') {
      log(sha256(fs.readFileSync(t2.filePath)) === sha256(mp4), '直链内容一致');
    }

    // 3. 断点/进度字段
    const list = await wvdFetch('/api/tasks');
    log(list.ok && list.tasks.length >= 2, '任务列表可用', `count=${list.tasks?.length}`);

    console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('自测异常：', e);
    process.exit(1);
  } finally {
    staticSrv.close();
    wvd.kill();
    setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true }), 300);
  }
})();
