// ============================================================
// iOS 快捷指令 ·「在网页上运行 JavaScript」脚本  (v2)
//
// 它自己会做两件事：
//   1) 找出当前页面这个视频的「最高画质」直链
//   2) 直接把 Safari 跳到服务器（新标签页）→ 你立刻能看到「已提交下载」
//
// 所以快捷指令只需要两个动作：
//   接收「Safari 浏览器」网页  →  在网页上运行 JavaScript（本脚本）
// 不需要「获取 URL 内容」，也就不会再有「请确保传递了有效 URL」的报错。
//
// 返回值同时是那个提交地址（纯文本），想保留旧的三动作流程也能用。
// ============================================================
(function () {
  // 服务器地址与访问码（与 server/config.json 的 token 一致）
  var SRV = 'http://192.168.5.22:8765';
  var TOK = 'c3be1b59181e341893900bdaaf87e56a';

  var host = '';
  var cands = [];     // [{ u, tag }]
  var seen = {};
  var resN = 0;       // 页面已加载资源数（诊断用）
  var vidN = 0;       // video/source 元素数（诊断用）

  function fin(v) {
    // iOS 部分版本要求脚本调用 completion(result) 才算完成
    try { if (typeof completion === 'function') completion(v); } catch (e) {}
    return v;
  }

  function add(u, tag) {
    u = String(u == null ? '' : u).replace(/&amp;/g, '&').trim();
    if (!u || !/^https?:\/\//i.test(u)) return;
    if (/\.(ts|m4s|jpg|jpeg|png|gif|webp|ico|css|js|woff2?|ttf|svg)(\?|$)/i.test(u)) return;
    if (u.length > 1200) return;
    if (seen[u]) return;
    seen[u] = 1;
    cands.push({ u: u, tag: tag || '' });
  }

  /* 1) 一个窗口里已加载的资源 + <video>/<source>（iframe 同源时也扫） */
  function scanWin(w, isTop) {
    try {
      var es = w.performance.getEntriesByType('resource') || [];
      if (isTop) resN = es.length;
      for (var i = 0; i < es.length; i++) {
        var n = es[i].name || '';
        if (/\.m3u8(\?|$)/i.test(n)) add(n, 'm3u8');
        else if (/\.mp4(\?|$)/i.test(n)) add(n, 'mp4');
      }
    } catch (e) {}
    try {
      var vs = w.document.querySelectorAll('video, source');
      if (isTop) vidN = vs.length;
      for (var j = 0; j < vs.length; j++) {
        var s = vs[j].currentSrc || vs[j].src || vs[j].getAttribute('src') || '';
        if (/^https?:/i.test(s)) add(s, 'video');
      }
    } catch (e) {}
  }

  try {
    host = location.hostname;
    scanWin(window, true);
    for (var f = 0; f < window.frames.length && f < 4; f++) scanWin(window.frames[f], false);
  } catch (e) {}

  /* 2) 页面源码里的地址：不少站点（missav 等）把 playlist 直接写在脚本里 */
  try {
    var html = document.documentElement ? document.documentElement.innerHTML : '';
    if (html && html.length < 4 * 1024 * 1024) {
      var m;
      var R1 = /https?:\/\/[^\s"'<>\\]{6,300}\.(?:m3u8|mp4)[^\s"'<>\\]{0,200}/gi;
      while ((m = R1.exec(html))) add(m[0], 'html');
      var R2 = /https?:\/\/surrit\.com\/[0-9a-f-]{36}[^\s"'<>\\]*/gi;
      while ((m = R2.exec(html))) add(m[0], 'surrit');
    }
  } catch (e) {}

  /* 3) 页面里的「下载」入口（H 站：点进去是下载页，列各画质直链） */
  var dlPages = [];
  try {
    var as = document.querySelectorAll('a[href]');
    for (var k = 0; k < as.length; k++) {
      var href = as[k].href || '';
      var txt = as[k].textContent || '';
      if (!/^https?:/i.test(href)) continue;
      if ((/download/i.test(href) || /下载/.test(txt) || /download/i.test(txt))
          && dlPages.indexOf(href) < 0 && dlPages.length < 3) {
        dlPages.push(href);
      }
    }
  } catch (e) {}

  function fetchText(u) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', u, false);   // 同步：快捷指令环境最稳（同源请求自带 cookie）
      xhr.send(null);
      return (xhr.status >= 200 && xhr.status < 300) ? xhr.responseText : '';
    } catch (e) { return ''; }
  }

  /* 4) H 站特化：抓下载页，把各画质 mp4 直链全捞出来 */
  if (/hanime1?\./i.test(host)) {
    var pages = dlPages.slice(0, 2);
    try {
      var vid = new URLSearchParams(location.search).get('v');
      if (vid) pages.push(location.origin + '/download?v=' + vid);
    } catch (e) {}
    for (var t = 0; t < pages.length; t++) {
      var dh = fetchText(pages[t]);
      if (!dh) continue;
      var dm, DR = /https?:\/\/[^\s"'<>]*\.mp4[^\s"'<>]*/gi;
      while ((dm = DR.exec(dh))) add(dm[0], 'download-page');
    }
  }

  /* 5) surrit 的分辨率子列表(/720p/video.m3u8) → master(/playlist.m3u8)
        master 里含 360p/480p/720p/1080p，服务端自动选最高 */
  function master(u) {
    var mm = String(u).match(/^(https?:\/\/surrit\.com\/[0-9a-f-]{36})\/(?:\d{3,4}p\/)?(?:video|playlist)\.m3u8(\?.*)?$/i);
    return mm ? mm[1] + '/playlist.m3u8' + (mm[2] || '') : u;
  }

  /* 6) 打分：master 优先，其次 1080 > 720 > 480 */
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

  var best = cands.length ? master(cands[0].u) : '';
  var title = '';
  try { title = String(document.title || '').slice(0, 150); } catch (e) {}
  var pageUrl = '';
  try { pageUrl = location.href; } catch (e) {}

  var target;
  if (best) {
    target = SRV + '/api/quick-download?token=' + TOK
      + '&title=' + encodeURIComponent(title)
      + '&referer=' + encodeURIComponent(pageUrl)
      + '&url=' + encodeURIComponent(best);
  } else {
    // 找不到直链也要返回一个「能打开的地址」，否则快捷指令会报「无效 URL」
    target = SRV + '/api/ios-hint?token=' + TOK
      + '&h=' + encodeURIComponent(host)
      + '&r=' + resN + '&c=' + cands.length + '&v=' + vidN;
  }

  // 顺序很重要：
  // 1) 先尝试新标签页打开提交地址（当前网页保留，能继续下别的）
  // 2) 再把地址交回快捷指令（部分 iOS 必须调 completion，否则报「必须调用 completion」）
  // 3) 实在开不了新标签才跳转当前页（此时结果已经交回，不会影响快捷指令）
  var opened = null;
  try { opened = window.open(target, '_blank'); } catch (e) { opened = null; }
  try { fin(target); } catch (e) {}
  if (!opened) {
    try { location.href = target; } catch (e) {}
  }
  return target;
})();
