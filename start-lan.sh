#!/usr/bin/env bash
# 网页视频下载 · 局域网模式启动脚本（macOS / Linux 服务器）
# 监听所有网卡，局域网内其他电脑可通过  http://服务器IP或主机名:8765  连接
# 可用环境变量 WVD_HOST 覆盖监听地址（默认 0.0.0.0），其余参数透传给服务
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js，请先安装：https://nodejs.org/"
  exit 1
fi

echo "局域网模式启动：请用启动日志里打印的局域网地址配置浏览器扩展（需 Token）。"

exec node server/src/server.js --host="${WVD_HOST:-0.0.0.0}" "$@"
