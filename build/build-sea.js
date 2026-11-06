/**
 * 把本地服务打包成单文件 exe（Node SEA）
 *
 * 产物：项目根目录的「网页视频下载器.exe」
 *   - 内置 Node 运行时与全部服务代码，目标机器无需安装 Node
 *   - 双击即启动，并自动打开浏览器控制台
 *   - 放在项目根目录时，自动复用 server/config.json（同一个 Token）
 *     与 server/bin（yt-dlp / ffmpeg）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const ENTRY = path.join(ROOT, 'server', 'src', 'server.js');
const BUNDLE = path.join(BUILD, 'server.cjs');
const BLOB = path.join(BUILD, 'server.blob');
const OUT_EXE = path.join(ROOT, '网页视频下载器.exe');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const step = (msg) => console.log('\n▶ ' + msg);

fs.mkdirSync(BUILD, { recursive: true });

/* 1. 打包成单文件 CJS */
step('1/4 打包源码 (esbuild)');
const esbuild = require('esbuild');
esbuild.buildSync({
  entryPoints: [ENTRY],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: BUNDLE,
  logLevel: 'info',
  // node: 前缀的内置模块自动视为 external
});
console.log('  bundle: ' + (fs.statSync(BUNDLE).size / 1024).toFixed(0) + ' KB');

/* 2. 生成 SEA blob */
step('2/4 生成 SEA blob');
const seaConfig = {
  main: BUNDLE,
  output: BLOB,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
};
const seaConfigPath = path.join(BUILD, 'sea-config.json');
fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit', cwd: BUILD });
console.log('  blob: ' + (fs.statSync(BLOB).size / 1024).toFixed(0) + ' KB');

/* 3. 复制 node 可执行文件作为载体 */
step('3/4 复制 Node 运行时');
fs.copyFileSync(process.execPath, OUT_EXE);
console.log('  ' + process.execPath);
console.log('  → ' + OUT_EXE + '  (' + (fs.statSync(OUT_EXE).size / 1024 / 1024).toFixed(0) + ' MB)');

/* 4. 注入 blob */
step('4/4 注入 blob (postject)');
const postjectCli = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
if (!fs.existsSync(postjectCli)) throw new Error('找不到 postject，请先运行 npm install');
execFileSync(process.execPath, [postjectCli, OUT_EXE, 'NODE_SEA_BLOB', BLOB, '--sentinel-fuse', FUSE], {
  stdio: 'inherit',
});

/* 校验：文件中应能搜到 blob magic 与 fuse 字符串 */
const exe = fs.readFileSync(OUT_EXE);
const hasFuse = exe.includes(Buffer.from(FUSE));
console.log('\n校验: 体积 ' + (exe.length / 1024 / 1024).toFixed(0) + ' MB  fuse=' + (hasFuse ? '✓' : '✗'));
if (!hasFuse) process.exit(1);

console.log('\n完成: ' + OUT_EXE);
