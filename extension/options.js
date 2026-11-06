'use strict';

const $ = (s) => document.querySelector(s);

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(res || { ok: false });
    });
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function fmtEta(sec) {
  sec = Number(sec) || 0;
  if (sec <= 0) return '';
  if (sec < 60) return `${Math.round(sec)} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${Math.round(sec % 60)} 秒`;
  return `${Math.floor(sec / 3600)} 时 ${Math.floor((sec % 3600) / 60)} 分`;
}

let cfg = {};

async function load() {
  const r = await send({ type: 'config:get' });
  if (!r.ok) return;
  const c = r.config;
  cfg = c;
  $('#saveTarget').value = ['server', 'local', 'ask'].includes(c.saveTarget) ? c.saveTarget : 'server';
  $('#serverUrl').value = c.serverUrl || 'http://127.0.0.1:8765';
  $('#serverToken').value = c.serverToken || '';
  $('#localUrl').value = c.localUrl || 'http://127.0.0.1:8765';
  $('#localToken').value = c.localToken || '';
  $('#mode').value = c.mode || 'auto';
  $('#autoButton').checked = c.autoButton !== false;
  $('#minSize').value = c.minSize || 120;
}

async function save() {
  const patch = {
    saveTarget: $('#saveTarget').value,
    serverUrl: $('#serverUrl').value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:8765',
    serverToken: $('#serverToken').value.trim(),
    localUrl: $('#localUrl').value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:8765',
    localToken: $('#localToken').value.trim(),
    mode: $('#mode').value,
    autoButton: $('#autoButton').checked,
    minSize: Math.max(60, Number($('#minSize').value) || 120),
  };
  const r = await send({ type: 'config:set', patch });
  if (r.ok) {
    const s = $('#saved');
    s.textContent = '已保存';
    s.classList.add('show');
    setTimeout(() => s.classList.remove('show'), 1800);
  }
  return r;
}

async function test() {
  const el = $('#test-result');
  el.className = 'result';
  el.textContent = '连接中…';
  await save();
  const [srv, loc] = await Promise.all([
    send({ type: 'health', target: 'server' }),
    send({ type: 'health', target: 'local' }),
  ]);
  const info = $('#server-info');
  const line = (name, r) => {
    const ok = r && r.ok;
    return `<div><b>${name}</b> ${ok ? '✓ 已连接' : '✗ 未连接'}${ok ? ` · 端口 ${r.port}` : ''}</div>`;
  };
  info.hidden = false;
  info.innerHTML = `
    ${line('服务器', srv)}
    ${line('本机', loc)}
    ${(srv && srv.ok) ? `<div><b>服务器下载目录</b> ${srv.downloadDir}</div>` : ''}
    ${(loc && loc.ok) ? `<div><b>本机下载目录</b> ${loc.downloadDir}</div>` : ''}
    ${(srv && srv.ok && srv.tools) ? `<div><b>服务器 yt-dlp / ffmpeg</b> ${srv.tools.ytdlp?.ok ? '✓' : '✗'} / ${srv.tools.ffmpeg?.ok ? '✓' : '✗'}</div>` : ''}
    ${(loc && loc.ok && loc.tools) ? `<div><b>本机 yt-dlp / ffmpeg</b> ${loc.tools.ytdlp?.ok ? '✓' : '✗'} / ${loc.tools.ffmpeg?.ok ? '✓' : '✗'}</div>` : ''}`;
  const okCount = (srv?.ok ? 1 : 0) + (loc?.ok ? 1 : 0);
  el.className = okCount ? 'result ok' : 'result bad';
  el.textContent = okCount ? `已连接 ${okCount} 个服务（未连接的不影响已连接的那个）` : '两个服务都没连上';
}

async function pairOne(target, el) {
  el.textContent = '正在配对…';
  const r = await send({ type: 'pair', target });
  if (r.ok && r.token) {
    if (target === 'server') $('#serverToken').value = r.token;
    else $('#localToken').value = r.token;
    await save();
    el.textContent = '配对成功';
  } else {
    el.textContent = '配对失败，请确认服务已启动';
  }
}

/* ------------------------------ 更新 ------------------------------ */

function setResult(msg, ok) {
  const el = $('#update-result');
  el.className = 'result ' + (ok ? 'ok' : 'bad');
  el.textContent = msg;
}

async function renderUpdate() {
  $('#frontend-ver').textContent = '检查中…';
  $('#backend-ver').textContent = '检查中…';
  const r = await send({ type: 'update:check', target: 'server' });
  if (!r || !r.ok) { $('#frontend-ver').textContent = '—'; $('#backend-ver').textContent = '—'; return; }
  const f = r.frontend || {};
  const b = r.backend || {};
  if (f.ok) {
    const span = document.createElement('span');
    span.textContent = `当前 v${f.current} · 最新 v${f.latest} ${f.newer ? '· 有新版本' : '· 已是最新'}`;
    $('#frontend-ver').textContent = '';
    $('#frontend-ver').appendChild(span);
    if (f.newer) { $('#frontend-ver').classList.add('new'); }
  } else {
    $('#frontend-ver').textContent = '检测失败：' + (f.error || '网络不可达');
  }
  if (b.ok) {
    const behind = b.behind || 0;
    const t = `服务器 v${b.version}（${b.commit || ''}）· 落后 ${behind} 个提交${behind > 0 ? '，可更新' : '，已是最新'}`;
    const span = document.createElement('span');
    span.textContent = t;
    $('#backend-ver').textContent = '';
    $('#backend-ver').appendChild(span);
  } else {
    $('#backend-ver').textContent = '检测失败：' + (b.error || '服务未连接');
  }
}

async function doUpdateBackend() {
  setResult('正在更新后端…', true);
  const r = await send({ type: 'update:backend', target: 'server' });
  if (r && r.ok) {
    setResult('后端已更新并重启（约数秒后恢复连接）', true);
    setTimeout(renderUpdate, 6000);
  } else {
    setResult('更新失败：' + ((r && r.error) || '未知错误'), false);
  }
}

/* ------------------------------ 一键更新前端 ------------------------------ */

const REPO_ZIP = 'https://github.com/paidaxingdiyim1/videodownload-deploy/archive/refs/heads/main.zip';
const IDB_NAME = 'wvd-update';
const IDB_STORE = 'handles';
let dirHandle = null; // 扩展目录句柄（首次选择后持久化，之后一键更新）

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => { try { r.result.createObjectStore(IDB_STORE); } catch (_) {} };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function saveDirHandle(h) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(h, 'dir');
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function loadDirHandle() {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const rq = tx.objectStore(IDB_STORE).get('dir');
    rq.onsuccess = () => res(rq.result || null);
    rq.onerror = () => rej(rq.error);
  });
}

async function writeFile(dir, rel, data) {
  const parts = rel.split('/');
  const name = parts.pop();
  let cur = dir;
  for (const seg of parts) cur = await cur.getDirectoryHandle(seg, { create: true });
  const fh = await cur.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(new Blob([data]));
  await w.close();
}

function detectZipRoot(zip) {
  const roots = new Set();
  for (const p of Object.keys(zip.files)) {
    const i = p.indexOf('/');
    if (i > 0) roots.add(p.slice(0, i));
  }
  return [...roots].sort((a, b) => a.length - b.length)[0] || '';
}

async function doUpdateFrontend() {
  setResult('正在更新前端…', true);

  // 1) 获取扩展目录句柄（showDirectoryPicker 必须在用户手势内同步调用）
  if (!dirHandle) {
    if (typeof window.showDirectoryPicker !== 'function') {
      setResult('当前浏览器不支持直接写入，改用下载方式…', false);
      const r = await send({ type: 'update:frontend' });
      setResult(r && r.ok ? '已开始下载，解压后到 chrome://extensions 重新加载' : '下载失败：' + (r && r.error), r && r.ok);
      return;
    }
    try {
      dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      saveDirHandle(dirHandle).catch(() => {});
    } catch (e) {
      setResult('未选择目录，已取消', false);
      return;
    }
  } else {
    try { await dirHandle.requestPermission({ mode: 'readwrite' }); } catch (_) {}
  }

  try {
    // 2) 下载最新包
    const res = await fetch(REPO_ZIP, { cache: 'no-store' });
    if (!res.ok) throw new Error('下载失败 HTTP ' + res.status);
    const buf = await res.arrayBuffer();

    // 3) 解压（GitHub archive 顶层是 <repo>-<branch>/）
    const zip = await JSZip.loadAsync(buf);
    const root = detectZipRoot(zip);
    const prefix = root + '/extension/';
    const entries = Object.keys(zip.files).filter((p) => p.startsWith(prefix) && !zip.files[p].dir);
    if (!entries.length) throw new Error('包里没找到 extension 目录');

    // 4) 写入扩展目录
    for (const p of entries) {
      const rel = p.slice(prefix.length);
      const data = await zip.files[p].async('uint8array');
      await writeFile(dirHandle, rel, data);
    }

    setResult('更新完成，正在重载扩展…', true);
    setTimeout(() => chrome.runtime.reload(), 800);
  } catch (e) {
    setResult('更新失败：' + ((e && e.message) || e), false);
  }
}

/* ------------------------------ 下载中心 ------------------------------ */

const ST_LABEL = {
  queued: '排队中', running: '下载中', decrypting: '解密中', merging: '合并中',
  done: '已完成', error: '失败', canceled: '已取消',
};

async function renderTasks() {
  const el = $('#task-list');
  const r = await send({ type: 'tasks' });
  const tasks = (r && r.ok && r.tasks) || [];
  const summary = $('#task-summary');
  if (!tasks.length) {
    el.innerHTML = '<div class="empty">暂无下载任务</div>';
    summary.textContent = '';
    return;
  }
  const active = tasks.filter((t) => ['queued', 'running', 'decrypting', 'merging'].includes(t.status)).length;
  summary.textContent = `共 ${tasks.length} 个 · 进行中 ${active} 个`;

  el.innerHTML = tasks.map((t) => {
    const st = t.status || '';
    const running = ['queued', 'running', 'decrypting', 'merging'].includes(st);
    const where = t.target === 'local' ? '本机' : '服务器';
    const size = t.total
      ? `${fmtSize(t.downloaded || 0)} / ${fmtSize(t.total)}`
      : (t.downloaded ? fmtSize(t.downloaded) : '');
    const speed = t.speed ? fmtSize(t.speed) + '/s' : '';
    const eta = fmtEta(t.eta);
    const meta = [size, speed, eta ? '剩余 ' + eta : ''].filter(Boolean).join(' · ');
    const loc = (t.filePath || t.fileName) ? `${where} · ${t.filePath || t.fileName}` : '';
    const bar = running ? `<div class="bar"><i style="width:${Math.min(100, Math.round(t.progress || 0))}%"></i></div>` : '';
    const btns = running
      ? `<button class="btn sm" data-cancel="${t.id}" data-target="${t.target}">停止</button>`
      : (st === 'done' ? `<button class="btn sm" data-open="${t.id}">▶ 播放</button>` : '');
    return `<div class="task">
      <div class="t1"><span class="st ${esc(st)}">${ST_LABEL[st] || st}</span><span class="tt" title="${esc(t.title || '')}">${esc(t.title || '(无标题)')}</span>${t.progress != null && running ? `<span>${Math.round(t.progress)}%</span>` : ''}</div>
      ${meta ? `<div class="meta">${esc(meta)}</div>` : ''}
      ${bar}
      ${loc ? `<div class="loc" title="${esc(loc)}">${esc(loc)}</div>` : ''}
      ${t.error ? `<div class="loc" style="color:#c22b2f">${esc(t.error)}</div>` : ''}
      ${btns ? `<div class="act2">${btns}</div>` : ''}
    </div>`;
  }).join('');

  // 停止
  el.querySelectorAll('[data-cancel]').forEach((b) => {
    b.addEventListener('click', async () => {
      b.textContent = '…';
      await send({ type: 'task:cancel', id: b.dataset.cancel, target: b.dataset.target });
      renderTasks();
    });
  });
  // 播放
  el.querySelectorAll('[data-open]').forEach((b) => {
    b.addEventListener('click', async () => {
      const t = tasks.find((x) => x.id === b.dataset.open);
      if (!t) return;
      const link = await send({ type: 'video:link', filePath: t.filePath, target: t.target });
      if (link && link.ok) {
        if (link.target === 'local') window.open(link.streamUrl);
        else chrome.tabs.create({ url: link.streamUrl });
      }
    });
  });
}

async function renderFiles() {
  const el = $('#file-list');
  const r = await send({ type: 'files' });
  const groups = (r && r.ok && r.groups) || [];
  if (!groups.length) {
    el.innerHTML = '<div class="empty">下载目录为空（或服务未连接）</div>';
    return;
  }
  const lines = [];
  for (const g of groups) {
    const label = g.target === 'local' ? '本机' : '服务器';
    const base = g.target === 'local' ? cfg.localUrl : cfg.serverUrl;
    const token = g.target === 'local' ? cfg.localToken : cfg.serverToken;
    const baseHost = String(base || 'http://127.0.0.1:8765').replace(/\/+$/, '');
    lines.push(`<div class="fileline"><span class="nm" style="color:#9aa0a6">▍${esc(label)} · ${esc(g.dir || '')}（${g.files.length} 个文件）</span></div>`);
    // 按子目录分组
    const byDir = new Map();
    for (const f of g.files) {
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '(根目录)';
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(f);
    }
    for (const [dir, files] of byDir) {
      if (dir !== '(根目录)') {
        const total = files.reduce((s, f) => s + (f.size || 0), 0);
        lines.push(`<div class="fileline"><span class="folder">📁 ${esc(dir)}</span><span class="cnt">${files.length} 个 · ${fmtSize(total)}</span></div>`);
      }
      files.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      for (const f of files) {
        const full = g.dir ? g.dir + '/' + f.path : f.path;
        const streamUrl = baseHost + '/api/stream?path=' + encodeURIComponent(full) + '&token=' + encodeURIComponent(token || '');
        lines.push(`<div class="fileline">
          <span class="nm" title="${esc(f.path)}">${dir === '(根目录)' ? '' : '&nbsp;&nbsp;&nbsp;'}${esc(f.name)}</span>
          <span class="sz">${fmtSize(f.size)}</span>
          <button class="btn" data-play="${esc(streamUrl)}">播放</button>
          <a class="btn" href="${esc(baseHost + (f.url || '/'))}" target="_blank">下载</a>
        </div>`);
      }
    }
  }
  el.innerHTML = lines.join('');
  el.querySelectorAll('[data-play]').forEach((b) => {
    b.addEventListener('click', () => chrome.tabs.create({ url: b.dataset.play }));
  });
}

$('#save').addEventListener('click', save);
$('#test').addEventListener('click', test);
$('#pairServer').addEventListener('click', () => pairOne('server', $('#test-result')));
$('#pairLocal').addEventListener('click', () => pairOne('local', $('#test-result')));
$('#checkFrontend').addEventListener('click', renderUpdate);
$('#checkBackend').addEventListener('click', renderUpdate);
$('#updateBackend').addEventListener('click', doUpdateBackend);
$('#updateFrontend').addEventListener('click', doUpdateFrontend);
$('#tasksRefresh').addEventListener('click', () => { renderTasks(); renderFiles(); });
$('#tasksClear').addEventListener('click', async () => {
  await send({ type: 'tasks:clear' });
  renderTasks();
  renderFiles();
});
document.addEventListener('DOMContentLoaded', () => {
  load();
  renderUpdate();
  renderTasks();
  renderFiles();
  loadDirHandle().then((h) => { dirHandle = h || null; }).catch(() => {});
  // 任务进度每 1.5s 刷新一次
  setInterval(renderTasks, 1500);
});
