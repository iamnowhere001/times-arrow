// ESLint 扁平配置（flat config），只负责 JS / CJS / MJS。
//
// TypeScript 源码（.ts / .tsx / .mts）由 oxlint 检查（见 .oxlintrc.json 与 `npm run lint:ts`），
// 这里显式忽略它们，确保两层不重叠、也不互相打架。
//
// 之所以这样分工：本项目的 TypeScript 是 7.x（原生移植版），typescript-eslint 的 peer
// 范围尚未覆盖，过去只能退化为「只检查 JS/CJS」。oxlint 自带 TS 解析器，不需要
// typescript-eslint，因此把 TS/TSX 交给它，ESLint 继续守住主进程与构建脚本。
//
// 规则取舍：error 只给确定是 bug 或会破坏安全边界的；纯风格交给 Prettier。

import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/** 共用规则：JS / CJS 侧的确定性错误 */
const sharedRules = {
  // 确定是 bug 的：留 error
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-unsafe-negation': 'error',
  'no-constant-binary-expression': 'error',
  'no-self-assign': 'error',
  'no-unreachable': 'error',
  'no-fallthrough': 'error',

  // 值得改但不影响正确性的：降级为 warn，避免淹没真实问题
  'no-empty': ['warn', { allowEmptyCatch: true }],
};

export default [
  // ------------------------------------------------------------------ 忽略
  {
    ignores: [
      'dist/**',
      'release/**',
      'node_modules/**',
      '**/*.d.ts',
      // 生成物：地名表与陆地掩码由脚本产出，格式不受我们控制
      'src/lib/geo/places.ts',
      'src/lib/geo/landMask.ts',
      // TS 源码由 oxlint 负责，ESLint 不参与，避免同一文件被两层重复检查
      '**/*.ts',
      '**/*.tsx',
      '**/*.mts',
    ],
  },

  // ------------------------------------------------------- 通用（仅 JS / CJS / MJS）
  js.configs.recommended,
  { rules: sharedRules },

  // ------------------------------------------------- 主进程 / 构建（Node CJS）
  {
    files: ['electron/**/*.{js,cjs}', 'build/**/*.js', 'tests/**/*.cjs', '*.cjs'],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'commonjs',
    },
    rules: {
      // 主进程里 console 是日志出口（logger 内部实现），不算问题
      'no-console': 'off',
      // 打开它（而非删掉代码里现有的 eslint-disable 注释）：那些注释标记的是
      // 「此处串行 await 是刻意的」（如逐项落盘后才能探测同名），
      // 规则不启用的话注释就是失效的噪音，作者表达的意图也随之丢失。
      // 其余 await-in-loop 以 warn 提示，属「值得看一眼但不影响正确性」。
      'no-await-in-loop': 'warn',
    },
  },

  // 配置文件本身（.mjs 就是本文件）
  {
    files: ['*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // 必须放最后：关掉所有与 Prettier 冲突的格式规则
  prettier,
];
