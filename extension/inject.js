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

  /* 抖音 feed / 作品列表 / 搜索接口：响应 JSON 里有每条作品的播放地址 */
  const DOUYIN_API_RE = /\/aweme\/v1\/(web|multi)\/feed\/|\/aweme\/v1\/web\/aweme\/post\/|\/aweme\/v1\/web\/general\/search\/single\//i;

  /** 从抖音接口 JSON 里提取作品：{id, desc, video, audio} */
  function extractAweme(json) {
    const out = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object' || out.length > 100) return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node.aweme_id && node.video) {
        const v = node.video;
        let video = '';
        const pa = v.play_addr && v.play_addr.url_list;
        if (pa && pa.length) video = pa[0];
        else if (Array.isArray(v.bit_rate) && v.bit_rate.length) {
          const best = v.bit_rate[v.bit_rate.length - 1];
          video = (best && best.play_addr && best.play_addr.url_list && best.play_addr.url_list[0]) || '';
        }
        const mu = node.music && node.music.play_addr && node.music.play_addr.url_list;
        out.push({ id: String(node.aweme_id), desc: String(node.desc || ''), video, audio: (mu && mu[0]) || '' });
        return;
      }
      for (const k of Object.keys(node)) walk(node[k]);
    };
    walk(json);
    return out.filter((x) => x.id && /^https?:/i.test(x.video));
  }

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
      const p = origFetch.apply(this, arguments);
      try {
        const u = typeof input === 'string' ? input : (input && input.url) || '';
        if (u && MEDIA_HINT_RE.test(u)) post('media', { url: u, t: Date.now() });
        // 抖音接口：克隆响应解析出每条作品的播放地址（按 aweme_id 精确归属）
        if (u && DOUYIN_API_RE.test(u)) {
          p.then((res) => {
            try {
              res.clone().text().then((txt) => {
                try { post('feeditems', { items: extractAweme(JSON.parse(txt)) }); } catch (_) {}
              }).catch(() => {});
            } catch (_) {}
          }).catch(() => {});
        }
      } catch (_) {}
      return p;
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      if (typeof url === 'string') {
        if (MEDIA_HINT_RE.test(url)) post('media', { url, t: Date.now() });
        if (DOUYIN_API_RE.test(url)) {
          this.addEventListener('load', () => {
            try {
              let json = null;
              if (this.responseType === 'json') json = this.response;
              else if (!this.responseType || this.responseType === 'text') json = JSON.parse(this.responseText);
              if (json) post('feeditems', { items: extractAweme(json) });
            } catch (_) {}
          });
        }
      }
    } catch (_) {}
    return origOpen.apply(this, arguments);
  };
})();
