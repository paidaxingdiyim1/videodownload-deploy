// ============================================================
// 网页视频下载 · Scriptable 脚本（iPhone / iPad 分享菜单入口）
//
// 安装：
//   1. App Store 搜「Scriptable」安装（免费，Apple 官方推荐脚本工具）
//   2. 打开 Scriptable → 右上角「+」→ 粘贴本脚本全部内容
//   3. 点左上角标题改名为「视频下载」→ 右上角 Done
//
// 使用（任选其一）：
//   A. 分享菜单：抖音/快手/B站/missav 点「分享」→ 更多 → Scriptable → 选「视频下载」
//   B. 主屏幕：先把分享文案复制到剪贴板，再点主屏幕上的 Scriptable 脚本图标
//
// 说明：下载在服务器上完成，手机只负责提交链接；进度和文件在
//       http://192.168.5.22:8765/m 查看
// ============================================================

const SERVER = 'http://192.168.5.22:8765';          // 服务器地址（手机需连同一 Wi-Fi）
const TOKEN = 'c3be1b59181e341893900bdaaf87e56a';   // 访问码（server/config.json 的 token）

/** 从整段分享文案里提取第一个 http(s) 链接（到空白或中文标点为止） */
function extractUrl(s) {
  const i = s.indexOf('http');
  if (i < 0) return '';
  const tail = s.slice(i);
  const stops = [' ', '\n', '\r', '\t', '，', '。', '；', '、', '！', '？', '）', '】', '」', '』', '"', "'", '“', '”'];
  let end = tail.length;
  for (const ch of stops) {
    const p = tail.indexOf(ch);
    if (p >= 0 && p < end) end = p;
  }
  return tail.slice(0, end);
}

function alertBox(title, message) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addCancelAction('好');
  return a.present();
}

/** 收集分享内容：不同入口拿到的东西不一样，逐个兜底 */
function collectInput() {
  if (args.plainTexts && args.plainTexts.length) return args.plainTexts.join('\n');
  if (args.urls && args.urls.length) return args.urls.join('\n');
  if (args.queryParameters && args.queryParameters.text) return args.queryParameters.text;
  if (args.shortcutParameter) return String(args.shortcutParameter);
  return Pasteboard.paste() || '';
}

const raw = collectInput();
const url = extractUrl(raw);
if (!url) {
  await alertBox(
    '没识别到链接',
    '请在「分享菜单」里使用本脚本，或先复制分享文案到剪贴板再运行。\n\n当前拿到：' + (raw || '（空）').slice(0, 150)
  );
  Script.complete();
} else {
  const req = new Request(SERVER + '/api/download');
  req.method = 'POST';
  req.timeoutInterval = 20;
  req.headers = {
    'Content-Type': 'application/json',
    'X-Auth-Token': TOKEN,
  };
  req.body = JSON.stringify({
    url: url,
    title: '',
    kind: 'auto',
    mode: 'auto',
    referer: SERVER,
  });

  let res = null;
  let err = '';
  try {
    res = await req.loadJSON();
  } catch (e) {
    err = String((e && e.message) || e);
  }

  const n = new Notification();
  if (res && res.ok) {
    n.title = '已提交下载';
    n.body = (res.task && res.task.title) ? res.task.title : '服务器正在下载，可在手机网页查看进度';
  } else {
    n.title = '提交失败';
    n.body = err || (res && res.error) || '未知错误（检查手机是否和服务器同一 Wi-Fi）';
  }
  n.schedule();

  // 如果是主屏幕运行（没有分享内容），额外弹个结果框，避免看不到通知
  if (!(args.plainTexts && args.plainTexts.length) && !(args.urls && args.urls.length)) {
    await alertBox(n.title, n.body + '\n\n链接：' + url);
  }

  Script.complete();
}
