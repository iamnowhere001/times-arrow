/**
 * 主进程集成测试运行器。
 *
 * 为什么不再把 12 条 `node tests/main-process/*.test.cjs` 硬编码进 package.json：
 *   1. 新增测试文件必须记得改脚本，否则「加了测试但没跑」；
 *   2. 文件一多，脚本行会变成维护负担；
 *   3. agent 需要一个可预测的入口：`npm run test:main` 就是「跑这个目录下所有测试」。
 *
 * 发现规则：同目录下所有 `*.test.cjs`，按文件名排序，**每个文件独立进程**。
 * 独立进程不是洁癖：harness 会在同一进程里缓存 `require(main.js)` 的结果，
 * 多个存储 / 迁移测试放进同一进程会互相污染。
 *
 * 用法：
 *   npm run test:main                 # 跑全部
 *   npm run test:main -- updater      # 只跑文件名包含 updater 的
 *   node tests/main-process/run.cjs ipc
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const APP_ROOT = path.resolve(__dirname, '../..');
const filter = process.argv.slice(2).join(' ').trim().toLowerCase();

const files = fs
  .readdirSync(__dirname)
  .filter((name) => name.endsWith('.test.cjs'))
  .filter((name) => (filter ? name.toLowerCase().includes(filter) : true))
  .sort();

if (files.length === 0) {
  console.error(`未找到匹配的主进程测试${filter ? `：${filter}` : ''}`);
  process.exit(1);
}

const failed = [];
const startedAt = Date.now();

for (const file of files) {
  const full = path.join(__dirname, file);
  console.log(`\n──────── ${file} ────────`);
  const result = spawnSync(process.execPath, [full], {
    cwd: APP_ROOT,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    console.error(`无法启动 ${file}: ${result.error.message}`);
    failed.push(file);
    continue;
  }
  if (result.status !== 0) failed.push(file);
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\n════════ 主进程测试汇总 ════════`);
console.log(
  `文件 ${files.length} 个 · 通过 ${files.length - failed.length} 个 · 失败 ${failed.length} 个 · ${elapsed}s`
);

if (failed.length) {
  console.log(`失败文件：\n${failed.map((name) => `  - ${name}`).join('\n')}`);
  process.exit(1);
}
