'use strict';

const fs = require('fs');
const util = require('./util');

/**
 * MPEG-DASH 下载器（基础版）
 * 支持 SegmentTemplate + $Number$ / SegmentTimeline 的常见形态。
 * 音视频分离时用 ffmpeg 合并；没有 ffmpeg 则只保存视频轨并提示。
 */
async function download(task, ctx) {
  const res = await ctx.fetch(task.url);
  if (!res.ok) throw new Error(`获取 MPD 失败：HTTP ${res.status}`);
  const xml = await res.text();
  const baseUrl = res.url || task.url;

  const mpd = parseMpd(xml, baseUrl);
  if (!mpd.videos.length) throw new Error('MPD 中没有视频轨道');

  const video = pickBest(mpd.videos);
  const audio = pickBest(mpd.audios);
  ctx.log(`DASH：视频 ${video.width || '?'}x${video.height || '?'}，音频 ${audio ? '有' : '无'}`);

  const videoTmp = ctx.tmpFile + '.video.mp4';
  const audioTmp = ctx.tmpFile + '.audio.mp4';

  await downloadTrack(ctx, video, videoTmp, (p) => ctx.report({ progress: p * (audio ? 0.9 : 0.97), stage: 'downloading' }));

  if (audio && ctx.hasFfmpeg) {
    await downloadTrack(ctx, audio, audioTmp, (p) => ctx.report({ progress: 90 + p * 0.07, stage: 'downloading' }));
    ctx.log('合并音视频…');
    ctx.report({ progress: 98, stage: 'merging' });
    await ctx.ffmpeg(['-y', '-i', videoTmp, '-i', audioTmp, '-c', 'copy', '-movflags', '+faststart', ctx.tmpFile + '.mp4']);
    safeUnlink(videoTmp);
    safeUnlink(audioTmp);
    return { file: ctx.tmpFile + '.mp4', ext: 'mp4' };
  }

  if (audio) ctx.log('未安装 ffmpeg，只保存视频轨（无声音），装好 ffmpeg 后可自动合并');
  fs.renameSync(videoTmp, ctx.tmpFile);
  return { file: ctx.tmpFile, ext: 'mp4' };
}

/* ------------------------------------------------------------------ */

function parseMpd(xml, baseUrl) {
  const resolve = (u) => util.absUrl(baseUrl, u);
  const rootBase = tagText(xml, 'BaseURL');
  const scopeBase = rootBase ? resolve(rootBase) : baseUrl;

  const periodBlock = matchBlock(xml, 'Period') || xml;
  const periodDuration = parseIsoDuration(attrOf(periodBlock.split('>')[0], 'duration')) ||
    parseIsoDuration(attrOf(xml.split('>')[0], 'mediaPresentationDuration')) || 0;

  const videos = [];
  const audios = [];

  for (const aset of matchBlocks(periodBlock, 'AdaptationSet')) {
    const head = aset.slice(0, aset.indexOf('>') + 1);
    const mime = attrOf(head, 'mimeType') || '';
    const type = attrOf(head, 'contentType') || (mime.startsWith('video') ? 'video' : mime.startsWith('audio') ? 'audio' : '');
    if (type !== 'video' && type !== 'audio') continue;

    const asetBase = tagText(aset, 'BaseURL');
    const asetScope = asetBase ? resolve(asetBase) : scopeBase;
    const asetTemplate = matchBlock(aset, 'SegmentTemplate');
    const asetTimeline = asetTemplate ? matchBlock(asetTemplate, 'SegmentTimeline') : null;

    for (const repBlock of matchBlocks(aset, 'Representation')) {
      const repHead = repBlock.slice(0, repBlock.indexOf('>') + 1);
      const repId = attrOf(repHead, 'id') || '';
      const repBase = tagText(repBlock, 'BaseURL');
      const repScope = repBase ? resolve(repBase) : asetScope;

      const tplBlock = matchBlock(repBlock, 'SegmentTemplate') || asetTemplate;
      const timelineBlock = (matchBlock(tplBlock || '', 'SegmentTimeline')) || asetTimeline;

      if (!tplBlock) {
        // SegmentList / 单文件 BaseURL：直接下整段
        const single = repBase ? resolve(repBase) : '';
        if (single) {
          (type === 'video' ? videos : audios).push({
            id: repId, width: +attrOf(repHead, 'width') || 0, height: +attrOf(repHead, 'height') || 0,
            bandwidth: +attrOf(repHead, 'bandwidth') || 0, singleUrl: single,
          });
        }
        continue;
      }

      const tpl = {
        media: attrOf(tplBlock.split('>')[0], 'media') || '',
        init: attrOf(tplBlock.split('>')[0], 'initialization') || '',
        timescale: +attrOf(tplBlock.split('>')[0], 'timescale') || 1,
        duration: +attrOf(tplBlock.split('>')[0], 'duration') || 0,
        startNumber: attrOf(tplBlock.split('>')[0], 'startNumber') != null ? +attrOf(tplBlock.split('>')[0], 'startNumber') : 1,
      };

      const segments = [];
      if (timelineBlock) {
        let number = tpl.startNumber;
        let time = 0;
        const sTags = timelineBlock.match(/<S\b[^>]*\/?>/g) || [];
        for (const s of sTags) {
          const d = +attrOf(s, 'd') || 0;
          const t = attrOf(s, 't');
          const r = +attrOf(s, 'r') || 0;
          if (t != null) time = +t;
          for (let k = 0; k <= r; k++) {
            segments.push(buildSeg(tpl, repId, number++, time, repScope));
            time += d;
          }
        }
      } else if (tpl.duration && periodDuration) {
        const segDur = tpl.duration / tpl.timescale;
        const count = Math.ceil(periodDuration / segDur);
        for (let i = 0; i < count; i++) {
          segments.push(buildSeg(tpl, repId, tpl.startNumber + i, i * tpl.duration, repScope));
        }
      }

      if (!segments.length) continue;
      const target = {
        id: repId,
        width: +attrOf(repHead, 'width') || 0,
        height: +attrOf(repHead, 'height') || 0,
        bandwidth: +attrOf(repHead, 'bandwidth') || 0,
        initUrl: tpl.init ? fillTemplate(tpl.init, repId, tpl.startNumber, 0, repScope) : '',
        segments,
      };
      task_duration_hint(target, periodDuration);
      (type === 'video' ? videos : audios).push(target);
    }
  }

  return { videos, audios, duration: periodDuration };
}

function task_duration_hint() {} // 占位，保持结构清晰

function buildSeg(tpl, repId, number, time, scope) {
  return { url: fillTemplate(tpl.media, repId, number, time, scope) };
}

function fillTemplate(tpl, repId, number, time, scope) {
  const out = tpl
    .replace(/\$RepresentationID\$/g, repId)
    .replace(/\$Bandwidth\$/g, '')
    .replace(/\$Number%0(\d+)d\$/g, (_, w) => String(number).padStart(+w, '0'))
    .replace(/\$Number\$/g, String(number))
    .replace(/\$Time(?:%0\d+d)?\$/g, String(time));
  return util.absUrl(scope, out);
}

function pickBest(list) {
  if (!list || !list.length) return null;
  return [...list].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
}

async function downloadTrack(ctx, track, outPath, onProgress) {
  const fd = fs.openSync(outPath, 'w');
  try {
    if (track.initUrl) {
      const r = await ctx.fetch(track.initUrl);
      if (r.ok) fs.writeSync(fd, Buffer.from(await r.arrayBuffer()));
    }
    const total = track.segments.length;
    let done = 0;
    let index = 0;
    const concurrency = Math.max(1, Math.min(ctx.config.segmentConcurrency || 6, 12));
    const buffers = new Map();
    let next = 0;

    const flush = () => {
      while (buffers.has(next)) {
        const b = buffers.get(next);
        buffers.delete(next);
        if (b && b.length) fs.writeSync(fd, b);
        next++;
      }
    };

    const workers = new Array(Math.min(concurrency, total)).fill(0).map(async () => {
      while (index < total) {
        if (ctx.signal.aborted) throw new Error('已取消');
        const i = index++;
        let buf = null;
        for (let a = 0; a < 3 && !buf; a++) {
          try {
            const r = await ctx.fetch(track.segments[i].url, { retries: 0 });
            if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
            buf = Buffer.from(await r.arrayBuffer());
          } catch (e) {
            if (a === 2) throw e;
            await util.sleep(300 * (a + 1));
          }
        }
        buffers.set(i, buf);
        done++;
        flush();
        onProgress((done / total) * 100);
      }
    });
    await Promise.all(workers);
  } finally {
    fs.closeSync(fd);
  }
}

/* --------------------------- XML 小工具 --------------------------- */

function attrOf(tag, name) {
  if (!tag) return null;
  const m = tag.match(new RegExp(name + '\\s*=\\s*"([^"]*)"'));
  return m ? m[1] : null;
}

function tagText(xml, tag) {
  if (!xml) return null;
  const m = xml.match(new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>'));
  return m ? m[1].trim() : null;
}

function matchBlock(xml, tag) {
  if (!xml) return null;
  const m = xml.match(new RegExp('<' + tag + '\\b[\\s\\S]*?</' + tag + '>'));
  return m ? m[0] : null;
}

function matchBlocks(xml, tag) {
  if (!xml) return [];
  return xml.match(new RegExp('<' + tag + '\\b[\\s\\S]*?</' + tag + '>', 'g')) || [];
}

function parseIsoDuration(str) {
  if (!str) return 0;
  const m = String(str).match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (parseFloat(m[4]) || 0);
}

function safeUnlink(p) { try { fs.unlinkSync(p); } catch (_) {} }

module.exports = { download };
