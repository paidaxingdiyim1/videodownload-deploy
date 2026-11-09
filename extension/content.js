'use strict';

/* ==========================================================================
 *  网页视频下载器 · 页面脚本
 *  - 扫描页面里的 <video>（含开放的 shadow DOM），在右上角浮出下载按钮
 *  - 右下角资源面板列出本页嗅探到的所有媒体流
 *  - 与后台通信，显示下载进度
 * ========================================================================== */

(() => {
  if (window.__WVD_CONTENT__) return;
  window.__WVD_CONTENT__ = true;

  const ICON_DL = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/></svg>`;
  const ICON_OK = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12 5 5L20 6"/></svg>`;

  const CSS = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
    .vbtn {
      position: absolute; pointer-events: auto; display: inline-flex; align-items: center; gap: 5px;
      height: 30px; padding: 0 10px; border: 0; border-radius: 15px;
      background: rgba(18, 20, 24, .84); color: #fff;
      font: 600 12px/1 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
      cursor: pointer; opacity: 0; transform: translateY(-5px); white-space: nowrap;
      box-shadow: 0 3px 10px rgba(0,0,0,.35), inset 0 0 0 1px rgba(255,255,255,.12);
      backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
      transition: opacity .16s ease, transform .16s ease, background .16s ease;
    }
    .vbtn.show { opacity: 1; transform: translateY(0); }
    .vbtn:hover { background: #2b6cff; }
    .vbtn:active { transform: scale(.96); }
    .vbtn[data-s="running"] { background: #2b6cff; cursor: default; }
    .vbtn[data-s="done"] { background: #10a35a; }
    .vbtn[data-s="error"] { background: #e5484d; }

    .tmenu { position: absolute; pointer-events: auto; min-width: 168px; background: #fff; border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,.25), 0 0 0 1px rgba(0,0,0,.06); overflow: hidden;
      font: 600 12.5px/1 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; color: #1a1d21; }
    .tm-hd { padding: 8px 12px; color: #8a8f98; font-weight: 500; font-size: 11.5px; border-bottom: 1px solid #f0f1f3; }
    .tm-it { display: flex; align-items: center; gap: 8px; width: 100%; border: 0; background: none;
      padding: 10px 12px; cursor: pointer; font: inherit; color: inherit; text-align: left; }
    .tm-it:hover { background: #2b6cff; color: #fff; }
    .tm-it .tm-ic { font-size: 13px; }
    .tm-in { box-sizing: border-box; width: 100%; border: 0; border-bottom: 1px solid #eef0f2;
      padding: 10px 12px; font: 500 13px/1.3 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
      color: #1a1d21; outline: none; background: #fff; }
    .tm-in:focus { border-bottom-color: #2b6cff; }
    .tm-row { display: flex; border-top: 1px solid #f0f1f3; }
    .tm-btn { flex: 1; border: 0; background: none; padding: 10px 0; cursor: pointer;
      font: 600 12.5px/1 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; color: #8a8f98; }
    .tm-btn + .tm-btn { border-left: 1px solid #f0f1f3; }
    .tm-btn.ok { color: #2b6cff; font-weight: 700; }
    .tm-btn:hover { background: #f4f6f8; }
  `;

  const state = {
    cfg: { autoButton: true, minSize: 120 },
    tracked: new Map(),
    host: null,
    shadow: null,
    layer: null,
    items: [],
    isLive: false,
    blobTimes: new Map(), // blob: 地址 -> 创建时刻（inject.js 主世界钩子上报）
    awemeItems: new Map(), // 抖音作品 id -> {desc, video, audio}（feed 接口解析）
  };

  /* ------------------------------ 通信 ------------------------------ */

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
          resolve(res || { ok: false, error: '无响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: '扩展已重新加载，请刷新页面' });
      }
    });
  }

  /* ------------------------------ UI 构建 ------------------------------ */

  function buildUI() {
    if (state.host) return;
    const host = document.createElement('div');
    host.setAttribute('data-wvd', '1');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const layer = document.createElement('div');
    layer.className = 'layer';
    shadow.append(style, layer);
    (document.documentElement || document.body).appendChild(host);
    state.host = host;
    state.shadow = shadow;
    state.layer = layer;
  }

  /* ------------------------------ 视频跟踪 ------------------------------ */

  /** 把页面级真实标题广播给后台（弹窗嗅探列表与下载命名都用它） */
  let lastBroadcast = 0;
  function broadcastTitle(force) {
    const now = Date.now();
    if (!force && now - lastBroadcast < 5000) return;
    lastBroadcast = now;
    const t = siteTitle() || titleWorth(stripSiteSuffix(document.title), location.hostname.replace(/^www\./, ''));
    if (t) send({ type: 'page:title', title: t });
  }

  /** 广播「当前正在播放的视频地址」，弹窗列表据此标注当前视频 */
  let lastCurrent = 0;
  function broadcastCurrent(force) {
    const now = Date.now();
    if (!force && now - lastCurrent < 5000) return;
    lastCurrent = now;
    const vw = window.innerWidth, vh = window.innerHeight;
    let best = null;
    for (const [v] of state.tracked) {
      if (!v.isConnected) continue;
      const r = v.getBoundingClientRect();
      if (r.width < 80 || r.height < 60) continue;
      // 必须真的在视口里：信息流滑走的视频仍留在布局中（只是移出屏幕），
      // 尺寸依旧很大，不排除会把预加载的别的视频当成「当前」
      const ix = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      const iy = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      if (ix * iy < 0.3 * r.width * r.height) continue;
      const item = { v, area: ix * iy, playing: !v.paused && !v.ended };
      // 优先正在播放的；同状态取可见面积大的
      if (!best || (item.playing && !best.playing) || (item.playing === best.playing && item.area > best.area)) {
        best = item;
      }
    }
    if (best && best.v.currentSrc) {
      // 抖音特化：当前作品 id + feed 接口里的播放地址（按 ID 精确匹配，不靠猜）
      const awemeId = activeAwemeId(best.v);
      const aweme = awemeId ? (state.awemeItems.get(awemeId) || null) : null;
      send({
        type: 'page:current',
        src: best.v.currentSrc,
        // blob: 地址的创建时刻——后台用它把 blob 精确配对到真实网络流
        blobT: state.blobTimes.get(best.v.currentSrc) || 0,
        // 正在播放视频的精确时长——后台拿它当指纹让服务器 ffprobe 配对（最可靠）
        duration: Number.isFinite(best.v.duration) ? best.v.duration : 0,
        awemeId,
        aweme,
        // 用「正在播放的这个视频」所在卡片里的描述作为标题（而非全局第一个）
        title: siteTitle(best.v) || (aweme && aweme.desc) || titleWorth(stripSiteSuffix(document.title), location.hostname.replace(/^www\./, '')) || '',
        // 信息流站点：弹窗只显示当前视频的链接（防堆积，只识别正在播放的）
        solo: isDouyin(),
      });
    }
  }

  /** 检测并同步直播间状态：直播间时停止扫描、隐藏按钮、通知后台停止嗅探 */
  function refreshLiveState() {
    const live = isLiveRoom();
    if (live === state.isLive) return;
    state.isLive = live;
    send({ type: 'page:live', live });
    if (live) {
      for (const rec of state.tracked.values()) rec.btn.classList.remove('show');
    }
  }

  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    refreshLiveState();
    if (state.isLive) return; // 直播间：不进行资源探索
    let list;
    try { list = root.querySelectorAll('video'); } catch (_) { return; }
    list.forEach(trackVideo);

    // 开放 shadow DOM 里的视频
    let all;
    try { all = root.querySelectorAll('*'); } catch (_) { return; }
    if (all.length > 4000) return;
    for (const el of all) {
      if (el.shadowRoot) {
        try { el.shadowRoot.querySelectorAll('video').forEach(trackVideo); } catch (_) {}
      }
    }
    broadcastTitle(false);
  }

  function trackVideo(v) {
    if (state.tracked.has(v)) return;
    if (!state.layer) buildUI();

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vbtn';
    btn.dataset.s = 'idle';
    const isDy = isDouyin();
    btn.innerHTML = `${ICON_DL}<span class="lab">${isDy ? '解析' : '下载'}</span>`;
    btn.title = isDy ? '解析当前视频的播放地址' : '下载这个视频';

    const stop = (e) => { e.stopPropagation(); };
    btn.addEventListener('mousedown', stop, true);
    btn.addEventListener('pointerdown', stop, true);
    btn.addEventListener('mouseup', stop, true);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rec = state.tracked.get(v);
      if (!rec || rec.state === 'running' || rec.state === 'loading') return;
      // 抖音：两段式——先「解析」拿到官方地址（含音轨+文案），就绪后变「下载」；
      // 其它站点：直接下载（无需开标签页解析）
      if (isDouyin() && !rec.aweme) {
        parseFor(v, rec);
      } else {
        startDownloadFor(v, rec);
      }
    }, true);

    state.layer.appendChild(btn);
    state.tracked.set(v, { btn, state: 'idle', taskId: null, hidden: true, aweme: null });
  }

  function setBtnState(rec, s, label, tip) {
    rec.state = s;
    rec.btn.dataset.s = s;
    const lab = rec.btn.querySelector('.lab');
    const icon = s === 'done' ? ICON_OK : ICON_DL;
    rec.btn.innerHTML = `${icon}<span class="lab">${label}</span>`;
    if (tip) rec.btn.title = tip;
    else if (s === 'idle') rec.btn.title = '下载这个视频';
    void lab;
  }

  let lastPos = 0;
  function loop(ts) {
    requestAnimationFrame(loop);
    if (ts - lastPos < 90) return;
    lastPos = ts;
    updatePositions();
  }

  function updatePositions() {
    if (document.hidden) return;
    if (state.isLive) {
      // 直播间：不显示任何下载按钮
      for (const rec of state.tracked.values()) rec.btn.classList.remove('show');
      return;
    }
    const fullscreen = !!document.fullscreenElement;
    const minW = state.cfg.minSize || 120;

    // 第一遍：收集可见的视频
    const visible = [];
    for (const [v, rec] of state.tracked) {
      if (!v.isConnected) {
        rec.btn.remove();
        state.tracked.delete(v);
        continue;
      }
      if (!state.cfg.autoButton) {
        rec.btn.classList.remove('show');
        continue;
      }
      const r = v.getBoundingClientRect();
      const ok = !fullscreen && r.width >= minW && r.height >= 90 &&
        r.bottom > 8 && r.top < window.innerHeight - 8 && r.right > 8 && r.left < window.innerWidth - 8;
      if (!ok) {
        rec.btn.classList.remove('show');
        continue;
      }
      visible.push({ v, rec, r, area: r.width * r.height });
    }
    broadcastCurrent(false);

    // 抖音信息流：只对「正在播放」的视频显示下载按钮。
    // 只要页面里有正在播放的视频，就隐藏所有已暂停（预加载/滑走）的视频按钮
    if (isDouyin() && visible.some((x) => !x.v.paused)) {
      for (let i = visible.length - 1; i >= 0; i--) {
        if (visible[i].v.paused) {
          visible[i].rec.btn.classList.remove('show');
          visible.splice(i, 1);
        }
      }
    }

    // 第二遍：重叠去重（信息流站点当前视频和预加载的下一条常完全叠在一起）
    // 优先保留「正在播放」的，其次面积大的；与其重叠超过小者 50% 的视为同一个
    const keep = [];
    for (const item of visible.sort((a, b) =>
      (a.v.paused ? 1 : 0) - (b.v.paused ? 1 : 0) || b.area - a.area)) {
      const dup = keep.some((k) => {
        const ox = Math.max(0, Math.min(k.r.right, item.r.right) - Math.max(k.r.left, item.r.left));
        const oy = Math.max(0, Math.min(k.r.bottom, item.r.bottom) - Math.max(k.r.top, item.r.top));
        const min = Math.min(k.area, item.area);
        return min > 0 && (ox * oy) / min > 0.5;
      });
      if (dup) {
        item.rec.btn.classList.remove('show');
        continue;
      }
      keep.push(item);
    }

    // 第三遍：定位显示
    for (const item of keep) {
      const w = item.rec.btn.offsetWidth || 84;
      item.rec.btn.style.left = Math.max(6, Math.round(item.r.right - w - 10)) + 'px';
      item.rec.btn.style.top = Math.round(Math.max(6, item.r.top + 10)) + 'px';
      item.rec.btn.classList.add('show');
    }
  }

  /* ------------------------------ 选择下载地址 ------------------------------ */

  const MANIFEST_RE = /\.(m3u8|mpd)(\?|#|$)/i;

  function candidatesOf(v) {
    const out = [];
    const push = (u) => {
      if (!u || typeof u !== 'string') return;
      if (!/^https?:/i.test(u)) return;
      if (!out.includes(u)) out.push(u);
    };
    push(v.currentSrc);
    push(v.getAttribute('src'));
    push(v.src);
    v.querySelectorAll('source').forEach((s) => { push(s.src); push(s.getAttribute('src')); });
    // 有些播放器把地址挂在属性上
    for (const attr of ['data-src', 'data-url', 'data-video-url', 'data-play-url']) {
      push(v.getAttribute(attr));
      const parent = v.parentElement;
      if (parent) push(parent.getAttribute(attr));
    }
    return out;
  }

  function pickTarget(v) {
    const cands = candidatesOf(v);
    const items = state.items || [];

    // 1) 页面里直接可用的播放列表
    const directManifest = cands.find((u) => MANIFEST_RE.test(u));
    if (directManifest) return { url: directManifest, kind: /\.mpd/i.test(directManifest) ? 'dash' : 'hls' };

    // 2) 和嗅探结果完全一致的地址
    for (const c of cands) {
      const hit = items.find((it) => it.url === c || decodeURIComponent(it.url) === c);
      if (hit) return hit;
    }

    // 3) 候选里的普通视频文件
    const directFile = cands.find((u) => /\.(mp4|webm|flv|m4v|mov|mkv)(\?|#|$)/i.test(u));
    if (directFile) return { url: directFile, kind: 'mp4' };

    // 4) 嗅探列表里优先级最高的（作品页地址最优——抖音按 ID 精确匹配的入口）
    const score = (it) => {
      let s = 0;
      if (it.kind === 'page') s += 200;
      else if (it.kind === 'hls') s += 100;
      else if (it.kind === 'dash') s += 90;
      else if (it.kind === 'mp4') s += 60;
      else if (it.kind === 'webm') s += 55;
      else s += 30;
      s += Math.min(20, (it.lastSeen - it.firstSeen) / 1000);
      return s;
    };
    const usable = items.filter((it) => ['hls', 'dash', 'mp4', 'webm', 'flv', 'video', 'audio', 'page'].includes(it.kind));
    if (usable.length) return [...usable].sort((a, b) => score(b) - score(a))[0];

    // 5) 兜底：候选里任意 http 地址
    if (cands.length) return { url: cands[0], kind: 'auto' };
    return null;
  }

  /** 判断一个标题是否「有信息量」：空、太短、纯站名都算没有 */
  function titleWorth(t, host) {
    t = String(t || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length < 2 || t.length > 300) return '';
    if (/^(视频|video|影片|正片|播放|player|index|首页|loading|live)$/i.test(t)) return '';
    if (host && t.toLowerCase() === host.toLowerCase()) return '';
    return t;
  }

  /** 在视频元素的祖先节点附近找标题文本（很多站点没有 og:title，但正文里有标题） */
  function nearbyTitle(video) {
    const SEL = 'h1, h2, h3, [itemprop="name"], [class*="title" i], [class*="headline" i]';
    let node = video;
    for (let depth = 0; depth < 6 && node; depth++) {
      node = node.parentElement;
      if (!node || node === document.body || node === document.documentElement) break;
      for (const h of node.querySelectorAll(SEL)) {
        // 排除把视频整个包进去的容器（class 碰巧带 title 的外层 div）
        if (h.contains(video)) continue;
        // 排除我们自己的浮层（虽然 Shadow DOM 理论上查不到，双保险）
        if (h.closest && h.closest('[data-wvd]')) continue;
        const txt = (h.innerText || h.textContent || '').replace(/\s+/g, ' ').trim();
        if (txt.length >= 2 && txt.length <= 120) return txt;
      }
    }
    return '';
  }

  /** 去掉「标题 - 站名」这类后缀 */
  function stripSiteSuffix(t) {
    const siteNameEl = document.querySelector('meta[property="og:site_name"]');
    const siteName = (siteNameEl && siteNameEl.content ? siteNameEl.content : location.hostname.replace(/^www\./, '').split('.')[0]).trim();
    const parts = t.split(/\s+[-|–—·|]\s+/);
    if (parts.length > 1 && siteName) {
      const last = parts[parts.length - 1].toLowerCase();
      if (last.includes(siteName.toLowerCase()) || location.hostname.toLowerCase().includes(last) && last.length >= 2) {
        parts.pop();
      }
    }
    return parts.join(' - ').trim();
  }

  /** 是否抖音站点 */
  function isDouyin() {
    return /douyin\.com$/i.test(location.hostname);
  }

  /** 短视频/中视频平台：不做主动资源嗅探，改为「粘贴分享链接解析」模式 */
  function isShortVideoSite() {
    return /(douyin\.com|iesdouyin\.com|kuaishou\.com|chenzhongtech\.com|gifshow\.com|bilibili\.com)$/i.test(location.hostname);
  }

  /** 是否直播间：URL 特征 + DOM 特征双保险 */
  function isLiveRoom() {
    if (/^live\./i.test(location.hostname)) return true;
    if (isDouyin()) {
      try {
        const t = document.title || '';
        if (t.includes('的直播间') || t.includes('正在直播')) return true;
        if (document.querySelector('[data-e2e="live-room"]')) return true;
      } catch (_) {}
    }
    return false;
  }

  /**
   * 站点特化标题：抖音等站点默认 document.title 是品牌标语，真正的标题在页面描述里。
   * 传入 video 时，优先在它所在的卡片容器内查找 desc，保证标题和正在看的视频对齐
   * （信息流页有多个视频卡片，全局 querySelector 抓到的第一个往往是错的）。
   */
  function siteTitle(video) {
    const host = location.hostname;
    if (!/douyin\.com$/i.test(host)) return '';

    // 确定查找范围：有 video 时向上找第一个「子树里含 desc 元素」的卡片容器
    let scope = document;
    if (video) {
      let node = video.parentElement;
      for (let i = 0; i < 9 && node && node !== document.body; i++) {
        let hasDesc = false;
        try {
          node.querySelectorAll('[data-e2e]').forEach((el) => {
            if (String(el.getAttribute('data-e2e') || '').toLowerCase().includes('desc')) hasDesc = true;
          });
        } catch (_) {}
        if (hasDesc) { scope = node; break; }
        node = node.parentElement;
      }
    }

    const els = [];
    const seen = new Set();
    const collect = (root) => {
      if (!root || !root.querySelectorAll) return;
      for (const sel of [
        '[data-e2e="detail-video-desc"]',
        '[data-e2e="video-desc"]',
        '[data-e2e="video-cover-desc"]',
        '[data-e2e="search-video-desc"]',
      ]) {
        try { root.querySelectorAll(sel).forEach((el) => { if (!seen.has(el)) { seen.add(el); els.push(el); } }); } catch (_) {}
      }
      try {
        root.querySelectorAll('[data-e2e]').forEach((el) => {
          const k = String(el.getAttribute('data-e2e') || '').toLowerCase();
          if (k.includes('desc') && !seen.has(el)) { seen.add(el); els.push(el); }
        });
      } catch (_) {}
    };
    collect(scope);
    if (!els.length && scope !== document) collect(document); // 卡片内没找到时兜底全局

    for (const el of els) {
      let txt = String((el.innerText || el.textContent || '')).replace(/\s+/g, ' ').trim();
      if (txt) {
        // 去掉话题标签、@用户、emoji 干扰，标题取前 60 字
        txt = txt.replace(/(#[^\s#]+|@[\w\u4e00-\u9fa5-]+)/g, ' ').replace(/\s+/g, ' ').trim();
        txt = txt.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ').replace(/\s+/g, ' ').trim();
        if (txt.length > 60) txt = txt.slice(0, 60).trim();
        const w = titleWorth(txt, host.replace(/^www\./, ''));
        if (w) return w;
      }
    }
    return '';
  }

  function pageTitle(video) {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      return el && el.content ? el.content.trim() : '';
    };
    const host = location.hostname.replace(/^www\./, '');

    // 1) 站点元数据（最可靠）
    let t = titleWorth(pick('meta[property="og:title"]'), host) || titleWorth(pick('meta[name="twitter:title"]'), host);

    // 2) JSON-LD 结构化数据
    if (!t) {
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const j = JSON.parse(s.textContent);
          const objs = Array.isArray(j) ? j : [j, ...((j && j['@graph']) || [])];
          for (const o of objs) {
            if (o && o.name) {
              t = titleWorth(String(o.name), host);
              if (t) break;
            }
          }
        } catch (_) { /* JSON 损坏就跳过 */ }
        if (t) break;
      }
    }

    // 3) 视频元素自身的标注
    if (!t && video) {
      t = titleWorth(video.getAttribute('title'), host)
        || titleWorth(video.getAttribute('aria-label'), host)
        || titleWorth(video.getAttribute('alt'), host)
        || titleWorth(video.getAttribute('data-title'), host);
    }

    // 4) 视频附近的标题节点
    if (!t && video) t = titleWorth(nearbyTitle(video), host);

    // 4.5) 站点特化标题（抖音等，优先在当前视频所在卡片里找）
    if (!t) t = siteTitle(video);

    // 4.7) 当前集数提取（通用三层信号）。影视站 document.title/og:title 里的
    // 「更新至第X集」是剧集最新进度，不是当前播放集（olevo 实测误标 E06）。
    // 按可靠性依次尝试：
    //   a) 页面主标题 h1/h2（如「FX战士久留美 第03集」）
    //   b) 选集面板当前项（▶ 标记或高亮样式，如「第03集▶」）
    //   c) 播放页 URL 路径的集数段（CMS 常见 /play/xxx-3-1.html）
    try {
      const EP_PAT = /第\s*(\d{1,3})\s*[集话期]/;
      let curEp = null;
      let h1Show = '';
      // a) 主标题：全量扫描 h1/h2，取第一个带集数的（跳过过长的，如推荐区标题）
      for (const el of document.querySelectorAll('h1, h2')) {
        const txt = String(el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!txt || txt.length > 60) continue;
        const m = txt.match(EP_PAT);
        if (m) { h1Show = txt.replace(EP_PAT, '').trim(); curEp = parseInt(m[1], 10); break; }
      }
      // b) 选集面板当前项：文本带 ▶ 或元素高亮 class
      if (curEp == null) {
        const candidates = document.querySelectorAll('a, button, li, span, div');
        for (const el of candidates) {
          const txt = String(el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!txt || txt.length > 12) continue;
          const m = txt.match(EP_PAT);
          if (!m) continue;
          const cls = String(el.className || '');
          if (txt.includes('▶') || /(^|[\s_-])(active|current|cur|on|selected|checked)([\s_-]|$)/i.test(cls)) {
            curEp = parseInt(m[1], 10);
            break;
          }
        }
      }
      // c) 播放页 URL 集数段
      if (curEp == null) {
        const pm = location.pathname.match(/-(\d{1,3})-\d+\.(?:html?|htm)$/i)
          || location.pathname.match(/(?:^|\/)ep(?:isode)?[-_]?(\d{1,3})(?:[-_.]|$)/i);
        if (pm) curEp = parseInt(pm[1], 10);
      }
      if (curEp != null) {
        // 剧名：优先 h1 去集数后的文本；否则用已取标题「- / 更新至」前的部分。
        // h1 剧名与标题剧名明显不符时（推荐位串台），改用标题剧名 + 提取到的集数
        let show = h1Show || '';
        if (t) {
          const tShow = t.split(/\s*[-–—]\s*/)[0].replace(/\s*更新至.*$/, '').trim();
          if (tShow) {
            if (!show || (show.slice(0, 4) !== tShow.slice(0, 4))) show = tShow;
          }
        }
        if (show) t = `${show} 第${String(curEp).padStart(2, '0')}集`;
      }
    } catch (_) { /* 忽略 */ }

    // 5) document.title（顺便剥掉「- 站名」后缀）
    if (!t) {
      const dt = titleWorth(document.title, host);
      if (dt) t = titleWorth(stripSiteSuffix(dt), host) || dt;
    }

    // 6) URL 路径段
    if (!t) {
      try {
        const seg = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
        t = titleWorth(seg.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_-]+/g, ' '), host);
      } catch (_) { /* decode 失败就算了 */ }
    }

    return t || '视频';
  }

  /* ------------------------------ 下载动作 ------------------------------ */

  /** 决定保存位置：配置固定则直接用；ask 模式弹菜单询问 */
  function chooseTarget(anchor) {
    const st = state.cfg && state.cfg.saveTarget;
    if (st === 'local') return Promise.resolve('local');
    if (st === 'server') return Promise.resolve('server');
    return askTarget(anchor);
  }

  function askTarget(anchor) {
    return new Promise((resolve) => {
      buildUI();
      const menu = document.createElement('div');
      menu.className = 'tmenu';
      menu.innerHTML = `
        <div class="tm-hd">保存到哪里？</div>
        <button class="tm-it" data-t="server" type="button"><span class="tm-ic">⬆</span>保存到服务器</button>
        <button class="tm-it" data-t="local" type="button"><span class="tm-ic">▣</span>保存到本机</button>`;
      let x = Math.max(8, window.innerWidth / 2 - 84);
      let y = Math.max(8, window.innerHeight / 2 - 50);
      if (anchor && typeof anchor.getBoundingClientRect === 'function') {
        const r = anchor.getBoundingClientRect();
        x = Math.min(Math.max(8, r.left), window.innerWidth - 180);
        y = r.bottom + 6;
        if (y + 92 > window.innerHeight) y = Math.max(8, r.top - 98);
      }
      menu.style.left = x + 'px';
      menu.style.top = y + 'px';
      state.layer.appendChild(menu);
      let done = false;
      const close = (val) => {
        if (done) return;
        done = true;
        menu.remove();
        document.removeEventListener('pointerdown', onDoc, true);
        resolve(val);
      };
      menu.querySelectorAll('.tm-it').forEach((b) => {
        b.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          close(b.dataset.t);
        });
      });
      const onDoc = (e) => {
        // 菜单在 Shadow DOM 里：其内部点击在 document 层会被重定向到宿主元素，
        // 所以 e.target === state.host 时说明点击发生在菜单内，不能关
        if (e.target === state.host) return;
        if (!menu.contains(e.target)) close(null);
      };
      setTimeout(() => document.addEventListener('pointerdown', onDoc, true), 0);
    });
  }

  /** 下载前可改文件名：预填自动识别的标题，像 Windows「另存为」一样，回车确认、Esc 取消 */
  function askFilename(defaultName, anchor) {
    return new Promise((resolve) => {
      buildUI();
      const box = document.createElement('div');
      box.className = 'tmenu';
      box.style.minWidth = '300px';
      box.innerHTML = `
        <div class="tm-hd">保存文件名</div>
        <input class="tm-in" type="text" spellcheck="false" autocomplete="off">
        <div class="tm-row">
          <button class="tm-btn" type="button">取消</button>
          <button class="tm-btn ok" type="button">下载</button>
        </div>`;
      const inp = box.querySelector('.tm-in');
      inp.value = defaultName || '';
      let x = Math.max(8, window.innerWidth / 2 - 150);
      let y = Math.max(8, window.innerHeight / 2 - 50);
      if (anchor && typeof anchor.getBoundingClientRect === 'function') {
        const r = anchor.getBoundingClientRect();
        x = Math.min(Math.max(8, r.left), window.innerWidth - 310);
        y = r.bottom + 6;
        if (y + 110 > window.innerHeight) y = Math.max(8, r.top - 116);
      }
      box.style.left = x + 'px';
      box.style.top = y + 'px';
      state.layer.appendChild(box);
      let done = false;
      const close = (val) => {
        if (done) return;
        done = true;
        box.remove();
        document.removeEventListener('pointerdown', onDoc, true);
        resolve(val);
      };
      setTimeout(() => { try { inp.focus(); inp.select(); } catch (_) {} }, 0);
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); close(inp.value.trim()); }
        else if (e.key === 'Escape') close(null);
      });
      const btns = box.querySelectorAll('.tm-btn');
      btns[0].addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); close(null); });
      btns[1].addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); close(inp.value.trim()); });
      const onDoc = (e) => {
        if (e.target === state.host) return;
        if (!box.contains(e.target)) close(null);
      };
      setTimeout(() => document.addEventListener('pointerdown', onDoc, true), 0);
    });
  }

  /* ------------------ 浏览器端 HLS 下载（Cloudflare 保护站回退） ------------------ */

  function parseM3U8Text(text, baseUrl) {
    const lines = String(text || '').split(/\r?\n/);
    const variants = [];
    const segments = [];
    let isMaster = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        isMaster = true;
        const bw = Number((line.match(/BANDWIDTH=(\d+)/) || [])[1] || 0);
        for (let j = i + 1; j < lines.length; j++) {
          const nl = lines[j].trim();
          if (nl && !nl.startsWith('#')) { variants.push({ bandwidth: bw, url: new URL(nl, baseUrl).toString() }); i = j; break; }
        }
      } else if (line.startsWith('#EXTINF')) {
        for (let j = i + 1; j < lines.length; j++) {
          const nl = lines[j].trim();
          if (nl && !nl.startsWith('#')) { segments.push(new URL(nl, baseUrl).toString()); i = j; break; }
        }
      }
    }
    return { isMaster, variants, segments };
  }

  /** 当前正在播放视频的按钮记录（浏览器下载回退时更新它的状态） */
  function activeRec() {
    const vw = window.innerWidth, vh = window.innerHeight;
    let best = null;
    for (const [v, rec] of state.tracked) {
      if (!v.isConnected || rec.hidden) continue;
      const r = v.getBoundingClientRect();
      if (r.width < 80 || r.height < 60) continue;
      const ix = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      const iy = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      if (ix * iy < 0.3 * r.width * r.height) continue;
      const playing = !v.paused && !v.ended;
      if (!best || (playing && !best.playing) || (playing === best.playing && ix * iy > best.area)) best = { rec, playing, area: ix * iy };
    }
    return best ? best.rec : null;
  }

  /** 浏览器端下载 HLS（页面同源，能过 Cloudflare）+ 分片上传服务器 */
  async function browserDownload(msg) {
    const url = msg.url;
    const title = msg.title || '视频';
    const customName = msg.customName || '';
    const referer = msg.referer || location.href;
    try {
      const hdrs = { 'Referer': referer };
      // 用主世界 fetch（inject.js 执行，与页面 hls.js 同上下文，能过 Cloudflare）
      let r = await wvdFetch(url, hdrs);
      if (!r.ok) throw new Error('浏览器获取播放列表失败：HTTP ' + r.status + '（' + url.slice(0, 70) + '…）');
      let text = new TextDecoder().decode(r.data);
      let baseUrl = r.finalUrl || url;
      let parsed = parseM3U8Text(text, baseUrl);

      if (parsed.isMaster && parsed.variants.length) {
        parsed.variants.sort((a, b) => b.bandwidth - a.bandwidth);
        r = await wvdFetch(parsed.variants[0].url, hdrs);
        if (!r.ok) throw new Error('浏览器获取播放列表失败：HTTP ' + r.status + '（' + parsed.variants[0].url.slice(0, 70) + '…）');
        text = new TextDecoder().decode(r.data);
        baseUrl = r.finalUrl || parsed.variants[0].url;
        parsed = parseM3U8Text(text, baseUrl);
      }
      const segs = parsed.segments;
      if (!segs.length) throw new Error('播放列表里没有分片（可能不是标准 m3u8）');

      // 按分片类型判定容器：TS 分片存 .ts，fmp4（.m4s/.mp4）分片存 .mp4
      const ext = /\.(m4s|mp4)(\?|$)/i.test(segs[0]) ? 'mp4' : 'ts';

      const start = await send({
        type: 'upload:start',
        title, site: location.hostname.replace(/^www\./, ''), ext, customName, referer,
      });
      if (!start || !start.ok) throw new Error((start && start.error) || '无法开始上传');

      const uploadId = start.uploadId;
      for (let i = 0; i < segs.length; i++) {
        const sr = await wvdFetch(segs[i], hdrs);
        if (!sr.ok) throw new Error('分片 ' + (i + 1) + ' 下载失败：HTTP ' + sr.status);
        const cr = await send({ type: 'upload:chunk', uploadId, data: sr.data });
        if (!cr || !cr.ok) throw new Error((cr && cr.error) || '上传分片失败');
      }
      const fin = await send({ type: 'upload:finish', uploadId, customName });
      if (!fin || !fin.ok) throw new Error((fin && fin.error) || '保存失败');
      return { ok: true, filePath: fin.filePath, fileName: fin.fileName };
    } catch (e) {
      let m = String(e && e.message || e);
      if (/Failed to fetch|NetworkError|TypeError|Load failed/i.test(m)) {
        m = '浏览器请求被拦截（可能 CORS/网络限制）：' + m;
      }
      return { ok: false, error: m };
    }
  }

  /** 是否 Cloudflare 强防护站（surrit 等）——这类站服务器下载慢，本机可用前端下载器 */
  function isCfUrl(u) {
    return /surrit\.com/i.test(String(u || ''));
  }

  /** 前端下载器：浏览器多线程下载分片 + 合并 + 保存到本机（用本机网络资源，绕过服务器慢链路） */
  async function downloadLocal(url, filename, rec) {
    try {
      // 拉取帮助：优先 content 直接 fetch（真实浏览器指纹）；失败回退主世界桥接。
      // 失败时把「content fetch 的具体结果 + 主世界结果」都带上，便于定位
      const fetchBuf = async (u) => {
        let contentErr = '';
        try {
          const res = await fetch(u, { credentials: 'include' });
          if (res.ok) {
            return { ok: true, status: res.status, finalUrl: res.url || u, data: await res.arrayBuffer() };
          }
          contentErr = 'HTTP ' + res.status;
        } catch (e) {
          contentErr = String(e && e.message || e);
        }
        // 回退主世界 fetch 桥接
        try {
          return await wvdFetch(u, {});
        } catch (e2) {
          const wm = String(e2 && e2.message || e2);
          if (/超时/.test(wm)) {
            throw new Error('浏览器直连失败(' + contentErr + ')，且页面钩子未响应——请刷新页面后重试');
          }
          throw new Error('浏览器直连失败(' + contentErr + ')，主世界也失败(' + wm + ')');
        }
      };

      // 1) m3u8 + variant + 分片
      let r = await fetchBuf(url);
      if (!r.ok) throw new Error('获取播放列表失败：HTTP ' + r.status);
      let text = new TextDecoder().decode(r.data);
      let baseUrl = r.finalUrl || url;
      let parsed = parseM3U8Text(text, baseUrl);
      if (parsed.isMaster && parsed.variants.length) {
        parsed.variants.sort((a, b) => b.bandwidth - a.bandwidth);
        r = await fetchBuf(parsed.variants[0].url);
        if (!r.ok) throw new Error('获取播放列表失败：HTTP ' + r.status);
        text = new TextDecoder().decode(r.data);
        baseUrl = r.finalUrl || parsed.variants[0].url;
        parsed = parseM3U8Text(text, baseUrl);
      }
      const segs = parsed.segments;
      if (!segs.length) throw new Error('播放列表里没有分片');

      const ext = /\.(m4s|mp4)(\?|$)/i.test(segs[0]) ? 'mp4' : 'ts';
      const fname = (filename || '视频') + '.' + ext;

      // 2) 并发下载分片（每批 6 个），累积到 Blob 数组
      const parts = new Array(segs.length);
      const BATCH = 6;
      for (let i = 0; i < segs.length; i += BATCH) {
        const batch = segs.slice(i, i + BATCH);
        const datas = await Promise.all(batch.map((u) => fetchBuf(u)));
        for (let j = 0; j < datas.length; j++) {
          if (!datas[j].ok) throw new Error('分片 ' + (i + j + 1) + ' 下载失败：HTTP ' + datas[j].status);
          parts[i + j] = datas[j].data;
        }
        if (rec) setBtnState(rec, 'running', Math.round((i + batch.length) * 100 / segs.length) + '%', '本机下载中');
      }

      // 3) 合并 + 触发浏览器下载到本机
      const blob = new Blob(parts, { type: ext === 'ts' ? 'video/mp2t' : 'video/mp4' });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
      return { ok: true, fileName: fname };
    } catch (e) {
      let m = String(e && e.message || e);
      if (/主世界 fetch 超时/.test(m)) {
        m = '页面钩子未响应：请刷新本页后重试（inject 钩子需页面重载才生效）';
      } else if (/Failed to fetch|NetworkError|TypeError|Load failed/i.test(m)) {
        m = '浏览器请求被拦截（可能 CORS/网络限制）：' + m;
      }
      return { ok: false, error: m };
    }
  }

  /** 抖音悬浮「解析」：按作品 ID 解析官方播放地址（含音轨+文案），成功后按钮变「下载」 */
  async function parseFor(video, rec) {
    if (rec) setBtnState(rec, 'loading', '解析中…', '正在解析播放地址');
    const awemeId = activeAwemeId(video) || '';
    let src = '';
    try { src = video.currentSrc || ''; } catch (_) {}
    const res = await send({
      type: 'parse:aweme',
      awemeId,
      // blob: 地址不可用，交给后台按 ID 反查；有真实流 URL 时一并带上
      url: /^https?:/i.test(src) ? src : '',
      referer: location.href,
    });
    if (res && res.ok && res.aweme && /^https?:/i.test(res.aweme.video || '')) {
      rec.aweme = res.aweme;
      const title = res.aweme.desc || '';
      setBtnState(rec, 'idle', '下载', title ? ('已解析：' + title + ' ｜ 点击下载') : '已解析，点击下载');
      return;
    }
    if (rec) {
      setBtnState(rec, 'error', '解析失败', (res && res.error) || '未能解析播放地址，请先播放几秒再试');
      setTimeout(() => rec.btn.isConnected && setBtnState(rec, 'idle', '解析', '解析当前视频的播放地址'), 4500);
    }
  }

  async function startDownloadFor(video, rec, explicit, target) {
    const btn = rec ? rec.btn : null;
    if (!target) target = await chooseTarget(btn);
    if (!target) return; // 用户取消了选择
    if (rec) setBtnState(rec, 'loading', '识别中…', '正在获取视频地址');

    const res = await send({ type: 'media:list' });
    if (res.ok) state.items = res.items || [];

    const pick = explicit || pickTarget(video);
    if (!pick || !pick.url) {
      if (rec) {
        setBtnState(rec, 'error', '没找到地址', '先点播放让视频加载几秒，再点下载');
        setTimeout(() => rec.btn.isConnected && setBtnState(rec, 'idle', '下载'), 4200);
      }
      return;
    }

    // 已解析过（抖音两段式）或走普通嗅探
    const aweme = rec && rec.aweme ? rec.aweme : null;
    const autoTitle = aweme ? (aweme.desc || pageTitle(video)) : ((explicit && explicit.title) || pageTitle(video));

    // 下载前可改文件名（像 Windows「另存为」：预填自动识别的标题，回车确认，Esc 取消）
    const customName = await askFilename(autoTitle, btn);
    if (customName === null) {
      if (rec) setBtnState(rec, 'idle', '下载');
      return; // 用户取消
    }
    const title = customName || autoTitle;
    const dlUrl = aweme ? aweme.video : pick.url;
    const dlKind = aweme ? 'mp4' : (pick.kind || 'auto');

    // Cloudflare 强防护站 + 保存到本机：用前端下载器（浏览器资源，绕过服务器慢链路）
    if (target === 'local' && isCfUrl(dlUrl)) {
      if (rec) setBtnState(rec, 'running', '0%', '本机下载中（浏览器多线程）');
      const lr = await downloadLocal(dlUrl, title, rec);
      if (lr.ok) {
        if (rec) setBtnState(rec, 'done', '已保存', '已保存到本机：' + lr.fileName);
        setTimeout(() => { if (rec && rec.btn.isConnected) setBtnState(rec, 'idle', '下载'); }, 5000);
      } else {
        send({ type: 'browser-notify', title: '本机下载失败', message: lr.error || '未知错误', diag: true });
        if (rec) setBtnState(rec, 'error', '失败', lr.error || '本机下载失败');
        setTimeout(() => { if (rec && rec.btn.isConnected) setBtnState(rec, 'idle', '下载'); }, 5200);
      }
      return;
    }

    const result = await send({
      type: 'download',
      url: dlUrl,
      kind: dlKind,
      title,
      customName: customName || '',
      // 抖音：带作品 ID，后台未命中时自动补缓存；普通站点 activeAwemeId 为空
      awemeId: aweme ? (aweme.id || '') : (activeAwemeId(video) || ''),
      referer: location.href,
      tabId: null,
      target,
    });

    if (!result.ok) {
      if (rec) {
        setBtnState(rec, 'error', '下载失败', result.error || '请检查下载服务是否启动');
        setTimeout(() => rec.btn.isConnected && setBtnState(rec, 'idle', '下载'), 5200);
      }
      return;
    }

    if (rec) {
      rec.taskId = result.task.id;
      setBtnState(rec, 'running', '0%', (target === 'local' ? '保存到本机：' : '保存到服务器：') + title);
    }
  }

  /* ------------------------------ 进度回调 ------------------------------ */

  // 主世界钩子（inject.js）上报：blob 创建时刻 / 媒体流请求时刻
  window.addEventListener('message', (e) => {
    const d = e && e.data;
    if (!d || d.__wvd !== 1) return;
    if (d.type === 'blob') {
      state.blobTimes.set(d.url, d.t);
      if (state.blobTimes.size > 500) {
        const first = state.blobTimes.keys().next().value;
        state.blobTimes.delete(first);
      }
    } else if (d.type === 'media') {
      send({ type: 'page:media', url: d.url, t: d.t });
    } else if (d.type === 'feeditems' && Array.isArray(d.items)) {
      // 抖音 feed 接口解析结果：作品 id -> 播放地址（画面 + 音频）
      for (const it of d.items) {
        if (it && it.id) state.awemeItems.set(String(it.id), it);
      }
      while (state.awemeItems.size > 300) {
        state.awemeItems.delete(state.awemeItems.keys().next().value);
      }
    } else if (d.type === 'wvd-fetch-result') {
      const w = fetchWaiters.get(d.id);
      if (w) {
        fetchWaiters.delete(d.id);
        if (d.ok) w.resolve(d);
        else w.reject(new Error(d.error || ('HTTP ' + d.status)));
      }
    }
  });

  /* 主世界 fetch 桥接（inject.js 执行，绕过隔离世界被 Cloudflare 单独拦截） */
  let fetchSeq = 0;
  const fetchWaiters = new Map();
  function wvdFetch(url, headers) {
    return new Promise((resolve, reject) => {
      const id = ++fetchSeq;
      fetchWaiters.set(id, { resolve, reject });
      window.postMessage({ __wvd: 1, type: 'wvd-fetch', id, url, headers }, '*');
      setTimeout(() => {
        if (fetchWaiters.has(id)) { fetchWaiters.delete(id); reject(new Error('主世界 fetch 超时')); }
      }, 90000);
    });
  }

  /** 当前视频的作品 id：详情页取路径；信息流取卡片的 data-e2e-vid（分享链接里的 ID） */
  function activeAwemeId(v) {
    const m = location.pathname.match(/\/video\/(\d{15,20})/);
    if (m) return m[1];
    let el = null;
    try { el = v && v.closest && v.closest('[data-e2e-vid]'); } catch (_) {}
    if (!el) {
      try {
        el = document.querySelector('[data-e2e="feed-active-video"] [data-e2e-vid]') ||
             document.querySelector('[data-e2e-vid]');
      } catch (_) {}
    }
    const id = el ? String(el.getAttribute('data-e2e-vid') || '') : '';
    return /^\d{15,20}$/.test(id) ? id : '';
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // 抖音本地解析：按作品 ID 返回缓存的播放地址（inject.js 拦截 feed API 缓存）
    if (msg && msg.type === 'aweme:get') {
      const it = state.awemeItems.get(String(msg.id || ''));
      sendResponse({ ok: true, aweme: it || null });
      return false;
    }
    // 抖音本地解析：按流 URL 反查所属作品（返回官方音轨 + 作品文案标题）
    if (msg && msg.type === 'aweme:find') {
      const u = String(msg.url || '');
      let hit = null;
      for (const it of state.awemeItems.values()) {
        if (it && (it.video === u || it.audio === u)) { hit = it; break; }
      }
      sendResponse({ ok: true, aweme: hit });
      return false;
    }
    // 弹窗「刷新」：清空记录后页面立刻重新上报当前视频与标题
    if (msg && msg.type === 'media:resync') {
      broadcastTitle(true);
      broadcastCurrent(true);
      return false;
    }
    // 服务器下载被 Cloudflare 拦（403）→ 回退浏览器本地下载 + 上传服务器
    if (msg && msg.type === 'browser-download') {
      const rec = activeRec();
      if (rec) setBtnState(rec, 'running', '浏览器下载中…', '绕过 Cloudflare，浏览器直下后上传服务器');
      browserDownload(msg).then((r) => {
        const rr = activeRec() || rec;
        if (r.ok) {
          send({ type: 'browser-notify', title: '已保存到服务器', message: r.fileName || '下载完成' });
          if (rr) { setBtnState(rr, 'done', '已保存', '已保存到服务器：' + (r.fileName || '下载完成')); }
          setTimeout(() => { const r2 = activeRec(); if (r2) setBtnState(r2, 'idle', '下载'); }, 5000);
        } else {
          send({ type: 'browser-notify', title: '浏览器下载失败', message: r.error || '未知错误' });
          if (rr) { setBtnState(rr, 'error', '失败', r.error || '浏览器下载失败'); }
          setTimeout(() => { const r2 = activeRec(); if (r2) setBtnState(r2, 'idle', '下载'); }, 5200);
        }
      });
      return false;
    }
    if (!msg || msg.type !== 'task:update') return false;
    const t = msg.task;
    for (const rec of state.tracked.values()) {
      if (rec.taskId !== t.id) continue;
      if (t.status === 'queued') setBtnState(rec, 'running', '排队…', t.title);
      else if (['running', 'decrypting', 'merging'].includes(t.status)) {
        const label = t.status === 'merging' ? '合并中…' : `${Math.round(t.progress || 0)}%`;
        setBtnState(rec, 'running', label, `${t.title} · ${t.status}`);
      } else if (t.status === 'done') {
        setBtnState(rec, 'done', '已保存', '已保存到：' + (t.filePath || t.fileName));
        rec.taskId = null;
        setTimeout(() => {
          if (rec.btn.isConnected) setBtnState(rec, 'idle', '下载');
        }, 5000);
      } else if (t.status === 'error' || t.status === 'canceled') {
        setBtnState(rec, 'error', t.status === 'canceled' ? '已取消' : '失败', t.error || '');
        rec.taskId = null;
        setTimeout(() => {
          if (rec.btn.isConnected) setBtnState(rec, 'idle', '下载');
        }, 5200);
      }
    }
    return false;
  });

  /* ------------------------------ 启动 ------------------------------ */

  async function init() {
    // 抖音/快手/B站：不做主动资源嗅探（无下载按钮、无列表堆积），
    // 只保留「粘贴分享链接解析」入口，交后端 yt-dlp 特化解析
    if (isShortVideoSite()) {
      send({ type: 'page:nosniff' });
      // 页面标题广播（给嗅探条目命名）
      const tb = () => {
        const t = siteTitle() || titleWorth(stripSiteSuffix(document.title), location.hostname.replace(/^www\./, ''));
        if (t) send({ type: 'page:title', title: t });
      };
      setTimeout(tb, 2000);
      setTimeout(tb, 6000);
      document.addEventListener('playing', (e) => {
        if (e.target && e.target.tagName === 'VIDEO') {
          setTimeout(tb, 400);
          setTimeout(() => broadcastCurrent(true), 700);
        }
      }, true);
      // 恢复下载按钮：仍只给「正在播放」的视频显示（直播间不显示）。
      // 点击后走后台 aweme 反查（v1.6.1）：自动下合并后的完整视频 + 作品文案标题
      buildUI();
      scan(document);
      requestAnimationFrame(loop);
      let moTimer2 = null;
      const mo2 = new MutationObserver((records) => {
        let need = false;
        for (const r of records) {
          if (r.addedNodes && r.addedNodes.length) { need = true; break; }
        }
        if (!need) return;
        clearTimeout(moTimer2);
        moTimer2 = setTimeout(() => scan(document), 350);
      });
      try { mo2.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {}
      window.addEventListener('resize', () => updatePositions(), { passive: true });
      return;
    }

    const cfgRes = await send({ type: 'config:get' });
    if (cfgRes && cfgRes.ok) state.cfg = cfgRes.config;

    buildUI();
    scan(document);
    requestAnimationFrame(loop);
    // 周期检测直播间（推荐流里滑动到直播卡片时 URL 不变，靠 DOM 特征识别）
    setInterval(refreshLiveState, 3000);
    // 标题延迟再广播一次（抖音等站点描述是异步渲染的）
    setTimeout(() => broadcastTitle(true), 2500);
    setTimeout(() => broadcastTitle(true), 8000);
    setTimeout(() => broadcastCurrent(true), 2500);

    // 切换/播放视频时立即刷新「当前视频」标记（信息流滑动）
    document.addEventListener('playing', (e) => {
      if (e.target && e.target.tagName === 'VIDEO') {
        broadcastTitle(true);
        broadcastCurrent(true);
      }
    }, true);

    // 动态插入的视频（SPA / 懒加载）
    let moTimer = null;
    const mo = new MutationObserver((records) => {
      let need = false;
      for (const r of records) {
        if (r.addedNodes && r.addedNodes.length) { need = true; break; }
      }
      if (!need) return;
      clearTimeout(moTimer);
      moTimer = setTimeout(() => scan(document), 350);
    });
    try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {}

    window.addEventListener('resize', () => updatePositions(), { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
