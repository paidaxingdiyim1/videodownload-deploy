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
const { probeDurations } = require('./probe');

const VERSION = '1.5.11';

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
  const site = up.site || (() => { try { return new URL(up.referer || '').hostname.replace(/^www\./, ''); } catch (_) { return ''; } })();
  let name = up.customName || up.title;
  if (!up.customName) name = name.replace(/\s*[-–—]\s*[^-–—]*$/, '').trim(); // 去掉「- 站名」后缀
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
          },
        }, cors);
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const allowed = ['downloadDir', 'namingTemplate', 'concurrency', 'segmentConcurrency', 'remuxToMp4', 'preferYtdlp'];
        const patch = {};
        for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
        Object.assign(cfg, config.update(patch));
        try { fs.mkdirSync(cfg.downloadDir, { recursive: true }); } catch (_) {}
        return send(res, 200, { ok: true, config: cfg }, cors);
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
  <div class="row"><span>yt-dlp</span><span>${dot(tools.ytdlp.ok)}${tools.ytdlp.ok ? tools.ytdlp.version : '未安装（复杂站点需要）'}</span></div>
  <div class="row"><span>ffmpeg</span><span>${dot(tools.ffmpeg.ok)}${tools.ffmpeg.ok ? '已安装（可合并音视频/转 MP4）' : '未安装（HLS 会保存为 .ts）'}</span></div>
  <div class="row"><span>并发 / 分片并发</span><span>${cfg.concurrency} / ${cfg.segmentConcurrency}</span></div>
  <div class="row"><span>API</span><code>GET /api/tasks · GET /api/files · POST /api/download · GET /api/events</code></div>
  ${tools.ytdlp.ok && tools.ffmpeg.ok ? '' : '<div class="warn">建议运行 <code>setup.bat</code> 安装 yt-dlp 与 ffmpeg，可支持更多站点并自动合并音视频。</div>'}
  <div class="warn">请只下载你有权保存的内容，并遵守目标网站的服务条款与相关法律。</div>
</div></html>`;
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
