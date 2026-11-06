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
  `;

  const state = {
    cfg: { autoButton: true, minSize: 120 },
    tracked: new Map(),
    host: null,
    shadow: null,
    layer: null,
    items: [],
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

  function scan(root) {
    if (!root || !root.querySelectorAll) return;
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
    btn.innerHTML = `${ICON_DL}<span class="lab">下载</span>`;
    btn.title = '下载这个视频';

    const stop = (e) => { e.stopPropagation(); };
    btn.addEventListener('mousedown', stop, true);
    btn.addEventListener('pointerdown', stop, true);
    btn.addEventListener('mouseup', stop, true);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rec = state.tracked.get(v);
      if (rec && rec.state === 'running') return;
      startDownloadFor(v, rec);
    }, true);

    state.layer.appendChild(btn);
    state.tracked.set(v, { btn, state: 'idle', taskId: null, hidden: true });
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
    const fullscreen = !!document.fullscreenElement;
    const minW = state.cfg.minSize || 120;

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
      const visible = !fullscreen && r.width >= minW && r.height >= 90 &&
        r.bottom > 8 && r.top < window.innerHeight - 8 && r.right > 8 && r.left < window.innerWidth - 8;

      if (!visible) {
        rec.btn.classList.remove('show');
        continue;
      }
      const w = rec.btn.offsetWidth || 84;
      rec.btn.style.left = Math.max(6, Math.round(r.right - w - 10)) + 'px';
      rec.btn.style.top = Math.round(Math.max(6, r.top + 10)) + 'px';
      rec.btn.classList.add('show');
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

    // 4) 嗅探列表里优先级最高的（播放列表优于直链，新的优于旧的）
    const score = (it) => {
      let s = 0;
      if (it.kind === 'hls') s += 100;
      else if (it.kind === 'dash') s += 90;
      else if (it.kind === 'mp4') s += 60;
      else if (it.kind === 'webm') s += 55;
      else s += 30;
      s += Math.min(20, (it.lastSeen - it.firstSeen) / 1000);
      return s;
    };
    const usable = items.filter((it) => ['hls', 'dash', 'mp4', 'webm', 'flv', 'video', 'audio'].includes(it.kind));
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

  /** 站点特化标题：抖音等站点默认 document.title 是品牌标语，真正的标题在页面描述里 */
  function siteTitle() {
    const host = location.hostname;
    if (/douyin\.com$/i.test(host)) {
      // 已知 data-e2e 取值 + 兜底扫描所有含 desc 的 data-e2e（覆盖个人主页视频弹窗等场景）
      const sels = [
        '[data-e2e="detail-video-desc"]',
        '[data-e2e="video-desc"]',
        '[data-e2e="video-cover-desc"]',
        '[data-e2e="search-video-desc"]',
      ];
      const els = [];
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (el) els.push(el);
      }
      try {
        document.querySelectorAll('[data-e2e]').forEach((el) => {
          const k = String(el.getAttribute('data-e2e') || '').toLowerCase();
          if (k.includes('desc') && !els.includes(el)) els.push(el);
        });
      } catch (_) {}
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

    // 4.5) 站点特化标题（抖音等）
    if (!t) t = siteTitle();

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
        if (!menu.contains(e.target)) close(null);
      };
      setTimeout(() => document.addEventListener('pointerdown', onDoc, true), 0);
    });
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

    const title = (explicit && explicit.title) || pageTitle(video);
    const result = await send({
      type: 'download',
      url: pick.url,
      kind: pick.kind || 'auto',
      title,
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

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'task:update') return;
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
  });

  /* ------------------------------ 启动 ------------------------------ */

  async function init() {
    const cfgRes = await send({ type: 'config:get' });
    if (cfgRes && cfgRes.ok) state.cfg = cfgRes.config;

    buildUI();
    scan(document);
    requestAnimationFrame(loop);
    // 标题延迟再广播一次（抖音等站点描述是异步渲染的）
    setTimeout(() => broadcastTitle(true), 2500);
    setTimeout(() => broadcastTitle(true), 8000);

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
