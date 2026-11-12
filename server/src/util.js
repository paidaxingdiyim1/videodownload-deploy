'use strict';

const crypto = require('crypto');

/* ---------------- 基础格式化 ---------------- */

function formatBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 2 : 1) + ' ' + u[i];
}

function formatDuration(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

/** 清洗成 Windows/macOS/Linux 都合法的文件名 */
function sanitizeFilename(name, maxLen = 110) {
  let s = String(name == null ? '' : name)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  if (!s) s = 'video';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = '_' + s;
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  // 文件名上限是「字节」不是「字符」：中文 1 字 3 字节，110 字 ≈ 330 字节会 ENAMETOOLONG。
  // 这里再按 UTF-8 字节压到 180，给「 - S01E01.mp4」等后缀留出余量。
  const MAX_BYTES = 180;
  if (Buffer.byteLength(s, 'utf8') > MAX_BYTES) {
    let out = '';
    for (const ch of s) {
      if (Buffer.byteLength(out + ch, 'utf8') > MAX_BYTES) break;
      out += ch;
    }
    s = out.trim();
  }
  return s || 'video';
}

/** 从 URL 猜一个还行的标题（扩展未提供标题时的兜底） */
function guessTitleFromUrl(u) {
  try {
    const url = new URL(u);
    const base = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
    const noExt = base.replace(/\.[a-z0-9]{1,5}$/i, '');
    if (noExt && noExt.length > 2 && !/^(index|playlist|master|manifest|video|media)$/i.test(noExt)) {
      return noExt.replace(/[_-]+/g, ' ');
    }
    return url.hostname.replace(/^www\./, '');
  } catch (_) {
    return 'video';
  }
}

/* ---------------- m3u8 解析 ---------------- */

function absUrl(base, rel) {
  if (!rel) return base;
  try { return new URL(rel, base).href; } catch (_) { return rel; }
}

function parseAttributes(str) {
  const out = {};
  const re = /([A-Za-z0-9-]+)\s*=\s*("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) {
    let v = m[2].trim();
    if (v.startsWith('"')) v = v.slice(1, -1);
    out[m[1].toUpperCase()] = v;
  }
  return out;
}

/**
 * 解析 m3u8，返回主列表(variants)或媒体列表(segments)
 * segment: { url, duration, key, byterange, seq }
 * key: { method, uri, iv } | null
 */
function parseM3U8(text, url) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));

  if (isMaster) {
    const variants = [];
    const audioRenditions = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttributes(line.slice(13));
        if ((a.TYPE || '').toUpperCase() === 'AUDIO' && a.URI) {
          audioRenditions.push({ url: absUrl(url, a.URI), group: a['GROUP-ID'] || '', lang: a.LANGUAGE || '', name: a.NAME || '' });
        }
      } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const a = parseAttributes(line.slice(18));
        let j = i + 1;
        while (j < lines.length && lines[j].startsWith('#')) j++;
        if (j < lines.length) {
          variants.push({
            url: absUrl(url, lines[j]),
            bandwidth: Number(a.BANDWIDTH || 0),
            averageBandwidth: Number(a['AVERAGE-BANDWIDTH'] || 0),
            resolution: a.RESOLUTION || '',
            codecs: a.CODECS || '',
            frameRate: Number(a['FRAME-RATE'] || 0),
            audioGroup: a.AUDIO || '',
          });
          i = j;
        }
      }
    }
    return { isMaster: true, variants, audioRenditions };
  }

  const segments = [];
  let targetDuration = 0;
  let mediaSequence = 0;
  let totalDuration = 0;
  let currentKey = null;
  let initSegment = null;
  let pendingDuration = 0;
  let pendingRange = null;
  let discontinuity = false;
  let ended = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice(8).split(',')[0]) || 0;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseFloat(line.slice(22)) || 0;
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.slice(22), 10) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(line.slice(11));
      const method = (a.METHOD || 'NONE').toUpperCase();
      currentKey = method === 'NONE' ? null : {
        method,
        uri: a.URI ? absUrl(url, a.URI) : null,
        iv: a.IV || null,
        keyFormat: a.KEYFORMAT || 'identity',
      };
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice(11));
      initSegment = { url: absUrl(url, a.URI), byterange: a.BYTERANGE || null };
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = line.slice(17);
    } else if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      discontinuity = true;
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      ended = true;
    } else if (line.startsWith('#')) {
      // 忽略其余标签
    } else {
      segments.push({
        url: absUrl(url, line),
        duration: pendingDuration,
        key: currentKey,
        byterange: pendingRange,
        discontinuity,
        seq: mediaSequence + segments.length,
      });
      totalDuration += pendingDuration;
      pendingDuration = 0;
      pendingRange = null;
      discontinuity = false;
    }
  }

  return { isMaster: false, segments, duration: totalDuration, targetDuration, mediaSequence, initSegment, ended };
}

/** 解析 "1024@0" 形式的 byterange */
function parseByterange(str) {
  if (!str) return null;
  const m = String(str).match(/^(\d+)(?:@(\d+))?$/);
  if (!m) return null;
  return { length: Number(m[1]), offset: m[2] != null ? Number(m[2]) : null };
}

/* ---------------- 解密 ---------------- */

/** HLS AES-128-CBC 解密；自动兼容带/不带 PKCS7 填充的分片 */
function decryptAes128(data, key, iv) {
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([d.update(data), d.final()]);
  } catch (_) {
    try {
      const d2 = crypto.createDecipheriv('aes-128-cbc', key, iv);
      d2.setAutoPadding(false);
      return Buffer.concat([d2.update(data), d2.final()]);
    } catch (__) {
      return data; // 实在解不开就原样写入，让播放器自己判断
    }
  }
}

/** 用序号生成默认 IV（16 字节大端） */
function ivFromSequence(seq) {
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(seq >>> 0, 12);
  return iv;
}

function ivFromHex(hex) {
  const clean = String(hex).replace(/^0x/i, '');
  const buf = Buffer.from(clean, 'hex');
  if (buf.length === 16) return buf;
  if (buf.length < 16) return Buffer.concat([Buffer.alloc(16 - buf.length), buf]);
  return buf.subarray(0, 16);
}

/* ---------------- 其他 ---------------- */

function uid(prefix = 't') {
  return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  formatBytes,
  formatDuration,
  sanitizeFilename,
  guessTitleFromUrl,
  absUrl,
  parseAttributes,
  parseM3U8,
  parseByterange,
  decryptAes128,
  ivFromSequence,
  ivFromHex,
  uid,
  sleep,
};
