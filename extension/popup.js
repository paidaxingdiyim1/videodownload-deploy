'use strict';

const $ = (s) => document.querySelector(s);

let currentTab = null;
let mediaItems = [];
let tasks = [];
let saveTarget = 'server'; // 当前保存位置（popup 里快速切换）
let cfg = {}; // 扩展配置（含服务器/本机地址与 Token）

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(res || { ok: false });
    });
  });
}

function fmtSize(n) {
  if (!n) return '';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function checkHealth() {
  const r = await send({ type: 'health', target: saveTarget });
  const el = $('#status');
  const where = saveTarget === 'local' ? '本机' : '服务器';
  if (r && r.ok) {
    el.className = 'status ok';
    el.querySelector('.stxt').textContent = `${where}服务已连接`;
  } else {
    el.className = 'status bad';
    el.querySelector('.stxt').textContent = `${where}服务未连接`;
  }
  return r;
}

function renderTarget() {
  document.querySelectorAll('#tgt button').forEach((b) => {
    b.classList.toggle('on', b.dataset.t === saveTarget);
  });
}

async function switchTarget(t) {
  if (t === saveTarget) return;
  saveTarget = t;
  renderTarget();
  await send({ type: 'config:set', patch: { saveTarget: t } });
  checkHealth();
  refresh();
}

function buildLink(t) {
  if (!t) return null;
  const target = t.target === 'local' ? 'local' : 'server';
  if (target === 'local') {
    const fileUrl = 'file:///' + String(t.filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    return { target, filePath: t.filePath, streamUrl: fileUrl, address: '本机 · ' + (t.filePath || t.fileName || '') };
  }
  const base = String(cfg.serverUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '');
  const streamUrl = base + '/api/stream?path=' + encodeURIComponent(t.filePath || '') + '&token=' + encodeURIComponent(cfg.serverToken || '');
  return { target, filePath: t.filePath, streamUrl, address: base + ' · ' + (t.filePath || t.fileName || '') };
}

async function openVideo(t, method) {
  const link = buildLink(t);
  if (!link) return;
  if (method === 'potplayer') {
    // 通过 wvdplay:// 协议唤起本机 PotPlayer（需先运行一次 install-potplayer-handler.ps1）
    window.open('wvdplay:' + link.streamUrl);
  } else {
    if (link.target === 'local') window.open(link.streamUrl);
    else chrome.tabs.create({ url: link.streamUrl });
  }
}

async function copyAddr(t) {
  const link = buildLink(t);
  if (!link) return;
  const text = link.target === 'local' ? link.filePath : link.streamUrl;
  try {
    await navigator.clipboard.writeText(text);
    flashCopy(t.id || '');
  } catch (_) {}
}

function flashCopy() {
  const el = $('#status .stxt');
  const old = el.textContent;
  el.textContent = '地址已复制';
  setTimeout(() => { el.textContent = old; }, 1200);
}

function renderMedia() {
  const list = $('#media-list');
  $('#count').textContent = mediaItems.length;
  if (!mediaItems.length) {
    list.innerHTML = `<div class="empty">这一页还没检测到媒体资源<br>先点开视频播放几秒，再回来看</div>`;
    return;
  }
  const byUrl = new Map(tasks.map((t) => [t.url, t]));
  list.innerHTML = mediaItems.map((it, i) => {
    const t = byUrl.get(it.url);
    const running = t && ['queued', 'running', 'decrypting', 'merging'].includes(t.status);
    const done = t && t.status === 'done';
    const err = t && t.status === 'error';
    const name = it.title || it.pageTitle || it.url.split('/').pop() || it.url;
    const bar = running ? `<div class="bar"><i style="width:${Math.round(t.progress || 0)}%"></i></div>` : '';

    if (done) {
      const link = buildLink(t);
      const addr = link ? link.address : (t.filePath || t.fileName || '');
      return `<div class="row done">
        <span class="tag ${it.kind}">${it.kind}</span>
        <span class="meta">
          <span class="nm" title="${esc(it.url)}">${it.isCurrent ? '<span class="cur">当前</span>' : ''}${esc(name).slice(0, 80)}</span>
          <span class="sub addr" title="${esc(addr)}" data-i="${i}">${esc(addr).slice(0, 60)}</span>
        </span>
        <button class="act open" data-i="${i}" data-m="browser">▶ 打开</button>
        <button class="act pp" data-i="${i}" data-m="potplayer" title="用本机 PotPlayer 播放（需先运行一次协议安装脚本）">PotPlayer</button>
      </div>`;
    }

    const label = running ? `${Math.round(t.progress || 0)}%` : (err ? '重试' : '下载');
    return `<div class="row">
      <span class="tag ${it.kind}">${it.kind}</span>
      <span class="meta"><span class="nm" title="${esc(it.url)}">${it.isCurrent ? '<span class="cur">当前</span>' : ''}${esc(name).slice(0, 80)}</span>
        <span class="sub">${fmtSize(it.size) || '大小未知'}${err ? ' · ' + esc(t.error || '失败') : ''}</span>${bar}</span>
      <button class="act" data-i="${i}" ${running ? 'disabled' : ''}>${label}</button>
    </div>`;
  }).join('');

  // 下载 / 重试
  list.querySelectorAll('.act:not(.open):not(.pp)').forEach((b) => {
    b.addEventListener('click', async () => {
      const it = mediaItems[Number(b.dataset.i)];
      if (!it) return;
      // 音画分离站点：找伴随音轨
      let audioUrl = '';
      if (it.kind !== 'audio' && ['hls', 'dash', 'mp4', 'webm', 'flv', 'video'].includes(it.kind)) {
        const mate = mediaItems
          .filter((x) => x.kind === 'audio' && Math.abs((x.lastSeen || 0) - (it.lastSeen || 0)) < 30000)
          .sort((a, b2) => (b2.lastSeen || 0) - (a.lastSeen || 0))[0];
        if (mate) audioUrl = mate.url;
      }
      b.textContent = '…';
      const res = await send({
        type: 'download',
        url: it.url,
        kind: it.kind,
        title: it.pageTitle || currentTab?.title || '视频',
        referer: currentTab?.url || '',
        tabId: currentTab?.id,
        target: saveTarget,
        audioUrl,
      });
      if (!res.ok) {
        b.textContent = '失败';
        b.title = res.error || '';
        setTimeout(refresh, 1500);
      } else {
        setTimeout(refresh, 500);
      }
    });
  });

  // 打开（浏览器 / PotPlayer）
  list.querySelectorAll('.act.open, .act.pp').forEach((b) => {
    b.addEventListener('click', () => {
      const it = mediaItems[Number(b.dataset.i)];
      const t = it && byUrl.get(it.url);
      if (t) openVideo(t, b.dataset.m);
    });
  });

  // 点击地址复制
  list.querySelectorAll('.sub.addr').forEach((s) => {
    s.addEventListener('click', () => {
      const it = mediaItems[Number(s.dataset.i)];
      const t = it && byUrl.get(it.url);
      if (t) copyAddr(t);
    });
  });
}

function renderTasks() {
  const items = tasks.filter((t) => ['queued', 'running', 'decrypting', 'merging'].includes(t.status)).slice(0, 6);
  const sec = $('#tasks-sec');
  if (!items.length) {
    sec.hidden = true;
    return;
  }
  sec.hidden = false;
  $('#task-list').innerHTML = items.map((t) => `
    <div class="row">
      <span class="tag">${t.status === 'merging' ? 'mux' : t.status === 'decrypting' ? 'dec' : 'dl'}</span>
      <span class="meta">
        <span class="nm">${esc(t.title)}</span>
        <span class="sub">${Math.round(t.progress || 0)}%${t.speed ? ' · ' + fmtSize(t.speed) + '/s' : ''}${t.total ? ' · ' + fmtSize(t.downloaded) + '/' + fmtSize(t.total) : ''}${t.segmentsTotal ? ` · 分片 ${t.segmentsDone}/${t.segmentsTotal}` : ''}</span>
        <span class="bar"><i style="width:${Math.round(t.progress || 0)}%"></i></span>
      </span>
      <button class="act" data-cancel="${t.id}" data-target="${t.target || 'server'}">停止</button>
    </div>`).join('');

  $('#task-list').querySelectorAll('[data-cancel]').forEach((b) => {
    b.addEventListener('click', async () => {
      b.textContent = '…';
      await send({ type: 'task:cancel', id: b.dataset.cancel, target: b.dataset.target });
      refresh();
    });
  });
}

async function refresh() {
  const [m, t] = await Promise.all([
    send({ type: 'media:list', tabId: currentTab?.id }),
    send({ type: 'tasks' }),
  ]);
  if (m.ok) {
    mediaItems = (m.items || []).filter((i) => ['hls', 'dash', 'mp4', 'webm', 'flv', 'video', 'audio'].includes(i.kind));
    // 当前正在播放的视频排最前
    mediaItems.sort((a, b) => (b.isCurrent ? 1 : 0) - (a.isCurrent ? 1 : 0));
  }
  tasks = t.ok ? t.tasks || [] : [];
  renderMedia();
  renderTasks();
}

async function init() {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const c = await send({ type: 'config:get' });
  if (c.ok) { cfg = c.config || {}; saveTarget = cfg.saveTarget === 'local' ? 'local' : 'server'; }
  renderTarget();
  document.querySelectorAll('#tgt button').forEach((b) => {
    b.addEventListener('click', () => switchTarget(b.dataset.t));
  });
  await checkHealth();
  await refresh();

  $('#refresh').addEventListener('click', async () => {
    // 清空本页记录，让页面重新上报当前视频与标题
    await send({ type: 'media:resync', tabId: currentTab?.id });
    setTimeout(refresh, 200);
  });
  $('#folder').addEventListener('click', () => send({ type: 'openFolder', target: saveTarget }));
  $('#options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  setInterval(async () => {
    const t = await send({ type: 'tasks' });
    if (t.ok) { tasks = t.tasks || []; renderTasks(); renderMedia(); }
  }, 1200);
}

document.addEventListener('DOMContentLoaded', init);
