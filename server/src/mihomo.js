'use strict';
/**
 * Clash / mihomo 控制接口（链路测速用）
 *
 * 服务器上跑的是 Clash Verge（内核 mihomo），TUN 模式 + fake-ip，所有代理流量都走
 * 「良心云」这个 Selector 组。这里通过它的 external-controller 做三件事：
 *   1) 读分组和当前节点
 *   2) 读各节点延迟
 *   3) 切换分组节点（测速时逐个切，测完还原 / 或应用最快的）
 *
 * Linux 下 Clash Verge 的控制器是 unix socket（/run/clash-verge-service/users/<uid>/verge-mihomo.sock），
 * 也兼容 HTTP 形式（config.clashApi，例如 http://127.0.0.1:9090）。
 */
const http = require('http');
const fs = require('fs');
const config = require('./config');

const GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay']);

let sockCache = { path: '', at: 0 };

function socketCandidates() {
  const cfg = config.load();
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const out = [];
  if (cfg.clashSocket) out.push(cfg.clashSocket);
  out.push(
    `/run/clash-verge-service/users/${uid}/verge-mihomo.sock`,
    '/run/clash-verge/users/verge-mihomo.sock',
    '/tmp/verge-mihomo.sock',
    '/run/mihomo.sock',
    '/run/clash.sock',
  );
  return out;
}

function socketPath() {
  if (sockCache.path && Date.now() - sockCache.at < 60000) return sockCache.path;
  for (const p of socketCandidates()) {
    try {
      if (fs.statSync(p).isSocket()) {
        sockCache = { path: p, at: Date.now() };
        return p;
      }
    } catch (_) {}
  }
  return '';
}

/** 有没有可用的控制接口（没有也能跑，只是测速页显示不可用） */
function available() {
  return !!(socketPath() || config.load().clashApi);
}

function request(method, pathname, timeout = 12000) {
  const cfg = config.load();
  const sock = socketPath();
  const opts = {
    method,
    path: pathname,
    timeout,
    headers: { 'Content-Type': 'application/json' },
  };
  if (sock) opts.socketPath = sock;
  else if (cfg.clashApi) {
    const u = new URL(cfg.clashApi);
    opts.host = u.hostname;
    opts.port = u.port || 9090;
    if (cfg.clashSecret) opts.headers.Authorization = 'Bearer ' + cfg.clashSecret;
  } else {
    return Promise.reject(new Error('没有找到 Clash 控制接口（TUN 未运行？）'));
  }

  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          const err = new Error(`Clash 返回 ${res.statusCode}${buf ? '：' + String(buf).slice(0, 120) : ''}`);
          err.status = res.statusCode;
          return reject(err);
        }
        resolve(buf);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Clash 接口超时')));
    req.on('error', reject);
    req.end();
  });
}

async function getJSON(pathname) {
  const text = await request('GET', pathname);
  try { return JSON.parse(text); } catch (e) { throw new Error('Clash 返回的不是 JSON：' + text.slice(0, 80)); }
}

async function version() {
  try { return await getJSON('/version'); } catch (_) { return null; }
}

/** 所有分组（Selector / URLTest …） */
async function groups() {
  const d = await getJSON('/proxies');
  const all = (d && d.proxies) || {};
  const out = [];
  for (const [name, v] of Object.entries(all)) {
    if (!GROUP_TYPES.has(v.type)) continue;
    out.push({ name, type: v.type, now: v.now || '', all: (v.all || []).slice() });
  }
  return out;
}

/** 取某个分组；不存在时抛出 */
async function group(name) {
  const gs = await groups();
  const g = gs.find((x) => x.name === name);
  if (!g) {
    const names = gs.map((x) => x.name).slice(0, 8).join(' / ');
    throw new Error(`找不到代理分组「${name}」，现有：${names || '（无）'}`);
  }
  return g;
}

/** 分组里可以直接测速的真实节点（排除「自动选择」这类子分组） */
async function nodes(groupName) {
  const d = await getJSON('/proxies');
  const all = (d && d.proxies) || {};
  const g = all[groupName];
  if (!g) throw new Error('找不到代理分组「' + groupName + '」');
  return (g.all || []).filter((n) => all[n] && !GROUP_TYPES.has(all[n].type));
}

/** 单个节点延迟（mihomo 自己测，毫秒；失败返回 -1） */
async function delay(node, timeout = 2500, url = 'http://www.gstatic.com/generate_204') {
  const q = `?timeout=${timeout}&url=${encodeURIComponent(url)}`;
  try {
    const d = await getJSON('/proxies/' + encodeURIComponent(node) + '/delay' + q);
    return Number(d && d.delay) || -1;
  } catch (_) {
    return -1;
  }
}

/** 切换分组当前节点 */
async function select(groupName, node) {
  const body = JSON.stringify({ name: node });
  const cfg = config.load();
  const sock = socketPath();
  const opts = {
    method: 'PUT',
    path: '/proxies/' + encodeURIComponent(groupName),
    timeout: 12000,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  };
  if (sock) opts.socketPath = sock;
  else if (cfg.clashApi) {
    const u = new URL(cfg.clashApi);
    opts.host = u.hostname;
    opts.port = u.port || 9090;
    if (cfg.clashSecret) opts.headers.Authorization = 'Bearer ' + cfg.clashSecret;
  } else {
    throw new Error('没有找到 Clash 控制接口');
  }
  await new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      res.resume();
      res.on('end', () => (res.statusCode >= 400 ? reject(new Error('切换节点失败：HTTP ' + res.statusCode)) : resolve()));
    });
    req.on('timeout', () => req.destroy(new Error('切换节点超时')));
    req.on('error', reject);
    req.end(body);
  });
  return node;
}

/** 当前分组选中的节点名 */
async function current(groupName) {
  const g = await group(groupName);
  return g.now;
}

module.exports = { available, version, groups, group, nodes, delay, select, current, socketPath };
