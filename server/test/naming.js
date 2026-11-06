'use strict';
/**
 * 命名与分目录行为验证（临时）
 *   1. 带真实标题 → downloads/<站点>/<标题>.mp4
 *   2. 占位标题「视频」 → downloads/<站点>/<站点>_<日期>_<序号>.mp4
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT_API = 8895;
const PORT_FILE = 8896;
const OUT = path.join(__dirname, 'tmp-naming', 'out');

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }

async function main() {
  fs.rmSync(path.join(__dirname, 'tmp-naming'), { recursive: true, force: true });
  // 素材文件服务
  const payload = crypto.randomBytes(220000);
  const fileSrv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': payload.length });
    res.end(payload);
  });
  await new Promise((r) => fileSrv.listen(PORT_FILE, '127.0.0.1', r));

  // 下载服务（子进程，指向测试输出目录）
  const { spawn } = require('child_process');
  const srv = spawn(process.execPath, ['src/server.js', `--port=${PORT_API}`], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, WVD_DOWNLOAD_DIR: OUT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));

  // 等 health 就绪 + 拿 token
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  const TOKEN = cfg.token;
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT_API}/api/health`);
      if (r.ok) { ready = true; break; }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) fail('下载服务未就绪');

  const H = { 'Content-Type': 'application/json', 'X-Auth-Token': TOKEN };
  const post = (body) => fetch(`http://127.0.0.1:${PORT_API}/api/download`, { method: 'POST', headers: H, body: JSON.stringify(body) }).then((r) => r.json());
  const waitDone = async (id) => {
    for (let i = 0; i < 120; i++) {
      const t = await fetch(`http://127.0.0.1:${PORT_API}/api/tasks/${id}`, { headers: H }).then((r) => r.json());
      if (['done', 'error', 'canceled'].includes(t.task.status)) return t.task;
      await new Promise((r) => setTimeout(r, 300));
    }
    return null;
  };

  // ① 带真实标题
  const a = await post({ url: `http://127.0.0.1:${PORT_FILE}/clip-a.mp4`, title: '我的测试标题', kind: 'mp4', referer: 'http://www.example-site.com/watch/1' });
  const ta = await waitDone(a.task.id);
  if (!ta || ta.status !== 'done') fail(`任务① 未完成: ${JSON.stringify(ta && ta.error)}`);
  const relA = path.relative(OUT, ta.filePath);
  console.log('① 真实标题落盘:', relA);
  if (!relA.includes('example-site.com')) fail('① 未按站点分目录');
  if (!/我的测试标题\.mp4$/.test(relA)) fail('① 文件名不是标题');

  // ② 占位标题「视频」
  const b = await post({ url: `http://127.0.0.1:${PORT_FILE}/clip-b.mp4`, title: '视频', kind: 'mp4', referer: 'http://www.example-site.com/watch/2' });
  const tb = await waitDone(b.task.id);
  if (!tb || tb.status !== 'done') fail(`任务② 未完成: ${JSON.stringify(tb && tb.error)}`);
  const relB = path.relative(OUT, tb.filePath);
  console.log('② 占位标题落盘:', relB);
  if (!relB.includes('example-site.com')) fail('② 未按站点分目录');
  // 占位标题「视频」必须被替换：URL 可猜时用 URL（clip b），否则用 站点_日期_序号
  const goodName = /clip b\.mp4$/.test(relB) || /example-site\.com_\d{8}_\d{3}\.mp4$/.test(relB);
  if (!goodName) fail('② 占位标题未被替换成有效命名: ' + relB);

  srv.kill();
  fileSrv.close();
  console.log('\n结果：2 通过，0 失败');
}

main().catch((e) => { console.error(e); process.exit(1); });
