'use strict';

/* ==========================================================================
 *  网页视频下载器 · 页面主世界钩子（MAIN world, document_start）
 *  作用：MSE 播放器（抖音等）的 video.src 是 blob: 虚拟地址，无法直接下载。
 *  这里挂钩 URL.createObjectURL 和 fetch/XHR，记录：
 *    1. 每个 blob: 地址的创建时刻
 *    2. 每条媒体流请求的时刻
 *  播放器为某个视频创建 MediaSource 的瞬间会紧接着拉取它的画面/音频流，
 *  按「请求时间最接近 blob 创建时刻」即可把 blob 精确配对到真实网络流。
 * ========================================================================== */

(() => {
  if (window.__WVD_HOOK__) return;
  window.__WVD_HOOK__ = true;

  const MEDIA_HINT_RE = /\.(mp4|m4a|mp3|m4v|mov|webm|flv|aac|m3u8|mpd)(\?|#|$)|\/video\/tos|\/audio\/tos|media-video|media-audio|douyinvod|bilivideo|googlevideo/i;

  const post = (type, data) => {
    try { window.postMessage({ __wvd: 1, type, ...data }, '*'); } catch (_) {}
  };

  const origCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    const url = origCreate(obj);
    try { if (url && url.startsWith('blob:')) post('blob', { url, t: Date.now() }); } catch (_) {}
    return url;
  };

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input) {
      try {
        const u = typeof input === 'string' ? input : (input && input.url) || '';
        if (u && MEDIA_HINT_RE.test(u)) post('media', { url: u, t: Date.now() });
      } catch (_) {}
      return origFetch.apply(this, arguments);
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      if (typeof url === 'string' && MEDIA_HINT_RE.test(url)) post('media', { url, t: Date.now() });
    } catch (_) {}
    return origOpen.apply(this, arguments);
  };
})();
