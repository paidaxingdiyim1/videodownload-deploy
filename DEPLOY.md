# 部署到局域网服务器指南

把「网页视频下载器」的后端服务部署到局域网服务器（示例服务器名：**yourserver**），局域网内所有电脑的浏览器扩展都可以把下载任务交给它。

```
局域网内任意电脑                               服务器（yourserver）
┌────────────────────┐    HTTP              ┌──────────────────────────┐
│ Chrome / Edge 扩展  │ ──────────────────▶ │  start-lan.bat / .sh      │
│ 服务地址填          │ http://yourserver:8765 │  监听 0.0.0.0:8765      │
│ http://yourserver:8765 │ ◀── 任务进度 ───── │  yt-dlp / ffmpeg / 下载   │
└────────────────────┘   (Token 鉴权)        └───────────┬──────────────┘
                                                         ▼
                                               downloads/（文件落在服务器上，
                                               可用 /api/files 列表取回）
```

## 服务器端

> **一律从公开仓库部署**：`https://github.com/paidaxingdiyim1/videodownload-deploy.git`。不要用旧的私有/个人仓库，保证服务器上的代码就是公开的那一份，且能在线 `git pull` 更新。

### Linux 服务器（推荐，一键部署 + 开机自启）

```bash
git clone https://github.com/paidaxingdiyim1/videodownload-deploy.git
cd videodownload-deploy
bash deploy/linux/install.sh
```

脚本会自动：从公开仓库克隆/更新 → 定位 node（nvm / PATH）→ 生成守护脚本 `~/wvd-service.sh`（崩溃自动重启、自更新后自动拉起）→ 用用户级 crontab 实现开机自启（**无需 sudo**）→ 立即后台启动。之后：

```bash
cat server/config.json            # 看 Token
tail -f ~/wvd-service.log         # 看日志
bash deploy/linux/install.sh      # 手动更新（或扩展设置页点「更新后端」）
```

> 装成 systemd 服务的方式见下方「systemd 常驻」；Docker 方式见「Docker」。无论哪种，代码都必须从上面的公开仓库 clone。

### Windows 服务器

1. 安装 **Node.js 18+**（https://nodejs.org/ ，装完 `node -v` 能出版本号即可）
2. 拿到代码：
   ```bat
   git clone https://github.com/paidaxingdiyim1/videodownload-deploy.git
   cd videodownload-deploy
   ```
3. 双击 **`start-lan.bat`**（窗口保持打开，关掉即停止服务）。脚本会：
   - 自动添加防火墙放行规则（`WebVideoDownloader`，TCP 8765）
   - 以 `--host=0.0.0.0` 监听所有网卡
4. 启动日志里会打印 Token 和所有可用的局域网地址，例如：
   ```
   地址      http://127.0.0.1:8765
   Token     a1b2c3d4e5f6...

   [局域网模式] 已监听所有网卡，其他电脑请用以下地址连接：
             http://192.168.1.100:8765
             http://yourserver:8765
   ```
5. （推荐）装 yt-dlp / ffmpeg：`node scripts/setup.js`，或把 `yt-dlp.exe`、`ffmpeg.exe` 放进 `server/bin/`

> 如果 8765 端口被占用，服务会自动 +1 重试，以窗口里显示的端口为准（防火墙规则只放行了 8765，换端口需自行放行或用管理员窗口重跑一次脚本）。

### Windows 常驻服务（推荐：开机自启、无需保持窗口）

不想让服务器一直开着命令行窗口？用管理员 PowerShell 一键装成计划任务（SYSTEM 账户、开机自启、无窗口、日志写 `logs/server.log`）：

```powershell
cd C:\path\to\videodownload\deploy\windows-service
powershell -ExecutionPolicy Bypass -File install-service.ps1
```

脚本会自动：找 node.exe → 加防火墙规则 → 注册计划任务 `WebVideoDownloader` → 立即启动 → 打印 Token。卸载：

```powershell
powershell -ExecutionPolicy Bypass -File uninstall-service.ps1
```

装成服务后 Token 从 `server/config.json` 或 `logs/server.log` 里查看（首次启动自动生成，重启不变）。

> 备选方案：用 [NSSM](https://nssm.cc/) 把 `node server\src\server.js --host=0.0.0.0 --no-open` 注册成真正的 Windows 服务（`nssm install WebVideoDownloader`），带崩溃自动重启；或使用「任务计划程序」图形界面手工建任务。

### systemd 常驻（Linux 可选，需 root）

放行端口（以 ufw 为例）：

```bash
sudo ufw allow 8765/tcp
```

**systemd 常驻**（开机自启、窗口关了也继续跑）：

```ini
# /etc/systemd/system/videodownload.service
[Unit]
Description=Web Video Downloader (LAN)
After=network.target

[Service]
WorkingDirectory=/opt/videodownload
ExecStart=/usr/bin/node server/src/server.js --host=0.0.0.0
Restart=on-failure
User=你的用户名

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now videodownload
journalctl -u videodownload -f      # 看 Token 和局域网地址
```

**Docker（可选）**：项目零 npm 依赖，任意带 Node 18 的镜像即可：

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY . .
RUN chmod +x start-lan.sh
EXPOSE 8765
CMD ["node", "server/src/server.js", "--host=0.0.0.0"]
```

```bash
docker build -t videodownload .
docker run -d --name videodownload -p 8765:8765 \
  -v "$PWD/downloads:/app/downloads" videodownload
docker logs videodownload            # 看 Token
```

### 安全说明（重要）

- 服务监听非回环地址时，**Token 校验强制开启**：`--no-token` 会被拒绝启动（确要关闭需显式加 `--allow-no-token`，风险自担）。
- 所有接口（配对除外）都需要 `X-Auth-Token`，扩展配对只认浏览器扩展来源。
- 局域网网页来源默认放行内网地址段（`10.x` / `192.168.x` / `172.16~31.x`）的 CORS；如需放行其他域名，在 `server/config.json` 里加：
  ```json
  "lanAllowedOrigins": ["*", "http://intra.example.com"]
  ```
- 请勿把该服务直接暴露到公网；如必须，请在前面加反向代理并限制访问来源。

## 在线更新（自更新）

代码在公开仓库里，更新不需要再手动 SSH 到服务器。

- **更新后端（服务器）**：扩展设置页「更新后端」→ 服务器执行 `git pull`（仅快进）→ 自动重启。也可在服务器上直接跑 `bash deploy/linux/install.sh`。
- **更新前端（扩展）**：扩展设置页「更新前端」→ 下载最新扩展包 → 解压后到 `chrome://extensions`「重新加载」。
- **自动检测**：扩展每 6 小时自动比对公开仓库里的前端版本号，有新版本会在图标上标「↑」并弹通知。

> 要求：服务器上的代码必须是 `git clone` 出来的（有 `.git` 目录、origin 指向公开仓库）。自更新接口需要 Token 鉴权，且只接受快进合并——服务器上若有未提交改动会拒绝更新并提示，防止覆盖你的本地修改。

相关接口（均需 Token）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/update/check` | 检查公开仓库是否有新提交（返回落后提交数） |
| POST | `/api/update` | 执行 `git pull --ff-only` 并重启 |

## 客户端（局域网内各电脑的浏览器扩展）

1. 打开 `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `extension` 文件夹
2. 点扩展图标 → **设置**：
   - **默认保存位置**：选「服务器」「本机」或「每次下载时询问」
   - **服务器地址**：`http://yourserver:8765`（或启动日志里打印的 IP 地址）
   - **服务器 Token**：把服务器窗口/`server/config.json` 里的 Token 粘贴进去（跨机器也可直接点「自动配对」）
   - **本机服务**：想往本机保存视频时，本机也要跑 `start.bat` 并完成本机配对
   - 点「测试连接」确认哪个服务在线
3. 保存位置的切换入口：
   - **扩展弹窗顶部**：「保存到 服务器 / 本机」开关，点了立即生效
   - **每次询问模式**：点视频旁下载按钮或资源面板里的「下载」时，会弹出「保存到服务器 / 保存到本机」小菜单
   - 文件保存在所选端点的 `downloads/` 里；保存到服务器时用服务器状态页或 `GET /api/files` 取回

## 取回下载好的文件

文件保存在 **服务器** 的 `downloads/<站点域名>/` 里（不是你自己的电脑）。取回方式：

1. **服务器上直接看**：服务器上操作时点扩展的「打开下载目录」，或去 `downloads/` 文件夹
2. **浏览器直接下载**：访问 `http://yourserver:8765`（无需 Token，仅状态页），或用带 Token 的文件接口：
   ```bash
   # 列出所有文件（含可直接点击的下载链接 url 字段）
   curl "http://yourserver:8765/api/files?token=<TOKEN>"
   # 下载某个文件
   curl -o out.mp4 "http://yourserver:8765/api/download-file?path=<绝对路径>&token=<TOKEN>"
   ```
   `/api/files` 返回的每个条目里已带拼好 Token 的 `url`，浏览器打开即可下载。

## 常见问题

**扩展测试连接失败**
确认服务器窗口还开着；确认用的是启动日志里打印的地址（主机名解析不了就用 IP）；服务器防火墙放行了对应端口。

**提示 token 无效**
服务器重启不会换 Token（存在 `server/config.json`），除非删掉了该文件。重新从服务器窗口复制 Token 填入扩展。

**想改监听地址/端口**
改 `server/config.json` 的 `host` / `port`，或用参数：`node server/src/server.js --host=0.0.0.0 --port=9000`。也可用环境变量 `WVD_HOST` / `WVD_DOWNLOAD_DIR`。
