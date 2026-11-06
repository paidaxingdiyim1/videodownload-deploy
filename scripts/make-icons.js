'use strict';

/**
 * 生成扩展图标（纯 Node，无第三方依赖）
 * 用法：node scripts/make-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------- PNG 编码 ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------- 图形 ---------------- */

function lerp(a, b, t) { return a + (b - a) * t; }

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function insideRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  if (x >= x0 + r && x <= x1 - r) return y >= y0 && y <= y1;
  if (y >= y0 + r && y <= y1 - r) return x >= x0 && x <= x1;
  return Math.hypot(x - cx, y - cy) <= r;
}

function renderIcon(size) {
  const SS = 4; // 超采样
  const rgba = Buffer.alloc(size * size * 4);
  const S = size;

  const pad = S * 0.035;
  const r = S * 0.235;
  const bx0 = pad, by0 = pad, bx1 = S - pad, by1 = S - pad;

  // 箭头几何（相对尺寸）
  const cx = S * 0.5;
  const stemTop = S * 0.235, stemBottom = S * 0.585;
  const stemW = S * 0.088;
  const headHalfW = S * 0.175;
  const headY = S * 0.545;
  const baseY0 = S * 0.735, baseY1 = S * 0.815;
  const baseX0 = S * 0.285, baseX1 = S * 0.715;
  const baseW = (baseY1 - baseY0) / 2;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let bgCov = 0, fgCov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;

          if (insideRoundRect(px, py, bx0, by0, bx1, by1, r)) bgCov++;

          const inStem = Math.abs(px - cx) <= stemW / 2 && py >= stemTop && py <= stemBottom + S * 0.01;
          const d1 = distToSegment(px, py, cx - headHalfW, headY - S * 0.075, cx, headY + S * 0.055);
          const d2 = distToSegment(px, py, cx + headHalfW, headY - S * 0.075, cx, headY + S * 0.055);
          const inHead = Math.min(d1, d2) <= stemW / 2;
          const inBase = py >= baseY0 && py <= baseY1 && px >= baseX0 && px <= baseX1;
          if (inStem || inHead || inBase) fgCov++;
        }
      }
      const n = SS * SS;
      const a = bgCov / n;
      const f = (fgCov / n) * a;

      const t = (x + y) / (2 * S);
      let R = lerp(0x4e, 0x1a, t), G = lerp(0x8b, 0x4f, t), B = lerp(0xff, 0xd6, t);

      // 白色字形覆盖
      R = lerp(R, 255, f);
      G = lerp(G, 255, f);
      B = lerp(B, 255, f);

      const i = (y * S + x) * 4;
      rgba[i] = Math.round(R);
      rgba[i + 1] = Math.round(G);
      rgba[i + 2] = Math.round(B);
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  return encodePNG(S, S, rgba);
}

const outDir = path.resolve(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, renderIcon(size));
  console.log('生成', file);
}
