'use strict';

const path = require('path');
const ytdlp = require('./ytdlp');

/**
 * 批量时长探测：用 ffprobe 读取一组媒体 URL 的真实时长。
 * 用途：MSE 播放器（抖音等）的 blob: 虚拟地址无法直接配对到真实网络流，
 * 但「正在播放的视频」在页面里有准确的 duration，用它做指纹——
 * 候选流里时长吻合（±2.5 秒）的就是当前视频的流，物理上不会配错。
 */

/** 从 ffmpeg 命令推导同目录的 ffprobe 命令 */
function ffprobeCmdOf(tools) {
  if (!tools.ffmpeg || !tools.ffmpeg.ok) return null;
  const cmd = tools.ffmpeg.cmd;
  if (!/ffmpeg(\.exe)?$/i.test(cmd[0])) return null;
  const probeBin = String(cmd[0]).replace(/ffmpeg(\.exe)?$/i, (m) =>
    /\.exe$/i.test(m) ? 'ffprobe.exe' : 'ffprobe');
  return [probeBin, ...cmd.slice(1)];
}

/** ffprobe 的 HTTP 头参数（Referer / UA / Cookie） */
function headerArgs({ referer, userAgent, cookies } = {}) {
  const args = [];
  if (userAgent) args.push('-user_agent', String(userAgent));
  const hs = [];
  if (referer) {
    hs.push('Referer: ' + referer);
    try { hs.push('Origin: ' + new URL(referer).origin); } catch (_) {}
  }
  if (cookies) {
    const c = typeof cookies === 'string'
      ? cookies
      : (cookies || []).map((x) => `${x.name}=${x.value}`).join('; ');
    if (c) hs.push('Cookie: ' + c);
  }
  if (hs.length) args.push('-headers', hs.join('\r\n') + '\r\n');
  return args;
}

async function probeDuration(ffprobe, url, hArgs) {
  const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', ...hArgs, '-i', url];
  const r = await ytdlp.run(ffprobe, args, { timeout: 25000 });
  if (r.code !== 0) return 0;
  try {
    const j = JSON.parse(r.stdout);
    const d = Number(j.format && j.format.duration);
    return Number.isFinite(d) ? d : 0;
  } catch (_) {
    return 0;
  }
}

/** 批量探测；最多 12 条并发，失败的返回 duration: 0 */
async function probeDurations(urls, opts = {}) {
  const list = (urls || []).filter((u) => /^https?:/i.test(u)).slice(0, 12);
  if (!list.length) return [];
  const tools = await ytdlp.detect();
  const ffprobe = ffprobeCmdOf(tools);
  if (!ffprobe) return list.map((url) => ({ url, duration: 0, error: 'no-ffprobe' }));
  const hArgs = headerArgs(opts);
  return Promise.all(list.map(async (url) => {
    try {
      const duration = await probeDuration(ffprobe, url, hArgs);
      return { url, duration };
    } catch (e) {
      return { url, duration: 0, error: String((e && e.message) || e) };
    }
  }));
}

module.exports = { probeDurations };
