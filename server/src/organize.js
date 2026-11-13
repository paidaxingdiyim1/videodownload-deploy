'use strict';

/**
 * 标题整理（本地规则版，无 AI）：
 *  1. 从标题里识别「剧集」（第XX話 / 第XX集 / ＃N / EP / SxxEyy / 前編·後編 / SP）
 *  2. 日系（hanime1、带「話」）→ 番剧库；其它真人剧 → 电视剧库
 *  3. 系列名规整：去集数标记、[标签]、站名尾巴，繁体转简体（opencc，可选）
 *  4. 剧集按 Jellyfin 标准结构落盘：<库>/<系列>/Season XX/<系列> - SXXEXX.mp4 + tvshow.nfo
 *     单集/电影留在站点目录，只规整文件名并生成 movie.nfo（带 JAV 番号，方便刮削插件）
 *
 * 设计目标：全部在下载器侧完成，media-sync 把 downloads/<库> 整目录镜像进
 * /srv/share/media/<库>，Jellyfin 无需任何人工整理。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const util = require('./util');
const config = require('./config');

const LIB_ANIME = '番剧';
const LIB_TV = '电视剧';

/** hanime1 属于番剧；olevod / 76 站这类真人剧默认电视剧 */
const ANIME_SITES = new Set(['hanime1']);

/** 中文数字 → 阿拉伯 */
function cnToInt(s) {
  s = String(s || '').trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (s === '十') return 10;
  const CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (s.length === 1) return CN[s] != null ? CN[s] : 0;
  if (s.includes('十')) {
    const p = s.split('十');
    return (p[0] ? (CN[p[0]] || 0) : 1) * 10 + (p[1] ? (CN[p[1]] || 0) : 0);
  }
  if (s.includes('百')) {
    const p = s.split('百');
    return (p[0] ? (CN[p[0]] || 1) : 1) * 100 + (p[1] ? (CN[p[1]] || 0) : 0);
  }
  return 0;
}

/** 标题里的 JAV 番号（missav 等），用于 nfo 刮削 */
function extractCode(t) {
  const m = String(t || '').match(/^\s*([A-Z]{2,7})-?(\d{2,5})\b/);
  return m ? `${m[1]}-${m[2]}` : '';
}

/** 去掉 [中文字幕] [作者名] 之类标签、括号、多余标点 */
function stripTags(s) {
  return String(s || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/【[^】]*】/g, ' ')
    .replace(/[【】\[\]]/g, ' ')
    .replace(/^OVA\s+/i, '')
    .replace(/[《》「」『』・··…]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 解析标题 → 结构化信息
 * @returns { kind:'movie'|'series', show, season, episode, lib, code }
 */
function analyze(title, site) {
  const t = util.cleanTitle(title);
  // 先去 [标签] 再匹配尾部标记（前編/後編、#N、SP）——否则「前編[ドラチェフ]」匹配不到；
  // 但【第XX話】是集数标记不能先删，所以集数匹配仍用原文 t。
  const tNoTag = t.replace(/\[[^\]]*\]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const code = extractCode(t);
  const site0 = String(site || '');

  // ---- SxxEyy / EPn / 第X集(期) ----
  let m = t.match(/[Ss](\d{1,2})\s*[Ee](\d{1,3})/);
  if (m) {
    const show = stripTags(t.slice(0, t.indexOf(m[0])));
    return mkSeries(show, parseInt(m[1], 10), parseInt(m[2], 10), site0, t);
  }
  m = t.match(/[Ee][Pp]\s*(\d{1,3})/);
  if (m) {
    const show = stripTags(t.replace(m[0], ''));
    return mkSeries(show, 1, parseInt(m[1], 10), site0, t);
  }
  // 「第X集/期」：跳过「更新至第X集/共X集/全X集」这种进度描述
  const epRe = /第\s*([0-9]+|[零一二两三四五六七八九十百]+)\s*[集期]/g;
  let em;
  while ((em = epRe.exec(t))) {
    const pre = t.slice(Math.max(0, em.index - 3), em.index);
    if (/[至到]$|共$|全$/.test(pre)) continue;
    const show = stripTags(t.slice(0, em.index));
    const ep = cnToInt(em[1]);
    if (ep > 0 && show) return mkSeries(show, 1, ep, site0, t);
  }

  // ---- 日系「第X話/话/巻/卷」 ----
  const waRe = /第\s*([0-9]+|[零一二两三四五六七八九十百]+)\s*[話话巻卷]/g;
  let wm;
  while ((wm = waRe.exec(t))) {
    const show = stripTags(t.slice(0, wm.index));
    const ep = cnToInt(wm[1]);
    if (ep > 0 && show) return mkSeries(show, 1, ep, site0, t);
  }

  // ---- 全角/半角 #N（OVA ＃2） ----
  m = tNoTag.match(/[＃#]\s*(\d{1,3})/);
  if (m) {
    const show = stripTags(tNoTag.slice(0, tNoTag.indexOf(m[0])));
    if (show) return mkSeries(show, 1, parseInt(m[1], 10), site0, t);
  }

  // ---- 前編/後編、上巻/中巻/下巻 ----
  m = tNoTag.match(/(前編|後編|前编|后编|上巻|上卷|中巻|中卷|下巻|下卷)\s*$/);
  if (m) {
    const ord = { 前編: 1, 前编: 1, 上巻: 1, 上卷: 1, 中巻: 2, 中卷: 2, 後編: 2, 后编: 2, 下巻: 2, 下卷: 2 };
    const show = stripTags(tNoTag.slice(0, m.index));
    if (show) return mkSeries(show, 1, ord[m[1]], site0, t);
  }

  // ---- SP（特典，进 Season 00） ----
  m = tNoTag.match(/【?\s*SP\s*(\d{1,2})\s*】?/i);
  if (m) {
    const show = stripTags(tNoTag.replace(m[0], ''));
    if (show) return mkSeries(show, 0, parseInt(m[1], 10), site0, t);
  }

  return { kind: 'movie', show: '', season: 0, episode: 0, lib: '', code };
}

function mkSeries(show, season, episode, site, orig) {
  const s = util.sanitizeFilename(stripTags(show)).slice(0, 80);
  if (!s) return { kind: 'movie', show: '', season: 0, episode: 0, lib: '', code: '' };
  // 库归属：hanime1 或带「話/话/巻/卷」→ 番剧；其它 → 电视剧
  const lib = ANIME_SITES.has(site) || /[話话巻卷]/.test(orig) ? LIB_ANIME : LIB_TV;
  return { kind: 'series', show: s, season, episode, lib, code: '' };
}

/* ---------------- 繁体转简体（opencc，不可用则原样） ---------------- */

function t2sBatch(texts) {
  if (!Array.isArray(texts) || !texts.length) return texts;
  try {
    const py = config.resolvePython();
    const script = path.join(config.ROOT, 'server', 'src', 't2s.py');
    if (!fs.existsSync(script)) return texts;
    const out = execFileSync(py, [script, JSON.stringify(texts)], {
      encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const arr = JSON.parse(out);
    return Array.isArray(arr) && arr.length === texts.length ? arr : texts;
  } catch (_) {
    return texts; // opencc 没装 / 转换失败：保持原样，绝不阻塞下载
  }
}

/* ---------------- nfo 生成 ---------------- */

function escXml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function tvshowNfo(show, site, orig) {
  return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<tvshow>
  <title>${escXml(show)}</title>
  <originaltitle>${escXml(orig)}</originaltitle>
  <studio>${escXml(site || '')}</studio>
</tvshow>
`;
}

function movieNfo(title, site, code, orig) {
  const uid = code ? `<uniqueid type="jav" default="false">${escXml(code)}</uniqueid>\n  ` : '';
  return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<movie>
  <title>${escXml(title)}</title>
  <originaltitle>${escXml(orig)}</originaltitle>
  ${uid}<studio>${escXml(site || '')}</studio>
</movie>
`;
}

/* ---------------- 落盘 ---------------- */

function moveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code === 'EXDEV') {
      fs.copyFileSync(from, to);
      fs.unlinkSync(from);
    } else throw e;
  }
}

/** 计算目标路径；movie 返回 null（原地不动） */
function targetPath(dlDir, a, ext, curPath) {
  if (a.kind !== 'series') return null;
  const season = String(a.season == null ? 1 : a.season).padStart(2, '0');
  const ep = String(a.episode).padStart(2, '0');
  const dir = path.join(dlDir, a.lib, a.show, `Season ${season}`);
  const base = `${a.show} - S${season}E${ep}`;
  let candidate = path.join(dir, `${base}.${ext}`);
  let n = 1;
  while (fs.existsSync(candidate) && candidate !== curPath) {
    candidate = path.join(dir, `${base} (${n++}).${ext}`);
  }
  return candidate;
}

/**
 * 单个文件整理入口（下载完成后调用；也用于批量）
 * @returns { moved?:string, note:string, nfo:boolean, show?:string }
 */
function place(cfg, { title, site, filePath, ext }) {
  const og = cfg.organize || {};
  const a = analyze(title, site);
  const ext0 = ext || path.extname(filePath).slice(1) || 'mp4';
  const dir0 = path.dirname(filePath);
  const base0 = path.basename(filePath);
  const stem0 = base0.slice(0, -(ext0.length + 1));
  const out = { note: '', moved: null, nfo: false };

  // 可选：繁→简（系列名）
  if (a.kind === 'series' && og.t2s !== false) {
    const [s2] = t2sBatch([a.show]);
    if (s2 && s2 !== a.show) a.show = util.sanitizeFilename(stripTags(s2)).slice(0, 80);
  }

  if (a.kind === 'series') {
    const tgt = targetPath(cfg.downloadDir, a, ext0, filePath);
    if (tgt && tgt !== filePath) {
      moveFile(filePath, tgt);
      out.moved = tgt;
      out.note = `${a.lib}/${a.show} → S${String(a.season).padStart(2, '0')}E${String(a.episode).padStart(2, '0')}`;
    }
    if (og.writeNfo !== false) {
      const showDir = path.join(cfg.downloadDir, a.lib, a.show);
      fs.mkdirSync(showDir, { recursive: true });
      fs.writeFileSync(path.join(showDir, 'tvshow.nfo'), tvshowNfo(a.show, site, title), 'utf8');
      out.nfo = true;
    }
    return out;
  }

  // movie：原地；可选繁→简重命名 + movie.nfo
  let newStem = stem0;
  if (og.t2s !== false) {
    const [s2] = t2sBatch([stem0]);
    if (s2 && s2 !== stem0) newStem = util.sanitizeFilename(s2);
  }
  if (newStem !== stem0) {
    const tgt = path.join(dir0, `${newStem}.${ext0}`);
    if (!fs.existsSync(tgt)) {
      moveFile(filePath, tgt);
      out.moved = tgt;
      out.note = `重命名：${base0} → ${path.basename(tgt)}`;
    }
  }
  if (og.writeNfo !== false) {
    const nfoPath = path.join(dir0, `${newStem}.nfo`);
    fs.writeFileSync(nfoPath, movieNfo(newStem, site, a.code, title), 'utf8');
    out.nfo = true;
  }
  return out;
}

/* ---------------- 批量整理（存量文件） ---------------- */

const LIB_DIRS = new Set([LIB_ANIME, LIB_TV]);
const SKIP_DIRS = new Set(['.wvd-tmp', '.tmp-upload']);
const VID_EXT = /\.(mp4|mkv|webm|ts|m4v|mov|flv|avi|wmv)$/i;

/** 遍历下载目录，计算整理计划（返回 rows，供预览 / 执行） */
function planAll(cfg) {
  const root = cfg.downloadDir;
  const items = [];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (depth === 0 && LIB_DIRS.has(e.name))) continue;
        // 已经在 Season XX 结构里的剧集（如 olevod 已整理的），跳过不重复整理
        if (/^Season\s+\d+$/i.test(e.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!VID_EXT.test(e.name)) continue;
      // 已经是「系列 - SxxEyy」命名的文件跳过（避免二次移动/拆名）
      if (/\s*-\s*S\d{1,2}E\d{1,3}\s*$/.test(e.name.replace(VID_EXT, ''))) continue;
      items.push({ full, rel, dir, site: depth >= 1 ? rel.split(path.sep)[0] : '', stem: e.name.replace(VID_EXT, ''), ext: path.extname(e.name).slice(1) });
    }
  };
  walk(root, 0);

  // 一次性繁→简转换（避免逐文件 spawn python）
  const og = cfg.organize || {};
  let conv = items.map((it) => it.stem);
  if (og.t2s !== false) conv = t2sBatch(conv);

  const rows = [];
  items.forEach((it, i) => {
    const title = conv[i] || it.stem;
    const a = analyze(title, it.site);
    const actionRow = {
      from: it.rel,
      to: null,
      action: 'skip',
      site: it.site,
      lib: a.lib || '',
      show: a.show || '',
      season: a.kind === 'series' ? a.season : null,
      episode: a.kind === 'series' ? a.episode : null,
      code: a.code || '',
      note: '',
    };
    if (a.kind === 'series') {
      const tgt = targetPath(root, a, it.ext, it.full);
      if (tgt !== it.full) {
        actionRow.action = 'move';
        actionRow.to = path.relative(root, tgt);
        actionRow.note = `${a.lib}/${a.show} · S${String(a.season).padStart(2, '0')}E${String(a.episode).padStart(2, '0')}`;
      } else {
        actionRow.note = '已在剧集结构里';
      }
    } else if (og.t2s !== false && title !== it.stem) {
      const tgt = path.join(it.dir, `${util.sanitizeFilename(title)}.${it.ext}`);
      if (!fs.existsSync(tgt)) {
        actionRow.action = 'rename';
        actionRow.to = path.relative(root, tgt);
        actionRow.note = '繁体→简体';
      }
    }
    rows.push(actionRow);
  });
  return rows;
}

/** 执行整理计划；返回统计。写备份清单到 logs/。 */
function applyPlan(cfg, rows) {
  const root = cfg.downloadDir;
  const moves = rows.filter((r) => r.action === 'move' || r.action === 'rename');
  const backup = { time: new Date().toISOString(), moves: [] };
  let moved = 0, skipped = 0;
  const errors = [];
  for (const r of moves) {
    const from = path.join(root, ...r.from.split('/'));
    const to = path.join(root, ...r.to.split('/'));
    try {
      if (!fs.existsSync(from)) { skipped++; continue; }
      moveFile(from, to);
      backup.moves.push({ from: r.from, to: r.to });
      moved++;
    } catch (e) {
      errors.push(`${r.from} → ${r.to}: ${e.message}`);
    }
  }
  // 补齐 nfo
  const og = cfg.organize || {};
  let nfo = 0;
  if (og.writeNfo !== false) {
    const seen = new Set();
    for (const r of rows) {
      const fileRel = (r.action === 'move' || r.action === 'rename') ? r.to : r.from;
      if (!fileRel || r.action === 'skip') continue;
      const full = path.join(root, ...fileRel.split('/'));
      try {
        if (!fs.existsSync(full)) continue;
        const dir = path.dirname(full);
        const stem = path.basename(full, path.extname(full));
        const nf = r.show
          ? path.join(path.dirname(dir), 'tvshow.nfo')   // <lib>/<show>/tvshow.nfo
          : path.join(dir, `${stem}.nfo`);
        if (!seen.has(nf)) {
          fs.mkdirSync(path.dirname(nf), { recursive: true });
          const content = r.show
            ? tvshowNfo(r.show, r.site, r.from)
            : movieNfo(stem, r.site, r.code || '', r.from);
          fs.writeFileSync(nf, content, 'utf8');
          seen.add(nf); nfo++;
        }
      } catch (_) {}
    }
  }
  try {
    const logDir = path.join(config.ROOT, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, `organize-${Date.now()}.json`), JSON.stringify(backup, null, 2), 'utf8');
  } catch (_) {}
  return { moved, skipped, nfo, errors };
}

module.exports = { analyze, place, planAll, applyPlan, t2sBatch, targetPath, tvshowNfo, movieNfo };
