/**
 * 验证打包后的 exe（Node SEA）能真正下载文件
 *  - 直链下载（direct 路径）
 *  - yt-dlp 引擎下载（验证子进程 + ffmpeg 定位在打包后仍有效）
 *
 * 用法：node build/test-exe.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, '网页视频下载器.exe');
const FFMPEG = path.join(ROOT, 'server', 'bin', 'ffmpeg.exe');
const TMP = path.join(os.tmpdir(), 'wvd-exe-test');
const PORT = 8901;

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'config.json'), 'utf8'));
const TOKEN = cfg.token;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`); }
}

async function api(pathname, opts = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-auth-token': TOKEN, ...(opts.headers || {}) },
  });
  return res.json();
}

async function waitTask(id, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await api('/api/tasks');
    const t = (r.tasks || []).find((x) => x.id === id);
    if (t && (t.status === 'done' || t.status === 'error' || t.status === 'canceled')) return t;
    await sleep(400);
  }
  return null;
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  console.log('▶ 准备素材');
  const sample = path.join(TMP, 'sample.mp4');
  execFileSync(FFMPEG, [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', sample,
  ]);
  const sampleSize = fs.statSync(sample).size;
  console.log(`  样本 ${(sampleSize / 1024).toFixed(0)} KB`);

  // 本地静态服务
  const fileSrv = http.createServer((req, res) => {
    const f = path.join(TMP, decodeURIComponent(req.url.split('?')[0]));
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    const stat = fs.statSync(f);
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => fileSrv.listen(0, '127.0.0.1', r));
  const filePort = fileSrv.address().port;
  console.log(`  静态服务 127.0.0.1:${filePort}`);

  console.log('\n▶ 启动 exe');
  if (!fs.existsSync(EXE)) { console.error('找不到 ' + EXE); process.exit(1); }
  const child = spawn(EXE, [`--port=${PORT}`, '--no-open', '--no-shortcut'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  child.on('error', (e) => { console.error('启动失败', e.message); });

  let health = null;
  for (let i = 0; i < 25; i++) {
    await sleep(400);
    try { health = await api('/api/health'); if (health.ok) break; } catch (_) {}
  }
  check('exe 启动并响应 /api/health', !!health && health.ok);
  if (!health) { console.log(out); process.exit(1); }
  check('yt-dlp 已识别', health.tools.ytdlp.ok, health.tools.ytdlp.version || '');
  check('ffmpeg 已识别', health.tools.ffmpeg.ok);

  console.log('\n▶ A. 直链下载');
  const a = await api('/api/download', {
    method: 'POST',
    body: JSON.stringify({ url: `http://127.0.0.1:${filePort}/sample.mp4`, title: 'exe-direct-test' }),
  });
  check('任务已创建', a.ok, a.task && a.task.id);
  const ta = await waitTask(a.task.id);
  check('任务完成', !!ta && ta.status === 'done', ta ? ta.status + ' ' + (ta.error || '') : 'timeout');
  check('返回了文件路径', !!(ta && ta.filePath), ta && ta.filePath);
  if (ta && ta.filePath) {
    check('文件已落盘', fs.existsSync(ta.filePath), ta.filePath);
    if (fs.existsSync(ta.filePath)) {
      check('文件大小一致', fs.statSync(ta.filePath).size === sampleSize, `${fs.statSync(ta.filePath).size} vs ${sampleSize}`);
    }
  }

  console.log('\n▶ B. yt-dlp 引擎下载（验证子进程）');
  const b = await api('/api/download', {
    method: 'POST',
    body: JSON.stringify({ url: `http://127.0.0.1:${filePort}/sample.mp4`, title: 'exe-ytdlp-test', mode: 'ytdlp' }),
  });
  check('任务已创建', b.ok, b.task && b.task.id);
  const tb = await waitTask(b.task.id, 90000);
  check('任务完成', !!tb && tb.status === 'done', tb ? tb.status + ' ' + (tb.error || '') : 'timeout');
  check('返回了文件路径', !!(tb && tb.filePath), tb && tb.filePath);
  if (tb && tb.filePath) {
    check('文件已落盘', fs.existsSync(tb.filePath), tb.filePath);
    if (fs.existsSync(tb.filePath)) check('文件非空', fs.statSync(tb.filePath).size > 1000, fs.statSync(tb.filePath).size + ' bytes');
  }

  console.log('\n▶ 清理');
  fileSrv.close();
  try { child.kill(); } catch (_) {}

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
