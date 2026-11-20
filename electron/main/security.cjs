/**
 * 内容安全策略（CSP）安装。
 *
 * ## 为什么需要它
 *
 * P0 把「主进程能读哪些文件」收紧了，但渲染层自身仍是一块可被注入的执行环境 ——
 * 图库里任何一张图片都可能是精心构造的 SVG。CSP 是唯一能在渲染层内部收敛
 * 「注入之后还能做什么」的机制：即便有内容被当作脚本执行，也无法外联、
 * 无法加载远程代码、无法把数据 POST 出去。
 *
 * ## 两条注入路径，互为补充
 *
 * 1. `onHeadersReceived` —— 覆盖开发（http://127.0.0.1:3000）与生产（file://）
 *    两种加载方式，且能按环境下发不同策略（开发必须给 Vite 让路）；
 * 2. `index.html` 里的 `<meta http-equiv>` —— 由 Vite 在生产构建时注入
 *    （见 `vite.config.mts` 的 `injectCspMeta`），防止将来更换加载方式
 *    （改成 loadFile、自定义协议等）时头部策略被漏掉。
 *
 * 两处同时存在时浏览器取交集（最严格者生效），所以 meta 只需覆盖生产场景。
 *
 * 策略本身定义在 `../lib/csp.cjs`，与构建期注入 meta 时用的是同一份字符串，
 * 避免两处各写一份导致的漂移。
 */
const { session } = require('electron');
const { policyFor } = require('../lib/csp.cjs');

/**
 * @param {object} deps
 * @param {object} deps.logger
 */
function createCspInstaller({ logger }) {
  /** 必须在创建窗口之前调用：晚于首次导航就会漏掉第一个文档 */
  function install() {
    const isDev = Boolean(process.env.ELECTRON_START_URL);
    const policy = policyFor(isDev);

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      // 只给「文档本身」注入 CSP，不对 pm:// 返回的图片 / 视频重复注入 ——
      // 那些响应的 Content-Type 不是文档，注入头部既无意义也会干扰 Range 请求。
      const isDocument =
        details.resourceType === 'mainFrame' ||
        details.resourceType === 'subFrame' ||
        /text\/html/i.test(details.responseHeaders?.['Content-Type']?.[0] ?? '');
      if (!isDocument) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }

      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [policy],
        },
      });
    });

    logger.info(`[csp] ${isDev ? 'development' : 'production'} policy installed`);
  }

  return { install };
}

module.exports = { createCspInstaller };
