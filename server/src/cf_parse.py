#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""解析 Cloudflare 保护的 m3u8，返回最高清 variant 的分片 URL 列表（JSON）。

用途：前端下载器「后端过验证 + 前端下分片」——后端用 curl_cffi（Firefox 指纹）
通过 Cloudflare 拿到 m3u8 与分片列表，前端用浏览器下载分片（真实浏览器指纹，
用户能看视频说明分片请求能过）。

用法：python cf_parse.py --url <master.m3u8> --referer <页面URL>
输出：{"ok":true,"segments":[...],"ext":"ts"|"mp4"}
"""
import sys, json, re, argparse
from urllib.parse import urlparse
from curl_cffi import requests as cffi

IMPERSONATE = ["firefox135", "firefox133"]

def build_headers(origin):
    return {
        'Accept': '*/*',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
        'Referer': origin + '/',
        'Origin': origin,
    }

def get(url, headers):
    last = None
    for tgt in IMPERSONATE:
        try:
            return cffi.get(url, impersonate=tgt, headers=headers, timeout=30)
        except Exception as e:
            last = e
    raise RuntimeError('请求失败: %s' % last)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', required=True)
    ap.add_argument('--referer', default='')
    args = ap.parse_args()

    origin = ''
    if args.referer:
        try:
            origin = 'https://' + urlparse(args.referer).netloc
        except Exception:
            origin = ''
    if not origin:
        origin = 'https://missav.ws'
    headers = build_headers(origin)

    # 1) master m3u8
    r = get(args.url, headers)
    if r.status_code != 200 or '#EXTM3U' not in r.text:
        raise RuntimeError('master m3u8 失败: HTTP %d' % r.status_code)
    master = r.text

    # 2) 选最高带宽 variant
    variant_url = args.url
    lines = master.splitlines()
    best_bw = -1
    for i, ln in enumerate(lines):
        if ln.startswith('#EXT-X-STREAM-INF'):
            m = re.search(r'BANDWIDTH=(\d+)', ln)
            bw = int(m.group(1)) if m else 0
            if i + 1 < len(lines) and lines[i + 1].strip() and not lines[i + 1].startswith('#'):
                vu = lines[i + 1].strip()
                if bw > best_bw:
                    best_bw = bw
                    variant_url = vu if vu.startswith('http') else args.url.rsplit('/', 1)[0] + '/' + vu

    # 3) variant m3u8 -> 分片
    r = get(variant_url, headers)
    if r.status_code != 200 or '#EXT' not in r.text:
        raise RuntimeError('variant m3u8 失败: HTTP %d' % r.status_code)
    base = variant_url.rsplit('/', 1)[0] + '/'
    segs = [s if s.startswith('http') else base + s
            for s in (ln.strip() for ln in r.text.splitlines()) if s and not s.startswith('#')]
    if not segs:
        raise RuntimeError('播放列表里没有分片')
    ext = 'mp4' if re.search(r'\.(m4s|mp4)(\?|$)', segs[0], re.I) else 'ts'

    print(json.dumps({'ok': True, 'segments': segs, 'ext': ext}, ensure_ascii=False))

if __name__ == '__main__':
    main()
