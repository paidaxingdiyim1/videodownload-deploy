#!/usr/bin/env bash
# 从公开仓库部署/更新后端，并用守护循环 + crontab 实现开机自启（无需 sudo）。
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

# ---- 3. 生成守护脚本（崩溃自动重启 + 自更新后重启由它拉起） ----
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

# ---- 4. 开机自启（用户级 crontab，无需 sudo） ----
CRON_LINE="@reboot /bin/bash \"$HOME/wvd-service.sh\" >> \"$HOME/wvd-service.log\" 2>&1"
( crontab -l 2>/dev/null | grep -v 'wvd-service.sh' ; echo "$CRON_LINE" ) | crontab -

# ---- 5. 立即启动 ----
if pgrep -f "server/src/server.js" >/dev/null 2>&1; then
  echo ">> 服务已在运行，跳过启动"
else
  nohup /bin/bash "$HOME/wvd-service.sh" >> "$HOME/wvd-service.log" 2>&1 &
  echo ">> 服务已后台启动"
fi

echo ""
echo "部署完成。"
echo "  局域网地址  http://$(hostname):8765"
echo "  Token 查看  cat $INSTALL_DIR/server/config.json"
echo "  日志        tail -f $HOME/wvd-service.log"
echo "  更新        bash $INSTALL_DIR/deploy/linux/install.sh  （或扩展设置页点「更新后端」）"
