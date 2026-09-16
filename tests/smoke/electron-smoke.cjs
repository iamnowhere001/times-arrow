/**
 * 端到端冒烟：加载真实 main.js，启动真实 Electron，检查四件事 ——
 *   1. CSP 有没有误伤应用自身（控制台出现 CSP 违规）
 *   2. 渲染进程有没有报错
 *   3. 页面是不是真的渲染出来了（#root 有内容、preload 暴露了 electronAPI）
 *   4. 主进程有没有起来（`require('electron')` 拿到的是不是真 API）
 *
 * 这是唯一能验证「CSP 策略没有把应用搞坏」的手段 —— 静态断言做不到。
 *
 * 运行：npm run test:smoke
 *
 * ## 两种失败模式，脚本会自己说清楚
 * - **拿不到 Electron API**（`app` 是 undefined）：说明 Electron 以 node 模式启动了。
 *   常见诱因是环境注入了 `ELECTRON_RUN_AS_NODE`，或把本命令与 `npm run xxx`
 *   串在同一条 shell 命令里（npm 会污染子进程环境）。**分两次调用即可。**
 * - **窗口一直不加载**：多半是本机无法初始化 Chromium 沙箱
 *   （打印 `sandbox initialization failed: Operation not permitted`）。
 *   开发环境下加 `PHOTOMINDER_DISABLE_SANDBOX=1` 走逃生口。
 */
const electron = require('electron');
const path = require('path');

const app = electron?.app;

// 把「看不懂的 TypeError」换成可操作的提示（见文件头两种失败模式）
if (!app || typeof app.on !== 'function') {
  console.error('[smoke] 无法加载 Electron 主进程 API —— Electron 似乎以 node 模式启动了。');
  console.error('[smoke] 请确认：① 本命令没有和 `npm run xxx` 串在同一条 shell 命令里；');
  console.error('[smoke]          ② 环境里没有注入 ELECTRON_RUN_AS_NODE。');
  process.exit(2);
}

// 从本文件位置回推项目根，避免依赖 cwd
const APP_DIR = path.resolve(__dirname, '../..');
const violations = [];
const errors = [];
let windowLoaded = false;

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (...args) => {
    const first = args[0];
    const message =
      first && typeof first === 'object' && 'message' in first
        ? first.message
        : String(args[2] ?? '');
    const level = first && typeof first === 'object' ? first.level : args[1];
    const text = String(message ?? '');
    if (/Content Security Policy|Refused to (load|execute|connect|apply)/i.test(text)) {
      violations.push(text);
      console.log('[CSP-VIOLATION]', text);
    } else if (level === 'error' || level === 3) {
      errors.push(text);
      console.log('[console.error]', text);
    }
  });
  win.webContents.on('did-finish-load', async () => {
    console.log('[probe] did-finish-load');
    windowLoaded = true;
    try {
      const title = await win.webContents.executeJavaScript('document.title');
      const rootHtml = await win.webContents.executeJavaScript(
        'document.getElementById("root") ? document.getElementById("root").innerHTML.length : -1'
      );
      const hasApi = await win.webContents.executeJavaScript(
        'Boolean(window.electronAPI && window.electronAPI.readFile)'
      );
      console.log(
        '[probe] title=',
        title,
        '| #root 内容长度=',
        rootHtml,
        '| electronAPI 可用=',
        hasApi
      );
      if (rootHtml <= 0) errors.push('渲染层没有产出任何 DOM');
      if (!hasApi) errors.push('preload 未暴露 electronAPI');
    } catch (e) {
      errors.push('executeJavaScript 失败: ' + e.message);
    }
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    console.log('[probe] did-fail-load', code, desc, url)
  );
});

require(path.join(APP_DIR, 'electron/main.js'));

setTimeout(() => {
  console.log('\n===== 冒烟结果 =====');
  console.log('CSP 违规:', violations.length);
  console.log('控制台错误:', errors.length);
  errors.forEach((e) => console.log('  - ' + e.slice(0, 200)));

  // 窗口完全没加载起来：多半是沙箱初始化失败（渲染进程根本没起来），
  // 这时「CSP 违规 0」是假阴性 —— 页面压根没跑，当然没有违规。必须显式失败。
  if (!windowLoaded) {
    console.error('\n[smoke] 窗口始终没有加载完成，无法判定 CSP 是否误伤应用。');
    console.error('[smoke] 若日志里出现 "sandbox initialization failed: Operation not permitted"，');
    console.error('[smoke] 说明本机无法初始化 Chromium 沙箱，请加 PHOTOMINDER_DISABLE_SANDBOX=1 重跑。');
    app.exit(3);
    return;
  }

  app.exit(violations.length === 0 && errors.length === 0 ? 0 : 1);
}, 15000);
