'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, spawn, execFile } = require('child_process');

const config = require('./config');
const tasks = require('./tasks');
const ytdlp = require('./ytdlp');
const util = require('./util');
const cfdl = require('./cfdl');
const nettest = require('./nettest');
const organize = require('./organize');
const { probeDurations } = require('./probe');

const VERSION = '1.5.28';

/* 日志同时写到 logs/server.log，方便窗口意外关闭后排查 */
const LOG_DIR = path.join(config.ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'server.log');
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  const stamp = () => new Date().toLocaleString('zh-CN', { hour12: false });
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      try {
        stream.write(`[${stamp()}] [${level}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
      } catch (_) {}
    };
  }
  process.on('uncaughtException', (e) => {
    console.error('未捕获异常：' + (e && e.stack ? e.stack : e));
    console.error('详情已写入 ' + LOG_FILE);
    process.exit(1);
  });
} catch (e) {
  console.warn('日志文件不可写：' + e.message);
}

const cfg = config.load();

// SEA 打包后 argv 里会多一段可执行文件路径，统一只取 -- 开头的参数，两种模式都正确
const args = process.argv.slice(1).filter((a) => a.startsWith('--'));
const NO_TOKEN = args.includes('--no-token');
const NO_OPEN = args.includes('--no-open');
const PORT_ARG = args.find((a) => /^--port=/.test(a));
const HOST_ARG = args.find((a) => /^--host=/.test(a));
// --no-token 在监听非回环地址时默认拒绝启动，除非显式加 --allow-no-token（明确自担风险）
const ALLOW_NO_TOKEN_LAN = args.includes('--allow-no-token');

/* ----------------------------- 工具 ----------------------------- */

// 实际监听地址：CLI 参数 > 环境变量 / config.json（load 里已处理 env）> 默认 127.0.0.1
const bindHost = HOST_ARG ? HOST_ARG.split('=')[1].trim() : cfg.host;
const LAN_BIND = config.isLanBind(bindHost);

function lanOriginsAllowed() {
  return Array.isArray(cfg.lanAllowedOrigins) ? cfg.lanAllowedOrigins : [];
}

function corsHeaders(origin) {
  const allowed = isAllowedOrigin(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Auth-Token,X-WVD-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (/^(chrome|moz|safari-web)-extension:\/\//i.test(origin)) return true;
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) return true;
  // 局域网模式：放行局域网内的 http(s) 网页来源（token 依然强制校验）
  if (LAN_BIND && /^https?:\/\/[\w.-]+(:\d+)?$/i.test(origin)) {
    const whitelist = lanOriginsAllowed();
    if (whitelist.includes('*')) return true;
    // 默认放行内网地址段来源；白名单可追加域名
    const m = origin.match(/^https?:\/\/([^:/]+)(:\d+)?$/i);
    const host = m ? m[1].toLowerCase() : '';
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return true;
    return whitelist.some((o) => host === o.toLowerCase().replace(/^https?:\/\//, ''));
  }
  return false;
}

function send(res, status, data, extra = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/*  浏览器端上传（Cloudflare 强防护站绕过：扩展在浏览器里下载后传上来）  */
/* ------------------------------------------------------------------ */

/** uploadId -> { part, title, site, ext, customName, referer, size, at } */
const uploads = new Map();

function moveUpload(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code === 'EXDEV') { fs.copyFileSync(from, to); fs.unlinkSync(from); }
    else throw e;
  }
}

async function finalizeUpload(up) {
  const rawSite = up.site || (() => { try { return new URL(up.referer || '').hostname.replace(/^www\./, ''); } catch (_) { return ''; } })();
  // 站点归一（missav.ai/.ws → missav），和任务下载走同一套目录规则
  const site = util.siteKey(/^https?:/i.test(rawSite) ? rawSite : 'https://' + rawSite) || rawSite;
  let name = up.customName || up.title;
  if (!up.customName) name = util.cleanTitle(name);
  name = util.sanitizeFilename(name) || 'video';
  const dir = cfg.siteFolders && site
    ? path.join(cfg.downloadDir, util.sanitizeFilename(site))
    : cfg.downloadDir;
  fs.mkdirSync(dir, { recursive: true });

  // 直接按浏览器端判定好的容器保存（TS 存 .ts、fmp4 存 .mp4），不做 ffmpeg
  // 转封装——服务器上的 ffmpeg 静态版对 mpegts→mp4 会段错误，且二者 Jellyfin 都能播
  const ext = up.ext === 'mp4' ? 'mp4' : (up.ext === 'ts' ? 'ts' : 'mp4');
  let candidate = path.join(dir, `${name}.${ext}`);
  let n = 1;
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${name} (${n++}).${ext}`);
  moveUpload(up.part, candidate);
  return candidate;
}

/* ----------------------------- 自更新 ----------------------------- */

const GIT_DIR = config.ROOT;

function runGit(args, opts = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: GIT_DIR, timeout: opts.timeout || 30000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, out: (stdout || '').trim(), err: (stderr || '').trim() });
    });
  });
}

function isGitDeployment() {
  return fs.existsSync(path.join(GIT_DIR, '.git'));
}

async function gitInfo() {
  if (!isGitDeployment()) return null;
  const [rev, remote] = await Promise.all([
    runGit(['rev-parse', '--short', 'HEAD']),
    runGit(['config', '--get', 'remote.origin.url']),
  ]);
  return { commit: rev.ok ? rev.out : '', remote: remote.ok ? remote.out : '' };
}

/** 检查公开仓库是否有新提交（自动检测） */
async function checkUpdate() {
  const info = await gitInfo();
  if (!info) return { ok: false, error: '当前不是 git 部署（缺少 .git 目录），无法在线更新' };
  const fetch = await runGit(['fetch', 'origin', '--quiet'], { timeout: 45000 });
  if (!fetch.ok) return { ok: false, error: 'git fetch 失败：' + (fetch.err || ('code ' + fetch.code)) };
  const [behind, latest] = await Promise.all([
    runGit(['rev-list', '--count', 'HEAD..origin/main']),
    runGit(['rev-parse', '--short', 'origin/main']),
  ]);
  return {
    ok: true,
    version: VERSION,
    commit: info.commit,
    remote: info.remote,
    latestCommit: latest.ok ? latest.out : '',
    behind: behind.ok ? parseInt(behind.out || '0', 10) : 0,
    branch: 'main',
  };
}

/** 执行 git pull（仅快进），成功后触发重启 */
async function doUpdate() {
  const info = await gitInfo();
  if (!info) return { ok: false, error: '当前不是 git 部署（缺少 .git 目录），无法在线更新' };
  const status = await runGit(['status', '--porcelain']);
  const dirty = status.out.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('??'));
  if (dirty.length) {
    return { ok: false, error: '服务器上有未提交的本地改动，请先处理再更新：' + dirty.slice(0, 3).join('；') };
  }
  const pull = await runGit(['pull', '--ff-only', 'origin', 'main'], { timeout: 90000 });
  if (!pull.ok) return { ok: false, error: 'git pull 失败：' + (pull.err || pull.out || ('code ' + pull.code)) };
  return { ok: true, updated: true, out: (pull.out || pull.err || '').split('\n').slice(0, 6).join(' | ') };
}

function restartAfterUpdate() {
  console.log('[update] 代码已更新，即将重启服务…');
  if (process.env.WVD_SUPERVISED) {
    // 有守护进程（systemd / 循环脚本）时直接退出，由守护进程拉起新版本
    setTimeout(() => process.exit(0), 300);
    return;
  }
  // 无守护进程时：另起一个进程再退出当前进程（尽力而为）
  try {
    const child = spawn(process.execPath, process.argv.slice(1), {
      cwd: process.cwd(), detached: true, stdio: 'ignore',
    });
    child.unref();
  } catch (_) {}
  setTimeout(() => process.exit(0), 900);
}

/* ----------------------------- 路由 ----------------------------- */

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    return res.end();
  }

  // 本机网页访问时不做 Origin 限制
  const fromWebPage = !origin || isAllowedOrigin(origin);

  if (pathname.startsWith('/api/') && !fromWebPage) {
    return send(res, 403, { ok: false, error: '来源不被允许' });
  }

  const cors = corsHeaders(origin || 'http://127.0.0.1');

  try {
    /* ---- 健康检查（不需要 token） ---- */
    if (pathname === '/api/health') {
      const tools = await ytdlp.detect();
      return send(res, 200, {
        ok: true,
        version: VERSION,
        pid: process.pid,
        port: cfg.port,
        downloadDir: cfg.downloadDir,
        requireToken: cfg.requireToken && !NO_TOKEN,
        tools,
        active: tasks.active,
        queued: tasks.queue.length,
      }, cors);
    }

    /* ---- 前端诊断上报：前端下载失败时把错误写到服务器日志，便于排查 ---- */
    if (pathname === '/api/diag' && req.method === 'POST') {
      let body = {};
      try { body = await readBody(req); } catch (_) {}
      const msg = String(body.message || '').slice(0, 500);
      try {
        const logDir = path.join(config.ROOT, 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(path.join(logDir, 'diag.log'),
          `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}\n`);
      } catch (_) {}
      return send(res, 200, { ok: true }, cors);
    }

    /* ---- 解析 Cloudflare 保护的 m3u8，返回分片列表（前端下载器「后端过验证+前端下分片」用） ---- */
    if (pathname === '/api/cf-m3u8' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.url) return send(res, 400, { ok: false, error: '缺少 url' }, cors);
      try {
        const py = config.resolvePython();
        const script = path.join(config.ROOT, 'server', 'src', 'cf_parse.py');
        const out = await new Promise((resolve, reject) => {
          const srcUrl = cfdl.toMasterPlaylist(body.url);
          execFile(py, [script, '--url', srcUrl, '--referer', body.referer || ''], { timeout: 90000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(String(stderr || stdout || err.message).trim()));
            try { resolve(JSON.parse(String(stdout).trim())); }
            catch (e) { reject(new Error('解析输出失败：' + String(stdout).slice(0, 200))); }
          });
        });
        return send(res, 200, out, cors);
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message }, cors);
      }
    }

    /* ---- 配对：扩展首次拿 token ---- */
    if (pathname === '/api/pair' && req.method === 'POST') {
      if (NO_TOKEN) return send(res, 200, { ok: true, token: '' }, cors);
      if (!/^(chrome|moz|safari-web)-extension:\/\//i.test(origin)) {
        return send(res, 403, { ok: false, error: '只有浏览器扩展可以配对' }, cors);
      }
      return send(res, 200, { ok: true, token: cfg.token }, cors);
    }

    /* ---- 其余接口校验 token ---- */
    if (pathname.startsWith('/api/') && cfg.requireToken && !NO_TOKEN) {
      const token = req.headers['x-auth-token'] || req.headers['x-wvd-token'] || url.searchParams.get('token');
      if (token !== cfg.token) {
        return send(res, 401, { ok: false, error: 'token 无效，请在扩展设置里重新配对' }, cors);
      }
    }

    /* ---- 极简下载入口（GET，给 iOS 快捷指令 / 书签用：/api/quick-download?token=xx&url=xx）---- */
    if (pathname === '/api/quick-download' && req.method === 'GET') {
      const u = url.searchParams.get('url') || '';
      const asHtml = wantsHtml(req);
      const reply = (status, data) => {
        if (!asHtml) return send(res, status, data, cors);
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(quickDownloadPage(data, cfg.token));
      };
      if (!u || !/^https?:\/\//i.test(u)) return reply(200, { ok: false, error: '缺少 url 参数' });

      // 传进来的是网页而不是视频流：大概率是快捷指令 / 书签没取到直链
      if (!looksLikeMedia(u)) return reply(200, { ok: false, error: 'PAGE', url: u });

      // 去重：同一地址 2 分钟内重复提交（快捷指令里脚本跳转 + 获取URL内容双触发）只建一个任务
      const dup = tasks.list().find((t) => t.url === u && Date.now() - (t.createdAt || 0) < 120000);
      if (dup) return reply(200, { ok: true, task: dup, dup: true });

      const snap = tasks.create({
        url: u,
        title: url.searchParams.get('title') || '',
        kind: 'auto',
        mode: 'auto',
        referer: url.searchParams.get('referer') || '',
      });
      return reply(200, { ok: true, task: snap }, cors);
    }

    /* ---- iOS 快捷指令：没找到直链时的提示页（带诊断信息，避免「无效 URL」）---- */
    if (pathname === '/api/ios-hint') {
      const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const h = esc(url.searchParams.get('h') || '未知');
      const r = esc(url.searchParams.get('r') || '0');
      const c = esc(url.searchParams.get('c') || '0');
      const v = esc(url.searchParams.get('v') || '0');
      const isMissav = /missav/i.test(h);
      const isHanime = /hanime/i.test(h);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>没找到直链</title>
<style>
 body{margin:0;font:15px/1.65 -apple-system,"PingFang SC",sans-serif;background:#f6f7f9;color:#1a1d21;padding:22px}
 .card{background:#fff;border-radius:14px;padding:18px 18px 16px;box-shadow:0 1px 3px rgba(0,0,0,.05)}
 h1{font-size:18px;margin:0 0 10px;color:#b42318}
 p{margin:10px 0}
 b{color:#2b6cff}
 table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13.5px}
 td{padding:7px 4px;border-bottom:1px solid #f0f1f3;word-break:break-all}
 td:first-child{color:#6b7280;width:42%}
 .tip{background:#f6f8ff;border:1px solid #e0e7ff;color:#374151;padding:10px 12px;border-radius:9px;font-size:13px}
</style></head><body><div class="card">
<h1>没找到视频直链</h1>
<p>请在视频页让视频 <b>播放 2~3 秒</b> 后，用 Safari 的 <b>分享 → 视频下载</b> 再跑一次——暂停或还在转圈时，页面里没有可用的流地址。</p>
<table>
 <tr><td>页面域名</td><td>${h}</td></tr>
 <tr><td>已加载资源</td><td>${r} 个</td></tr>
 <tr><td>候选直链</td><td>${c} 个</td></tr>
 <tr><td>video 元素</td><td>${v} 个</td></tr>
</table>
${r === '0' && v === '0' ? '<p class="tip"><b>资源数是 0</b>：说明脚本根本没在那个网页里运行。不要在「快捷指令」App 里点 ▶ 测试（那时前台是快捷指令自己，取不到网页）；请在 Safari 里通过分享菜单运行。</p>' : ''}
${isMissav ? '<p class="tip">missav：确认视频正在播放（不是暂停/加载中），播放器会去 surrit 拉 m3u8；播放 2~3 秒后再点分享。</p>' : ''}
${isHanime ? '<p class="tip">hanime1：确认页面已完整加载，且页面上能看到「下载」入口。</p>' : ''}
<p class="tip">把这一页截图发我，我能判断卡在哪一步。也可以先用 <a href="/m?token=${encodeURIComponent(cfg.token)}">手机网页版</a> 粘贴链接试试。</p>
</div></body></html>`);
    }

    /* ---- 链路测速：当前节点 / 测速 / 切节点 ---- */
    if (pathname === '/api/net/status' && req.method === 'GET') {
      try { return send(res, 200, await nettest.status(), cors); }
      catch (e) { return send(res, 200, { ok: false, available: false, error: e.message }, cors); }
    }
    if (pathname === '/api/net/test' && req.method === 'POST') {
      let body = {};
      try { body = await readBody(req); } catch (_) {}
      try {
        const st = await nettest.test({
          group: body.group, top: body.top, bytes: body.bytes, url: body.url, auto: !!body.auto,
        });
        return send(res, 200, { ok: true, ...st }, cors);
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message }, cors);
      }
    }
    if (pathname === '/api/net/select' && req.method === 'POST') {
      let body = {};
      try { body = await readBody(req); } catch (_) {}
      if (!body.node) return send(res, 400, { ok: false, error: '缺少 node' }, cors);
      try { return send(res, 200, { ok: true, ...(await nettest.apply(body.node, body.group)) }, cors); }
      catch (e) { return send(res, 200, { ok: false, error: e.message }, cors); }
    }

    /* ---- 新建下载 ---- */
    if (pathname === '/api/download' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.url) return send(res, 400, { ok: false, error: '缺少 url' }, cors);
      const snap = tasks.create({
        url: body.url,
        title: body.title,
        kind: body.kind || 'auto',
        mode: body.mode || 'auto',
        quality: body.quality || '',
        format: body.format || '',
        referer: body.referer || body.pageUrl || '',
        userAgent: body.userAgent || '',
        headers: body.headers || null,
        cookies: body.cookies || null,
        withSeparateAudio: !!body.withSeparateAudio,
      });
      return send(res, 200, { ok: true, task: snap }, cors);
    }

    /* ---- 浏览器端上传（Cloudflare 强防护站绕过） ---- */
    if (pathname === '/api/upload/start' && req.method === 'POST') {
      const body = await readBody(req);
      const id = 'up' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const tmpDir = path.join(cfg.downloadDir, '.tmp-upload');
      fs.mkdirSync(tmpDir, { recursive: true });
      uploads.set(id, {
        part: path.join(tmpDir, id + '.part'),
        title: String(body.title || '视频').trim(),
        site: String(body.site || '').trim(),
        ext: String(body.ext || 'mp4').replace(/^\./, '').toLowerCase(),
        customName: String(body.customName || '').trim(),
        referer: String(body.referer || '').trim(),
        size: 0,
        at: Date.now(),
      });
      return send(res, 200, { ok: true, uploadId: id }, cors);
    }

    if (pathname === '/api/upload/chunk' && req.method === 'POST') {
      const id = url.searchParams.get('uploadId') || '';
      const up = uploads.get(id);
      if (!up) return send(res, 404, { ok: false, error: '上传会话不存在或已过期' }, cors);
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(up.part, { flags: 'a' });
        req.on('data', (c) => { up.size += c.length; });
        req.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
        req.on('error', reject);
      });
      up.at = Date.now();
      return send(res, 200, { ok: true, size: up.size }, cors);
    }

    if (pathname === '/api/upload/finish' && req.method === 'POST') {
      const id = url.searchParams.get('uploadId') || '';
      const up = uploads.get(id);
      if (!up) return send(res, 404, { ok: false, error: '上传会话不存在或已过期' }, cors);
      let body = {};
      try { body = await readBody(req); } catch (_) {}
      if (body.customName) up.customName = String(body.customName).trim();
      if (body.title) up.title = String(body.title).trim();
      try {
        const finalPath = await finalizeUpload(up);
        return send(res, 200, { ok: true, filePath: finalPath, fileName: path.basename(finalPath) }, cors);
      } catch (e) {
        return send(res, 500, { ok: false, error: '保存失败：' + e.message }, cors);
      } finally {
        uploads.delete(id);
      }
    }

    /* ---- 任务列表 / 详情 / 取消 / 清理 ---- */
    if (pathname === '/api/tasks' && req.method === 'GET') {
      return send(res, 200, { ok: true, tasks: tasks.list() }, cors);
    }
    if (pathname === '/api/tasks/clear' && req.method === 'POST') {
      tasks.clear();
      return send(res, 200, { ok: true }, cors);
    }
    const mTask = pathname.match(/^\/api\/tasks\/([\w]+)(\/cancel)?$/);
    if (mTask) {
      if (mTask[2]) {
        const ok = tasks.cancel(mTask[1]);
        return send(res, ok ? 200 : 404, { ok }, cors);
      }
      const t = tasks.get(mTask[1]);
      return t ? send(res, 200, { ok: true, task: t }, cors) : send(res, 404, { ok: false, error: '任务不存在' }, cors);
    }

    /* ---- 探测（时长 / 标题 / 清晰度） ---- */
    if (pathname === '/api/probe' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.url) return send(res, 400, { ok: false, error: '缺少 url' }, cors);
      const tools = await ytdlp.detect();
      let info = null;
      if (body.useYtdlp !== false) info = await ytdlp.probe(body.url, { referer: body.referer });
      if (!info) {
        // 原生探测：HEAD 拿大小，m3u8 拿分片数与时长
        const headers = {};
        if (body.referer) headers.Referer = body.referer;
        if (body.userAgent) headers['User-Agent'] = body.userAgent;
        try {
          if (/\.m3u8(\?|$)/i.test(body.url)) {
            const r = await fetch(body.url, { headers });
            const text = await r.text();
            const pl = util.parseM3U8(text, body.url);
            if (pl.isMaster) {
              info = {
                title: util.guessTitleFromUrl(body.url),
                variants: pl.variants.map((v) => ({
                  resolution: v.resolution, bandwidth: v.bandwidth, url: v.url, isMasterVariant: true,
                })),
              };
            } else {
              info = { title: util.guessTitleFromUrl(body.url), duration: Math.round(pl.duration), segments: pl.segments.length };
            }
          } else {
            const r = await fetch(body.url, { method: 'HEAD', headers });
            info = {
              title: util.guessTitleFromUrl(body.url),
              size: Number(r.headers.get('content-length') || 0),
              contentType: r.headers.get('content-type') || '',
            };
          }
        } catch (e) {
          info = { title: util.guessTitleFromUrl(body.url), error: e.message };
        }
      }
      return send(res, 200, { ok: true, info, tools }, cors);
    }

    /* ---- 批量时长探测（MSE blob 配对指纹） ---- */
    if (pathname === '/api/probe-durations' && req.method === 'POST') {
      const body = await readBody(req);
      const urls = Array.isArray(body.urls) ? body.urls.filter((u) => /^https?:/i.test(u)) : [];
      if (!urls.length) return send(res, 400, { ok: false, error: '缺少 urls' }, cors);
      const results = await probeDurations(urls, body);
      return send(res, 200, { ok: true, results }, cors);
    }

    /* ---- 打开下载目录 ---- */
    if (pathname === '/api/open-folder' && req.method === 'POST') {
      const dir = cfg.downloadDir;
      fs.mkdirSync(dir, { recursive: true });
      const cmd = process.platform === 'win32'
        ? `explorer.exe "${dir}"`
        : process.platform === 'darwin' ? `open "${dir}"` : `xdg-open "${dir}"`;
      exec(cmd, () => {});
      return send(res, 200, { ok: true, dir }, cors);
    }

    /* ---- 运行配置 ---- */
    if (pathname === '/api/config') {
      if (req.method === 'GET') {
        return send(res, 200, {
          ok: true,
          config: {
            downloadDir: cfg.downloadDir,
            namingTemplate: cfg.namingTemplate,
            concurrency: cfg.concurrency,
            segmentConcurrency: cfg.segmentConcurrency,
            remuxToMp4: cfg.remuxToMp4,
            preferYtdlp: cfg.preferYtdlp,
            organize: cfg.organize,
          },
        }, cors);
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const allowed = ['downloadDir', 'namingTemplate', 'concurrency', 'segmentConcurrency', 'remuxToMp4', 'preferYtdlp', 'organize'];
        const patch = {};
        for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
        if (patch.organize && typeof patch.organize === 'object') {
          patch.organize = { ...(cfg.organize || {}), ...patch.organize };
        }
        Object.assign(cfg, config.update(patch));
        try { fs.mkdirSync(cfg.downloadDir, { recursive: true }); } catch (_) {}
        return send(res, 200, { ok: true, config: cfg }, cors);
      }
    }

    /* ---- 标题整理：预览计划 / 执行存量整理 ---- */
    if (pathname === '/api/organize') {
      if (req.method === 'GET') {
        try {
          const rows = organize.planAll(cfg);
          const summary = {
            total: rows.length,
            move: rows.filter((r) => r.action === 'move').length,
            rename: rows.filter((r) => r.action === 'rename').length,
            skip: rows.filter((r) => r.action === 'skip').length,
            series: rows.filter((r) => r.show).length,
            movie: rows.filter((r) => !r.show).length,
          };
          return send(res, 200, { ok: true, plan: rows.slice(0, 500), summary, enabled: !!(cfg.organize && cfg.organize.enabled) }, cors);
        } catch (e) {
          return send(res, 500, { ok: false, error: e.message }, cors);
        }
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (!body.apply) {
          return send(res, 400, { ok: false, error: '需要 {apply:true} 才会执行整理（先用 GET 预览）' }, cors);
        }
        try {
          const rows = organize.planAll(cfg);
          const stat = organize.applyPlan(cfg, rows);
          // 同步媒体库镜像（media-sync.sh 存在时；5 分钟 cron 兜底）
          const syncSh = path.join(config.ROOT, 'deploy', 'linux', 'media-sync.sh');
          if (fs.existsSync(syncSh)) {
            exec(`bash "${syncSh}"`, (err) => {
              if (err) console.warn('[organize] media-sync 执行失败：' + err.message);
            });
          }
          return send(res, 200, { ok: true, ...stat, total: rows.length }, cors);
        } catch (e) {
          return send(res, 500, { ok: false, error: e.message }, cors);
        }
      }
    }

    /* ---- 文件列表（局域网模式：从服务器浏览/取回已下载文件） ---- */
    if (pathname === '/api/files' && req.method === 'GET') {
      const root = path.resolve(cfg.downloadDir);
      const out = [];
      const walk = (dir, rel, depth) => {
        if (depth > 4 || out.length >= 500) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const e of entries) {
          if (out.length >= 500) return;
          const full = path.join(dir, e.name);
          const relPath = rel ? rel + '/' + e.name : e.name;
          if (e.isDirectory()) {
            walk(full, relPath, depth + 1);
          } else {
            try {
              const st = fs.statSync(full);
              out.push({
                path: relPath,
                name: e.name,
                size: st.size,
                mtime: st.mtimeMs,
                url: '/api/download-file?path=' + encodeURIComponent(full) + '&token=' + encodeURIComponent(cfg.token),
              });
            } catch (_) {}
          }
        }
      };
      walk(root, '', 0);
      out.sort((a, b) => b.mtime - a.mtime);
      return send(res, 200, { ok: true, dir: cfg.downloadDir, files: out }, cors);
    }

    /* ---- 自更新：检查公开仓库是否有新版本 ---- */
    if (pathname === '/api/update/check' && req.method === 'GET') {
      const r = await checkUpdate();
      return send(res, 200, r, cors);
    }

    /* ---- 自更新：git pull + 重启 ---- */
    if (pathname === '/api/update' && req.method === 'POST') {
      const r = await doUpdate();
      send(res, r.ok ? 200 : 500, r, cors);
      if (r.ok) setTimeout(restartAfterUpdate, 400);
      return;
    }

    /* ---- SSE 实时进度 ---- */
    if (pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...cors,
      });
      res.write(`data: ${JSON.stringify({ type: 'hello', version: VERSION })}\n\n`);
      const off = tasks.subscribe((type, payload) => {
        res.write(`data: ${JSON.stringify({ type, payload })}\n\n`);
      });
      const hb = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(hb);
        off();
      });
      return;
    }

    /* ---- 首页状态面板 ---- */
    if (pathname === '/' || pathname === '/index.html') {
      const tools = await ytdlp.detect();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(dashboardPage(tools));
    }

    /* ---- 手机版下载页：iPhone/安卓浏览器直接访问，粘贴分享链接即可下载 ---- */
    if (pathname === '/m' || pathname === '/mobile') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(mobilePage());
    }

    /* ---- iOS 安装引导页：Safari 书签（Bookmarklet）一键装 ---- */
    if (pathname === '/ios') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(iosGuidePage());
    }

    /* ---- 链路测速 / 批量下载页 ---- */
    if (pathname === '/speed' || pathname === '/links') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(speedPage());
    }

    if (pathname === '/api/download-file') {
      // 供用户从浏览器直接取回文件（可选）
      const file = url.searchParams.get('path');
      if (!file || !path.resolve(file).startsWith(path.resolve(cfg.downloadDir))) {
        return send(res, 400, { ok: false, error: '路径不合法' }, cors);
      }
      if (!fs.existsSync(file)) return send(res, 404, { ok: false, error: '文件不存在' }, cors);
      const stat = fs.statSync(file);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
      });
      return fs.createReadStream(file).pipe(res);
    }

    /* ---- 流式播放（供浏览器 / PotPlayer 直接播放局域网文件，支持拖动） ---- */
    if (pathname === '/api/stream') {
      const file = url.searchParams.get('path');
      if (!file || !path.resolve(file).startsWith(path.resolve(cfg.downloadDir))) {
        return send(res, 400, { ok: false, error: '路径不合法' }, cors);
      }
      let stat;
      try { stat = fs.statSync(file); } catch (_) { return send(res, 404, { ok: false, error: '文件不存在' }, cors); }
      if (!stat.isFile()) return send(res, 404, { ok: false, error: '不是文件' }, cors);
      const mime = mimeFor(file);
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = m && m[1] ? parseInt(m[1], 10) : 0;
        let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
        if (!Number.isFinite(start) || start < 0) start = 0;
        if (!Number.isFinite(end) || end >= stat.size) end = stat.size - 1;
        if (start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          return res.end();
        }
        res.writeHead(206, {
          'Content-Type': mime,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      });
      return fs.createReadStream(file).pipe(res);
    }

    /* ---- 删除下载目录里的文件 ---- */
    if (pathname === '/api/delete-file' && req.method === 'POST') {
      const file = url.searchParams.get('path');
      const root = path.resolve(cfg.downloadDir);
      if (!file || !path.resolve(file).startsWith(root + path.sep)) {
        return send(res, 400, { ok: false, error: '路径不合法' }, cors);
      }
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) return send(res, 400, { ok: false, error: '只能删除文件' }, cors);
        fs.unlinkSync(file);
        return send(res, 200, { ok: true }, cors);
      } catch (e) {
        return send(res, 404, { ok: false, error: '删除失败：' + e.message }, cors);
      }
    }

    return send(res, 404, { ok: false, error: 'Not found' }, cors);
  } catch (e) {
    console.error('[error]', e);
    return send(res, 500, { ok: false, error: e.message }, cors);
  }
});

/* ----------------------------- 面板页 ----------------------------- */

/** 请求方要 HTML 吗（Safari / 快捷指令「获取URL内容」都会带 Accept: text/html） */
function wantsHtml(req) {
  return /\btext\/html\b/i.test(String(req.headers.accept || ''));
}

/** 这个地址看起来是媒体流/文件（而不是网页） */
function looksLikeMedia(u) {
  const s = String(u || '');
  if (/\.(m3u8|mp4|m4v|webm|mkv|flv|mov|mp3|m4a|aac|mpd|ts)(\?|#|$)/i.test(s)) return true;
  if (/\/hls\//i.test(s)) return true;
  if (/mime_type=video/i.test(s)) return true;
  return false;
}

/** 手机端「已提交下载」页：显示标题与实时进度，提交后立刻有反馈 */
function quickDownloadPage(data, token) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const t = data && data.task;
  const bad = !data || data.ok === false;

  if (bad || data.error === 'PAGE') {
    const isPage = data && data.error === 'PAGE';
    return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${isPage ? '拿到的是网页地址' : '没提交成功'}</title>
<style>
 body{margin:0;font:15px/1.65 -apple-system,"PingFang SC",sans-serif;background:#f6f7f9;color:#1a1d21;padding:20px}
 .card{background:#fff;border-radius:14px;padding:18px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
 h1{font-size:18px;margin:0 0 12px;color:#b42318}
 ol{margin:8px 0 0;padding-left:20px} li{margin:7px 0}
 b{color:#2b6cff} code{background:#f2f3f5;padding:1px 5px;border-radius:4px;font-size:12.5px;word-break:break-all}
 .tip{background:#f6f8ff;border:1px solid #e0e7ff;color:#374151;padding:10px 12px;border-radius:9px;font-size:13px;margin-top:12px}
 a.btn{display:block;text-align:center;background:#2b6cff;color:#fff;text-decoration:none;padding:12px;border-radius:11px;margin-top:14px;font-weight:600}
</style></head><body><div class="card">
<h1>${isPage ? '这条链接是网页，不是视频流' : esc((data && data.error) || '提交失败')}</h1>
${isPage ? `<p>刚才提交的是页面地址：<br><code>${esc(data.url)}</code></p>
<p>说明脚本没在页面里找到直链，按下面重试：</p>
<ol>
 <li>回到那个视频页，<b>让视频真正播放 2~3 秒</b>（暂停或还在转圈时拿不到地址）</li>
 <li>点 Safari 的 <b>分享</b> → 选 <b>「视频下载」</b> 快捷指令</li>
 <li>若报「没找到直链」，看诊断页上的资源数，把截图发我</li>
</ol>
<div class="tip">也可以在电脑上装扩展下载；或直接用<a href="/m?token=${encodeURIComponent(token)}">手机网页版</a>粘贴分享链接。</div>`
      : `<p>${esc((data && data.error) || '未知错误')}</p>`}
<a class="btn" href="/ios">看安装/使用说明</a>
</div></body></html>`;
  }

  const st = { queued: '排队中', running: '下载中', merging: '合并中', decrypting: '解密中', done: '已完成', error: '失败', canceled: '已取消' }[t.status] || t.status;
  const color = t.status === 'error' ? '#b42318' : (t.status === 'done' ? '#12a150' : '#2b6cff');
  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${data.dup ? '已在下载' : '已提交下载'}</title>
<style>
 body{margin:0;font:15px/1.6 -apple-system,"PingFang SC",sans-serif;background:#f6f7f9;color:#1a1d21;padding:20px}
 .card{background:#fff;border-radius:14px;padding:18px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
 .big{font-size:22px;font-weight:700;margin:0 0 6px;color:${color}}
 .name{font-size:15px;color:#111;word-break:break-word;margin:8px 0 4px}
 .bar{height:8px;background:#eef0f3;border-radius:6px;overflow:hidden;margin:14px 0 8px}
 .bar i{display:block;height:100%;width:${Math.max(2, t.progress || 0)}%;background:#2b6cff;border-radius:6px;transition:width .3s}
 .meta{color:#6b7280;font-size:13px;display:flex;justify-content:space-between}
 .err{color:#b42318;font-size:13px;margin-top:10px;word-break:break-word}
 a.btn{display:block;text-align:center;background:#2b6cff;color:#fff;text-decoration:none;padding:12px;border-radius:11px;margin-top:18px;font-weight:600}
 .tip{color:#6b7280;font-size:12.5px;margin-top:12px}
</style></head><body><div class="card">
<p class="big" id="st">${data.dup ? '这个视频已经在下载了' : '已提交下载'} · ${esc(st)}</p>
<div class="name" id="name">${esc(t.title || '')}</div>
<div class="bar"><i id="bar"></i></div>
<div class="meta"><span id="pct">${Math.round(t.progress || 0)}%</span><span id="spd"></span></div>
<div class="err" id="err">${esc(t.error || '')}</div>
<div id="done" style="display:none;margin-top:14px"><a class="btn" id="dl" href="#">打开/播放文件</a></div>
<a class="btn" href="/m?token=${encodeURIComponent(token)}" style="background:#111">手机网页版（看队列和文件）</a>
<p class="tip">下载在服务器上跑，可以关掉这页；进度也能在手机网页版里看。</p>
</div>
<script>
(function(){
  var id=${JSON.stringify(t.id)}, token=${JSON.stringify(token)};
  var ST={queued:'排队中',running:'下载中',merging:'合并中',decrypting:'解密中',done:'已完成',error:'失败',canceled:'已取消'};
  function fmt(n){n=Number(n)||0;var u=['B','KB','MB','GB'],i=0;while(n>=1024&&i<u.length-1){n/=1024;i++}return n.toFixed(i?1:0)+' '+u[i];}
  function set(t){
    if(!t) return;
    var s=document.getElementById('st'), e=document.getElementById('err');
    s.textContent='${data.dup ? '这个视频已经在下载了' : '已提交下载'} · '+(ST[t.status]||t.status);
    if(t.title) document.getElementById('name').textContent=t.title;
    document.getElementById('bar').style.width=Math.max(2,t.progress||0)+'%';
    document.getElementById('pct').textContent=Math.round(t.progress||0)+'%';
    document.getElementById('spd').textContent=t.speed?fmt(t.speed)+'/s':'';
    e.textContent=t.error||'';
    if(t.status==='done'&&t.filePath){
      var d=document.getElementById('done');
      d.style.display='block';
      document.getElementById('dl').href='/api/download-file?token='+token+'&path='+encodeURIComponent(t.filePath);
    }
  }
  function tick(){
    fetch('/api/tasks?token='+encodeURIComponent(token),{cache:'no-store'})
      .then(function(r){return r.json()})
      .then(function(j){
        var t=(j.tasks||[]).filter(function(x){return x.id===id})[0];
        if(t){ set(t); if(t.status==='done'||t.status==='error'||t.status==='canceled') return; }
        setTimeout(tick,1500);
      }).catch(function(){ setTimeout(tick,4000); });
  }
  setTimeout(tick,1200);
})();
</script>
</body></html>`;
}

/** 链路测速页（/speed）：测代理节点真实带宽 → 选最快的那条用于下载 */
function speedPage() {
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>链路测速 · 视频下载</title>
<style>
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;font:15px/1.55 -apple-system,"SF Pro SC","PingFang SC","Microsoft YaHei",sans-serif;background:#f6f7f9;color:#1a1d21;padding-bottom:40px}
  header{background:#fff;padding:15px 18px 12px;border-bottom:1px solid #eef0f3;position:sticky;top:0;z-index:10}
  header h1{font-size:18px;margin:0;display:flex;align-items:center;gap:8px}
  header .dot{width:8px;height:8px;border-radius:50%;background:#12a150;flex:none}
  header .sub{color:#6b7280;font-size:12.5px;margin-top:4px}
  main{padding:14px 14px 40px;max-width:760px;margin:0 auto}
  .card{background:#fff;border-radius:14px;padding:14px 15px;margin-bottom:12px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
  .card h2{font-size:14px;margin:0 0 10px;color:#374151;font-weight:600;display:flex;justify-content:space-between;align-items:center}
  .card h2 .n{color:#9aa0a6;font-weight:400;font-size:12px}
  textarea,input[type=text]{width:100%;border:1px solid #dfe2e7;border-radius:10px;padding:10px 12px;font-size:15px;font-family:inherit;outline:none;background:#fbfcfd;color:#1a1d21}
  textarea{min-height:76px;resize:vertical}
  textarea:focus,input:focus{border-color:#2b6cff;background:#fff}
  .btn{width:100%;border:0;border-radius:11px;padding:13px;font-size:16px;font-weight:600;color:#fff;background:#2b6cff;margin-top:10px;cursor:pointer}
  .btn:disabled{background:#b9c6e8;cursor:default}
  .btn.ghost{background:#eef3ff;color:#2b6cff;font-size:14px;padding:9px}
  .hint{color:#9aa0a6;font-size:12px;margin-top:8px}
  .now{font-size:17px;font-weight:600;word-break:break-all}
  .row2{display:flex;gap:10px;margin-top:10px}
  .row2 label{flex:1;font-size:12.5px;color:#6b7280}
  .row2 input{width:100%;border:1px solid #dfe2e7;border-radius:9px;padding:8px 10px;font-size:14px;margin-top:4px}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th,td{text-align:left;padding:8px 4px;border-bottom:1px solid #f2f3f5;vertical-align:middle}
  th{color:#9aa0a6;font-weight:500;font-size:12px}
  td.sp{font-weight:600;color:#12a150;white-space:nowrap}
  td.lat{color:#6b7280;white-space:nowrap}
  .node{word-break:break-all}
  .use{border:1px solid #dfe2e7;background:#fff;color:#2b6cff;border-radius:8px;padding:5px 10px;font-size:12.5px;cursor:pointer}
  .use.cur{background:#eef3ff;border-color:#cddcff}
  .empty{color:#9aa0a6;font-size:13px;text-align:center;padding:16px 0}
  .toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:rgba(20,22,26,.92);color:#fff;padding:10px 16px;border-radius:10px;font-size:13.5px;opacity:0;transition:opacity .25s;pointer-events:none;z-index:99;max-width:88vw;text-align:center}
  .toast.show{opacity:1}
</style></head>
<body>
<header>
  <h1><span class="dot"></span>链路测速</h1>
  <div class="sub" id="sub">读取节点中…</div>
</header>
<main>
  <div class="card" id="tokenCard" style="display:none">
    <h2>访问码</h2>
    <input type="text" id="tokenInput" placeholder="粘贴服务端 Token" autocapitalize="off" spellcheck="false">
    <button class="btn" id="saveToken" type="button">确定</button>
  </div>

  <div class="card">
    <h2>当前线路 <span class="n" id="grp"></span></h2>
    <div class="now" id="now">—</div>
    <div class="hint">下载走 Clash 的 <b id="grpName">良心云</b> 分组（TUN 模式全量代理），这里选哪条，下载就用哪条。</div>
    <div id="quick" style="margin-top:8px"></div>
    <div class="row2">
      <label>深度测速节点数<input id="top" type="number" value="8" min="1" max="30"></label>
      <label>每个节点下（MB）<input id="mb" type="number" value="6" min="1" max="30"></label>
    </div>
    <button class="btn" id="test" type="button">开始测速</button>
    <div class="hint">先测全部节点延迟 → 取最快的几个逐个切过去真下数据。测速期间其他走代理的流量会短暂受影响，结束后自动还原。</div>
  </div>

  <div class="card">
    <h2>测速结果 <span class="n" id="took"></span></h2>
    <div id="res"><div class="empty">还没有测过</div></div>
  </div>

  <div class="card">
    <h2>批量下载 <span class="n">一行一个链接</span></h2>
    <textarea id="batch" placeholder="https://hanime1.me/watch?v=38054&#10;https://missav.ws/dm30/cn/lulu-271-uncensored-leak&#10;……"></textarea>
    <button class="btn" id="go" type="button">全部提交</button>
    <div class="hint">按服务器并发数自动排队；提交后可以关掉这一页，下载在服务器继续。</div>
  </div>
</main>
<div class="toast" id="toast"></div>
<script>
(function () {
  var TOKEN_KEY = 'wvd_token';
  var token = '';
  try { token = new URLSearchParams(location.search).get('token') || ''; } catch (e) {}
  if (token) { try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {} }
  else { try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) {} }

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function toast(m) {
    var t = $('toast');
    t.textContent = m;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }
  function api(path, body) {
    var sep = path.indexOf('?') >= 0 ? '&' : '?';
    var url = path + sep + 'token=' + encodeURIComponent(token);
    var opt = body ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    } : {};
    return fetch(url, opt).then(function (r) { return r.json(); });
  }
  function showToken(on) { $('tokenCard').style.display = on ? '' : 'none'; }
  $('saveToken').onclick = function () {
    token = $('tokenInput').value.trim();
    try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {}
    showToken(false); load();
  };

  function render(st, curNode) {
    $('grp').textContent = st.group || '';
    $('grpName').textContent = st.group || '良心云';
    $('now').textContent = st.applied || st.now || '未知';
    // 分组里嵌套的子分组（自动选择 / 故障转移 …）：一键切回去用自动挑的
    var q = $('quick');
    if (q) {
      q.innerHTML = '';
      var names = {};
      for (var gi = 0; gi < (st.groups || []).length; gi++) names[st.groups[gi].name] = 1;
      for (var ci = 0; ci < (st.children || []).length; ci++) {
        var cn = st.children[ci];
        if (!names[cn]) continue;
        var b = document.createElement('button');
        b.className = 'use' + (cn === st.now ? ' cur' : '');
        b.style.marginRight = '8px';
        b.textContent = '用 ' + cn;
        b.setAttribute('data-node', cn);
        b.onclick = function () {
          var node = this.getAttribute('data-node');
          api('/api/net/select', { node: node }).then(function (r) {
            if (r.ok) { toast('已切换到 ' + node); load(); } else toast(r.error || '切换失败');
          }).catch(function () { toast('切换失败'); });
        };
        q.appendChild(b);
      }
    }
    if (st.now) $('sub').textContent = '当前：' + st.now + (st.all ? ' · 共 ' + st.all + ' 个节点' : '');
    var links = (st.links && st.links.length) ? st.links : ((st.last && st.last.links) || []);
    $('took').textContent = st.at ? new Date(st.at).toLocaleTimeString('zh-CN', { hour12: false }) : '';
    if (!links.length) return;
    var h = '<table><tr><th>线路</th><th>延迟</th><th>速度</th><th></th></tr>';
    for (var i = 0; i < links.length; i++) {
      var l = links[i];
      var cur = (l.node === curNode) || (l.node === st.now);
      h += '<tr><td class="node">' + esc(l.node) + '</td>'
        + '<td class="lat">' + (l.delay > 0 ? l.delay + 'ms' : '—') + '</td>'
        + '<td class="sp">' + (l.speed > 0 ? l.speed.toFixed(2) + ' MB/s' : (l.error ? '失败' : '—')) + '</td>'
        + '<td><button class="use' + (cur ? ' cur' : '') + '" data-node="' + esc(l.node) + '">' + (cur ? '当前' : '用这条') + '</button></td></tr>';
    }
    h += '</table>';
    if (links[0] && links[0].speed > 0) {
      h += '<div class="hint">最快：<b>' + esc(links[0].node) + '</b> · ' + links[0].speed.toFixed(2) + ' MB/s</div>';
    }
    var box = $('res');
    box.innerHTML = h;
    var btns = box.querySelectorAll('.use');
    for (var k = 0; k < btns.length; k++) {
      btns[k].onclick = function () {
        var node = this.getAttribute('data-node');
        this.disabled = true;
        api('/api/net/select', { node: node }).then(function (r) {
          if (r.ok) { toast('已切换到 ' + node); load(); }
          else toast(r.error || '切换失败');
        }).catch(function () { toast('切换失败'); });
      };
    }
  }

  function load() {
    api('/api/net/status').then(function (r) {
      if (r.available === false) {
        $('sub').textContent = '未检测到 Clash 控制接口：' + (r.error || '');
        $('now').textContent = '不可用';
        $('test').disabled = true;
        return;
      }
      render(r, '');
    }).catch(function () { showToken(!token); });
  }

  $('test').onclick = function () {
    var btn = this;
    btn.disabled = true;
    var t0 = Date.now();
    btn.textContent = '测速中…（约 ' + Math.max(10, Number($('top').value) * 8) + ' 秒）';
    $('sub').textContent = '正在逐个切换节点测速，请稍等…';
    api('/api/net/test', {
      top: Number($('top').value) || 8,
      bytes: Number($('mb').value) || 6,
      auto: false
    }).then(function (r) {
      btn.disabled = false;
      btn.textContent = '重新测速';
      if (!r.ok) { toast(r.error || '测速失败'); $('sub').textContent = r.error || '测速失败'; return; }
      render(r, '');
      var secs = Math.round((Date.now() - t0) / 1000);
      $('sub').textContent = '测速完成 · 用了 ' + secs + ' 秒 · 已还原原节点';
      toast('测速完成');
    }).catch(function () {
      btn.disabled = false;
      btn.textContent = '重新测速';
      toast('测速失败');
    });
  };

  $('go').onclick = function () {
    var lines = String($('batch').value || '').split(/\\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!lines.length) return toast('先贴几个链接');
    var btn = this;
    btn.disabled = true;
    var n = 0, fail = 0, idx = 0;
    function next() {
      if (idx >= lines.length) {
        btn.disabled = false;
        toast('已提交 ' + n + ' 个' + (fail ? '，失败 ' + fail + ' 个' : ''));
        return;
      }
      var raw = lines[idx++];
      var i = raw.indexOf('http');
      var u = i >= 0 ? raw.slice(i).split(/[\\s，。、）)】]/)[0] : '';
      if (!u) { fail++; return next(); }
      fetch('/api/download?token=' + encodeURIComponent(token), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: u })
      }).then(function (r) { return r.json(); })
        .then(function (r) { if (r.ok) n++; else fail++; next(); })
        .catch(function () { fail++; next(); });
    }
    next();
  };

  if (!token) showToken(true);
  load();
})();
</script>
</body></html>`;
}

function mimeFor(file) {
  const map = {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska',
    '.webm': 'video/webm', '.flv': 'video/x-flv', '.mov': 'video/quicktime',
    '.ts': 'video/mp2t', '.m3u8': 'application/vnd.apple.mpegurl',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  };
  return map[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function dashboardPage(tools) {
  const dot = (ok) => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${ok ? '#12a150' : '#e5484d'};margin-right:6px"></span>`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>网页视频下载 · 本地服务</title>
<style>
 body{font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f6f7f9;color:#1a1d21;margin:0;padding:40px}
 .card{max-width:720px;margin:0 auto;background:#fff;border-radius:14px;padding:28px 30px;box-shadow:0 1px 3px rgba(0,0,0,.06),0 12px 32px rgba(0,0,0,.05)}
 h1{font-size:20px;margin:0 0 4px} p.sub{color:#6b7280;margin:0 0 22px}
 .row{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #f0f1f3}
 .row:last-child{border:0} code{background:#f2f3f5;padding:2px 6px;border-radius:5px;font-size:12.5px;word-break:break-all}
 .warn{background:#fff7e6;border:1px solid #ffe0a3;color:#8a5b00;padding:10px 14px;border-radius:9px;margin-top:16px;font-size:13px}
 a{color:#2b6cff}
</style>
<div class="card">
  <h1>网页视频下载 · 本地服务运行中</h1>
  <p class="sub">v${VERSION} · 监听 ${bindHost === '0.0.0.0' ? '所有网卡' : bindHost}:${cfg.port}${LAN_BIND ? ' · 局域网可访问（需 Token）' : ' · 只接受本机请求'}</p>
  <div class="row"><span>下载目录</span><code>${cfg.downloadDir}</code></div>
  ${LAN_BIND ? `<div class="row"><span>局域网地址</span><code>${lanAddresses().map((a) => `http://${a}:${cfg.port}`).join(' · ')}</code></div>` : ''}
  ${LAN_BIND ? `<div class="row"><span>手机访问</span><code><a href="http://${lanAddresses()[0] || '127.0.0.1'}:${cfg.port}/m?token=${cfg.token}" target="_blank">http://${lanAddresses()[0] || '127.0.0.1'}:${cfg.port}/m</a><br>手机打开上面地址即可（已含访问码，别分享给别人）</code></div>` : ''}
  <div class="row"><span>yt-dlp</span><span>${dot(tools.ytdlp.ok)}${tools.ytdlp.ok ? tools.ytdlp.version : '未安装（复杂站点需要）'}</span></div>
  <div class="row"><span>ffmpeg</span><span>${dot(tools.ffmpeg.ok)}${tools.ffmpeg.ok ? '已安装（可合并音视频/转 MP4）' : '未安装（HLS 会保存为 .ts）'}</span></div>
  <div class="row"><span>并发 / 分片并发</span><span>${cfg.concurrency} / ${cfg.segmentConcurrency}</span></div>
  <div class="row"><span>链路测速 / 批量下载</span><code><a href="/speed?token=${cfg.token}" target="_blank">/speed</a>（测代理节点真实带宽，选最快的下载）</code></div>
  <div class="row"><span>API</span><code>GET /api/tasks · GET /api/files · POST /api/download · GET /api/events</code></div>
  ${tools.ytdlp.ok && tools.ffmpeg.ok ? '' : '<div class="warn">建议运行 <code>setup.bat</code> 安装 yt-dlp 与 ffmpeg，可支持更多站点并自动合并音视频。</div>'}
  <div class="warn">请只下载你有权保存的内容，并遵守目标网站的服务条款与相关法律。</div>
</div></html>`;
}

/** 手机版下载页（移动端友好：粘贴分享链接 → 下到服务器 → 看进度 → 存手机/播放） */
function mobilePage() {
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="theme-color" content="#ffffff">
<title>视频下载</title>
<style>
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;font:15px/1.55 -apple-system,"SF Pro SC","PingFang SC","Microsoft YaHei",sans-serif;background:#f6f7f9;color:#1a1d21;padding-bottom:env(safe-area-inset-bottom)}
  header{background:#fff;padding:15px 18px 12px;border-bottom:1px solid #eef0f3;position:sticky;top:0;z-index:10}
  header h1{font-size:18px;margin:0;display:flex;align-items:center;gap:8px}
  header .dot{width:8px;height:8px;border-radius:50%;background:#12a150;flex:none}
  header .sub{color:#6b7280;font-size:12.5px;margin-top:4px}
  main{padding:14px 14px 40px}
  .card{background:#fff;border-radius:14px;padding:14px 15px;margin-bottom:12px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
  .card h2{font-size:14px;margin:0 0 10px;color:#374151;font-weight:600;display:flex;justify-content:space-between;align-items:center}
  .card h2 .n{color:#9aa0a6;font-weight:400;font-size:12px}
  textarea,input[type=text]{width:100%;border:1px solid #dfe2e7;border-radius:10px;padding:10px 12px;font-size:15px;font-family:inherit;outline:none;background:#fbfcfd;color:#1a1d21}
  textarea:focus,input:focus{border-color:#2b6cff;background:#fff}
  textarea{min-height:76px;resize:vertical}
  .btn{width:100%;border:0;border-radius:11px;padding:13px;font-size:16px;font-weight:600;color:#fff;background:#2b6cff;margin-top:10px;cursor:pointer}
  .btn:active{opacity:.85}
  .btn:disabled{background:#b9c6e8}
  .hint{color:#9aa0a6;font-size:12px;margin-top:8px}
  .task{padding:11px 0;border-bottom:1px solid #f2f3f5}
  .task:last-child{border-bottom:0}
  .task .t{font-size:14px;font-weight:500;word-break:break-all;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .task .meta{font-size:12px;color:#9aa0a6;margin-top:4px;display:flex;justify-content:space-between;gap:10px}
  .task .err{font-size:11.5px;color:#e5484d;margin-top:4px;word-break:break-all;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .bar{height:5px;background:#eef0f4;border-radius:3px;margin-top:7px;overflow:hidden}
  .bar i{display:block;height:100%;background:#2b6cff;border-radius:3px;transition:width .4s}
  .st-done{color:#12a150}.st-error{color:#e5484d}.st-run{color:#2b6cff}
  .file{display:flex;align-items:center;gap:11px;padding:11px 0;border-bottom:1px solid #f2f3f5;text-decoration:none;color:inherit}
  .file:last-child{border-bottom:0}
  .file:active{opacity:.7}
  .file .ico{width:34px;height:34px;border-radius:9px;background:#eef3ff;color:#2b6cff;display:flex;align-items:center;justify-content:center;font-size:15px;flex:none}
  .file .info{flex:1;min-width:0}
  .file .n{font-size:13.5px;word-break:break-all;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .file .s{font-size:11.5px;color:#9aa0a6;margin-top:2px}
  .empty{color:#9aa0a6;font-size:13px;text-align:center;padding:16px 0}
  .toast{position:fixed;left:50%;bottom:calc(28px + env(safe-area-inset-bottom));transform:translateX(-50%);background:rgba(20,22,26,.92);color:#fff;padding:10px 16px;border-radius:10px;font-size:13.5px;opacity:0;transition:opacity .25s;pointer-events:none;z-index:99;max-width:88vw;text-align:center}
  .toast.show{opacity:1}
</style></head>
<body>
<header>
  <h1><span class="dot"></span>视频下载</h1>
  <div class="sub" id="sub">连接中…</div>
</header>
<main>
  <div class="card" id="tokenCard" style="display:none">
    <h2>访问码</h2>
    <input type="text" id="tokenInput" placeholder="粘贴服务端 Token" autocapitalize="off" autocorrect="off" spellcheck="false">
    <button class="btn" type="button" data-act="saveToken">确定</button>
    <div class="hint">在服务器 server/config.json 的 token 字段，或电脑端状态页复制「手机访问」链接</div>
  </div>

  <div class="card">
    <h2>粘贴分享链接</h2>
    <textarea id="input" placeholder="抖音 / 快手 / B站 / missav 的分享文案或链接，整段粘贴即可"></textarea>
    <button class="btn" id="go" type="button" data-act="submit">开始下载</button>
    <div class="hint">自动从分享文案提取链接；下载在服务器完成，完成后点文件即可存到手机</div>
  </div>

  <div class="card">
    <h2>下载任务 <span class="n" id="taskCount"></span></h2>
    <div id="tasks"><div class="empty">暂无任务</div></div>
  </div>

  <div class="card">
    <h2>已下载文件 <span class="n" id="fileCount"></span></h2>
    <div id="files"><div class="empty">加载中…</div></div>
  </div>
</main>
<div class="toast" id="toast"></div>
<script>
(function () {
  var TOKEN_KEY = 'wvd_token';
  var token = '';
  try { token = new URLSearchParams(location.search).get('token') || ''; } catch (e) {}
  if (token) { try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {} }
  else { try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) {} }

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }
  function fmt(n) {
    n = Number(n) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }
  /** 从整段分享文案里提取第一个 http(s) 链接（到空白或中文标点为止，避免正则转义问题） */
  function extractUrl(raw) {
    var s = String(raw || '').trim();
    var i = s.indexOf('http');
    if (i < 0) return '';
    var tail = s.slice(i);
    var stops = [' ', '\\n', '\\r', '\\t', '，', '。', '；', '、', '！', '？', '）', '】', '」', '』', '"', "'", '“', '”'];
    var end = tail.length;
    for (var k = 0; k < stops.length; k++) {
      var p = tail.indexOf(stops[k]);
      if (p >= 0 && p < end) end = p;
    }
    return tail.slice(0, end);
  }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json', 'X-Auth-Token': token }, opts.headers || {});
    return fetch(path, opts).then(function (r) { return r.json(); });
  }

  function saveToken() {
    var v = ($('tokenInput').value || '').trim();
    if (!v) { toast('请输入访问码'); return; }
    token = v;
    try { localStorage.setItem(TOKEN_KEY, v); } catch (e) {}
    $('tokenCard').style.display = 'none';
    refresh();
  }

  function submit() {
    var raw = $('input').value || '';
    var url = extractUrl(raw);
    if (!url) { toast('没识别到链接，请检查分享文案'); return; }
    if (!token) { $('tokenCard').style.display = 'block'; toast('请先填写访问码'); return; }
    var btn = $('go');
    btn.disabled = true; btn.textContent = '提交中…';
    api('/api/download', {
      method: 'POST',
      body: JSON.stringify({ url: url, title: '', kind: 'auto', mode: 'auto', referer: location.origin }),
    }).then(function (r) {
      btn.disabled = false; btn.textContent = '开始下载';
      if (r && r.ok) { $('input').value = ''; toast('已提交，正在下载'); refresh(); }
      else { toast('失败：' + ((r && r.error) || '未知错误')); }
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = '开始下载';
      toast('网络错误：' + (e && e.message || e));
    });
  }

  function renderTasks(list) {
    var box = $('tasks');
    $('taskCount').textContent = list && list.length ? list.length + ' 条' : '';
    if (!list || !list.length) { box.innerHTML = '<div class="empty">暂无任务</div>'; return; }
    var html = '';
    list.slice(0, 10).forEach(function (t) {
      var st = t.status, label = '排队中', cls = '';
      if (st === 'running' || st === 'decrypting' || st === 'merging') {
        label = '下载中' + (t.progress ? ' ' + Math.round(t.progress) + '%' : '');
        cls = 'st-run';
      } else if (st === 'done') { label = '已完成'; cls = 'st-done'; }
      else if (st === 'error') { label = '失败'; cls = 'st-error'; }
      else if (st === 'canceled') { label = '已取消'; }
      html += '<div class="task"><div class="t">' + esc(t.title || '未命名') + '</div>';
      html += '<div class="meta"><span class="' + cls + '">' + label + '</span><span>' + esc(t.engine || '') + '</span></div>';
      if (st === 'running' || st === 'merging' || st === 'decrypting') {
        html += '<div class="bar"><i style="width:' + (Number(t.progress) || 0) + '%"></i></div>';
      }
      if (st === 'error' && t.error) html += '<div class="err">' + esc(String(t.error).slice(0, 160)) + '</div>';
      html += '</div>';
    });
    box.innerHTML = html;
  }

  function renderFiles(list) {
    var box = $('files');
    $('fileCount').textContent = list && list.length ? list.length + ' 个' : '';
    if (!list || !list.length) { box.innerHTML = '<div class="empty">还没有下载完成的文件</div>'; return; }
    var html = '';
    list.slice(0, 30).forEach(function (f) {
      html += '<a class="file" href="' + esc(f.url) + '" target="_blank" rel="noopener">'
        + '<div class="ico">&#9654;</div><div class="info"><div class="n">' + esc(f.name || '') + '</div>'
        + '<div class="s">' + fmt(f.size) + '</div></div></a>';
    });
    box.innerHTML = html;
  }

  function refresh() {
    if (!token) { $('tokenCard').style.display = 'block'; $('sub').textContent = '需要访问码'; return; }
    Promise.all([
      api('/api/health').catch(function () { return null; }),
      api('/api/tasks').catch(function () { return null; }),
      api('/api/files').catch(function () { return null; }),
    ]).then(function (r) {
      var h = r[0], t = r[1], f = r[2];
      if (t && t.ok === false && String(t.error || '').indexOf('token') >= 0) {
        $('sub').textContent = '访问码无效，请重新填写';
        $('tokenCard').style.display = 'block';
        return;
      }
      if (h && h.ok) {
        var busy = (Number(h.active) || 0) + (Number(h.queued) || 0);
        $('sub').textContent = '已连接 · v' + (h.version || '') + ' · ' + (busy ? busy + ' 个任务进行中' : '空闲');
        $('tokenCard').style.display = 'none';
      }
      renderTasks((t && t.tasks) || []);
      renderFiles((f && f.files) || []);
    });
  }

  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    var act = el.getAttribute('data-act');
    if (act === 'saveToken') saveToken();
    else if (act === 'submit') submit();
  });
  $('input').addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
  });

  if (!token) $('tokenCard').style.display = 'block';
  refresh();
  setInterval(refresh, 1500);
})();
</script>
</body></html>`;
}

/** Safari 书签（Bookmarklet）代码模板：__TOKEN__ 运行时替换成访问码 */
const BM_TEMPLATE = String.raw`javascript:(function(){var h=location.hostname,c=[],S={};function A(u){u=String(u||'').trim();if(!/^https?:\/\//i.test(u)||/\.(ts|m4s|jpg|jpeg|png|gif|webp|css|js)(\?|$)/i.test(u)||S[u])return;S[u]=1;c.push(u)}try{performance.getEntriesByType('resource').forEach(function(e){var n=e.name||'';if(/\.m3u8(\?|$)/i.test(n)||/\.mp4(\?|$)/i.test(n))A(n)})}catch(e){}document.querySelectorAll('video').forEach(function(v){var x=v.currentSrc||v.src||'';if(/^https?:/i.test(x))A(x)});if(/hanime1?\./i.test(h)){var P=[];document.querySelectorAll('a[href]').forEach(function(a){if(/download|下载/i.test(a.href)||/download|下载/i.test(a.textContent||''))P.push(a.href)});try{var v=new URLSearchParams(location.search).get('v');if(v)P.push(location.origin+'/download?v='+v)}catch(e){}P.slice(0,3).forEach(function(u){try{var x=new XMLHttpRequest();x.open('GET',u,false);x.send();if(x.status>199&&x.status<300){var m,R=/https?:\/\/[^"'\s<>]*\.mp4[^"'\s<>]*/gi;while((m=R.exec(x.responseText)))A(m[0])}}catch(e){}})}function Q(u){var s=/playlist\.m3u8/i.test(u)?1e5:0,m=u.match(/(\d{3,4})p/i);if(m)s+=+m[1];if(/1080/.test(u))s=Math.max(s,1080);else if(/720/.test(u))s=Math.max(s,720);return s}c.sort(function(a,b){return Q(b)-Q(a)});var u=c[0]||'',M=u.match(/^(https?:\/\/surrit\.com\/[0-9a-f-]{36})\/(?:\d{3,4}p\/)?(?:video|playlist)\.m3u8(\?.*)?$/i);if(M)u=M[1]+'/playlist.m3u8'+(M[2]||'');if(!u){alert('没找到视频直链，先让视频播放几秒再试');return}var t='http://192.168.5.22:8765/api/quick-download?token=__TOKEN__&title='+encodeURIComponent((document.title||'').slice(0,150))+'&referer='+encodeURIComponent(location.href)+'&url='+encodeURIComponent(u);if(!window.open(t,'_blank'))location.href=t})();`;

/** iOS 安装引导页：把书签代码直接呈现出来，复制即用 */
function iosGuidePage() {
  const bm = BM_TEMPLATE.replace('__TOKEN__', cfg.token);
  let scJs = '';
  try { scJs = fs.readFileSync(path.join(config.ROOT, 'ios', 'shortcut-web-js.js'), 'utf8'); } catch (_) {}
  const escHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>iPhone 安装</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f6f7f9;color:#1a1d21;padding-bottom:env(safe-area-inset-bottom)}
  header{background:#fff;padding:16px 18px 12px;border-bottom:1px solid #eef0f3}
  header h1{font-size:18px;margin:0}
  header .sub{color:#6b7280;font-size:12.5px;margin-top:4px}
  main{padding:14px}
  .card{background:#fff;border-radius:14px;padding:15px 16px;margin-bottom:12px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
  .card h2{font-size:15px;margin:0 0 10px;color:#111}
  .steps{margin:0;padding-left:20px;font-size:14px}
  .steps li{margin-bottom:9px;word-break:break-word}
  .steps b{color:#2b6cff}
  textarea{width:100%;height:120px;border:1px solid #dfe2e7;border-radius:10px;padding:9px 10px;font:11px/1.5 ui-monospace,Menlo,monospace;background:#fbfcfd;color:#374151;resize:vertical;margin-top:6px;word-break:break-all}
  .btn{width:100%;border:0;border-radius:11px;padding:13px;font-size:16px;font-weight:600;color:#fff;background:#2b6cff;margin-top:10px}
  .btn:active{opacity:.85}
  .hint{color:#6b7280;font-size:13px;margin:0}
  .warn{background:#fff7e6;border:1px solid #ffe0a3;color:#8a5b00;padding:10px 12px;border-radius:9px;font-size:13px;margin-top:10px}
  code{background:#f2f3f5;padding:1px 5px;border-radius:4px;font-size:12px}
  .toast{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);background:rgba(20,22,26,.92);color:#fff;padding:10px 16px;border-radius:10px;font-size:13.5px;opacity:0;transition:opacity .25s;pointer-events:none;z-index:99}
  .toast.show{opacity:1}
</style></head>
<body>
<header>
  <h1>iPhone 安装下载工具</h1>
  <div class="sub">Safari 里点一下书签，自动识别当前页最高画质并下载</div>
</header>
<main>
  <div class="card">
    <h2>方案 A · Safari 书签（推荐，无需 Mac）</h2>
    <ol class="steps">
      <li>点最下方 <b>「复制代码」</b></li>
      <li>Safari 随便打开一个网页 → <b>分享</b> → <b>添加到书签</b> → 保存（收藏夹选「个人收藏」）</li>
      <li>打开书签列表 → <b>编辑</b> → 选中刚加的那条 → 名称改成 <b>视频下载</b>，网址栏<b>全选删掉、粘贴刚复制的代码</b> → 完成</li>
      <li>以后在视频页：<b>让视频播 2~3 秒</b> → 点地址栏 → 个人收藏 → <b>视频下载</b></li>
    </ol>
    <textarea id="bm" readonly spellcheck="false">${bm.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
    <button class="btn" type="button" onclick="cp()">复制代码</button>
    <div class="warn">代码里已内置访问码，请勿把这条书签分享给别人。</div>
  </div>

  <div class="card">
    <h2>方案 B · 快捷指令（2 个动作，约 2 分钟）</h2>
    <ol class="steps">
      <li><b>设置 → 快捷指令 → 打开「允许运行脚本」</b>（iOS 17/18 在「设置 → 快捷指令 → 高级」里）</li>
      <li>打开「快捷指令」App → 右上角 <b>+</b>，只保留两个动作：<br>
        ① <b>接收</b>「Safari 浏览器」的<b>网页</b>输入（分享到本快捷指令时自动带进来）<br>
        ② <b>「在网页上运行 JavaScript」</b> → 把下面这段脚本<b>全部粘贴</b>进去<br>
        <span class="hint">认准动作名：<b>在网页上运行 JavaScript</b>（蓝色 Safari 指南针图标，在操作列表「网页」分组最下面）。
        不是「获取网页内容」（那是文章/RSS 提取器），也不是「获取 Safari 浏览器网页的详细信息」（只给标题和网址，跑不了脚本）。</span></li>
      <li>粘贴方法（这段编辑区<b>长按只会弹出「变量菜单」</b>，不是粘贴菜单）：<br>
        <b>① </b>点进脚本区让光标闪 <b>② </b>用<b>双击</b>选中任意一个单词 → 弹出「剪切/拷贝/粘贴/全选」→ 点 <b>全选</b> <b>③ </b>再点 <b>粘贴</b>（整段旧脚本被替换）。<br>
        <span class="hint">粘完自检：第一行应是 <code>// iOS 快捷指令 ·「在网页上运行 JavaScript」脚本  (v2)</code>，最后一行应是 <code>})();</code>。
        如果看到的最后一行是 <code>completion(result);</code>，说明还是苹果的默认模板，没粘进去。</span></li>
      <li><b>不要再加「获取 URL 内容」</b>。脚本自己会把页面跳到服务器，并显示「已提交下载 · 进度」页，所以不会再出现「请确保传递了有效 URL」。<br>如果旧版快捷指令里还留着这个动作，<b>左滑删掉</b>；留着也不会重复下载（服务端 2 分钟内同地址只建一个任务）。</li>
      <li>点快捷指令名字改成 <b>视频下载</b>；点 <b>ⓘ</b> → 打开 <b>「在分享表单中显示」</b> → 接收类型勾 <b>URL</b> 和 <b>文本</b></li>
      <li><b>务必在 Safari 的视频页里</b>点 <b>分享 → 视频下载</b> 运行。在「快捷指令」App 里点 ▶ 测试是无效的——那时前台是快捷指令自己，取不到网页，结果会是空的。</li>
    </ol>
    <textarea id="sc" readonly spellcheck="false">${escHtml(scJs)}</textarea>
    <button class="btn" type="button" onclick="cp2()">复制脚本</button>
    <div class="warn">粘不进去就先走上面的<b>方案 A（书签）</b>：书签的网址栏是普通文本框，粘贴和编辑都更简单，效果完全一样。</div>
  </div>

  <div class="card">
    <h2>能做什么</h2>
    <p class="hint">
      · <b>missav</b>：自动取 master 列表 → 最高 1080p<br>
      · <b>hanime1</b>：自动抓「下载页」→ 各画质里选最高<br>
      · 普通网页：读页面里的 video 直链<br>
      · 手机和服务器要在同一 Wi-Fi；下载在服务器完成，进度看 <a href="/m">手机网页版</a>
    </p>
  </div>
</main>
<div class="toast" id="toast"></div>
<script>
function toast(m){var t=document.getElementById('toast');t.textContent=m;t.classList.add('show');clearTimeout(t._h);t._h=setTimeout(function(){t.classList.remove('show');},2200);}
function copyEl(id, okMsg){
  var t=document.getElementById(id);
  if(!t) return;
  t.focus();t.select();
  try{t.setSelectionRange(0,999999);}catch(e){}
  var v=t.value;
  function ok(){toast(okMsg);}
  function fail(){toast('自动复制失败，请长按代码框手动全选复制');}
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(v).then(ok,fail);
  }else{
    try{document.execCommand('copy')?ok():fail();}catch(e){fail();}
  }
}
function cp(){copyEl('bm','已复制，去 书签 → 编辑 里粘贴');}
function cp2(){copyEl('sc','已复制，去「在网页上运行 JavaScript」里粘贴');}
</script>
</body></html>`;
}

/* ----------------------------- 启动 ----------------------------- */

/**
 * 打包成 exe 后：首次运行时把桌面快捷方式装好（正常软件的安装行为）
 * - 桌面已有同名快捷方式则跳过
 * - 装好后顺带清掉早期版本的 .cmd 入口，避免两个同名图标混淆
 * - --no-shortcut 可关闭
 */
function ensureDesktopShortcut() {
  if (!config.SEA_MODE || args.includes('--no-shortcut')) return;
  const ico = path.join(config.ROOT, 'assets', 'app.ico');
  if (!fs.existsSync(ico)) return;
  const exe = process.execPath;
  const root = config.ROOT;
  const ps = [
    "$d = if ($env:WVD_TEST_DESKTOP) { $env:WVD_TEST_DESKTOP } else { [Environment]::GetFolderPath('Desktop') }",
    "if (-not $d) { exit 1 }",
    "$p = Join-Path $d '网页视频下载器.lnk'",
    "if (Test-Path $p) { Write-Host 'EXISTS'; exit 0 }",
    "$ws = New-Object -ComObject WScript.Shell",
    "$l = $ws.CreateShortcut($p)",
    "$l.TargetPath = '" + exe + "'",
    "$l.WorkingDirectory = '" + root + "'",
    "$l.IconLocation = '" + ico + ",0'",
    "$l.Description = '启动网页视频下载本地服务（关闭窗口即停止服务）'",
    "$l.WindowStyle = 1",
    "$l.Save()",
    "$c = Join-Path $d '网页视频下载器.cmd'",
    "if (Test-Path $c) { Remove-Item $c -Force -ErrorAction SilentlyContinue }",
    "Write-Host 'CREATED'",
  ].join('; ');
  execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    timeout: 25000,
    windowsHide: true,
  }, (err, stdout) => {
    if (err) {
      console.log('（桌面快捷方式未创建：' + (err.message || err.code || '未知错误') + '）');
      return;
    }
    const s = (stdout || '').trim();
    if (s.indexOf('CREATED') >= 0) console.log('已在桌面创建快捷方式「网页视频下载器」');
  });
}

function openBrowser(url) {
  try {
    // 用 spawn + 参数数组，避免 exec 的引号嵌套问题
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (_) {
    /* 打不开浏览器不影响服务本身 */
  }
}

/** 探测端口上是否已经有本服务在跑（避免重复双击启动多个实例） */
function runningInstance(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1000 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve(j && j.ok ? j : null);
        } catch (_) {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/** 收集本机所有非内回环的 IPv4 地址，局域网模式下打印给用户看 */
function lanAddresses() {
  const out = [];
  try {
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
      for (const it of list || []) {
        if (it.family === 'IPv4' && !it.internal) out.push(it.address);
      }
    }
  } catch (_) {}
  let hostname = '';
  try { hostname = os.hostname(); } catch (_) {}
  if (hostname) out.push(hostname);
  return out;
}

function listen(port, attempt = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < 8) {
      console.log(`端口 ${port} 被占用，尝试 ${port + 1}…`);
      listen(port + 1, attempt + 1);
    } else {
      console.error('启动失败：', e.message);
      process.exit(1);
    }
  });
  server.listen(port, bindHost, () => {
    cfg.port = port; // 只改内存值，避免把临时端口写进配置
    banner();
    // 打包成独立程序时，双击即用：自动打开控制台页面 + 首次安装桌面快捷方式
    if (config.SEA_MODE && !NO_OPEN) {
      setTimeout(() => openBrowser(`http://127.0.0.1:${port}`), 400);
    }
    ensureDesktopShortcut();
  });
}

function banner() {
  const line = '─'.repeat(58);
  console.log('\n' + line);
  console.log('  网页视频下载 · 本地服务 v' + VERSION);
  console.log(line);
  console.log('  地址      http://' + (bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost) + ':' + cfg.port);
  console.log('  下载目录  ' + cfg.downloadDir);
  console.log('  Token     ' + (NO_TOKEN ? '（已用 --no-token 关闭校验）' : cfg.token));
  if (LAN_BIND) {
    console.log('');
    console.log('  [局域网模式] 已监听所有网卡，其他电脑请用以下地址连接：');
    for (const addr of lanAddresses()) {
      console.log('            http://' + addr + ':' + cfg.port);
    }
    console.log('  扩展设置里把服务地址改成上面的地址，再填入 Token 即可。');
  }
  console.log(line);
  console.log('  把 Token 填到扩展的设置页，或点扩展里的「自动配对」');
  console.log('  关闭此窗口即停止服务。');
  console.log(line + '\n');
  ytdlp.detect().then((t) => {
    console.log('  yt-dlp : ' + (t.ytdlp.ok ? '✓ ' + t.ytdlp.version : '✗ 未安装（可选，用于复杂站点）'));
    console.log('  ffmpeg : ' + (t.ffmpeg.ok ? '✓ 已安装' : '✗ 未安装（HLS 将保存为 .ts）'));
    console.log('');
  });
}

/* ----------------------------- 局域网安全 ----------------------------- */

if (LAN_BIND && NO_TOKEN) {
  if (!ALLOW_NO_TOKEN_LAN) {
    console.error('\n[拒绝启动] 服务监听在非回环地址（' + bindHost + '）时，不允许关闭 Token 校验。');
    console.error('局域网内任何设备都能访问这个服务。如确要关闭，请加参数 --allow-no-token（风险自担），');
    console.error('或改用默认监听（去掉 --host 参数）。');
    process.exit(1);
  }
  console.warn('[警告] 已在局域网模式下关闭 Token 校验（--allow-no-token），任何局域网设备都可创建下载任务。');
}

const port = PORT_ARG ? parseInt(PORT_ARG.split('=')[1], 10) : cfg.port;

if (config.SEA_MODE && !PORT_ARG) {
  // 双击启动：已经在跑就直接打开控制台，不再起第二个实例
  runningInstance(cfg.port).then((existing) => {
    if (existing) {
      console.log(`服务已在运行（PID ${existing.pid}，端口 ${cfg.port}），直接打开控制台页面。`);
      if (!NO_OPEN) openBrowser(`http://${cfg.host}:${cfg.port}`);
      setTimeout(() => process.exit(0), 800);
      return;
    }
    listen(port);
  });
} else {
  listen(port);
}

process.on('SIGINT', () => {
  console.log('\n服务已停止');
  process.exit(0);
});
