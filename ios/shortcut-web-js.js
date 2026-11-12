// ============================================================
// iOS 快捷指令 ·「在网页上运行 JavaScript」动作脚本
//
// 作用：在 Safari 当前页面里，找出这个视频的「最高画质」直链。
// 适用：missav（hls.js/surrit，自动取 master 里的 1080p）
//       hanime1（点「下载」进下载页，抓 1080p 直链）
//       普通网页（<video> 直链）
//
// 安装：
//   设置 → 快捷指令 → 打开「允许运行脚本」
//   快捷指令 App → 新建 → 加「在网页上运行 JavaScript」→ 粘贴本文件全部内容
//
// 返回：最优直链（纯文本）；找不到返回空字符串
// ============================================================
(function () {
  // 服务器地址与访问码（与 server/config.json 的 token 一致）
  var SERVER = 'http://192.168.5.22:8765';
  var TOKEN = 'c3be1b59181e341893900bdaaf87e56a';

  var host = location.hostname;
  var cands = [];   // { u, tag }
  var seen = {};

  // iOS 快捷指令要求脚本必须调用 completion(result) 才算完成；
  // 普通浏览器里没有该函数，则退回 return 值（便于调试）
  function done(v) {
    if (typeof completion === 'function') {
      try { completion(v); } catch (e) {}
    }
    return v;
  }

  function add(u, tag) {
    u = String(u || '').trim();
    if (!u || !/^https?:\/\//i.test(u)) return;
    // 排除分片和静态资源
    if (/\.(ts|m4s|jpg|jpeg|png|gif|webp|css|js)(\?|$)/i.test(u)) return;
    if (seen[u]) return;
    seen[u] = 1;
    cands.push({ u: u, tag: tag || '' });
  }

  /* 1) 页面已加载的资源：hls.js 请求过的 m3u8、播放器拉过的 mp4 都在这里
        （跨域资源的 timing 受限，但 URL 一定可见） */
  try {
    var es = performance.getEntriesByType('resource') || [];
    for (var i = 0; i < es.length; i++) {
      var n = es[i].name || '';
      if (/\.m3u8(\?|$)/i.test(n)) add(n, 'm3u8');
      else if (/\.mp4(\?|$)/i.test(n)) add(n, 'mp4');
    }
  } catch (e) {}

  /* 2) 页面里的 <video> 直链（普通站点） */
  try {
    var vs = document.querySelectorAll('video');
    for (var j = 0; j < vs.length; j++) {
      var s = vs[j].currentSrc || vs[j].src || '';
      if (/^https?:/i.test(s)) add(s, 'video');
    }
  } catch (e) {}

  /* 3) 页面里的「下载」入口（H 站：点进去是新页面，列出各画质直链） */
  var dlLinks = [];
  try {
    var as = document.querySelectorAll('a[href]');
    for (var k = 0; k < as.length; k++) {
      var href = as[k].href || '';
      var txt = as[k].textContent || '';
      if (/download|下载/i.test(href) || /download|下载/i.test(txt)) {
        if (/^https?:/i.test(href) && dlLinks.indexOf(href) < 0) dlLinks.push(href);
      }
    }
  } catch (e) {}

  function fetchText(u) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', u, false);   // 同步：快捷指令环境最稳
      xhr.send(null);
      return (xhr.status >= 200 && xhr.status < 300) ? xhr.responseText : '';
    } catch (e) { return ''; }
  }

  /* 4) H 站特化：抓「下载页」，把各画质 mp4 直链全捞出来
        页面本身已过 Cloudflare，同源请求自带 cookie，再选 1080p */
  if (/hanime1?\./i.test(host)) {
    var pages = dlLinks.slice(0, 3);
    try {
      var vid = new URLSearchParams(location.search).get('v');
      if (vid) pages.push(location.origin + '/download?v=' + vid);
    } catch (e) {}
    for (var t = 0; t < pages.length; t++) {
      var html = fetchText(pages[t]);
      if (!html) continue;
      var m;
      var re = /https?:\/\/[^"'\s<>]*\.mp4[^"'\s<>]*/gi;
      while ((m = re.exec(html))) add(m[0], 'download-page');
    }
  }

  /* 5) surrit 的分辨率子列表（/720p/video.m3u8）→ master（/playlist.m3u8）
        master 里含 360p/480p/720p/1080p 全部画质，服务端会自动选最高 */
  function toMaster(u) {
    var mm = u.match(/^(https?:\/\/surrit\.com\/[0-9a-f-]{36})\/(?:\d{3,4}p\/)?(?:video|playlist)\.m3u8(\?.*)?$/i);
    return mm ? mm[1] + '/playlist.m3u8' + (mm[2] || '') : u;
  }

  /* 6) 画质打分：master playlist 优先，其次按 1080 > 720 > 480 */
  function score(u) {
    var s = 0;
    if (/playlist\.m3u8/i.test(u)) s += 100000;
    var mm = u.match(/(\d{3,4})p/i);
    if (mm) s += parseInt(mm[1], 10);
    if (/1080/.test(u)) s = Math.max(s, 1080);
    else if (/720/.test(u)) s = Math.max(s, 720);
    else if (/480/.test(u)) s = Math.max(s, 480);
    return s;
  }
  cands.sort(function (a, b) { return score(b.u) - score(a.u); });

  var best = cands.length ? toMaster(cands[0].u) : '';
  if (!best) {
    try { alert('没找到视频直链：先让视频播放 2~3 秒再运行'); } catch (e) {}
    return done('');
  }
  // 返回「提交下载」的完整 URL —— 快捷指令只需接「获取 URL 内容」一步
  return done(SERVER + '/api/quick-download?token=' + TOKEN + '&url=' + encodeURIComponent(best));
})();
