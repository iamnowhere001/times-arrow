import path from 'path';
import { createRequire } from 'module';
import { defineConfig, normalizePath, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 主进程是 CommonJS，这里用 createRequire 取同一份 CSP 定义，
// 保证「响应头下发的策略」与「构建期写进 index.html 的 meta」逐字一致。
// 变量名刻意避开 `require`：配置文件可能被以 CJS 形式求值，重名会直接报错。
const nodeRequire = createRequire(import.meta.url);
// 用 META 变体：`frame-ancestors` 在 <meta> 中被规范忽略，带上去只会多一条控制台告警
const { CSP_PROD_META } = nodeRequire('./electron/lib/csp.cjs') as { CSP_PROD_META: string };

/**
 * 主进程与渲染层共用的那份 CommonJS 模块的路径。
 * 与 `src/lib/media/photoHash.ts` 里的相对导入指向同一个文件。
 */
const SHARED_CJS_PATH = normalizePath(path.resolve(import.meta.dirname, 'electron/lib/dhash.cjs'));

/**
 * 把主进程那份 CommonJS 的共享模块（`electron/lib/dhash.cjs`）转成 ESM，供渲染层具名导入。
 *
 * ## 为什么必须有这个插件
 *
 * Vite 的 CJS 互操作只覆盖 `node_modules` 里的依赖（走依赖预构建）；
 * **项目源码里的 `.cjs` 会被原样发给浏览器**。浏览器按 ESM 解析它，
 * 而文件里一条 `export` 都没有，于是 `import { HASH_WIDTH } from '.../dhash.cjs'`
 * 在链接阶段直接失败：`does not provide an export named 'HASH_WIDTH'`。
 * （注意 URL 上的 `?import` 只是 Vite 的请求标记，不代表它做了 CJS→ESM 转换；
 * 也不能靠给 `esbuild.include` 加 `.cjs` 解决 —— 那一步不做模块格式转换。）
 *
 * ## 为什么不直接把 dhash 改写成 ESM
 *
 * 主进程是 CommonJS，`require()` 一份 ESM 要额外依赖 Node 的 `require(esm)`
 * （多一个运行时版本约束）；而「同一算法只有一份实现」是本项目刻意守住的约束
 * （见 `tests/unit/dhash.test.ts` 的跨入口一致性断言）。所以这里选择
 * 在构建期做一次机械转换，而不是把实现拆成两份。
 *
 * ## 转换方式
 *
 * 把原始 CJS 源码原封不动地包进一个提供 `module` / `exports` 的 IIFE
 * （纯粹搬壳，不含任何算法知识），再按 `module.exports` 的**实际键名**生成具名导出。
 * 键名在配置求值时由 Node 直接 `require` 该文件得到，因此实现里增删导出项
 * 不需要同步改这里，也就不会出现「声明与实现漂移」。
 *
 * 前置约束：被包裹的模块不能有 `require()` 调用 —— dhash.cjs 是纯函数模块，没有依赖。
 *
 * ## 为什么只作用于 dev（`apply: 'serve'`）
 *
 * 生产构建走 rolldown，它**自带** CJS 互操作（按扩展名识别 `.cjs` 并解析具名导出），
 * 根本不需要转换；反过来，若在构建期也注入 `export`，rolldown 会按扩展名把该文件
 * 判定为 CJS 模块，然后报「Cannot use export statement outside a module」。
 * 所以两边各用各的原生能力：dev 靠本插件，build 靠 rolldown。
 */
function sharedCjsAsEsm(): Plugin {
  // 配置求值时先 require 一次：既拿到导出键名，也让实现本身出错时在启动阶段就暴露
  const exportNames = Object.keys(nodeRequire(SHARED_CJS_PATH) as Record<string, unknown>).filter(
    (name) => name !== '__esModule' && /^[A-Za-z_$][\w$]*$/.test(name),
  );

  const namedExports = exportNames
    .map((name) => `export const ${name} = sharedModule.exports.${name};`)
    .join('\n');

  return {
    name: 'photominder-shared-cjs-as-esm',
    // 只在 dev 生效：构建期由 rolldown 自带的 CJS 互操作负责（见上方注释）
    apply: 'serve',
    // 必须 pre：否则会先被其它插件按「没有 ESM 导出的模块」处理掉
    enforce: 'pre',
    transform(source, id) {
      // 只认这一个文件；id 可能带 `?import` / `?t=` 等查询串
      if (normalizePath(id.split('?')[0]) !== SHARED_CJS_PATH) return null;

      return [
        '// 由 vite.config.mts 的 sharedCjsAsEsm 插件生成，请勿手改',
        'const sharedModule = { exports: {} };',
        '(function (module, exports) {',
        source,
        '})(sharedModule, sharedModule.exports);',
        namedExports,
        'export default sharedModule.exports;',
      ].join('\n');
    },
  };
}

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
    plugins: [react(), tailwindcss(), sharedCjsAsEsm(), injectCspMeta()],
    resolve: {
      alias: {
        // AI 密钥等敏感配置一律由主进程读取 .env，不再注入渲染进程
        '@': path.resolve(import.meta.dirname, 'src'),
      }
    }
});
