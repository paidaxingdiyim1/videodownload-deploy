# iPhone 端下载方案

> 服务器地址：`http://192.168.5.22:8765`（手机需与服务器同一 Wi-Fi）
> 访问码：`c3be1b59181e341893900bdaaf87e56a`（server/config.json 的 token）

---

## 为什么手机分享链接容易失败

| 网站 | 手机分享的 URL | 服务端直接解析 | 原因 |
|---|---|---|---|
| missav | `missav.ai/cn/xxx` | ❌ 403 | Cloudflare 页面级防护 |
| hanime1 | `hanime1.me/watch?v=3071` | ❌ 403 | Cloudflare 页面级防护 |

**但手机 Safari 里页面已经过了 Cloudflare**——所以正确做法是：**在页面内部解析出真实直链，再交给服务器下载**。

---

## 方案一：手机网页版（最省事，适合日常）

iPhone Safari 打开：

```
http://192.168.5.22:8765/m?token=c3be1b59181e341893900bdaaf87e56a
```

粘贴分享文案 → 开始下载 → 看进度 → 点文件存手机。

**局限**：它只能处理"服务器能直接解析的链接"；missav / hanime1 这类 Cloudflare 站会失败（403）。

---

## 方案二：iOS 快捷指令「页面内解析」（推荐，两站特化）

在 Safari 页面里运行 JS，直接从已加载的页面数据里拿最高画质直链。

### 配置（一次性，约 5 分钟）

**准备**：设置 → 快捷指令 → 打开「允许运行脚本」（在"高级"里）

1. 打开「快捷指令」App → 右上角 **+** 新建
2. 添加操作：搜索 **「在网页上运行 JavaScript」** → 添加
   - 把 `ios/shortcut-web-js.js` 的**全部内容**粘贴进去
3. 添加操作：搜索 **「URL 编码」** → 添加
   - 输入：选「JavaScript 在网页上运行」的结果
   - 模式：**URL 查询参数**
4. 添加操作：搜索 **「文本」** → 添加，内容填：

   ```
   http://192.168.5.22:8765/api/quick-download?token=c3be1b59181e341893900bdaaf87e56a&url=
   ```

   然后把上一步「URL 编码」的结果**插到文本末尾**（点文本 → 键盘上方变量 → 选 URL 编码结果）
5. 添加操作：搜索 **「获取 URL 内容」** → 添加
   - URL：选上一步「文本」
   - 方法：GET（默认）
6. 给这个快捷指令改名：**网页视频下载**
7. 点快捷指令的详情（ⓘ）→ 打开 **「在分享表单中显示」**，接收类型勾选 **URL** 和 **文本**

### 使用

1. Safari 打开视频页（missav / hanime1 / 普通网页）
2. **等视频播放 2~3 秒**（让 hls.js 把 m3u8 拉起来）
3. 点 Safari 分享 → **网页视频下载**
4. 服务器开始下载 → 打开 `http://192.168.5.22:8765/m` 看进度

---

## 两站特化原理

### missav（surrit / hls.js）

- 页面播放时 hls.js 会请求 `https://surrit.com/<uuid>/720p/video.m3u8`（当前画质）
- 脚本从 `performance.getEntriesByType('resource')` 拿到这个 URL
- **自动转成 master**：`https://surrit.com/<uuid>/playlist.m3u8`
- master 里有 360p / 480p / 720p / **1080p**，服务端按 BANDWIDTH 自动选最高

> 服务端也做了同样的转换（`cfdl.js` 的 `toMasterPlaylist`），所以**电脑扩展点按钮下载也会自动 1080p**。

### hanime1（下载页多画质）

- watch 页里有一个「下载」入口，点进去是下载页，列出不同画质的 mp4
- 脚本在页面内：找「下载」链接 → 同步 XHR 抓下载页（同源、带 cookie、已过 Cloudflare）
  → 正则提取所有 `vdownload.hembed.com/*.mp4` 直链 → 按 1080p > 720p > 480p 取最高
- 如果页面没有下载链接，会按 `watch?v=ID` 自动构造 `download?v=ID` 兜底

---

## 自动最高画质覆盖范围

| 场景 | 实现 | 状态 |
|---|---|---|
| missav / surrit HLS | 子列表自动转 master，按 BANDWIDTH 选最高 | ✅ 1080p |
| hanime1 下载页 | 页面内解析全部 mp4，按 1080p>720p>480p | ✅ 1080p |
| 普通 HLS | `pickVariant` 按 bandwidth 降序取第一 | ✅ 最高 |
| DASH | 按 bandwidth 降序取第一 | ✅ 最高 |
| yt-dlp（抖音/B站等） | `-f bv*+ba/b` | ✅ 最高 |
| 扩展嗅探到子列表 | 服务端 `toMasterPlaylist` 转 master | ✅ 最高 |

---

## 其他：Scriptable（分享菜单纯提交）

如果只是"快速丢链接"，用 `ios/scriptable-submit.js`（见上一版说明）。它不解析页面，只提交链接，等同于手机网页版。

---

## 排查

- **没识别到直链**：先在 Safari 里让视频播放 2~3 秒，再运行快捷指令
- **server 返回 token 无效**：检查配置里的 token 是否与服务端 `server/config.json` 一致
- **403 / 下载失败**：看服务器 `logs/tasks.log`，或手机网页版的失败原因
