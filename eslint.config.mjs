// ESLint 扁平配置（flat config）。
//
// 首次接入的取舍：**宽松基线，只报错不阻断**。
// 这个仓库此前没有任何 lint，如果一上来开满规则，几千条历史告警会把真实问题淹没。
// 因此这里的划分是：
//   - error：确定是 bug 或会破坏安全边界的（hooks 调用规则、未定义变量、重复键…）
//   - warn ：值得改但不影响正确性的（未使用变量、any、依赖数组不全…）
//   - off  ：纯风格问题一律交给 Prettier，不在这里吵
//
// ## 为什么 typescript-eslint 是「可选」的
//
// 本项目的 TypeScript 是 7.x（原生移植版），而 typescript-eslint 的 peer 范围是
// `typescript >=4.8.4 <6.1.0` —— 生态尚未跟上。装不上时如果整个配置直接抛错，
// 就连 JS 侧也检查不了，得不偿失。
//
// 所以这里做能力探测：装得上就开类型感知规则；装不上就退化为只检查 JS/CJS。
// **退化后仍然有实际价值** —— 主进程（路径白名单、CSP、IPC 兜底这些安全边界所在）
// 与构建脚本都是 JS/CJS，本来就在这一侧。

import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

let tseslint = null;
try {
  tseslint = (await import('typescript-eslint')).default;
} catch {
  console.warn(
    '[eslint] typescript-eslint 不可用（本项目的 TypeScript 7 超出其 peer 范围），' +
      '本次仅检查 JS/CJS：主进程 / 构建脚本 / 配置文件。'
  );
}

/** 共用规则：无论是否启用 TS 解析都用这一套 */
const sharedRules = {
  // 确定是 bug 的：留 error
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-unsafe-negation': 'error',
  'no-constant-binary-expression': 'error',
  'no-self-assign': 'error',
  'no-unreachable': 'error',
  'no-fallthrough': 'error',
  'react-hooks/rules-of-hooks': 'error',

  // 值得改但不影响正确性的：降级为 warn，避免淹没真实问题
  'react-hooks/exhaustive-deps': 'warn',
  'no-empty': ['warn', { allowEmptyCatch: true }],

  // 纯风格：交给 Prettier
  'prettier/prettier': 'off',
};

/** TS 专属规则：只有装上 typescript-eslint 才生效 */
const tsRules = {
  '@typescript-eslint/no-unused-vars': [
    'warn',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
    },
  ],
  '@typescript-eslint/no-explicit-any': 'warn',
  // 本仓库有大量 `catch {}` 的显式忽略与 `any` 边界，先不阻断
  '@typescript-eslint/no-unused-expressions': 'warn',
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
      // 没有 TS 解析器时，TS/TSX 源码无法被解析，直接跳过（否则会报一堆语法错）
      ...(tseslint ? [] : ['**/*.ts', '**/*.tsx', '**/*.mts']),
    ],
  },

  // ------------------------------------------------------- 通用（全部文件）
  js.configs.recommended,
  ...(tseslint ? tseslint.configs.recommended : []),
  {
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: { ...sharedRules, ...(tseslint ? tsRules : {}) },
  },

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

  // ------------------------------------------------------------ 渲染层（TS）
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // 渲染层不允许 console：统一走 @/lib/logger
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // ------------------------------------------------------- 单测（Node + TS）
  {
    files: ['tests/unit/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // 配置文件本身（.mts 由 Vite 加载，.mjs 就是本文件）
  {
    files: ['*.mts', '*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // 必须放最后：关掉所有与 Prettier 冲突的格式规则
  prettier,
];
