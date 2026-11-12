'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * 判断是否运行在「单文件可执行程序」里（Node SEA 打包）
 * 打包后没有源码目录，所有路径都相对 exe 所在位置
 */
function isSea() {
  try {
    const sea = require('node:sea');
    return !!(sea && typeof sea.isSea === 'function' && sea.isSea());
  } catch (_) {
    return false;
  }
}

const SEA_MODE = isSea();
const ROOT = SEA_MODE ? path.dirname(process.execPath) : path.resolve(__dirname, '..', '..');

/** 依次尝试，返回第一个存在的路径；都不存在则返回第一个（用于创建） */
function pickExisting(candidates) {
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return candidates[0];
}

// 打包模式：exe 同目录优先，其次沿用项目里已有的 server/ 目录（这样能复用原来的 Token 和 bin）
const CONFIG_PATH = SEA_MODE
  ? pickExisting([path.join(ROOT, 'config.json'), path.join(ROOT, 'server', 'config.json')])
  : path.join(ROOT, 'server', 'config.json');
const BIN_DIR = SEA_MODE
  ? pickExisting([path.join(ROOT, 'bin'), path.join(ROOT, 'server', 'bin')])
  : path.join(ROOT, 'server', 'bin');

const defaults = {
  host: '127.0.0.1',
  port: 8765,
  token: '',
  downloadDir: path.join(ROOT, 'downloads'),
  /** 同时下载的任务数 */
  concurrency: 6,
  /** 单个 HLS 任务的分片并发数 */
  segmentConcurrency: 8,
  /** Cloudflare 站（cfdl 引擎）分片并发数。本机网络强可调高（实测本机 32 线程 ~20MB/s，服务器 12 线程 ~4.8MB/s） */
  cfWorkers: 12,
  /** 命名模板，支持 {title} {site} {date} {quality} {index} */
  namingTemplate: '{title}',
  /** 按站点分文件夹保存：downloads/<域名>/<文件> */
  siteFolders: true,
  /** 有 yt-dlp 时优先用它（对复杂站点更稳） */
  preferYtdlp: true,
  /** HLS 分片下完后尝试用 ffmpeg 转封装成 mp4 */
  remuxToMp4: true,
  /** 小于该字节数的响应不当作视频 */
  minMediaBytes: 64 * 1024,
  /** 是否强制校验 token */
  requireToken: true,
  /**
   * 局域网模式：监听非回环地址（如 0.0.0.0）时自动生效。
   * true  —— 放行局域网网页来源的 CORS，token 保持强制校验
   * false —— 只接受本机 / 浏览器扩展来源（历史行为）
   * 可通过 config.json 的 lanAllowedOrigins 追加白名单，'*' 表示放行所有 http(s) 来源
   */
  lanAllowedOrigins: [],
};

let cached = null;

function load() {
  if (cached) return cached;
  let onDisk = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.warn('[config] 读取 config.json 失败，使用默认配置:', e.message);
  }
  const cfg = { ...defaults, ...onDisk };
  let changed = false;
  if (!cfg.token) {
    cfg.token = crypto.randomBytes(16).toString('hex');
    changed = true;
  }
  cached = cfg;
  if (changed || !fs.existsSync(CONFIG_PATH)) save(cfg);
  // 环境变量覆盖放最后，避免被持久化
  if (process.env.WVD_DOWNLOAD_DIR) cfg.downloadDir = path.resolve(process.env.WVD_DOWNLOAD_DIR);
  if (process.env.WVD_HOST) cfg.host = process.env.WVD_HOST.trim();
  if (process.env.WVD_LAN_ORIGINS) {
    cfg.lanAllowedOrigins = process.env.WVD_LAN_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  try {
    fs.mkdirSync(cfg.downloadDir, { recursive: true });
  } catch (_) {}
  return cfg;
}

function save(cfg) {
  cached = cfg;
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    console.warn('[config] 保存失败:', e.message);
  }
}

function update(patch) {
  const cfg = { ...load(), ...patch };
  save(cfg);
  return cfg;
}

/** 是否监听在非回环地址（局域网 / 全网卡） */
function isLanBind(host) {
  const h = String(host || '').trim();
  if (!h || h === '127.0.0.1' || h === '::1' || h === 'localhost') return false;
  return true;
}

/** 找到可用的 Python 解释器（优先项目 venv，兼容 Windows/Linux；兜底系统命令） */
function resolvePython() {
  const venv = path.join(ROOT, 'server', 'venv');
  const cands = process.platform === 'win32'
    ? [path.join(venv, 'Scripts', 'python.exe'), path.join(venv, 'bin', 'python.exe'), path.join(venv, 'bin', 'python')]
    : [path.join(venv, 'bin', 'python')];
  for (const p of cands) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

/** 找到可用的 curl（优先项目自带，其次系统命令）；找不到返回空串 */
function resolveCurl() {
  const name = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const cands = [path.join(BIN_DIR, name)];
  for (const p of cands) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  // 系统 curl：Windows 10+ 自带，Linux/macOS 基本都有
  return name;
}

module.exports = { load, save, update, ROOT, SEA_MODE, CONFIG_PATH, BIN_DIR, defaults, isLanBind, resolvePython, resolveCurl };
