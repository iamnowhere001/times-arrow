/**
 * 轻量日志器（主进程）。
 * - debug / info 仅在未打包（开发）时输出，打包后静默，避免把磁盘完整路径等调试信息写入发布产物；
 * - warn / error 始终输出，便于排查。
 */
let app;
try {
  ({ app } = require('electron'));
} catch {
  app = undefined;
}

const isDev = () => {
  try {
    return !app || !app.isPackaged;
  } catch {
    return true;
  }
};

const logger = {
  debug(...args) {
    if (isDev()) console.log(...args);
  },
  info(...args) {
    if (isDev()) console.info(...args);
  },
  warn(...args) {
    console.warn(...args);
  },
  error(...args) {
    console.error(...args);
  },
};

module.exports = logger;
