import path from 'path';
import { createRequire } from 'module';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 主进程是 CommonJS，这里用 createRequire 取同一份 CSP 定义，
// 保证「响应头下发的策略」与「构建期写进 index.html 的 meta」逐字一致。
// 变量名刻意避开 `require`：配置文件可能被以 CJS 形式求值，重名会直接报错。
const nodeRequire = createRequire(import.meta.url);
// 用 META 变体：`frame-ancestors` 在 <meta> 中被规范忽略，带上去只会多一条控制台告警
const { CSP_PROD_META } = nodeRequire('./electron/lib/csp.cjs') as { CSP_PROD_META: string };

/**
 * 生产构建时把 CSP 写进 index.html 的 `<meta http-equiv>`。
 *
 * 为什么主进程已经下发响应头了还要 meta：响应头依赖 `onHeadersReceived` 这条链路，
 * 一旦将来更换加载方式（改成 `loadFile`、或把渲染层挪到自定义协议上），头部策略
 * 有可能被漏掉，而 meta 是随文档走的、不依赖主进程。两者同时存在时浏览器取交集，
 * 因此 meta 只需覆盖生产场景 —— 开发环境交给主进程按环境下发（dev 需要放行 Vite）。
 *
 * 只用 `apply: 'build'`：dev 模式由主进程的 CSP_DEV 负责，注入 CSP_PROD 会白屏。
 */
function injectCspMeta(): Plugin {
  return {
    name: 'photominder-inject-csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        /<head(\s[^>]*)?>/i,
        (match) => `${match}\n    <meta http-equiv="Content-Security-Policy" content="${CSP_PROD_META}" />`,
      );
    },
  };
}

export default defineConfig({
    base: './',
    server: {
      port: 3000,
      // 只监听回环地址。原先的 '0.0.0.0' 会把开发服务器暴露到局域网，
      // 而这是一个本地桌面应用的调试服务，没有任何被外部访问的理由。
      // 注意：`electron:dev` 里的 ELECTRON_START_URL 必须同步用 127.0.0.1，
      // 否则在 localhost 解析到 ::1 的机器上会连不上只绑了 IPv4 的服务器。
      host: '127.0.0.1',
      // Electron 的 ELECTRON_START_URL 固定指向 3000（见 package.json 的 electron:dev），
      // 端口被占用时必须直接失败，否则 Vite 会静默换到 3001，而 Electron 仍连 3000 的旧进程
      strictPort: true,
    },
    plugins: [react(), tailwindcss(), injectCspMeta()],
    resolve: {
      alias: {
        // AI 密钥等敏感配置一律由主进程读取 .env，不再注入渲染进程
        '@': path.resolve(import.meta.dirname, 'src'),
      }
    }
});
