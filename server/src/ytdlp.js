'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');

let cache = null; // { ytdlp: {ok, cmd, version}, ffmpeg: {ok, cmd, version}, at: 时间戳 }
const CACHE_TTL = 60 * 1000; // 60 秒后重新探测，装上 bin/ 里的工具不必重启服务

/** 依次尝试多个候选命令，返回第一个可用的 */
function tryCommand(candidates, args) {
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (i >= candidates.length) return resolve(null);
      const cmd = candidates[i++];
      execFile(cmd[0], [...cmd.slice(1), ...args], { timeout: 20000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) return next();
        resolve({ cmd, out: String(stdout || stderr).trim() });
      });
    };
    next();
  });
}

async function detect(force = false) {
  if (cache && !force) {
    if (Date.now() - cache.at < CACHE_TTL) return cache;
    // 过期后若两个工具都找齐了就不再重复探测
    if (cache.ytdlp.ok && cache.ffmpeg.ok) return cache;
  }

  const binDir = config.BIN_DIR;
  const extra = [];
  if (fs.existsSync(binDir)) {
    for (const f of fs.readdirSync(binDir)) {
      if (/^yt-dlp(\.exe)?$/i.test(f)) extra.push(path.join(binDir, f));
      if (/^ffmpeg(\.exe)?$/i.test(f)) extra.push(path.join(binDir, f));
    }
  }

  const ytCandidates = [
    ...extra.filter((p) => /yt-dlp/i.test(p)).map((p) => [p]),
    ['yt-dlp'],
    ['yt-dlp.exe'],
    ['python', '-m', 'yt_dlp'],
    ['py', '-m', 'yt_dlp'],
    ['python3', '-m', 'yt_dlp'],
  ];

  const ffCandidates = [
    ...extra.filter((p) => /ffmpeg/i.test(p)).map((p) => [p]),
    ['ffmpeg'],
    ['ffmpeg.exe'],
  ];

  const [yt, ff] = await Promise.all([
    tryCommand(ytCandidates, ['--version']),
    tryCommand(ffCandidates, ['-version']),
  ]);

  cache = {
    ytdlp: yt ? { ok: true, cmd: yt.cmd, version: yt.out.split('\n')[0] } : { ok: false },
    ffmpeg: ff ? { ok: true, cmd: ff.cmd, version: ff.out.split('\n')[0].slice(0, 80) } : { ok: false },
    at: Date.now(),
  };
  return cache;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], [...cmd.slice(1), ...args], {
      windowsHide: true,
      ...opts,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** 把扩展传来的 cookie 数组/字符串写成 Netscape 格式 cookie 文件 */
function writeCookieFile(cookies, url) {
  if (!cookies) return null;
  let list = cookies;
  if (typeof cookies === 'string') {
    list = cookies
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => {
        const idx = pair.indexOf('=');
        return { name: pair.slice(0, idx), value: pair.slice(idx + 1) };
      });
  }
  if (!Array.isArray(list) || !list.length) return null;

  let host = '';
  try { host = new URL(url).hostname; } catch (_) { return null; }

  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of list) {
    if (!c || !c.name) continue;
    // domain 必须带前导点（domain cookie），否则 http.cookiejar 遇到
    // host-only 的不带点 domain 会抛 AssertionError，yt-dlp 报 invalid cookie
    const raw = c.domain || host;
    const dom = raw.startsWith('.') ? raw : '.' + raw;
    lines.push([dom, 'TRUE', '/', 'FALSE', '0', c.name, c.value].join('\t'));
  }
  const file = path.join(os.tmpdir(), 'wvd-cookies-' + Date.now() + '.txt');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

/** 用 yt-dlp 探测信息 */
async function probe(url, opts = {}) {
  const tools = await detect();
  if (!tools.ytdlp.ok) return null;
  const args = ['-J', '--no-warnings', '--no-playlist', '--socket-timeout', '20'];
  if (opts.referer) args.push('--referer', opts.referer);
  args.push(url);
  const res = await run(tools.ytdlp.cmd, args, { timeout: 60000 });
  if (res.code !== 0) return null;
  try {
    const j = JSON.parse(res.stdout);
    return {
      title: j.title,
      duration: j.duration,
      uploader: j.uploader,
      thumbnail: j.thumbnail,
      webpage_url: j.webpage_url,
      ext: j.ext,
      formats: (j.formats || []).map((f) => ({
        id: f.format_id,
        ext: f.ext,
        resolution: f.resolution || (f.height ? `${f.width}x${f.height}` : ''),
        height: f.height,
        vcodec: f.vcodec,
        acodec: f.acodec,
        filesize: f.filesize || f.filesize_approx,
        note: f.format_note,
      })),
    };
  } catch (_) {
    return null;
  }
}

const PROGRESS_RE = /\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*([\d.]+)([KMG]iB))?(?:\s+at\s+([\d.]+)([KMG]iB)\/s)?(?:\s+ETA\s+([\d:]+))?/;

/** 用 yt-dlp 下载（复杂站点 / SAMPLE-AES / DASH 合并场景） */
async function download(task, ctx) {
  const tools = await detect();
  if (!tools.ytdlp.ok) throw new Error('未检测到 yt-dlp，请先运行 setup');

  const outTemplate = path.join(path.dirname(ctx.tmpFile), path.basename(ctx.tmpFile, path.extname(ctx.tmpFile)) + '.%(ext)s');
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--no-part',
    '--socket-timeout', '30',
    '--retries', '5',
    '--merge-output-format', 'mp4',
    '-o', outTemplate,
  ];

  if (task.format) args.push('-f', task.format);
  else args.push('-f', 'bv*+ba/b');
  // 让 yt-dlp 用我们随项目携带的 ffmpeg（server/bin），不依赖系统 PATH
  if (tools.ffmpeg.ok) {
    const ffCmd = tools.ffmpeg.cmd[0];
    if (path.isAbsolute(ffCmd)) args.push('--ffmpeg-location', path.dirname(ffCmd));
  }
  if (task.referer) args.push('--referer', task.referer);
  if (task.userAgent) args.push('--user-agent', task.userAgent);
  if (task.headers && typeof task.headers === 'object') {
    for (const [k, v] of Object.entries(task.headers)) args.push('--add-header', `${k}:${v}`);
  }
  const cookieFile = writeCookieFile(task.cookies, task.url);
  if (cookieFile) args.push('--cookies', cookieFile);
  args.push(task.url);

  ctx.log('使用 yt-dlp 下载…');

  return new Promise((resolve, reject) => {
    const child = spawn(tools.ytdlp.cmd[0], [...tools.ytdlp.cmd.slice(1), ...args], { windowsHide: true });
    let buf = '';
    let lastErr = '';

    const handleLine = (line) => {
      if (!line) return;
      const m = line.match(PROGRESS_RE);
      if (m) {
        const pct = parseFloat(m[1]);
        const speed = m[4] ? parseFloat(m[4]) * unit(m[5]) : 0;
        const eta = m[6] ? toSeconds(m[6]) : 0;
        ctx.report({ progress: Math.min(99, pct), speed, eta, stage: 'downloading' });
        return;
      }
      if (/^\[(download|Merger|FixupM3u8|VideoConvertor|ExtractAudio)\]/.test(line)) {
        if (/Merger|FixupM3u8|VideoConvertor/.test(line)) ctx.report({ stage: 'merging', progress: 96 });
        ctx.log(line.slice(0, 200));
      } else if (/^(ERROR|WARNING)/.test(line)) {
        lastErr = line;
        ctx.log(line.slice(0, 300));
      }
    };

    child.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      lines.forEach(handleLine);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      s.split(/\r?\n/).forEach(handleLine);
    });

    const onAbort = () => { try { child.kill('SIGKILL'); } catch (_) {} };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', reject);
    child.on('close', (code) => {
      if (cookieFile) { try { fs.unlinkSync(cookieFile); } catch (_) {} }
      if (ctx.signal.aborted) return reject(new Error('已取消'));
      if (code !== 0) return reject(new Error(lastErr || `yt-dlp 退出码 ${code}`));

      // 找出实际落盘文件（扩展名由 yt-dlp 决定）
      const dir = path.dirname(ctx.tmpFile);
      const base = path.basename(ctx.tmpFile, path.extname(ctx.tmpFile));
      let found = null;
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith(base + '.') && !f.endsWith('.part')) {
            const full = path.join(dir, f);
            const st = fs.statSync(full);
            if (!found || st.mtimeMs > fs.statSync(found).mtimeMs) found = full;
          }
        }
      } catch (_) {}
      if (!found) return reject(new Error('yt-dlp 未产生输出文件'));
      ctx.report({ progress: 100 });
      resolve({ file: found, ext: path.extname(found).slice(1) || 'mp4' });
    });
  });
}

function unit(u) {
  if (!u) return 1;
  if (/K/i.test(u)) return 1024;
  if (/M/i.test(u)) return 1024 * 1024;
  if (/G/i.test(u)) return 1024 * 1024 * 1024;
  return 1;
}

function toSeconds(str) {
  return String(str).split(':').reduce((acc, p) => acc * 60 + (parseInt(p, 10) || 0), 0);
}

module.exports = { detect, probe, download, run };
