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
    // 三条静态断言（dhash / photoTime / placesData）会遍历整个 src 逐文件读源码，
    // worker 全开时 CPU 竞争会把它们推过默认 5s，误报成断言失败。放宽超时只针对
    // 「慢但确定性」的扫描，不改变任何断言口径；普通纯函数用例仍是毫秒级。
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
});
