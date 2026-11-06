'use strict';

const fs = require('fs');
const util = require('./util');

/**
 * HLS 下载器
 * - 支持 master/media 两级播放列表
 * - 支持 AES-128 分片解密（HLS 最常见的加密方式）
 * - 支持 fMP4（EXT-X-MAP 初始化段）与 MPEG-TS 两种容器
 * - 分片并发下载、按序落盘
 * - 支持 EXT-X-MEDIA 独立音轨（需要 ffmpeg 合并）
 */
async function download(task, ctx) {
  const playlistUrl = task.url;

  // 1. 抓播放列表
  const first = await fetchPlaylist(ctx, playlistUrl);
  let pl = first.pl;
  let currentUrl = playlistUrl;
  let quality = task.quality || '';

  if (pl.isMaster) {
    const chosen = pickVariant(pl.variants, task.quality);
    if (!chosen) throw new Error('m3u8 主列表里没有可用的清晰度');
    currentUrl = chosen.url;
    quality = chosen.resolution || (chosen.bandwidth ? Math.round(chosen.bandwidth / 1000) + 'kbps' : '');
    ctx.log(`选择清晰度：${quality || '默认'}`);
    pl = (await fetchPlaylist(ctx, currentUrl)).pl;
    if (pl.isMaster) throw new Error('检测到多层嵌套的主播放列表，请改用 yt-dlp 模式');
  }

  if (!pl.segments.length) throw new Error('播放列表里没有分片，可能是直播或需要特殊处理');
  if (!pl.ended) ctx.log('⚠ 播放列表没有 #EXT-X-ENDLIST，可能是直播流，只下载当前可见片段');

  task.quality = quality;
  task.segmentsTotal = pl.segments.length;
  task.duration = Math.round(pl.duration);

  // 2. 主视频轨
  const isFmp4 = !!pl.initSegment;
  const videoTmp = ctx.tmpFile + (isFmp4 ? '.video.mp4' : '.ts');

  ctx.log(`开始下载 ${pl.segments.length} 个分片（${util.formatDuration(pl.duration)}）`);
  await runTrack(ctx, pl, videoTmp, (p) => {
    ctx.report({
      progress: p.progress * 0.95,
      downloaded: p.bytes,
      total: p.totalBytes,
      speed: p.speed,
      eta: p.eta,
      stage: p.decrypting ? 'decrypting' : 'downloading',
      segmentsDone: p.done,
      segmentsTotal: p.total,
    });
  });

  // 3. 独立音轨（部分站点把音轨单独放）
  const audioRendition = pickAudioRendition(pl, task);
  if (audioRendition && ctx.hasFfmpeg) {
    try {
      ctx.log('检测到独立音轨，开始下载音频');
      const apl = (await fetchPlaylist(ctx, audioRendition.url)).pl;
      if (apl.isMaster) throw new Error('音轨列表异常');
      const audioTmp = ctx.tmpFile + '.audio.m4a';
      await runTrack(ctx, apl, audioTmp, (p) => {
        ctx.report({ progress: 95 + p.progress * 0.03, stage: 'audio' });
      });
      ctx.log('合并音视频…');
      ctx.report({ progress: 98, stage: 'merging' });
      await ctx.ffmpeg(['-y', '-i', videoTmp, '-i', audioTmp, '-c', 'copy', '-movflags', '+faststart', ctx.tmpFile + '.merged.mp4']);
      safeUnlink(audioTmp);
      safeUnlink(videoTmp);
      return { file: ctx.tmpFile + '.merged.mp4', ext: 'mp4', merged: true };
    } catch (e) {
      ctx.log('音轨处理失败，回退为纯视频：' + e.message);
    }
  }

  // 4. 收尾：TS 尝试转封装成 mp4
  if (!isFmp4 && ctx.hasFfmpeg && ctx.config.remuxToMp4) {
    try {
      ctx.report({ progress: 97, stage: 'merging' });
      ctx.log('正在转封装为 MP4…');
      await ctx.ffmpeg(['-y', '-i', videoTmp, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', ctx.tmpFile + '.mp4']);
      safeUnlink(videoTmp);
      return { file: ctx.tmpFile + '.mp4', ext: 'mp4', merged: true };
    } catch (e) {
      ctx.log('转封装失败，保留 TS 文件：' + e.message);
    }
  }

  fs.renameSync(videoTmp, ctx.tmpFile);
  return { file: ctx.tmpFile, ext: isFmp4 ? 'mp4' : 'ts' };
}

/* ------------------------------------------------------------------ */

async function fetchPlaylist(ctx, url) {
  const res = await ctx.fetch(url, { headers: { ...ctx.headers } });
  if (!res.ok) throw new Error(`获取播放列表失败：HTTP ${res.status}`);
  let text = await res.text();
  if (!text.includes('#EXTM3U')) {
    // 有些站点返回的是加密文本或者需要 key 参数，给出明确提示
    throw new Error('返回内容不是 m3u8（可能是防盗链或需要登录）');
  }
  return { pl: util.parseM3U8(text, url), text, finalUrl: res.url || url };
}

function pickVariant(variants, wanted) {
  if (!variants || !variants.length) return null;
  const sorted = [...variants].sort((a, b) => b.bandwidth - a.bandwidth);
  if (!wanted || wanted === 'best' || wanted === 'auto') return sorted[0];
  if (wanted === 'worst') return sorted[sorted.length - 1];

  const height = parseInt(String(wanted).replace(/[^\d]/g, ''), 10);
  if (height) {
    // 找最接近且不超过目标高度的
    const byHeight = sorted
      .filter((v) => {
        const h = parseInt((v.resolution || '').split('x')[1] || '0', 10);
        return h && h <= height;
      })
      .sort((a, b) => b.bandwidth - a.bandwidth);
    if (byHeight.length) return byHeight[0];
  }
  return sorted[0];
}

function pickAudioRendition(pl, task) {
  if (!task.withSeparateAudio) return null;
  const list = pl.audioRenditions || [];
  return list.length ? list[0] : null;
}

/**
 * 下载一条轨道到 outPath，进度回调
 */
async function runTrack(ctx, pl, outPath, onProgress) {
  const segments = pl.segments;
  const keyCache = new Map();
  const concurrency = Math.max(1, Math.min(ctx.config.segmentConcurrency || 6, 16));

  const fd = fs.openSync(outPath, 'w');
  const pending = new Map();
  let nextToWrite = 0;
  let done = 0;
  let bytes = 0;
  let lastTick = Date.now();
  let lastBytes = 0;
  let speed = 0;
  let failCount = 0;

  const flush = () => {
    while (pending.has(nextToWrite)) {
      const buf = pending.get(nextToWrite);
      pending.delete(nextToWrite);
      if (buf && buf.length) fs.writeSync(fd, buf);
      nextToWrite++;
    }
  };

  // 初始化段（fMP4）
  if (pl.initSegment) {
    try {
      const buf = await loadSegment(ctx, pl.initSegment, keyCache, 0);
      if (buf) fs.writeSync(fd, buf);
    } catch (e) {
      ctx.log('初始化段下载失败：' + e.message);
    }
  }

  const totalDuration = pl.duration || segments.length;

  try {
    let index = 0;
    const workers = new Array(Math.min(concurrency, segments.length)).fill(0).map(async () => {
      while (index < segments.length) {
        if (ctx.signal.aborted) throw new Error('已取消');
        const i = index++;
        const seg = segments[i];
        let buf = null;
        for (let attempt = 0; attempt < 3 && !buf; attempt++) {
          try {
            buf = await loadSegment(ctx, seg, keyCache, i);
          } catch (e) {
            if (attempt === 2) {
              failCount++;
              ctx.log(`分片 #${i + 1} 失败：${e.message}`);
              throw e;
            }
            await util.sleep(400 * (attempt + 1));
          }
        }
        pending.set(i, buf);
        bytes += buf.length;
        done++;
        flush();

        const now = Date.now();
        if (now - lastTick >= 300) {
          speed = (bytes - lastBytes) / ((now - lastTick) / 1000);
          lastTick = now;
          lastBytes = bytes;
        }
        onProgress({
          progress: (done / segments.length) * 100,
          done,
          total: segments.length,
          bytes,
          totalBytes: bytes,
          speed,
          eta: speed > 0 ? Math.round(((segments.length - done) * (bytes / Math.max(done, 1))) / speed) : 0,
        });
      }
    });

    await Promise.all(workers);
  } finally {
    flush();
    // 有缺口也尽量把能写的按序补上
    if (pending.size) {
      [...pending.keys()].sort((a, b) => a - b).forEach((k) => {
        const b = pending.get(k);
        if (b && b.length) fs.writeSync(fd, b);
      });
      pending.clear();
    }
    fs.closeSync(fd);
  }

  if (failCount > 0) ctx.log(`有 ${failCount} 个分片最终失败，文件可能不完整`);
  return { bytes, totalDuration };
}

async function loadSegment(ctx, seg, keyCache, index) {
  const headers = { ...ctx.headers };
  const range = util.parseByterange(seg.byterange);
  if (range) {
    const start = range.offset != null ? range.offset : 0;
    headers.Range = `bytes=${start}-${start + range.length - 1}`;
  }

  const res = await ctx.fetch(seg.url, { headers, retries: 0 });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
  let buf = Buffer.from(await res.arrayBuffer());

  if (seg.key && seg.key.method === 'AES-128') {
    const key = await getKey(ctx, seg.key, keyCache);
    const iv = seg.key.iv ? util.ivFromHex(seg.key.iv) : util.ivFromSequence(seg.seq != null ? seg.seq : index);
    buf = util.decryptAes128(buf, key, iv);
  } else if (seg.key && seg.key.method && seg.key.method !== 'NONE') {
    throw new Error(`不支持的加密方式 ${seg.key.method}（SAMPLE-AES 需要 yt-dlp 模式）`);
  }
  return buf;
}

async function getKey(ctx, keyInfo, cache) {
  const id = keyInfo.uri || '__default__';
  if (cache.has(id)) return cache.get(id);
  const res = await ctx.fetch(keyInfo.uri, { headers: { ...ctx.headers } });
  if (!res.ok) throw new Error(`获取解密密钥失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== 16) throw new Error(`密钥长度异常：${buf.length} 字节`);
  cache.set(id, buf);
  return buf;
}

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch (_) {}
}

module.exports = { download };
