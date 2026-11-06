# 网页视频下载器

一个「浏览器扩展 + 本地下载服务」的网页视频下载工具。

扩展在页面里**识别出正在播放的视频，并在每个视频右上角浮出一个下载按钮**；本地服务负责带着页面的 Cookie / Referer 去请求、**解密 HLS 加密分片**、合并音视频、按标题落盘。

适合下载需要登录、带防盗链、分片加密的流媒体（HLS / DASH），这类流用普通的「右键另存为」或浏览器下载器通常拿不到。

```
┌──────────────────────┐      HTTP 127.0.0.1      ┌──────────────────────────────┐
│  Chrome / Edge 扩展   │ ── 下载请求(含Cookie/UA)─▶│  本地服务                      │
│  · webRequest 嗅探    │                          │  · m3u8 解析 + AES-128 解密    │
│  · 视频旁浮动按钮      │ ◀── 任务进度 (SSE) ────── │  · DASH / 直链下载             │
│  · 资源面板 / popup   │                          │  · yt-dlp / ffmpeg 增强        │
└──────────────────────┘                          └───────────────┬──────────────┘
                                                                   ▼
                                                          downloads/ 按标题命名
```

## 功能

| 能力 | 说明 |
|---|---|
| **视频旁浮动按钮** | 每个 `<video>` 右上角自动出现下载按钮，实时显示百分比 → 合并中 → 已保存 |
| **媒体流嗅探** | 后台持续嗅探页面发出的 m3u8 / mpd / mp4 / webm 请求，刷新页面不丢；能抓到没挂在 `<video>` 上的隐藏流 |
| **HLS 解密** | 主列表自动选清晰度，逐分片取 AES-128 密钥解密，并发下载、按序拼接；TS 与 fMP4（EXT-X-MAP）都支持 |
| **DASH** | SegmentTemplate / SegmentTimeline 解析，音视频分离时用 ffmpeg 合并 |
| **直链下载** | 流式写入 + 进度 + 断点续传 |
| **复杂站点** | 检测到 yt-dlp 时自动启用（YouTube、B站等） |
| **自动转封装** | 有 ffmpeg 时 TS→MP4、音视频轨合并；没有则保留 .ts（PotPlayer / VLC 可播） |
| **登录可见视频** | 自动带上页面的 Cookie、Referer、User-Agent |
| **保存位置可选** | 视频可保存到局域网服务器或本机：扩展弹窗一键切换、设置里改默认、或每次下载时弹出「服务器 / 本机」菜单 |
| **在线自更新** | 前后端都能在扩展设置页一键更新：后端从公开仓库 git pull 自重启，前端自动写入并重载；并自动检测新版本 |
| **打开已下载视频** | 下载完成后前端显示具体地址（局域网标出 http 地址），可一键用浏览器播放、复制地址，或用本机 PotPlayer 打开 |
| **零依赖服务** | 服务端只用 Node 标准库，不装任何 npm 包也能跑 |

## 快速开始

### 1. 装 Node.js

需要 **Node.js 18+**（[下载](https://nodejs.org/)）。`node -v` 能输出版本号即可。

### 2. 拿到代码

```bash
git clone https://github.com/paidaxingdiyim1/videodownload-deploy.git
cd videodownload-deploy
```

### 3. 启动本地服务

**Windows**：双击 `start.bat`（窗口里会显示端口和 Token，**窗口保持打开**，关掉即停止服务）

**macOS / Linux**：

```bash
chmod +x start.sh && ./start.sh
# 或者直接：
node server/src/server.js
```

要把服务部署到**局域网服务器**（其他电脑的扩展也连它），Linux 一键 `bash deploy/linux/install.sh`（开机自启 + 在线更新），Windows 用 `start-lan.bat` 或 `deploy/windows-service/install-service.ps1`。详见 [DEPLOY.md](DEPLOY.md)。

启动成功长这样：

```
本地服务已启动
  地址      http://127.0.0.1:8765
  Token     a1b2c3d4e5f6...
  下载目录  .../downloads
  yt-dlp    ✗ 未安装（不影响 m3u8 / 直链下载）
  ffmpeg    ✗ 未安装（HLS 将保存为 .ts）
```

想随时看服务状态和任务队列，浏览器打开 <http://127.0.0.1:8765> 有个控制台页面。

### 4.（推荐）装增强组件

这两个是可选但强烈推荐，装完体验差别很大：

```bash
node scripts/setup.js
```

- **yt-dlp** —— 复杂站点（YouTube、B站等）靠它，也能兜底各种非常规流
- **ffmpeg** —— 把 HLS 的 `.ts` 自动转成 `.mp4`，DASH 的音视频轨自动合并

脚本会依次尝试 pip / winget / 直接下载到 `server/bin/`。也可以自己手动下：

- yt-dlp：<https://github.com/yt-dlp/yt-dlp/releases/latest> → 把 `yt-dlp.exe` 放进 `server/bin/`
- ffmpeg：<https://www.gyan.dev/ffmpeg/builds/> → 把 `ffmpeg.exe`、`ffprobe.exe` 放进 `server/bin/`

放在 `server/bin/` 里的版本**不依赖系统 PATH**，服务启动时自动识别（换新版本后最多 60 秒自动生效，不用重启）。

### 5. 加载扩展

1. 打开 `chrome://extensions`（Edge 是 `edge://extensions`）
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」→ 选中项目里的 **`extension`** 文件夹
4. 建议把扩展图标「固定」到工具栏

### 6. 配对

点扩展图标 → **设置** → 点「**自动配对**」（它会去问本地服务要 Token）；配对不上就手动把服务窗口里的 Token 粘进去，点「测试连接」，变绿即成功。

> 服务只监听 `127.0.0.1`，所有接口都要 Token，配对只是把 Token 存进扩展里，不会外传。

## 使用

1. 打开任意视频页面，**点一下播放**让它加载出流
2. 视频右上角出现 **⬇ 下载** 按钮 → 点击
3. 按钮上依次显示百分比 → `合并中…` → `✓ 已保存`
4. 文件在 `downloads/<站点域名>/` 里，默认用网页标题命名

**标题识别**按以下顺序取值，全都没有时用 `站点_日期_序号` 兜底（保证文件名有意义，不会一堆「视频.mp4」）：

1. 页面元数据（`og:title` / `twitter:title` / JSON-LD 结构化数据）
2. `<video>` 元素自身的 `title` / `aria-label` / `data-title`
3. 视频附近的标题节点（`h1`~`h3`、class 含 title 的元素——很多站没有 og:title，但正文里有标题）
4. `document.title`（自动剥掉「- 站名」后缀）
5. URL 路径段（如 `/video/abc123.mp4` → `abc123`）

其他入口：

- **页面右下角的「视频资源」浮标**：展开能看到本页嗅探到的**全部**媒体流（包括不在 `<video>` 里的），逐个下载；也能打开下载目录
- **扩展图标弹窗**：当前页资源 + 下载任务进度 + 打开下载目录

支持 SPA 动态插入的视频、iframe 内的视频、以及开放 Shadow DOM 里的视频。

## 配置

首次启动自动生成 `server/config.json`（已 gitignore，含本机 Token）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 监听地址。局域网部署时改为 `0.0.0.0`（或用 `start-lan.bat` / `--host=0.0.0.0` / 环境变量 `WVD_HOST`），监听非回环地址时 Token 校验强制开启 |
| `port` | `8765` | 端口被占用时会自动 +1 重试，以窗口输出为准 |
| `token` | 随机生成 | 接口鉴权；扩展配对用 |
| `downloadDir` | `<项目>/downloads` | 下载目录，可用环境变量 `WVD_DOWNLOAD_DIR` 覆盖 |
| `concurrency` | `2` | 同时下载的任务数 |
| `segmentConcurrency` | `6` | 单个 HLS 任务的分片并发数 |
| `namingTemplate` | `{title}` | 文件命名模板，支持 `{title} {site} {date} {quality} {index}` |
| `siteFolders` | `true` | **按站点分文件夹**：`downloads/<域名>/<文件>`，设为 `false` 恢复全部平铺 |
| `preferYtdlp` | `true` | 有 yt-dlp 时优先用它 |
| `remuxToMp4` | `true` | 分片下完后尝试用 ffmpeg 转封装成 mp4 |
| `minMediaBytes` | `65536` | 小于该大小的响应不当作视频 |
| `requireToken` | `true` | 是否强制校验 Token |

命令行参数：

```bash
node server/src/server.js --port=9000     # 指定端口
node server/src/server.js --host=0.0.0.0  # 监听所有网卡（局域网部署，强制 Token）
node server/src/server.js --no-token      # 关闭鉴权（仅本机调试；监听非回环地址时会被拒绝启动，需再加 --allow-no-token）
```

打包成 exe 后另有两个：`--no-open`（不自动开浏览器）、`--no-shortcut`（不自动装桌面快捷方式）。

扩展设置页里另有：引擎模式（自动 / 只用本地解密 / 尽量用 yt-dlp）、按钮显示的最小视频尺寸。

## 打包成单文件 exe（Windows，可选）

不想装 Node、也不想开命令行，可以打成自带运行时的独立程序：

```bash
npm install                # esbuild + postject
node build/build-sea.js    # 产出 网页视频下载器.exe（约 84MB）
node build/test-exe.js     # 验证：启动 / 识别工具 / 直链下载 / yt-dlp 下载，13 项
```

用的是 Node 22 官方的 **SEA（Single Executable Application）**。打包后的程序：

- 双击即启动，**自动打开浏览器**控制台，并在桌面**自动安装快捷方式**（`--no-shortcut` 可关掉）
- 重复双击不会启动第二个实例，只会把浏览器打开
- exe 同目录优先找 `config.json` / `bin/`，找不到回退到 `server/config.json` / `server/bin/`
- 单独拷到别的电脑时，身边放一个 `bin/`（装 yt-dlp、ffmpeg）就有完整能力

## API

所有接口需要 `X-Auth-Token` 头（`/api/health` 和 `/api/pair` 除外）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 服务状态、依赖检测、配置摘要 |
| POST | `/api/pair` | 扩展配对换取 Token |
| POST | `/api/download` | 创建任务 `{url, title, kind, referer, cookies…}` |
| GET | `/api/probe` | 探测 URL 是直链 / m3u8 / mpd / 需要 yt-dlp |
| GET | `/api/tasks` | 任务列表；`/api/tasks/:id` 单个任务 |
| POST | `/api/tasks/:id/cancel` | 取消任务 |
| POST | `/api/tasks/clear` | 清空已完成任务 |
| GET | `/api/events` | SSE 实时进度 |
| GET | `/api/config` | 读取配置 |
| GET | `/api/files` | 列出 `downloadDir` 下的文件（含带 Token 的取回链接），局域网部署取回文件用 |
| GET | `/api/update/check` | 检查公开仓库是否有新提交 |
| POST | `/api/update` | 从公开仓库 `git pull` 并重启 |
| GET | `/api/stream` | 流式播放下载目录文件（支持 Range 拖动） |

## 目录结构

```
extension/            Chrome MV3 扩展
  manifest.json       权限声明（webRequest 嗅探 / content script 注入）
  background.js       后台嗅探 + 任务轮询 + 与本地服务通信
  content.js          页面内：视频旁浮动按钮 + 资源面板（Shadow DOM 隔离样式）
  popup.*             工具栏弹窗
  options.*           设置页（服务地址 / Token / 引擎模式）
server/               本地服务（Node ≥18，无第三方依赖）
  src/hls.js          m3u8 解析 + AES-128 解密 + 分片并发下载
  src/dash.js         MPD 解析下载
  src/direct.js       直链流式下载
  src/ytdlp.js        yt-dlp / ffmpeg 探测与调用
  src/tasks.js        任务队列、进度、命名
  src/server.js       HTTP API + 状态页
  src/config.js       配置读写（区分源码模式 / SEA 模式）
  bin/                放 yt-dlp / ffmpeg（gitignored，用 scripts/setup.js 装）
  test/selftest.js    自测：自建加密 HLS 流，验证解密后**逐字节一致**
  test/e2e.js         真实链路：ffmpeg 现场生成加密 HLS → 下载 → 转 MP4 → ffprobe 校验
  test/naming.js      标题兜底与按站点分目录的落盘验证
build/                Node SEA 打包
  build-sea.js        esbuild 打包 → 生成 blob → 注入 node.exe
  test-exe.js         对打包产物做真实下载验证
scripts/              辅助脚本
  setup.js            安装 yt-dlp / ffmpeg
  make-icons.js       扩展图标生成
  make-ico.js         多尺寸 PNG → assets/app.ico
  make-bat.js         生成 start.bat，并断言「纯 ASCII + CRLF」
deploy/               部署脚本
  linux/install.sh    Linux 一键部署（公开仓库克隆 + 守护循环 + crontab 自启）
  windows-service/    Windows 计划任务常驻（install/uninstall）
  windows/install-potplayer-handler.ps1  注册 wvdplay:// 协议，供扩展用本机 PotPlayer 打开视频
assets/app.ico        应用图标
```

## 测试

```bash
node server/test/selftest.js   # 7 项，零依赖：加密 HLS 解密正确性 + 直链下载
node server/test/naming.js     # 2 项，零依赖：标题兜底命名 + 按站点分目录
node server/test/e2e.js        # 11 项，需要 server/bin/ffmpeg.exe
node build/test-exe.js         # 13 项，需要先 node build/build-sea.js
```

`selftest.js` 会在临时目录里自己造一条 **AES-128 加密的 HLS 流**，下载解密后与原始字节**逐字节比对**——这是验证解密链路最硬的方式。

## 常见问题

**按钮不出现**
先点播放让视频加载几秒。按钮只出现在宽度 ≥ 120px 的视频上（设置页可调）。iframe 内的视频需要等扩展注入完成。

**提示「没找到地址」**
页面用的是 blob 流且还没加载，先播几秒；或者在右下角「视频资源」面板里找已嗅探到的流。

**HLS 下载失败 / 密钥 403**
站点对密钥接口做了防盗链。设置页把引擎模式切成「尽量用 yt-dlp」再试。

**下完是 .ts 而不是 .mp4**
没装 ffmpeg。跑 `node scripts/setup.js`，或者手动把 `ffmpeg.exe` 放进 `server/bin/`，之后自动转封装。

**端口被占用**
服务会自动 +1 重试，按窗口里显示的端口更新扩展设置里的服务地址。

**Windows 双击 `start.bat` 闪退**
这个坑已经修过：`.bat` 必须是**纯 ASCII + CRLF**，用 UTF-8 中文 + LF 换行会让 cmd 在 `chcp` 生效前按系统码页读文件，中文变乱码还会吞掉相邻字节（`@echo off` 变成 `cho`），整个脚本崩掉。改动过就重新生成：

```bash
node scripts/make-bat.js   # 生成并断言纯 ASCII + CRLF
```

仍异常时用备用入口：右键 `start.ps1` →「使用 PowerShell 运行」，或终端里 `node server/src/server.js`，日志看 `logs/server.log`。

**扩展下载报 CORS / 连不上**
确认服务窗口还开着，扩展设置里的地址端口与窗口输出一致，然后重新「自动配对」。

## 已知限制

- 只支持 Chrome / Edge（MV3）；Firefox 需要改动。
- DRM（Widevine / PlayReady / FairPlay）加密的视频**不支持**——本项目做的是 HLS 的 AES-128 分片解密，不是破解 DRM。
- 直播流（无限 m3u8）只能抓到当前窗口的分片。
- 需要在页面里真实播放过，流才会被嗅探到。

## 免责声明

本项目仅供**个人学习与技术研究**。请只下载你拥有权利、或已获得授权的内容，并遵守目标网站的服务条款与所在地区的法律法规。使用者自行承担因使用本工具产生的一切后果。
