#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""繁体 → 简体批量转换（供 organize.js 调用）。

用法：python t2s.py '<json 字符串数组>'
输出：转换后的 JSON 数组（opencc 不可用时原样返回，保证下载流程不被打断）
"""
import sys
import json

try:
    from opencc import OpenCC
    _cc = OpenCC('t2s')
except Exception:
    _cc = None


def main():
    texts = json.loads(sys.argv[1])
    if _cc is None:
        print(json.dumps(texts, ensure_ascii=False))
        return
    try:
        out = [_cc.convert(str(t)) for t in texts]
    except Exception:
        out = texts
    print(json.dumps(out, ensure_ascii=False))


if __name__ == '__main__':
    main()
