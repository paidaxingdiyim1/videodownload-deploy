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

async function load() {
  const r = await send({ type: 'config:get' });
  if (!r.ok) return;
  const c = r.config;
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

async function doUpdateFrontend() {
  setResult('正在下载最新前端包…', true);
  const r = await send({ type: 'update:frontend' });
  if (r && r.ok) {
    setResult(`已开始下载 v${r.version} 扩展包，解压后在 chrome://extensions 里「重新加载」`, true);
  } else {
    setResult('下载失败：' + ((r && r.error) || '未知错误'), false);
  }
}

$('#save').addEventListener('click', save);
$('#test').addEventListener('click', test);
$('#pairServer').addEventListener('click', () => pairOne('server', $('#test-result')));
$('#pairLocal').addEventListener('click', () => pairOne('local', $('#test-result')));
$('#checkFrontend').addEventListener('click', renderUpdate);
$('#checkBackend').addEventListener('click', renderUpdate);
$('#updateBackend').addEventListener('click', doUpdateBackend);
$('#updateFrontend').addEventListener('click', doUpdateFrontend);
document.addEventListener('DOMContentLoaded', () => {
  load();
  renderUpdate();
});
