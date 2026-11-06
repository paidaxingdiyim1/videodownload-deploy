'use strict';

const $ = (s) => document.querySelector(s);

let currentTab = null;
let mediaItems = [];
let tasks = [];
let saveTarget = 'server'; // 当前保存位置（popup 里快速切换）

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
    const label = done ? '已保存' : running ? `${Math.round(t.progress || 0)}%` : '下载';
    const name = it.title || it.pageTitle || it.url.split('/').pop() || it.url;
    const bar = running ? `<div class="bar"><i style="width:${Math.round(t.progress || 0)}%"></i></div>` : '';
    return `<div class="row">
      <span class="tag ${it.kind}">${it.kind}</span>
      <span class="meta"><span class="nm" title="${esc(it.url)}">${esc(name).slice(0, 80)}</span>
        <span class="sub">${fmtSize(it.size) || '大小未知'}${t && t.status === 'error' ? ' · ' + esc(t.error || '失败') : ''}</span>${bar}</span>
      <button class="act" data-i="${i}" ${done || running ? 'disabled' : ''}>${label}</button>
    </div>`;
  }).join('');

  list.querySelectorAll('.act').forEach((b) => {
    b.addEventListener('click', async () => {
      const it = mediaItems[Number(b.dataset.i)];
      if (!it) return;
      b.textContent = '…';
      const res = await send({
        type: 'download',
        url: it.url,
        kind: it.kind,
        title: it.pageTitle || currentTab?.title || '视频',
        referer: currentTab?.url || '',
        tabId: currentTab?.id,
        target: saveTarget,
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
        <span class="sub">${Math.round(t.progress || 0)}%${t.speed ? ' · ' + fmtSize(t.speed) + '/s' : ''}${t.segmentsTotal ? ` · 分片 ${t.segmentsDone}/${t.segmentsTotal}` : ''}</span>
        <span class="bar"><i style="width:${Math.round(t.progress || 0)}%"></i></span>
      </span>
    </div>`).join('');
}

async function refresh() {
  const [m, t] = await Promise.all([
    send({ type: 'media:list', tabId: currentTab?.id }),
    send({ type: 'tasks' }),
  ]);
  if (m.ok) mediaItems = (m.items || []).filter((i) => ['hls', 'dash', 'mp4', 'webm', 'flv', 'video', 'audio'].includes(i.kind));
  tasks = t.ok ? t.tasks || [] : [];
  renderMedia();
  renderTasks();
}

async function init() {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const c = await send({ type: 'config:get' });
  if (c.ok) saveTarget = c.config.saveTarget === 'local' ? 'local' : 'server';
  renderTarget();
  document.querySelectorAll('#tgt button').forEach((b) => {
    b.addEventListener('click', () => switchTarget(b.dataset.t));
  });
  await checkHealth();
  await refresh();

  $('#refresh').addEventListener('click', refresh);
  $('#folder').addEventListener('click', () => send({ type: 'openFolder', target: saveTarget }));
  $('#options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  setInterval(async () => {
    const t = await send({ type: 'tasks' });
    if (t.ok) { tasks = t.tasks || []; renderTasks(); renderMedia(); }
  }, 1200);
}

document.addEventListener('DOMContentLoaded', init);
