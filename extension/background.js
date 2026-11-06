'use strict';

/* ==========================================================================
 *  网页视频下载器 · 后台 Service Worker
 *  职责：
 *   1. 用 webRequest 嗅探页面里加载的媒体资源（m3u8 / mpd / mp4 / webm ...）
 *   2. 按标签页维护资源列表，供 content script 和 popup 查询
 *   3. 收到下载请求时补全 Referer / Cookie / UA，转发给本机服务
 *   4. 轮询本机服务任务进度，推送到对应标签页
 * ========================================================================== */

const DEFAULT_CONFIG = {
  /** 远程服务器（局域网服务器，如 http://yourserver:8765） */
  serverUrl: 'http://127.0.0.1:8765',
  serverToken: '',
  /** 本机服务（视频保存到这台电脑时使用） */
  localUrl: 'http://127.0.0.1:8765',
  localToken: '',
  /** 保存位置：server=服务器 local=本机 ask=每次下载时询问 */
  saveTarget: 'server',
  autoButton: true,
  minSize: 120,
  mode: 'auto', // auto | native | ytdlp
};

const MEDIA_RE = /\.(m3u8|mpd|mp4|webm|flv|m4v|mov|mkv|m4a|mp3|aac)(\?|#|$)/i;
const IGNORE_RE = /\.(ts|m4s|aac\.seg|jpg|jpeg|png|gif|webp|svg|css|js|json|html?)(\?|#|$)/i;
/** 无扩展名音频流（抖音 media-audio-mp4a 之类）按 URL 特征识别 */
const AUDIO_HINT_RE = /media-audio|audio-mp4a|\/audio[\/._-]|_audio\//i;

/* 公开仓库（自更新来源），前端版本号与最新包都从这里取 */
const REPO_RAW = 'https://raw.githubusercontent.com/paidaxingdiyim1/videodownload-deploy/main';
const REPO_ZIP = 'https://github.com/paidaxingdiyim1/videodownload-deploy/archive/refs/heads/main.zip';
const EXT_VERSION = chrome.runtime.getManifest().version;

/** tabId -> Map(url -> entry) */
const mediaByTab = new Map();
/** tabId -> 页面标题（浏览器标签页标题） */
const tabTitles = new Map();
/** tabId -> 页面真实视频标题（content script 广播，at=广播时间） */
const realTitleByTab = new Map();
/** tabId -> 当前正在播放的视频地址（content script 广播） */
const currentSrcByTab = new Map();
/** tabId -> true（该标签页当前是直播间，停止媒体嗅探） */
const liveByTab = new Map();
/** tabId -> {src, since} 当前视频纪元：切换视频即开启新纪元，用于把 MSE 播放器的
 *  blob: 虚拟地址归属到「这个视频开始播放前后嗅探到的真实网络流」 */
const epochByTab = new Map();
/** tabId -> true（信息流站点：弹窗只显示当前视频的链接，防堆积） */
const soloByTab = new Map();
/** tabId -> {videoUrl, audioUrl} 当前视频的流绑定（blob 归属决策结果，下载时直接用） */
const bindingByTab = new Map();
/** tabId -> Set(urls) 已被之前视频消费的流，归属新视频时排除（每条流只归属一次） */
const consumedByTab = new Map();
/** taskId -> {tabId, frameId} */
const activeTasks = new Map();

let storageReady = null;
let pollTimer = null;

/* ------------------------------ 存储 ------------------------------ */

function ensureLoaded() {
  if (storageReady) return storageReady;
  storageReady = (async () => {
    try {
      const bag = await chrome.storage.session.get('media');
      const raw = bag.media || {};
      for (const [tabId, list] of Object.entries(raw)) {
        const m = new Map();
        for (const e of list) m.set(e.url, e);
        mediaByTab.set(Number(tabId), m);
      }
    } catch (_) {}
  })();
  return storageReady;
}

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    try {
      const out = {};
      for (const [tabId, m] of mediaByTab) out[tabId] = [...m.values()].slice(-80);
      await chrome.storage.session.set({ media: out });
    } catch (_) {}
  }, 400);
}

/* ------------------------------ 配置 ------------------------------ */

async function getConfig() {
  const bag = await chrome.storage.local.get('config');
  const cfg = { ...DEFAULT_CONFIG, ...(bag.config || {}) };
  // 旧版本迁移：原来只有一个 token/serverUrl，视作服务器端点的凭据
  if (bag.config && bag.config.token && !bag.config.serverToken) cfg.serverToken = bag.config.token;
  if (!['server', 'local', 'ask'].includes(cfg.saveTarget)) cfg.saveTarget = 'server';
  return cfg;
}

async function setConfig(patch) {
  const cfg = { ...(await getConfig()), ...patch };
  await chrome.storage.local.set({ config: cfg });
  return cfg;
}

/** 解析目标端点：显式指定优先，否则用默认保存位置（ask 时回落到服务器） */
function resolveTarget(target, cfg) {
  if (target === 'local' || target === 'server') return target;
  return cfg.saveTarget === 'local' ? 'local' : 'server';
}

/** 目标端点对应的地址与 Token */
function endpointFor(cfg, target) {
  return target === 'local'
    ? { base: (cfg.localUrl || DEFAULT_CONFIG.localUrl).replace(/\/+$/, ''), token: cfg.localToken || '' }
    : { base: (cfg.serverUrl || DEFAULT_CONFIG.serverUrl).replace(/\/+$/, ''), token: cfg.serverToken || '' };
}

const TOKEN_KEY = { server: 'serverToken', local: 'localToken' };

let cachedToken = { server: null, local: null };
async function getToken(target) {
  if (cachedToken[target]) return cachedToken[target];
  const cfg = await getConfig();
  cachedToken[target] = cfg[TOKEN_KEY[target]] || '';
  return cachedToken[target];
}

/* ------------------------------ 与下载服务通信 ------------------------------ */

async function api(pathname, { method = 'GET', body, timeout = 8000, retryToken = true, target } = {}) {
  const cfg = await getConfig();
  const t = resolveTarget(target, cfg);
  const { base } = endpointFor(cfg, t);
  let token = await getToken(t);
  if (!token) token = await pair(t);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(base + pathname, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': token || '',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (res.status === 401 && retryToken) {
      cachedToken[t] = null;
      const fresh = await pair(t, true);
      if (fresh) return api(pathname, { method, body, timeout, retryToken: false, target: t });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** 扩展首次使用时向对应服务要一个 token */
async function pair(target = 'server', force) {
  try {
    const cfg = await getConfig();
    const t = resolveTarget(target, cfg);
    const { base } = endpointFor(cfg, t);
    const res = await fetch(base + '/api/pair', { method: 'POST' });
    if (!res.ok) return '';
    const data = await res.json();
    if (data.token !== undefined) {
      cachedToken[t] = data.token;
      await setConfig({ [TOKEN_KEY[t]]: data.token });
      return data.token;
    }
  } catch (_) {}
  return '';
}

async function health(target) {
  const cfg = await getConfig();
  const t = resolveTarget(target, cfg);
  const { base } = endpointFor(cfg, t);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(base + '/api/health', { signal: ctrl.signal });
    return await res.json();
  } catch (e) {
    return { ok: false, error: t === 'local' ? '无法连接本机服务' : '无法连接服务器服务' };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ 自更新 ------------------------------ */

function compareVersion(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n || '0', 10));
  const pb = String(b || '').split('.').map((n) => parseInt(n || '0', 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 检查前端（扩展）最新版本：从公开仓库读 manifest */
async function checkFrontend() {
  try {
    const res = await fetch(`${REPO_RAW}/extension/manifest.json`, { cache: 'no-store' });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const m = await res.json();
    const latest = m.version || '';
    return { ok: true, current: EXT_VERSION, latest, newer: compareVersion(latest, EXT_VERSION) > 0 };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/** 检查后端（服务器）更新 */
async function checkBackend(target) {
  try {
    return await api('/api/update/check', { timeout: 15000, target });
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/** 更新后端：让服务器 git pull 自公开仓库并重启 */
async function updateBackend(target) {
  try {
    return await api('/api/update', { method: 'POST', timeout: 120000, target });
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/** 更新前端：下载最新扩展包到本地，由用户解压后重新加载 */
async function updateFrontend() {
  const c = await checkFrontend();
  const v = (c.ok && c.latest) ? c.latest : 'latest';
  return new Promise((resolve) => {
    chrome.downloads.download({
      url: REPO_ZIP,
      filename: `videodownload-extension-v${v}.zip`,
      conflictAction: 'uniquify',
      saveAs: true,
    }, (id) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve({ ok: true, downloadId: id, version: v });
    });
  });
}

function clearUpdateBadge() {
  chrome.action.setBadgeText({ text: '' }).catch(() => {});
}

/* ------------------------------ 媒体嗅探 ------------------------------ */

function kindOf(url, mime) {
  const m = String(mime || '').toLowerCase();
  const u = String(url).toLowerCase();
  if (m.includes('mpegurl') || /\.m3u8(\?|#|$)/.test(u)) return 'hls';
  if (m.includes('dash') || /\.mpd(\?|#|$)/.test(u)) return 'dash';
  if (m.startsWith('audio/') || /\.(m4a|mp3|aac)(\?|#|$)/.test(u) || AUDIO_HINT_RE.test(u)) return 'audio';
  if (m.includes('webm') || /\.webm(\?|#|$)/.test(u)) return 'webm';
  if (m.includes('flv') || /\.flv(\?|#|$)/.test(u)) return 'flv';
  if (m.includes('mp4') || /\.(mp4|m4v|mov)(\?|#|$)/.test(u)) return 'mp4';
  return 'video';
}

function isCandidate(url, mime) {
  if (!url || !/^https?:/i.test(url)) return false;
  if (IGNORE_RE.test(url)) return false;
  const m = String(mime || '').toLowerCase();
  if (m && !/^(video\/|audio\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|octet-stream))/.test(m) && !MEDIA_RE.test(url)) {
    return false;
  }
  return MEDIA_RE.test(url) || /^(video|audio)\//.test(m) || m.includes('mpegurl') || m.includes('dash+xml') || AUDIO_HINT_RE.test(url);
}

async function addMedia(tabId, entry) {
  if (tabId == null || tabId < 0) return;
  if (!/^https?:/i.test(entry.url || '')) return; // blob:/data: 等虚拟地址无法下载，一律不入列
  await ensureLoaded();
  let map = mediaByTab.get(tabId);
  if (!map) {
    map = new Map();
    mediaByTab.set(tabId, map);
  }
  const existing = map.get(entry.url);
  if (existing) {
    existing.lastSeen = Date.now();
    if (entry.size && !existing.size) existing.size = entry.size;
    if (entry.mime && !existing.mime) existing.mime = entry.mime;
    return;
  }

  entry.id = 'm' + Math.random().toString(36).slice(2, 9);
  entry.firstSeen = entry.lastSeen = Date.now();
  const rt = realTitleByTab.get(tabId);
  entry.pageTitle = entry.pageTitle || (rt && rt.title) || tabTitles.get(tabId) || '';
  entry.pageUrl = entry.pageUrl || '';
  map.set(entry.url, entry);

  // 信息流站点（如抖音推荐页）会随滑动无限累积，最多保留 12 条最新的
  if (map.size > 12) {
    const sorted = [...map.entries()].sort((a, b) => a[1].firstSeen - b[1].firstSeen);
    for (let i = 0; i < map.size - 12; i++) map.delete(sorted[i][0]);
  }
  persist();
  updateBadge(tabId);
  notifyTab(tabId, { type: 'media:changed' });
}

function updateBadge(tabId) {
  const map = mediaByTab.get(tabId);
  const n = map ? [...map.values()].filter((x) => ['hls', 'dash', 'mp4', 'webm', 'flv'].includes(x.kind)).length : 0;
  chrome.action.setBadgeText({ tabId, text: n ? String(Math.min(n, 99)) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#2b6cff' }).catch(() => {});
}

function notifyTab(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

/**
 * 给视频找伴随音轨（音画分离站点，如抖音）。按可靠性三级匹配：
 *  3. 抖音音画配对：画面流与音频流 URL 共享同一段 CDN 路径前缀（/media- 之前完全一致）
 *  2. 纪元匹配：音轨是在 since（上一个纪元起点）之后嗅探到的 —— 抖音预加载的
 *     音画是成对抓取的，归属当前视频的窗口内通常只有一条音频流
 *  1. 时间窗兜底：最近 30 秒内嗅探到的音轨
 */
function findAudioMate(tabId, videoUrl, since, consumed) {
  const map = mediaByTab.get(tabId);
  if (!map) return '';
  const vPrefix = String(videoUrl || '').split('/media-')[0];
  const now = Date.now();
  let best = null;
  for (const e of map.values()) {
    if (e.kind !== 'audio') continue;
    if (consumed && consumed.has(e.url)) continue;
    let score = 0;
    if (vPrefix && vPrefix.length > 20 && String(e.url).startsWith(vPrefix)) score = 3;
    else if (since && e.firstSeen >= since - 5000) score = 2;
    else if (now - (e.lastSeen || 0) < 30000) score = 1;
    if (!score) continue;
    if (!best || score > best.score || (score === best.score && (e.size || 0) > (best.e.size || 0))) best = { e, score };
  }
  return best ? best.e.url : '';
}

/* ------------------------------ webRequest 监听 ------------------------------ */

const urlCache = new Map(); // requestId -> {url, tabId}

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId == null || d.tabId < 0) return;
    if (liveByTab.get(d.tabId)) return; // 直播间：不嗅探
    if (!isCandidate(d.url, '')) return;
    urlCache.set(d.requestId, { url: d.url, tabId: d.tabId, timeStamp: d.timeStamp });
    if (urlCache.size > 400) urlCache.delete(urlCache.keys().next().value);
    addMedia(d.tabId, {
      url: d.url,
      kind: kindOf(d.url, ''),
      mime: '',
      size: 0,
      frameId: d.frameId,
      pageUrl: d.initiator || '',
    });
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] }
);

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId == null || d.tabId < 0) return;
    if (liveByTab.get(d.tabId)) return; // 直播间：不嗅探
    const headers = d.responseHeaders || [];
    const get = (name) => {
      const h = headers.find((x) => x.name.toLowerCase() === name);
      return h ? h.value : '';
    };
    const mime = get('content-type') || '';
    const len = Number(get('content-length') || 0);

    if (!isCandidate(d.url, mime)) return;
    const kind = kindOf(d.url, mime);
    const isManifest = kind === 'hls' || kind === 'dash';
    if (!isManifest && len && len < 65536) return; // 太小，多半是广告/封面

    addMedia(d.tabId, {
      url: d.url,
      kind,
      mime,
      size: len,
      frameId: d.frameId,
      pageUrl: d.initiator || '',
    });
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
  ['responseHeaders']
);

/* 标签页生命周期 */
chrome.tabs.onRemoved.addListener((tabId) => {
  mediaByTab.delete(tabId);
  tabTitles.delete(tabId);
  realTitleByTab.delete(tabId);
  currentSrcByTab.delete(tabId);
  liveByTab.delete(tabId);
  epochByTab.delete(tabId);
  soloByTab.delete(tabId);
  bindingByTab.delete(tabId);
  consumedByTab.delete(tabId);
  persist();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.title) tabTitles.set(tabId, changeInfo.title);
  if (changeInfo.url) {
    mediaByTab.delete(tabId);
    liveByTab.delete(tabId); // 导航到新页面时重置直播间状态
    epochByTab.delete(tabId);
    soloByTab.delete(tabId);
    bindingByTab.delete(tabId);
    consumedByTab.delete(tabId);
    persist();
    updateBadge(tabId);
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then((t) => tabTitles.set(tabId, t.title || '')).catch(() => {});
  updateBadge(tabId);
});

/* ------------------------------ 下载流程 ------------------------------ */

async function collectCookies(url) {
  try {
    const list = await chrome.cookies.getAll({ url });
    return (list || []).filter((c) => !/^__(ga|gid|utm)/.test(c.name)).map((c) => ({ name: c.name, value: c.value, domain: c.domain }));
  } catch (_) {
    return [];
  }
}

async function startDownload(msg, sender) {
  const cfg = await getConfig();
  const tabId = sender?.tab?.id ?? msg.tabId ?? -1;
  const pageUrl = sender?.tab?.url || msg.referer || '';
  const cookies = await collectCookies(msg.url);
  const target = resolveTarget(msg.target, cfg);

  const payload = {
    url: msg.url,
    title: msg.title || tabTitles.get(tabId) || '',
    kind: msg.kind || 'auto',
    mode: msg.mode || cfg.mode || 'auto',
    quality: msg.quality || '',
    format: msg.format || '',
    referer: msg.referer || pageUrl,
    userAgent: navigator.userAgent,
    cookies,
  };

  // 音画分离站点（抖音等）：统一在后台配音轨。优先用 page:current 归属时
  // 已经绑定好的配对（blob 归属决策时连同音轨一起选定，最可靠），否则兜底匹配
  if (payload.kind !== 'audio' && ['hls', 'dash', 'mp4', 'webm', 'flv', 'video', 'auto'].includes(payload.kind)) {
    const binding = bindingByTab.get(tabId);
    if (binding && binding.videoUrl === payload.url) {
      payload.audioUrl = binding.audioUrl || '';
    } else {
      payload.audioUrl = findAudioMate(tabId, payload.url, (epochByTab.get(tabId) || {}).since || 0, consumedByTab.get(tabId));
    }
  }

  const data = await api('/api/download', { method: 'POST', body: payload, timeout: 15000, target });
  if (!data.ok || !data.task) throw new Error(data.error || '创建任务失败');

  activeTasks.set(data.task.id, { tabId, frameId: sender?.frameId ?? 0, target });
  ensurePolling();
  return data.task;
}

/* 轮询进度（Service Worker 里不能用 EventSource）；任务可能分布在服务器/本机两个端点 */
function ensurePolling() {
  if (pollTimer) return;
  pollTimer = setTimeout(pollOnce, 800);
}

async function pollOnce() {
  pollTimer = null;
  if (!activeTasks.size) return;

  // 按 target 分组，各查各的服务
  const byTarget = new Map();
  for (const [id, info] of activeTasks) {
    const t = info.target || 'server';
    if (!byTarget.has(t)) byTarget.set(t, new Map());
    byTarget.get(t).set(id, info);
  }

  for (const [target, ids] of byTarget) {
    try {
      const data = await api('/api/tasks', { timeout: 6000, target });
      const list = data.tasks || [];
      const byId = new Map(list.map((t) => [t.id, t]));
      for (const [id, info] of ids) {
        const t = byId.get(id);
        if (!t) {
          activeTasks.delete(id);
          continue;
        }
        chrome.tabs.sendMessage(info.tabId, { type: 'task:update', task: t, target }, { frameId: info.frameId }).catch(() => {
          chrome.tabs.sendMessage(info.tabId, { type: 'task:update', task: t, target }).catch(() => {});
        });
        if (['done', 'error', 'canceled'].includes(t.status)) {
          activeTasks.delete(id);
        }
      }
    } catch (_) {
      // 该服务可能没启动，减少无效轮询
    }
  }
  if (activeTasks.size) pollTimer = setTimeout(pollOnce, 1200);
}

/* ------------------------------ 消息路由 ------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'page:live': {
          // content script 广播的直播间状态：true=进入直播间（清空媒体、停止嗅探）
          const tabId = sender?.tab?.id;
          if (tabId == null || tabId < 0) return sendResponse({ ok: true });
          if (msg.live) {
            liveByTab.set(tabId, true);
            mediaByTab.delete(tabId);
            persist();
            updateBadge(tabId);
          } else {
            liveByTab.delete(tabId);
          }
          return sendResponse({ ok: true });
        }
        case 'page:current': {
          // content script 广播「当前正在播放的视频」：地址 + 当前页面文案。
          // 注意：MSE 播放器（抖音等）的 currentSrc 是 blob: 虚拟地址，无法下载。
          // 此时改用「当前纪元内嗅探到的真实网络流」作为当前视频。
          const tabId = sender?.tab?.id;
          const src = String(msg.src || '');
          if (tabId == null || tabId < 0 || !src) return sendResponse({ ok: true });
          if (msg.solo != null) soloByTab.set(tabId, !!msg.solo);

          const prevEpoch = epochByTab.get(tabId);
          const consumed = consumedByTab.get(tabId) || new Set();
          let currentUrl = src;
          let audioUrl = '';

          if (!/^https?:/i.test(src)) {
            // blob:（MSE 播放器，如抖音）→ 归属到真实网络流。
            // 关键：抖音是滑动前就预加载下一条，新视频的流在上一个纪元期间就被
            // 抓好了，所以窗口从「上一个纪元开始」算起；并排除已被之前视频消费
            // 的流（每条流只归属一次），找不到时放宽 consumed 兜底（用户回看场景）
            const since = prevEpoch ? prevEpoch.since : 0;
            const mapB = mediaByTab.get(tabId);
            const pickBest = (ignoreConsumed) => {
              let best = null;
              if (!mapB) return best;
              for (const e of mapB.values()) {
                if (!['mp4', 'webm', 'flv', 'video', 'hls', 'dash'].includes(e.kind)) continue;
                if (!ignoreConsumed && consumed.has(e.url)) continue;
                if (since && e.firstSeen < since - 5000) continue;
                if (!best || (e.size || 0) > (best.size || 0) || ((e.size || 0) === (best.size || 0) && e.lastSeen > best.lastSeen)) best = e;
              }
              return best;
            };
            let best = pickBest(false) || pickBest(true);
            if (!best) return sendResponse({ ok: true });
            currentUrl = best.url;
            audioUrl = findAudioMate(tabId, best.url, since, consumed);
            // 绑定本视频的流归属，下载时直接用；已消费的流不再参与下一条归属
            bindingByTab.set(tabId, { videoUrl: currentUrl, audioUrl });
            consumed.add(currentUrl);
            if (audioUrl) consumed.add(audioUrl);
            consumedByTab.set(tabId, consumed);
          } else {
            bindingByTab.set(tabId, { videoUrl: src, audioUrl: findAudioMate(tabId, src, 0, null) });
          }

          // 纪元：当前视频变化时开启新纪元（之后嗅探到的流归属新视频）
          if (!prevEpoch || prevEpoch.src !== src) epochByTab.set(tabId, { src, since: Date.now() });
          currentSrcByTab.set(tabId, currentUrl);

          // 标题：优先用广播里带的当前文案
          const rt = realTitleByTab.get(tabId);
          const title = String(msg.title || '').trim() || (rt && rt.title) || tabTitles.get(tabId) || '';
          if (title) realTitleByTab.set(tabId, { title, at: Date.now() });

          // 确保当前视频一定有列表条目，且标题无条件对齐页面文案
          const kind = /\.mpd(\?|#|$)/i.test(currentUrl) ? 'dash'
            : /\.m3u8(\?|#|$)/i.test(currentUrl) ? 'hls'
            : /\.(mp4|webm|flv|m4v|mov|mkv)(\?|#|$)/i.test(currentUrl) ? 'mp4' : 'video';
          await addMedia(tabId, { url: currentUrl, kind, pageTitle: title || undefined });
          const mapC = mediaByTab.get(tabId);
          if (mapC) {
            const cur = mapC.get(currentUrl);
            if (cur && title) cur.pageTitle = title;
            // 顺带纠正停留在旧标题上的近期条目（信息流预加载导致的串味）
            if (rt && title && rt.title !== title) {
              const cut = Date.now() - 120000;
              for (const e of mapC.values()) {
                if (e.lastSeen >= cut && e.pageTitle === rt.title) e.pageTitle = title;
              }
            }
            persist();
          }
          return sendResponse({ ok: true });
        }
        case 'media:resync': {
          // 弹窗「刷新」：信息流(solo)页保留记录只重新标记当前视频（记录里存着
          // 本视频的真实流，清了就找不回来了）；普通页面清空重嗅探
          const tabId = msg.tabId ?? sender?.tab?.id;
          if (!soloByTab.get(tabId)) {
            mediaByTab.delete(tabId);
          }
          persist();
          updateBadge(tabId);
          notifyTab(tabId, { type: 'media:resync' });
          return sendResponse({ ok: true });
        }
        case 'media:list': {
          await ensureLoaded();
          const tabId = msg.tabId ?? sender?.tab?.id;
          const map = mediaByTab.get(tabId);
          const currentSrc = currentSrcByTab.get(tabId) || '';
          let items = map
            ? [...map.values()]
                .sort((a, b) => b.lastSeen - a.lastSeen)
                .map((x) => ({ ...x, isCurrent: !!currentSrc && (x.url === currentSrc || decodeURIComponent(x.url) === currentSrc) }))
            : [];
          // 信息流站点：只显示当前视频的链接（用户要求：只识别正在播放的视频）
          if (soloByTab.get(tabId)) items = items.filter((x) => x.isCurrent);
          return sendResponse({ ok: true, items, tabId, title: tabTitles.get(tabId) || '' });
        }
        case 'media:clear': {
          await ensureLoaded();
          const tabId = msg.tabId ?? sender?.tab?.id;
          mediaByTab.delete(tabId);
          persist();
          updateBadge(tabId);
          notifyTab(tabId, { type: 'media:changed' });
          return sendResponse({ ok: true });
        }
        case 'download': {
          const task = await startDownload(msg, sender);
          return sendResponse({ ok: true, task });
        }
        case 'tasks': {
          // 合并服务器 + 本机两个端点的任务列表，并给每条任务打上所属端点
          const results = await Promise.allSettled([
            api('/api/tasks', { timeout: 6000, target: 'server' }),
            api('/api/tasks', { timeout: 6000, target: 'local' }),
          ]);
          const all = [];
          let any = false;
          const targets = ['server', 'local'];
          results.forEach((r, i) => {
            if (r.status === 'fulfilled' && r.value && r.value.ok) {
              any = true;
              for (const t of (r.value.tasks || [])) { t.target = targets[i]; all.push(t); }
            }
          });
          return sendResponse({ ok: true, tasks: all, connected: any });
        }
        case 'video:link': {
          // 构建某个已下载文件的播放/打开地址
          const cfg = await getConfig();
          const target = msg.target === 'local' ? 'local' : 'server';
          const filePath = msg.filePath || '';
          const { base, token } = endpointFor(cfg, target);
          if (target === 'local') {
            const fileUrl = 'file:///' + filePath.replace(/\\/g, '/').replace(/^\/+/, '');
            return sendResponse({ ok: true, target, filePath, streamUrl: fileUrl, address: '本机 · ' + filePath });
          }
          const streamUrl = base + '/api/stream?path=' + encodeURIComponent(filePath) + '&token=' + encodeURIComponent(token);
          return sendResponse({ ok: true, target, filePath, streamUrl, address: base + ' · ' + filePath });
        }
        case 'file:delete': {
          try {
            const data = await api('/api/delete-file?path=' + encodeURIComponent(msg.filePath), { method: 'POST', target: msg.target, timeout: 15000 });
            return sendResponse(data);
          } catch (e) {
            return sendResponse({ ok: false, error: String(e && e.message || e) });
          }
        }
        case 'files': {
          // 列出服务器 + 本机的下载目录内容（用于设置页「下载中心」）
          const results = await Promise.allSettled([
            api('/api/files', { timeout: 10000, target: 'server' }),
            api('/api/files', { timeout: 10000, target: 'local' }),
          ]);
          const groups = [];
          const targets = ['server', 'local'];
          results.forEach((r, i) => {
            if (r.status === 'fulfilled' && r.value && r.value.ok) {
              groups.push({ target: targets[i], dir: r.value.dir || '', files: r.value.files || [] });
            }
          });
          return sendResponse({ ok: true, groups });
        }
        case 'task:cancel': {
          const cfg = await getConfig();
          const t = resolveTarget(msg.target, cfg);
          // 优先按已知任务的端点取消；找不到就两端都试
          const known = activeTasks.get(msg.id);
          const order = known ? [known.target] : ['server', 'local'];
          for (const target of order) {
            try {
              await api(`/api/tasks/${msg.id}/cancel`, { method: 'POST', target });
              return sendResponse({ ok: true });
            } catch (_) {}
          }
          return sendResponse({ ok: false, error: '任务不存在或已结束' });
        }
        case 'tasks:clear': {
          // 两个端点都清一遍，失败不阻塞
          await Promise.allSettled([
            api('/api/tasks/clear', { method: 'POST', target: 'server' }),
            api('/api/tasks/clear', { method: 'POST', target: 'local' }),
          ]);
          return sendResponse({ ok: true });
        }
        case 'openFolder': {
          const data = await api('/api/open-folder', { method: 'POST', target: msg.target });
          return sendResponse({ ok: true, dir: data.dir });
        }
        case 'health': {
          return sendResponse(await health(msg.target));
        }
        case 'pair': {
          const token = await pair(msg.target || 'server', true);
          return sendResponse({ ok: !!token, token });
        }
        case 'page:title': {
          // content script 广播的页面真实标题。信息流页面只修正「最近嗅探、
          // 且标题还是上一条页面标题/标签页标题」的条目，避免把当前视频的
          // 标题覆盖到所有历史条目上
          const tabId = sender?.tab?.id;
          const title = String(msg.title || '').trim();
          if (tabId == null || tabId < 0 || !title) return sendResponse({ ok: true });
          const prev = realTitleByTab.get(tabId);
          const now = Date.now();
          realTitleByTab.set(tabId, { title, at: now });
          const map = mediaByTab.get(tabId);
          if (map) {
            const prevTitle = prev ? prev.title : '';
            const tabTitle = tabTitles.get(tabId) || '';
            for (const e of map.values()) {
              if (now - e.lastSeen < 20000 && (!e.pageTitle || e.pageTitle === prevTitle || e.pageTitle === tabTitle)) {
                e.pageTitle = title;
              }
            }
            persist();
          }
          return sendResponse({ ok: true });
        }
        case 'config:get': {
          return sendResponse({ ok: true, config: await getConfig() });
        }
        case 'config:set': {
          const cfg = await setConfig(msg.patch || {});
          cachedToken = { server: cfg.serverToken || '', local: cfg.localToken || '' };
          return sendResponse({ ok: true, config: cfg });
        }
        case 'update:check': {
          clearUpdateBadge();
          const [b, f] = await Promise.all([checkBackend(msg.target), checkFrontend()]);
          if (f.ok && f.newer) {
            chrome.action.setBadgeText({ text: '↑' }).catch(() => {});
            chrome.action.setBadgeBackgroundColor({ color: '#e5484d' }).catch(() => {});
          }
          return sendResponse({ ok: true, backend: b, frontend: f });
        }
        case 'update:backend': {
          return sendResponse(await updateBackend(msg.target));
        }
        case 'update:frontend': {
          return sendResponse(await updateFrontend());
        }
        case 'update:clear-badge': {
          clearUpdateBadge();
          return sendResponse({ ok: true });
        }
        default:
          return sendResponse({ ok: false, error: '未知消息类型: ' + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // 异步响应
});

chrome.runtime.onInstalled.addListener(async () => {
  await ensureLoaded();
  await getConfig();
  // 两个端点都尝试预配对（本机/服务器若在线则直接拿到 Token）
  pair('server').catch(() => {});
  pair('local').catch(() => {});
  // 建立自动更新检测：首次延迟 1 分钟后查一次，此后每 6 小时一次
  chrome.alarms.create('wvd-update-check', { delayInMinutes: 1, periodInMinutes: 360 });
});

/* 自动检测更新：前端（扩展）有新版本时打徽标 + 通知 */
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'wvd-update-check') return;
  const f = await checkFrontend();
  if (!f.ok || !f.newer) return;
  chrome.action.setBadgeText({ text: '↑' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#e5484d' }).catch(() => {});
  chrome.notifications.create('wvd-update', {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: '网页视频下载器有新版本',
    message: `当前 v${f.current}，最新 v${f.latest}。到扩展设置页点「更新前端」即可。`,
    priority: 2,
  }).catch(() => {});
});
