import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * 单测配置：只跑纯函数层的测试（tests/unit）。
 *
 * 主进程的集成测试与端到端冒烟不走这里 —— 它们需要拦截 `require('electron')`
 * 或真的启动 Electron，用独立的 npm script 跑更直接（见 package.json 的
 * `test:main` / `test:smoke`）。
 */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
});
