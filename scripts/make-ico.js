/**
 * 把 extension/icons 里的多尺寸 PNG 打包成 Windows 的 .ico
 * ICO 支持内嵌 PNG（Vista 及以上），所以不用做位图转换
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ICON_DIR = path.join(ROOT, 'extension', 'icons');
const OUT = path.join(ROOT, 'assets', 'app.ico');
const SIZES = [16, 32, 48, 128];

const images = SIZES.map((size) => {
  const file = path.join(ICON_DIR, `icon${size}.png`);
  if (!fs.existsSync(file)) throw new Error('缺少图标: ' + file);
  const buf = fs.readFileSync(file);
  if (buf.slice(1, 4).toString() !== 'PNG') throw new Error('不是 PNG: ' + file);
  return { size, buf };
});

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type = icon
header.writeUInt16LE(images.length, 4);

const entries = [];
let offset = 6 + images.length * 16;
for (const img of images) {
  const e = Buffer.alloc(16);
  e.writeUInt8(img.size >= 256 ? 0 : img.size, 0); // width
  e.writeUInt8(img.size >= 256 ? 0 : img.size, 1); // height
  e.writeUInt8(0, 2); // palette
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // color planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(img.buf.length, 8); // size in bytes
  e.writeUInt32LE(offset, 12); // offset
  offset += img.buf.length;
  entries.push(e);
}

const ico = Buffer.concat([header, ...entries, ...images.map((i) => i.buf)]);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, ico);

console.log('已生成 ' + OUT);
console.log('  尺寸: ' + SIZES.join('/') + '  大小: ' + (ico.length / 1024).toFixed(1) + ' KB');
