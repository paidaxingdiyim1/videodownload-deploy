'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const config = require('./config');

/**
 * 普通直链下载（mp4 / webm / flv / m4a ...）
 *
 * 重要：优先用系统 curl 下载，而不是 Node 自带的 fetch（undici）。
 * 实测同一台机器、同一个地址：
 *   curl（HTTP/1.1）  30~50 MB/s
 *   Node fetch        2.4 MB/s
 *   Node http2        0.87 MB/s
 * curl 走系统 OpenSSL + 自己的 IO 循环，Node 这套在老 CPU 上被拖慢十几倍。
 * 所以：有 curl 就用 curl（顺带拿到断点续传、重试、限速保护），没有才退回 Node 下载。
 *
 * 进度：curl 不输出进度（-sS），改为每 400ms 取一次 .part 文件大小算速度/百分比。
 */
async function download(task, ctx) {
  const bin = config.resolveCurl();
  if (bin) {
    try {
      return await curlDownload(task, ctx, bin);
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      ctx.log && ctx.log('curl 下载失败，改用内置下载器重试：' + String(e.message || e).slice(0, 120));
      try { fs.unlinkSync(ctx.tmpFile + '.part'); } catch (_) {}
    }
  }
  return nodeDownload(task, ctx);
}

/* ----------------------------- curl 实现 ----------------------------- */

function curlDownload(task, ctx, bin, resumed) {
  return new Promise((resolve, reject) => {
    const partPath = ctx.tmpFile + '.part';
    const hdrPath = ctx.tmpFile + '.hdr';
    let start = 0;
    try { start = fs.statSync(partPath).size; } catch (_) {}
    if (!(start > 0)) start = 0;

    const buildArgs = (resume) => {
      const args = [
        '-sS', '-L', '--fail',
        '--connect-timeout', '20',
        '--retry', '2', '--retry-delay', '1', '--retry-connrefused',
        '--speed-limit', '1024', '--speed-time', '90',   // 90 秒低于 1KB/s 才放弃
        '-o', partPath, '-D', hdrPath,
      ];
      if (resume) args.push('-C', '-');
      for (const [k, v] of Object.entries(ctx.headers || {})) {
        if (v) args.push('-H', `${k}: ${v}`);
      }
      args.push(task.url);
      return args;
    };

    const state = { total: 0, lastTick: Date.now(), lastBytes: start, done: false };

    const readTotal = () => {
      try {
        const h = fs.readFileSync(hdrPath, 'utf8');
        const blocks = h.split(/\r?\n\r?\n/).filter(Boolean);
        const last = blocks[blocks.length - 1] || h;
        const range = /content-range:\s*bytes\s+\d+-\d+\/(\d+)/i.exec(last);
        if (range) return Number(range[1]);
        const m = /content-length:\s*(\d+)/i.exec(last);
        if (m) return Number(m[1]) + (/HTTP\/[\d.]+ 206/.test(last) ? start : 0);
      } catch (_) {}
      return 0;
    };

    const timer = setInterval(() => {
      let size = 0;
      try { size = fs.statSync(partPath).size; } catch (_) {}
      if (!state.total) state.total = readTotal();
      const now = Date.now();
      const dt = (now - state.lastTick) / 1000;
      if (dt >= 0.35) {
        const speed = Math.max(0, (size - state.lastBytes) / dt);
        state.lastTick = now;
        state.lastBytes = size;
        ctx.report({
          progress: state.total ? Math.min(99, (size / state.total) * 100) : 0,
          downloaded: size,
          total: state.total,
          speed,
          eta: speed > 0 && state.total ? Math.round((state.total - size) / speed) : 0,
        });
      }
    }, 400);

    let stderr = '';
    const child = spawn(bin, buildArgs(start > 0), { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (d) => { stderr += String(d); if (stderr.length > 4000) stderr = stderr.slice(-4000); });

    const onAbort = () => { try { child.kill('SIGTERM'); } catch (_) {} };
    if (ctx.signal) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (err) => {
      if (state.done) return;
      state.done = true;
      clearInterval(timer);
      try { fs.unlinkSync(hdrPath); } catch (_) {}
      if (err) return reject(err);
      let size = 0;
      try { size = fs.statSync(partPath).size; } catch (_) {}
      if (!size || size < (ctx.config.minMediaBytes || 0)) {
        return reject(new Error(`下载内容过小（${size} 字节），可能被服务器拒绝`));
      }
      try {
        fs.renameSync(partPath, ctx.tmpFile);
      } catch (e) {
        try { fs.copyFileSync(partPath, ctx.tmpFile); fs.unlinkSync(partPath); }
        catch (e2) { return reject(e2); }
      }
      ctx.report({ progress: 100, downloaded: size, total: size, speed: 0, eta: 0 });
      resolve({ file: ctx.tmpFile, ext: guessExt(task.url, '') });
    };

    child.on('error', (e) => finish(new Error('无法启动 curl：' + e.message)));
    child.on('close', (code) => {
      if (state.done) return;
      if (ctx.signal && ctx.signal.aborted) return finish(new Error('已取消'));
      if (code === 0) return finish(null);
      const msg = String(stderr || '').trim().split('\n').filter(Boolean).slice(-2).join(' ');
      // 断点续传不被支持 / 残留分片无效：删掉残留，从零重来一次
      if (!resumed && start > 0 && /range|resume|416|HTTP server doesn't/i.test(msg)) {
        state.done = true;
        clearInterval(timer);
        try { fs.unlinkSync(partPath); } catch (_) {}
        try { fs.unlinkSync(hdrPath); } catch (_) {}
        return curlDownload(task, ctx, bin, true).then(resolve, reject);
      }
      finish(new Error('curl 退出码 ' + code + (msg ? '：' + msg : '')));
    });
  });
}

/* ----------------------------- 内置实现（无 curl 时兜底） ----------------------------- */

async function nodeDownload(task, ctx) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await downloadOnce(task, ctx);
    } catch (e) {
      lastErr = e;
      const msg = String((e && (e.code || e.message)) || '');
      if (ctx.signal.aborted || !/ENOENT/.test(msg)) throw e;
      ctx.log && ctx.log('临时文件意外丢失，重下一次…');
      try { fs.unlinkSync(ctx.tmpFile + '.part'); } catch (_) {}
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw lastErr;
}

async function downloadOnce(task, ctx) {
  const partPath = ctx.tmpFile + '.part';
  let start = 0;
  try { start = fs.statSync(partPath).size; } catch (_) {}

  const headers = { ...ctx.headers };
  if (start > 0) headers.Range = `bytes=${start}-`;

  const res = await ctx.fetch(task.url, { headers });
  if (!res.ok && res.status !== 206) {
    throw new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim());
  }

  const lenHeader = Number(res.headers.get('content-length') || 0);
  const total = res.status === 206 ? start + lenHeader : lenHeader;
  const out = fs.createWriteStream(partPath, { flags: start > 0 ? 'a' : 'w' });

  let downloaded = start;
  let lastTick = Date.now();
  let lastBytes = downloaded;

  const write = (chunk) => new Promise((resolve, reject) => {
    if (!out.write(chunk)) out.once('drain', resolve);
    else resolve();
  });

  try {
    for await (const chunk of res.body) {
      if (ctx.signal.aborted) throw new Error('已取消');
      await write(chunk);
      downloaded += chunk.length;

      const now = Date.now();
      if (now - lastTick >= 250) {
        const speed = (downloaded - lastBytes) / ((now - lastTick) / 1000);
        lastTick = now;
        lastBytes = downloaded;
        ctx.report({
          progress: total ? Math.min(99, (downloaded / total) * 100) : 0,
          downloaded, total, speed,
          eta: speed > 0 && total ? Math.round((total - downloaded) / speed) : 0,
        });
      }
    }
  } finally {
    await new Promise((r) => out.end(r));
  }

  if (!fs.existsSync(partPath)) {
    const e = new Error('临时文件被外部删除（' + partPath + '）');
    e.code = 'ENOENT';
    throw e;
  }
  fs.renameSync(partPath, ctx.tmpFile);
  ctx.report({ progress: 100, downloaded, total: total || downloaded, speed: 0, eta: 0 });
  return { file: ctx.tmpFile, ext: guessExt(task.url, res.headers.get('content-type')) };
}

function guessExt(url, contentType) {
  const m = String(url).match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
  if (m) {
    const e = m[1].toLowerCase();
    if (['mp4', 'webm', 'mkv', 'flv', 'mov', 'm4v', 'ts', 'm4a', 'mp3', 'aac'].includes(e)) return e;
  }
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('webm')) return 'webm';
  if (ct.includes('matroska')) return 'mkv';
  if (ct.includes('quicktime')) return 'mov';
  if (ct.includes('flv')) return 'flv';
  if (ct.includes('mpegurl')) return 'ts';
  if (ct.includes('audio/mp4') || ct.includes('audio/aac')) return 'm4a';
  return 'mp4';
}

module.exports = { download, guessExt };
