#!/usr/bin/env bash
# 从公开仓库部署/更新后端，并实现开机自启 + 崩溃自动重启（无需 sudo）。
# 优先用 systemd 用户服务（要求 Linger 已开启）；否则回退到 cron + 守护循环。
# 用法：  bash deploy/linux/install.sh
# 可自定义目录：WVD_DIR=/opt/videodownload bash deploy/linux/install.sh
set -e

REPO_URL="https://github.com/paidaxingdiyim1/videodownload-deploy.git"
INSTALL_DIR="${WVD_DIR:-$HOME/videodownload-deploy}"

# ---- 1. 克隆或更新代码（一律从公开仓库拉取） ----
if [ -d "$INSTALL_DIR/.git" ]; then
  echo ">> 目录已存在，git pull 更新…"
  git -C "$INSTALL_DIR" pull --ff-only origin main
else
  echo ">> 从公开仓库克隆…"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

# ---- 2. 定位 node（优先 nvm，其次 PATH） ----
NODE=""
for n in "$HOME"/.nvm/versions/node/v*/bin/node; do [ -x "$n" ] && NODE="$n"; done
[ -z "$NODE" ] && NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ]; then echo "[错误] 未找到 node，请先安装 Node.js 18+"; exit 1; fi
echo ">> 使用 node: $NODE"

# ---- 3. 开机自启 + 崩溃自动重启 ----
USE_SYSTEMD=0
if systemctl --user show-environment >/dev/null 2>&1 && [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = "yes" ]; then
  USE_SYSTEMD=1
fi

if [ "$USE_SYSTEMD" = "1" ]; then
  echo ">> 使用 systemd 用户服务（Linger 已开启，可开机自启）"
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/wvd.service" <<EOF
[Unit]
Description=Web Video Downloader (LAN)
After=network-online.target

[Service]
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE server/src/server.js --host=0.0.0.0 --no-open
Environment=WVD_SUPERVISED=1
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now wvd.service
  # 清理旧的 cron 方案
  crontab -l 2>/dev/null | grep -v 'wvd-service.sh' | crontab - 2>/dev/null || true
  rm -f "$HOME/wvd-service.sh"
  echo ">> 服务已通过 systemd 启动"
else
  echo ">> 回退到 cron + 守护循环（Linger 未开启，登录后启动）"
  cat > "$HOME/wvd-service.sh" <<EOF
#!/usr/bin/env bash
cd "$INSTALL_DIR"
NODE="$NODE"
[ -x "\$NODE" ] || NODE="\$(command -v node)"
export WVD_SUPERVISED=1
while true; do
  "\$NODE" server/src/server.js --host=0.0.0.0 --no-open
  echo "[wvd] 服务退出，3 秒后重启…"
  sleep 3
done
EOF
  chmod +x "$HOME/wvd-service.sh"
  CRON_LINE="@reboot /bin/bash \"$HOME/wvd-service.sh\" >> \"$HOME/wvd-service.log\" 2>&1"
  ( crontab -l 2>/dev/null | grep -v 'wvd-service.sh' ; echo "$CRON_LINE" ) | crontab -
  if pgrep -f "server/src/server.js" >/dev/null 2>&1; then
    echo ">> 服务已在运行，跳过启动"
  else
    nohup /bin/bash "$HOME/wvd-service.sh" >> "$HOME/wvd-service.log" 2>&1 &
    echo ">> 服务已后台启动"
  fi
fi

echo ""
echo "部署完成。"
echo "  局域网地址  http://$(hostname):8765"
echo "  Token 查看  cat $INSTALL_DIR/server/config.json"
echo "  日志        journalctl --user -u wvd -f   （systemd）或 tail -f $HOME/wvd-service.log"
echo "  更新        bash $INSTALL_DIR/deploy/linux/install.sh  （或扩展设置页点「更新后端」）"
echo ""
echo "  提示：若局域网其他电脑连不上 8765，通常是防火墙拦截，请放行："
echo "        sudo ufw allow 8765/tcp"
