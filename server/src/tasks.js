'use strict';

const fs = require('fs');
const path = require('path');
const util = require('./util');
const config = require('./config');
const hls = require('./hls');
const dash = require('./dash');
const direct = require('./direct');
const ytdlp = require('./ytdlp');

/* ------------------------------------------------------------------ */
/*  网络请求封装：带 Referer / Cookie / UA / 重试                       */
/* ------------------------------------------------------------------ */

function buildBaseHeaders(task) {
  const h = {};
  if (task.userAgent) h['User-Agent'] = task.userAgent;
  else h['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  if (task.referer) {
    h['Referer'] = task.referer;
    try { h['Origin'] = new URL(task.referer).origin; } catch (_) {}
  }
  if (task.headers && typeof task.headers === 'object') {
    for (const [k, v] of Object.entries(task.headers)) if (v) h[k] = String(v);
  }
  if (task.cookies) {
    const c = typeof task.cookies === 'string'
      ? task.cookies
      : (task.cookies || []).map((x) => `${x.name}=${x.value}`).join('; ');
    if (c) h['Cookie'] = c;
  }
  return h;
}

function makeFetch(baseHeaders, signal) {
  return async function doFetch(input, init = {}) {
    const retries = init.retries == null ? 2 : init.retries;
    const headers = { ...baseHeaders, ...(init.headers || {}) };
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (signal.aborted) throw new Error('已取消');
      try {
        const res = await fetch(input, {
          method: init.method || 'GET',
          headers,
          signal,
          redirect: 'follow',
        });
        if (res.status >= 500 && attempt < retries) {
          lastErr = new Error('HTTP ' + res.status);
          await util.sleep(500 * (attempt + 1));
          continue;
        }
        return res;
      } catch (e) {
        if (signal.aborted) throw new Error('已取消');
        lastErr = e;
        if (attempt < retries) await util.sleep(500 * (attempt + 1));
      }
    }
    throw lastErr || new Error('请求失败');
  };
}

/* ------------------------------------------------------------------ */
/*  任务队列                                                           */
/* ------------------------------------------------------------------ */

class TaskStore {
  constructor() {
    this.tasks = new Map();
    this.queue = [];
    this.active = 0;
    this.subs = new Set();
    this.seq = 0;
  }

  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  emit(type, payload) {
    for (const fn of this.subs) {
      try { fn(type, payload); } catch (_) {}
    }
  }

  snapshot(t) {
    return {
      id: t.id,
      title: t.title,
      url: t.url,
      kind: t.kind,
      engine: t.engine,
      status: t.status,
      stage: t.stage,
      progress: Math.round(t.progress * 10) / 10,
      speed: t.speed,
      eta: t.eta,
      downloaded: t.downloaded,
      total: t.total,
      segmentsDone: t.segmentsDone || 0,
      segmentsTotal: t.segmentsTotal || 0,
      fileName: t.fileName || '',
      filePath: t.filePath || '',
      error: t.error || '',
      quality: t.quality || '',
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      logs: (t.logs || []).slice(-12),
    };
  }

  list() {
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((t) => this.snapshot(t));
  }

  get(id) {
    const t = this.tasks.get(id);
    return t ? this.snapshot(t) : null;
  }

  create(input) {
    const cfg = config.load();
    const uid = util.uid('dl');
    // 标题：扩展没给、或只给了「视频」这类占位词时，改从 URL 猜
    const rawTitle = String(input.title || '').trim();
    const PLACEHOLDER = /^(视频|video|影片|媒体|media|player|播放|index)$/i;
    const title = util.sanitizeFilename(!rawTitle || PLACEHOLDER.test(rawTitle) ? util.guessTitleFromUrl(input.url) : rawTitle);
    const task = {
      id: uid,
      url: input.url,
      title,
      // 标题来源：client=扩展传来的真实标题（页面文案），guess=从 URL 猜的占位。
      // ytdlp 引擎只对 guess 标题做探测覆盖（yt-dlp 对 CDN 裸直链探测出的
      // title 就是文件名 media-video-hvc1 之类，会反过来顶掉正确标题）
      titleSource: rawTitle && !PLACEHOLDER.test(rawTitle) ? 'client' : 'guess',
      kind: input.kind || 'auto',
      mode: input.mode || 'auto',
      quality: input.quality || '',
      format: input.format || '',
      referer: input.referer || '',
      userAgent: input.userAgent || '',
      headers: input.headers || null,
      cookies: input.cookies || null,
      withSeparateAudio: !!input.withSeparateAudio,
      audioUrl: String(input.audioUrl || ''),
      customName: String(input.customName || '').trim(),
      status: 'queued',
      stage: 'queued',
      progress: 0,
      speed: 0,
      eta: 0,
      downloaded: 0,
      total: 0,
      logs: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      abort: null,
      seq: ++this.seq,
    };
    this.tasks.set(task.id, task);
    this.queue.push(task);
    this.emit('created', this.snapshot(task));
    this.pump(cfg);
    return this.snapshot(task);
  }

  async pump(cfg) {
    const max = Math.max(1, cfg.concurrency || 2);
    while (this.active < max && this.queue.length) {
      const task = this.queue.shift();
      if (task.status !== 'queued') continue;
      this.active++;
      this.run(task, cfg).finally(() => {
        this.active--;
        this.pump(cfg);
      });
    }
    // 队列空闲时清理已完成很久的任务之外的记录无需处理
  }

  log(task, msg) {
    const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
    task.logs.push(line);
    if (task.logs.length > 200) task.logs.shift();
    task.updatedAt = Date.now();
    this.emit('log', { id: task.id, line });
  }

  report(task, patch) {
    if (patch.progress != null) task.progress = Math.max(task.progress, Math.min(100, patch.progress));
    if (patch.speed != null) task.speed = patch.speed;
    if (patch.eta != null) task.eta = patch.eta;
    if (patch.downloaded != null) task.downloaded = patch.downloaded;
    if (patch.total != null) task.total = patch.total;
    if (patch.segmentsDone != null) task.segmentsDone = patch.segmentsDone;
    if (patch.segmentsTotal != null) task.segmentsTotal = patch.segmentsTotal;
    if (patch.stage) {
      task.stage = patch.stage;
      if (patch.stage === 'decrypting') task.status = 'decrypting';
      else if (patch.stage === 'merging') task.status = 'merging';
      else if (patch.stage === 'downloading') task.status = 'running';
    }
    task.updatedAt = Date.now();
    const now = Date.now();
    if (!task._lastEmit || now - task._lastEmit > 300) {
      task._lastEmit = now;
      this.emit('progress', this.snapshot(task));
    }
  }

  async run(task, cfg) {
    const controller = new AbortController();
    task.abort = controller;
    task.status = 'running';
    task.stage = 'starting';
    this.emit('progress', this.snapshot(task));

    const tools = await ytdlp.detect();
    const baseHeaders = buildBaseHeaders(task);
    const doFetch = makeFetch(baseHeaders, controller.signal);

    const tmpDir = path.join(cfg.downloadDir, '.wvd-tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `${task.id}`);

    const ctx = {
      task,
      config: cfg,
      headers: baseHeaders,
      fetch: doFetch,
      signal: controller.signal,
      tmpFile,
      hasFfmpeg: tools.ffmpeg.ok,
      log: (m) => this.log(task, m),
      report: (p) => this.report(task, p),
      ffmpeg: async (args) => {
        const r = await ytdlp.run(tools.ffmpeg.cmd, args);
        if (r.code !== 0) throw new Error('ffmpeg 失败：' + r.stderr.slice(-200));
        return r;
      },
    };

    try {
      let result;
      const engine = this.pickEngine(task, tools, cfg);
      task.engine = engine;
      this.log(task, `引擎：${engine}`);

      // yt-dlp 引擎：仅在扩展没给有效标题时，用 yt-dlp 探测的标题覆盖
      // （抖音等 CDN 裸直链 probe 出的 title 是文件名，不能覆盖页面真实文案）
      if (engine === 'ytdlp' && task.titleSource !== 'client') {
        try {
          const info = await ytdlp.probe(task.url, { referer: task.referer });
          const TITLE_JUNK = /记录美好生活|^抖音[\s-]*$|^douyin[\s-]*$/i;
          if (info && info.title) {
            const real = util.sanitizeFilename(info.title).trim();
            if (real && !TITLE_JUNK.test(real)) {
              task.title = real;
              this.emit('progress', this.snapshot(task));
            }
          }
        } catch (_) { /* 探测失败则沿用扩展给的标题 */ }
      }

      if (engine === 'ytdlp') {
        result = await ytdlp.download(task, ctx);
      } else if (task.kind === 'hls' || /\.m3u8(\?|$)/i.test(task.url)) {
        result = await hls.download(task, ctx);
      } else if (task.kind === 'dash' || /\.mpd(\?|$)/i.test(task.url)) {
        result = await dash.download(task, ctx);
      } else {
        result = await direct.download(task, ctx);
      }

      // 音画分离站点（如抖音）：下载伴随音轨并用 ffmpeg 合并，避免无声视频
      if (task.audioUrl && tools.ffmpeg.ok) {
        try {
          this.log(task, '下载伴随音轨并合并…');
          const actx = { ...ctx, tmpFile: ctx.tmpFile + '.audio', report: () => {} };
          const atask = { ...task, url: task.audioUrl, kind: 'audio' };
          const ares = await direct.download(atask, actx);
          const merged = ctx.tmpFile + '.av.mp4';
          await ctx.ffmpeg(['-y', '-i', result.file, '-i', ares.file, '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0?', '-movflags', '+faststart', merged]);
          try { fs.unlinkSync(ares.file); } catch (_) {}
          result = { file: merged, ext: 'mp4' };
          this.log(task, '音轨合并完成');
        } catch (e) {
          this.log(task, '音轨合并失败（保留原文件）：' + e.message);
        }
      }

      // 落盘到最终文件名
      const finalPath = this.buildFinalPath(cfg, task, result.ext);
      moveFile(result.file, finalPath);
      cleanupTmp(tmpFile, finalPath);

      task.status = 'done';
      task.stage = 'done';
      task.progress = 100;
      task.filePath = finalPath;
      task.fileName = path.basename(finalPath);
      try { task.total = fs.statSync(finalPath).size; task.downloaded = task.total; } catch (_) {}
      this.log(task, `完成：${finalPath}`);
      this.emit('done', this.snapshot(task));
    } catch (e) {
      const canceled = controller.signal.aborted;
      task.status = canceled ? 'canceled' : 'error';
      task.stage = canceled ? 'canceled' : 'error';
      task.error = canceled ? '已取消' : friendlyError(e.message);
      this.log(task, (canceled ? '已取消：' : '失败：') + task.error);
      this.emit('done', this.snapshot(task));
      try { cleanupTmp(tmpFile, null); } catch (_) {}
    } finally {
      task.abort = null;
      task.updatedAt = Date.now();
    }
  }

  pickEngine(task, tools, cfg) {
    if (task.mode === 'native') return 'native';
    if (task.mode === 'ytdlp') return 'ytdlp';
    // 作品页地址（抖音分享链接的规范化 URL 等）：必须由 yt-dlp 解析
    if (task.kind === 'page') return tools.ytdlp.ok ? 'ytdlp' : 'native';
    // auto：明显的直链/播放列表走原生（可解密、无需额外依赖）
    const looksNative = /\.(m3u8|mpd|mp4|webm|flv|m4v|mov|ts)(\?|#|$)/i.test(task.url);
    if (looksNative || task.kind === 'hls' || task.kind === 'dash') return 'native';
    if (cfg.preferYtdlp && tools.ytdlp.ok) return 'ytdlp';
    return 'native';
  }

  buildFinalPath(cfg, task, ext) {
    const site = (() => { try { return new URL(task.referer || task.url).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })();
    const d = new Date();
    const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    let name;
    if (task.customName) {
      // 用户自定义文件名：直接采用，不走模板与兜底
      name = task.customName;
    } else {
      name = cfg.namingTemplate || '{title}';
      name = name
        .replace(/\{title\}/g, task.title)
        .replace(/\{site\}/g, site)
        .replace(/\{date\}/g, date)
        .replace(/\{quality\}/g, task.quality || '')
        .replace(/\{index\}/g, String(task.seq).padStart(3, '0'));
      // 无信息量标题（站点没提供标题 / 纯站名）时，用 站名_日期_序号 兜底，避免一堆「视频.mp4」「视频 (1).mp4」
      const GENERIC = /^(视频|video|media|index|playlist|manifest|player|movie)$/i;
      if (!name || GENERIC.test(name) || (site && name.toLowerCase() === site.toLowerCase())) {
        name = [site || 'video', date, String(task.seq).padStart(3, '0')].filter(Boolean).join('_');
      }
    }
    // 剧集识别：有剧名 + 集数的，按 Jellyfin 标准剧集结构落盘
    //   downloads/<站点>/<剧名>/Season XX/<剧名> - SXXEXX.ext
    const ep = parseEpisode(name);
    if (ep && ep.show && ep.episode > 0) {
      const show = util.sanitizeFilename(ep.show);
      const season = String(ep.season || 1).padStart(2, '0');
      const epNum = String(ep.episode).padStart(2, '0');
      const base = `${show} - S${season}E${epNum}`;
      const baseDir = cfg.siteFolders && site
        ? path.join(cfg.downloadDir, util.sanitizeFilename(site))
        : cfg.downloadDir;
      const dir = path.join(baseDir, show, `Season ${season}`);
      fs.mkdirSync(dir, { recursive: true });
      let candidate = path.join(dir, `${base}.${ext}`);
      let n = 1;
      while (fs.existsSync(candidate)) candidate = path.join(dir, `${base} (${n++}).${ext}`);
      return candidate;
    }

    name = util.sanitizeFilename(name);
    // 按站点分文件夹
    const dir = cfg.siteFolders && site
      ? path.join(cfg.downloadDir, util.sanitizeFilename(site))
      : cfg.downloadDir;
    fs.mkdirSync(dir, { recursive: true });
    let candidate = path.join(dir, `${name}.${ext}`);
    let n = 1;
    while (fs.existsSync(candidate)) {
      candidate = path.join(dir, `${name} (${n++}).${ext}`);
    }
    return candidate;
  }

  cancel(id) {
    const t = this.tasks.get(id);
    if (!t) return false;
    if (t.status === 'queued') {
      t.status = 'canceled';
      t.stage = 'canceled';
      this.emit('done', this.snapshot(t));
      return true;
    }
    if (t.abort) t.abort.abort();
    return true;
  }

  clear() {
    for (const [id, t] of [...this.tasks.entries()]) {
      if (['done', 'error', 'canceled'].includes(t.status)) this.tasks.delete(id);
    }
    this.emit('cleared', {});
  }
}

/** 中文数字转阿拉伯（一~九十九、百） */
function cnToInt(s) {
  s = String(s || '').trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s.length === 1) return CN[s] != null ? CN[s] : 0;
  if (s === '十') return 10;
  if (s.includes('十')) {
    const parts = s.split('十');
    return (parts[0] ? (CN[parts[0]] || 0) : 1) * 10 + (parts[1] ? (CN[parts[1]] || 0) : 0);
  }
  if (s.includes('百')) {
    const parts = s.split('百');
    return (parts[0] ? (CN[parts[0]] || 1) : 1) * 100 + (parts[1] ? (CN[parts[1]] || 0) : 0);
  }
  return 0;
}

/** 从标题解析剧集：返回 {show, season, episode} 或 null（无剧名/集数则不归集） */
function parseEpisode(title) {
  const t = String(title || '').trim();
  if (!t) return null;
  let m = t.match(/[Ss](\d{1,2})\s*[Ee](\d{1,3})/);
  if (m) {
    const show = t.slice(0, t.indexOf(m[0])).replace(/[《》「」【】\[\]#·\s]+/g, ' ').trim();
    return { show, season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
  }
  m = t.match(/[Ee][Pp]\s*(\d{1,3})/);
  if (m) {
    const show = t.replace(m[0], '').replace(/[《》「」【】\[\]#·\s]+/g, ' ').trim();
    return { show, season: 1, episode: parseInt(m[1], 10) };
  }
  m = t.match(/第\s*([0-9]+|[零一二两三四五六七八九十百]+)\s*[集话期]/);
  if (m) {
    const before = t.slice(0, m.index);
    // 剧名：优先书名号内容，否则取「第X集」前的文字（去标签/标点）
    let show = '';
    const book = before.match(/《([^》]{1,40})》/);
    if (book) show = book[1].trim();
    else show = before.replace(/#\s*[^\s#]+/g, ' ').replace(/[【】\[\]「」·、，。！？!?:：;；'"‘’“”\s]+/g, ' ').trim();
    const ep = cnToInt(m[1]);
    if (ep > 0 && show) return { show: show.slice(0, 60), season: 1, episode: ep };
  }
  return null;
}

/** 把 yt-dlp 等底层英文错误翻译成用户能看懂的提示 */
function friendlyError(msg) {
  const s = String(msg || '');
  if (/Fresh cookies/i.test(s)) {
    return '抖音需要登录状态：请先在浏览器打开并登录 douyin.com（获取 Cookie），再重新解析该链接';
  }
  if (/invalid Netscape/i.test(s)) {
    return 'Cookie 解析出错（内部格式问题，请反馈）';
  }
  if (/Unsupported url scheme/i.test(s)) {
    return '链接格式不支持（可能是页面里的虚拟地址，请改用分享链接）';
  }
  return s;
}

function moveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code === 'EXDEV') {
      fs.copyFileSync(from, to);
      fs.unlinkSync(from);
    } else throw e;
  }
}

function cleanupTmp(tmpBase, keep) {
  const dir = path.dirname(tmpBase);
  const base = path.basename(tmpBase);
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(base)) {
        const full = path.join(dir, f);
        if (keep && full === keep) continue;
        try { fs.unlinkSync(full); } catch (_) {}
      }
    }
  } catch (_) {}
}

module.exports = new TaskStore();
