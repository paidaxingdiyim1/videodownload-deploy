/* Cloudflare 强防护站（surrit.com 等）下载引擎：调用 Python(curl_cffi) 脚本。
 * 参考 missav-dlp-web：Firefox TLS 指纹 + 跨站 header（Sec-Fetch-Site: cross-site），
 * 无需 cookie。Node 原生 fetch / yt-dlp --impersonate chrome 都过不了这类站。 */
const { execFile } = require('child_process');
const path = require('path');
const config = require('./config');

function download(task, ctx) {
  return new Promise((resolve, reject) => {
    const py = path.join(config.ROOT, 'server', 'venv', 'bin', 'python');
    const script = path.join(config.ROOT, 'server', 'src', 'dl_cf.py');
    const tmpOut = ctx.tmpFile + '.cf.mp4';
    const args = [script, '--url', task.url, '--referer', task.referer || '', '--out', tmpOut];

    let settled = false;
    const child = execFile(py, args, { timeout: 0, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (settled) return;
      settled = true;
      if (err) {
        const msg = String(stderr || stdout || err.message).trim();
        return reject(new Error(msg || '浏览器指纹下载失败'));
      }
      const m = String(stdout || '').match(/OK\s+(.+)/);
      const outPath = m ? m[1].trim() : tmpOut;
      const ext = /\.ts$/i.test(outPath) ? 'ts' : 'mp4';
      resolve({ file: outPath, ext });
    });

    // 实时解析 "PROGRESS x" 上报进度
    let pbuf = '';
    if (child.stdout) {
      child.stdout.on('data', (d) => {
        pbuf += d.toString();
        let m;
        while ((m = pbuf.match(/PROGRESS\s+(\d+)/))) {
          const pct = parseInt(m[1], 10);
          if (ctx && ctx.report) ctx.report({ progress: Math.min(100, pct) });
          pbuf = pbuf.slice(m.index + m[0].length);
        }
      });
    }

    // 任务取消时杀掉子进程
    if (ctx && ctx.signal) {
      const onAbort = () => { try { child.kill('SIGKILL'); } catch (_) {} };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

module.exports = { download };
