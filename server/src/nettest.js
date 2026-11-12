'use strict';
/**
 * 链路（代理节点）真实带宽测速
 *
 * 思路：
 *   延迟低 ≠ 下载快。所以先让 mihomo 自己测一轮延迟，筛出最快的 N 个节点，
 *   再逐个切过去、用同一个测试文件真下一段数据，量出 MB/s。
 *   测完还原原来的节点（除非要求「自动应用最快」）。
 *
 * 结果存 server/state/links.json，网页 /speed 直接读，下载侧不需要关心。
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const mihomo = require('./mihomo');

const STATE_DIR = path.join(config.ROOT, 'server', 'state');
const STATE_FILE = path.join(STATE_DIR, 'links.json');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return null; }
}

function writeState(data) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
}

/** 用 curl 下一段数据，返回真实吞吐 */
function curlSpeed(url, opts = {}) {
  const curl = config.resolveCurl();
  const maxTime = opts.maxTime || 8;
  const bytes = opts.bytes || 6 * 1024 * 1024;
  const tmp = path.join(os.tmpdir(), 'wvd-nettest-' + process.pid + '.bin');
  const args = [
    '-sS', '-L', '--max-time', String(maxTime),
    '-r', '0-' + (bytes - 1),
    '-o', tmp,
    '-w', '%{http_code}|%{size_download}|%{time_total}|%{time_starttransfer}',
  ];
  if (opts.proxy) args.push('--proxy', opts.proxy);
  else args.push('--noproxy', '*');
  for (const h of (opts.headers || [])) args.push('-H', h);
  args.push(url);

  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile(curl, args, { timeout: maxTime * 1000 + 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      try { fs.unlinkSync(tmp); } catch (_) {}
      const parts = String(stdout || '').trim().split('|');
      const code = Number(parts[0]) || 0;
      const size = Number(parts[1]) || 0;
      const secs = Number(parts[2]) || (Date.now() - t0) / 1000;
      if (err && !size) return resolve({ code, bytes: 0, seconds: secs, speed: 0, error: String(err.message || '').slice(0, 120) });
      resolve({ code, bytes: size, seconds: secs, speed: secs > 0 ? size / 1048576 / secs : 0 });
    });
  });
}

/** 并行限制器 */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = { error: e.message }; }
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * @param {object} opts
 *   group   分组名（默认 config.proxyGroup）
 *   top     深度测速的节点数（默认 8）
 *   bytes   每个节点下载多少字节（默认 6MB）
 *   url     测试地址（默认 config.netTestUrl）
 *   auto    true = 测完把最快的应用上；false = 还原原来的节点
 */
async function test(opts = {}) {
  const cfg = config.load();
  if (!mihomo.available()) throw new Error('这台机器上没有找到 Clash 控制接口，无法测速');

  const groupName = opts.group || cfg.proxyGroup || '良心云';
  const total = await mihomo.group(groupName);
  const original = total.now || '';
  const top = Math.max(1, Math.min(30, Number(opts.top) || 8));
  const bytes = Math.max(1, Number(opts.bytes) || 6) * 1024 * 1024;
  const url = opts.url || cfg.netTestUrl || 'https://speed.cloudflare.com/__down?bytes=8000000';
  const proxy = 'http://127.0.0.1:' + (cfg.proxyPort || 7897);
  const startedAt = Date.now();

  // 1) 全部节点先测延迟（并发 8，mihomo 自己发请求，很快）
  const names = await mihomo.nodes(groupName);
  const delays = await pool(names, 8, async (n) => ({ node: n, delay: await mihomo.delay(n, 2500) }));
  const alive = delays.filter((d) => d && d.delay > 0).sort((a, b) => a.delay - b.delay);
  if (!alive.length) throw new Error('所有节点都连不上（延迟测试全失败）');

  // 2) 取延迟最好的前 top 个，逐个切过去真下数据
  const picked = alive.slice(0, top);
  const results = [];
  for (const item of picked) {
    let r;
    try {
      await mihomo.select(groupName, item.node);
      await sleep(260);
      r = await curlSpeed(url, { proxy, bytes, maxTime: 8 });
    } catch (e) {
      r = { bytes: 0, seconds: 0, speed: 0, error: e.message };
    }
    results.push({
      node: item.node,
      delay: item.delay,
      speed: Math.round((r.speed || 0) * 100) / 100,
      bytes: r.bytes || 0,
      seconds: Math.round((r.seconds || 0) * 10) / 10,
      code: r.code || 0,
      error: r.error || '',
    });
  }

  results.sort((a, b) => b.speed - a.speed || a.delay - b.delay);
  const best = results.find((r) => r.speed > 0) || results[0];

  // 3) 收尾：应用最快的，或还原原节点
  let applied = '';
  try {
    if (opts.auto && best) { await mihomo.select(groupName, best.node); applied = best.node; }
    else if (original) { await mihomo.select(groupName, original); }
  } catch (_) {}

  const state = {
    group: groupName,
    original,
    applied,
    best: best ? best.node : '',
    url,
    total: names.length,
    aliveCount: alive.length,
    testedTop: picked.length,
    at: Date.now(),
    tookMs: Date.now() - startedAt,
    links: results,
    all: alive.map((a) => ({ node: a.node, delay: a.delay })),
  };
  writeState(state);
  return state;
}

/** 当前状态（网页首屏用，不阻塞） */
async function status() {
  const cfg = config.load();
  const out = {
    ok: true,
    available: mihomo.available(),
    group: cfg.proxyGroup || '良心云',
    now: '',
    groups: [],
    last: readState(),
  };
  if (!out.available) return out;
  try {
    const g = await mihomo.group(out.group);
    out.now = g.now;
    out.all = g.all.length;
    out.children = g.all.slice();
    out.groups = (await mihomo.groups()).map((x) => ({ name: x.name, type: x.type, now: x.now }));
  } catch (e) {
    out.available = false;
    out.error = e.message;
  }
  return out;
}

/** 直接切节点（网页上点「用这个」） */
async function apply(node, groupName) {
  const cfg = config.load();
  const g = groupName || cfg.proxyGroup || '良心云';
  await mihomo.select(g, node);
  const st = readState() || {};
  st.applied = node;
  st.group = g;
  st.at = st.at || Date.now();
  writeState(st);
  return { group: g, node };
}

module.exports = { test, status, apply, curlSpeed, readState };
