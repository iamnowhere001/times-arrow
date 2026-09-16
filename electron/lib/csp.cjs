/**
 * 内容安全策略（CSP）的**唯一定义处**。
 *
 * 为什么单独成一个模块：策略要在两个地方使用 ——
 *   1. 主进程 `electron/main.js` 通过 `onHeadersReceived` 下发响应头（开发 + 生产都覆盖）；
 *   2. `vite.config.mts` 在生产构建时把同一条策略写进 `index.html` 的 `<meta http-equiv>`。
 * 如果两处各写一份字符串，改了一处忘了另一处，就会出现「头部放行、meta 拦截」
 * 这种极难排查的问题（浏览器取交集，最严格者生效）。因此统一从这里取。
 *
 * 本文件用 CommonJS 导出，因为主进程是 CJS；`vite.config.mts` 用
 * `createRequire(import.meta.url)` 引入同一份，保证两条路径拿到的是同一字符串。
 */

/**
 * 生产环境策略。开发环境的差异见下方 CSP_DEV。
 *
 * 取舍说明：
 *  - `default-src 'none'`：默认全拒再逐项放行，比 `default-src 'self'` 更不容易漏项。
 *  - `img-src` / `media-src` 必须放行 `pm:`（原图与原视频，自定义特权协议）、
 *    `data:`（base64 缩略图兜底）、`blob:`（拖放降级预览）。
 *  - `style-src` 需要 `'unsafe-inline'`：index.html 里有内联 `<style>`，
 *    组件也大量使用 style 属性。样式注入的危害远低于脚本注入，这个让步可接受。
 *  - `script-src` 生产**不给** `'unsafe-inline'` —— 这正是 CSP 的主要价值所在。
 *  - `connect-src` 生产只需 `'self'`：AI 请求由主进程发出，渲染层不直接联网。
 *  - `object-src` / `base-uri` / `form-action` / `frame-ancestors` 全部封死，属零成本加固。
 */
const CSP_PROD = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' pm: data: blob:",
  "media-src 'self' pm: data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' pm:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * 开发环境的两个额外来源。
 * - `script-src` 追加 `'unsafe-inline'`：`@vitejs/plugin-react` 会注入一段内联的
 *   RefreshRuntime 前导脚本，没有它会直接白屏。
 * - `connect-src` 追加 http 与 ws：Vite 开发服务器与 HMR 的 WebSocket。
 * 这两项只影响 `npm run electron:dev`，打包产物永远走 CSP_PROD。
 */
const DEV_ORIGIN = 'http://127.0.0.1:3000';
const DEV_WS_ORIGIN = 'ws://127.0.0.1:3000';

const CSP_DEV = CSP_PROD.replace(
  "script-src 'self'",
  `script-src 'self' 'unsafe-inline' ${DEV_ORIGIN}`
).replace("connect-src 'self' pm:", `connect-src 'self' pm: ${DEV_ORIGIN} ${DEV_WS_ORIGIN}`);

/** 按是否开发模式取策略。判据与 createWindow() 里加载地址的判据保持一致。 */
function policyFor(isDev) {
  return isDev ? CSP_DEV : CSP_PROD;
}

/**
 * 供 `<meta http-equiv>` 使用的生产策略。
 *
 * 为什么不能直接复用 CSP_PROD：`frame-ancestors`（以及 `report-uri` / `sandbox`）
 * 在 meta 中**被规范明确忽略**，Chromium 会为此打印一条控制台告警：
 *   "The Content Security Policy directive 'frame-ancestors' is ignored
 *    when delivered via a <meta> element."
 * 这条告警本身无害（响应头那一份照常生效），但会污染控制台、干扰真实问题的排查，
 * 所以 meta 版本把它去掉。其余指令 meta 与头部等价，浏览器取交集后行为不变。
 */
const CSP_PROD_META = CSP_PROD.split('; ')
  .filter((directive) => !directive.startsWith('frame-ancestors'))
  .join('; ');

module.exports = { CSP_PROD, CSP_PROD_META, CSP_DEV, DEV_ORIGIN, DEV_WS_ORIGIN, policyFor };
