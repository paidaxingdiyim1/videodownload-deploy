'use strict';

/**
 * AI 标题整理：调用本机 cc-switch 里配置的 codex 路由（OpenAI Responses API），
 * 对下载目录里「尚未整理」的散视频做结构化命名（识别剧集 → 番剧/电视剧库 + 生成 nfo）。
 *
 * ⚠️ 敏感配置（base_url / model / api_key）一律从 ~/.cc-switch/cc-switch.db 动态读取，
 *    绝不硬编码、不提交到仓库。本文件只包含「读本地配置 + 调 OpenAI 兼容接口」的通用代码。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execFile } = require('child_process');
const util = require('./util');
const config = require('./config');
const organize = require('./organize');

const CC_DB = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
const VID_EXT = /\.(mp4|mkv|webm|ts|m4v|mov|flv|avi|wmv)$/i;
const SKIP_DIRS = new Set(['.wvd-tmp', '.tmp-upload', '番剧', '电视剧']);
const BATCH = 35;

/** 从 cc-switch 读 codex 路由配置（key/base_url/model 均不硬编码） */
function readCodex() {
  const py = config.resolvePython();
  const code = [
    'import sqlite3, json, os, re',
    `db = ${JSON.stringify(CC_DB)}`,
    "if not os.path.exists(db): print(json.dumps({})); raise SystemExit",
    'c = sqlite3.connect(db)',
    "row = c.execute(\"SELECT settings_config FROM providers WHERE app_type='codex' AND is_current=1 LIMIT 1\").fetchone()",
    "if not row: row = c.execute(\"SELECT settings_config FROM providers WHERE app_type='codex' LIMIT 1\").fetchone()",
    'if not row: print(json.dumps({})); raise SystemExit',
    'cfg = json.loads(row[0])',
    "key = (cfg.get('auth') or {}).get('OPENAI_API_KEY', '')",
    "txt = cfg.get('config', '')",
    "m = re.search(r'base_url\\s*=\\s*\"([^\"]+)\"', txt)",
    "m2 = re.search(r'model\\s*=\\s*\"([^\"]+)\"', txt)",
    "print(json.dumps({'key': key, 'base_url': m.group(1) if m else '', 'model': m2.group(1) if m2 else ''}, ensure_ascii=False))",
  ].join('\n');
  try {
    const out = execFileSync(py, ['-c', code], { encoding: 'utf8', timeout: 15000 }).trim();
    const r = JSON.parse(out);
    return (r && r.key && r.base_url && r.model) ? r : null;
  } catch (_) {
    return null;
  }
}

/** 收集下载目录里「尚未整理」的散视频文件（顶层站点目录下的直接文件，无配套 .nfo） */
function collectUnorganized(cfg) {
  const root = cfg.downloadDir;
  const out = [];
  let sites;
  try { sites = fs.readdirSync(root); } catch (_) { return out; }
  for (const site of sites) {
    if (site.startsWith('.') || SKIP_DIRS.has(site)) continue;
    const d = path.join(root, site);
    let st;
    try { st = fs.statSync(d); } catch (_) { continue; }
    if (!st.isDirectory()) continue;
    let files;
    try { files = fs.readdirSync(d); } catch (_) { continue; }
    for (const f of files) {
      if (!VID_EXT.test(f)) continue;
      const stem = f.replace(VID_EXT, '');
      if (/S\d{1,2}E\d{1,3}$/i.test(stem)) continue;   // 已按剧集命名
      if (fs.existsSync(path.join(d, stem + '.nfo'))) continue; // 已有 nfo（整理过）
      out.push({ site, file: f, stem, full: path.join(d, f), ext: f.slice(f.lastIndexOf('.') + 1) });
    }
  }
  return out;
}

/** 调用 codex 做结构化整理；返回 { ok, result:[{stem,type,series,season,episode,library,title,code}], error } */
function callAI(codex, items) {
  const HEAD = `你是媒体库整理助手。下面是一批视频文件名（已去掉扩展名），需要整理成 Jellyfin 可识别的规范结构。
站点：missav=日本成人影片(文件名开头是番号如HND-818)、hanime1=成人动画、76g3zssqj7.xyz 与 抖音=短视频。

对每个文件输出结构化信息：
1. type："series"（系列剧集，含第X話/话/集/巻、SP/OVA、前編後編、上中下巻、＃N 等集数标记）或 "movie"（独立单集）
2. series 类型给：series(系列名，去集数标记、【】、[]标签、站名尾巴、OVA前缀；简体；日文/罗马音保留辨识度高的形式；同系列各集必须同名)、season(默认1，SP→0)、episode(数字，前編=1後編=2上巻=1中巻=2下巻=2)、library(日系动画→"番剧"，真人影视/短视频→"电视剧")
3. movie 类型给：title(干净标题，简体，去站名/作者/标签尾巴，保留番号)、code(JAV番号如HND-818，无则"")

严格只输出 JSON 数组，每项对应输入一行、顺序一致，不要解释、不要markdown、不要省略。格式：
[{"stem":"原文","type":"series","series":"系列名","season":1,"episode":1,"library":"番剧"},{"stem":"原文","type":"movie","title":"标题","code":"HND-818"}]

文件名列表（每行 站点|文件名）：
`;

  const all = [];
  const batches = [];
  for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));

  for (const b of batches) {
    const prompt = HEAD + b.map((i) => `${i.site}|${i.stem}`).join('\n');
    const reqFile = path.join(os.tmpdir(), 'wvd_ai_req.json');
    const respFile = path.join(os.tmpdir(), 'wvd_ai_resp.json');
    fs.writeFileSync(reqFile, JSON.stringify({ model: codex.model, input: prompt, reasoning: { effort: 'low' } }, 'utf8'));
    try {
      execFileSync('curl', ['-sS', '-m', '280', '-X', 'POST', codex.base_url + '/v1/responses',
        '-H', 'Authorization: Bearer ' + codex.key, '-H', 'Content-Type: application/json',
        '--data-binary', '@' + reqFile, '-o', respFile], { timeout: 290000 });
    } catch (e) {
      return { ok: false, error: 'AI 请求失败：' + e.message };
    }
    let resp;
    try { resp = JSON.parse(fs.readFileSync(respFile, 'utf8')); } catch (_) {
      return { ok: false, error: 'AI 响应解析失败' };
    }
    const text = (resp.output || []).filter((o) => o.type === 'message')
      .map((o) => ((o.content || [])[0] || {}).text || '').join('');
    const m = text.match(/\[[\s\S]*\]/);
    let arr = [];
    if (m) { try { arr = JSON.parse(m[0]); } catch (_) {} }
    if (!arr.length) return { ok: false, error: 'AI 未返回有效结果' };
    all.push(...arr);
  }
  return { ok: true, result: all };
}

function moveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code === 'EXDEV') { fs.copyFileSync(from, to); fs.unlinkSync(from); }
    else throw e;
  }
}

/** 主入口：一键整理。返回 { ok, aiModel, total, moved, nfo, errors, note } */
function run(cfg, opts = {}) {
  const codex = readCodex();
  if (!codex) return { ok: false, error: '未找到 codex 路由：请先在服务器 cc-switch 里配置一个 codex 供应商' };

  const flat = collectUnorganized(cfg);
  if (!flat.length) {
    return { ok: true, aiModel: codex.model, total: 0, moved: 0, nfo: 0, errors: [], note: '所有文件均已整理，无需处理' };
  }

  const ai = callAI(codex, flat);
  if (!ai.ok) return { ok: false, error: ai.error, aiModel: codex.model };

  const byStem = new Map(flat.map((i) => [i.stem, i]));
  const errors = [];
  let moved = 0, nfo = 0;
  const seenNfo = new Set();

  for (const a of ai.result) {
    const it = byStem.get(a.stem);
    if (!it) { errors.push('未匹配：' + a.stem); continue; }
    try {
      if (a.type === 'series' && a.series) {
        const show = util.sanitizeFilename(organize.t2sBatch([a.series])[0] || a.series).slice(0, 80);
        const target = organize.targetPath(cfg.downloadDir,
          { kind: 'series', show, season: a.season == null ? 1 : a.season, episode: a.episode || 1, lib: a.library === '电视剧' ? '电视剧' : '番剧' },
          it.ext, it.full);
        if (target && target !== it.full) { moveFile(it.full, target); moved++; }
        const nf = path.join(cfg.downloadDir, a.library === '电视剧' ? '电视剧' : '番剧', show, 'tvshow.nfo');
        if (!seenNfo.has(nf)) {
          fs.mkdirSync(path.dirname(nf), { recursive: true });
          fs.writeFileSync(nf, organize.tvshowNfo(show, it.site, it.stem), 'utf8');
          seenNfo.add(nf); nfo++;
        }
      } else {
        const title = organize.t2sBatch([a.title || it.stem])[0] || it.stem;
        const clean = util.sanitizeFilename(title);
        const nf = path.join(path.dirname(it.full), clean + '.nfo');
        fs.writeFileSync(nf, organize.movieNfo(clean, it.site, a.code || '', it.stem), 'utf8');
        nfo++;
      }
    } catch (e) {
      errors.push(it.stem + ': ' + e.message);
    }
  }

  // 同步媒体库镜像（cron 也会每 5 分钟兜底）
  const syncSh = path.join(config.ROOT, 'deploy', 'linux', 'media-sync.sh');
  if (fs.existsSync(syncSh)) {
    try { execFile('bash', [syncSh], (e) => { if (e) console.warn('[organize-ai] media-sync 失败：' + e.message); }); } catch (_) {}
  }

  return {
    ok: true,
    aiModel: codex.model,
    total: flat.length,
    moved,
    nfo,
    errors,
    note: `已用 AI（${codex.model}）整理 ${flat.length} 个文件：移动 ${moved} 个到剧集库、写 ${nfo} 个 nfo`,
  };
}

module.exports = { run, readCodex, collectUnorganized };
