#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Cloudflare 强防护站（surrit.com 等）m3u8 下载器。

原理（参考 missav-dlp-web）：
  surrit.com 的 Cloudflare 只放行「镜像页播放器发出的跨站子资源请求」，对
  直接访问（Sec-Fetch-Site: none/navigate）返回 403。因此用 curl_cffi 模拟
  Firefox TLS 指纹，并携带与浏览器一致的跨站 header：
    Sec-Fetch-Site: cross-site / Sec-Fetch-Mode: cors / Sec-Fetch-Dest: empty
    + Referer/Origin（镜像域名）。不需要 cookie、不需要 VPN。

用法：
  python dl_cf.py --url <master.m3u8> --referer <页面URL> --out <输出.mp4> [--ffmpeg <路径>]
进度：stdout 每若干分片输出一行 "PROGRESS <0-100>"，最后 "OK <路径>"。
"""
import sys, os, re, subprocess, tempfile, argparse, threading
from urllib.parse import urlparse
from concurrent.futures import ThreadPoolExecutor
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

def get(url, headers, timeout=30, tries=3):
    last = None
    for _ in range(tries):
        for tgt in IMPERSONATE:
            try:
                r = cffi.get(url, impersonate=tgt, headers=headers, timeout=timeout)
                return r
            except Exception as e:
                last = e
    raise RuntimeError('请求失败: %s' % last)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', required=True)
    ap.add_argument('--referer', default='')
    ap.add_argument('--out', required=True)
    ap.add_argument('--ffmpeg', default='')
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
    r = get(args.url, headers, timeout=30)
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

    # 3) variant m3u8 -> 分片列表
    r = get(variant_url, headers, timeout=30)
    if r.status_code != 200 or '#EXT' not in r.text:
        raise RuntimeError('variant m3u8 失败: HTTP %d' % r.status_code)
    base = variant_url.rsplit('/', 1)[0] + '/'
    segs = [s if s.startswith('http') else base + s
            for s in (ln.strip() for ln in r.text.splitlines()) if s and not s.startswith('#')]
    if not segs:
        raise RuntimeError('播放列表里没有分片')
    total = len(segs)

    # 4) 并发下载分片（带重试 + 进度输出）
    tmpdir = tempfile.mkdtemp(prefix='wvd_cf_')
    done = [0]
    lock = threading.Lock()

    def fetch(item):
        i, u = item
        data = None
        last = None
        # 分片重试 3 次，单次超时 120 秒
        for _ in range(3):
            for tgt in IMPERSONATE:
                try:
                    rr = cffi.get(u, impersonate=tgt, headers=headers, timeout=120)
                    if rr.status_code == 200:
                        data = rr.content
                        break
                    last = 'HTTP %d' % rr.status_code
                except Exception as e:
                    last = str(e)
            if data is not None:
                break
        if data is None:
            raise RuntimeError('分片 %d 失败(%s)' % (i + 1, last))
        p = os.path.join(tmpdir, '%05d.ts' % i)
        with open(p, 'wb') as f:
            f.write(data)
        with lock:
            done[0] += 1
            if done[0] % 20 == 0 or done[0] == total:
                print('PROGRESS %d' % int(done[0] * 100 / total), flush=True)
        return p

    with ThreadPoolExecutor(max_workers=6) as ex:
        list(ex.map(fetch, enumerate(segs)))

    # 5) 合成：优先 ffmpeg concat 转 mp4；失败则字节直拼存 .ts（都能播）
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    is_ts = not re.search(r'\.(m4s|mp4)(\?|$)', segs[0], re.I)

    ffmpeg = args.ffmpeg or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'bin', 'ffmpeg')
    if os.path.isfile(ffmpeg):
        listfile = os.path.join(tmpdir, 'list.txt')
        with open(listfile, 'w', encoding='utf-8') as f:
            for i in range(total):
                f.write("file '%s'\n" % os.path.join(tmpdir, '%05d.ts' % i))
        proc = subprocess.run([ffmpeg, '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
                               '-i', listfile, '-c', 'copy', args.out],
                              capture_output=True, text=True)
        if proc.returncode == 0 and os.path.exists(args.out) and os.path.getsize(args.out) > 0:
            print('OK %s' % args.out, flush=True)
            return

    # 降级：字节直拼为 .ts（TS 分片直接拼接即合法 TS；fmp4 则保留原扩展名）
    out = args.out
    if not out.lower().endswith('.ts') and is_ts:
        out = args.out.rsplit('.', 1)[0] + '.ts'
    with open(out, 'wb') as fo:
        for i in range(total):
            with open(os.path.join(tmpdir, '%05d.ts' % i), 'rb') as fi:
                fo.write(fi.read())
    print('OK %s' % out, flush=True)

if __name__ == '__main__':
    main()
