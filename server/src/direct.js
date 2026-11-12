'use strict';

const fs = require('fs');

/**
 * 普通直链下载（mp4 / webm / flv / m4a ...）
 * 支持断点续传（服务端支持 Range 时）与实时进度。
 * 若中途临时文件被外部删除（rename 报 ENOENT），自动从头重下一次。
 */
async function download(task, ctx) {
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
