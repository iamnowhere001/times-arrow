/**
 * 「数据资产」专项回归测试（2026-11-05）。
 *
 * 覆盖四件事：内容指纹与路径无关、v1 → v2 结构迁移、写盘前配置滚动备份、
 * compute-file-ids 的路径授权边界。
 *
 * ⚠️ 独立成一个文件 / 一个进程：harness 的 loadMainProcess() 在同一进程里
 * 不能二次调用（Node 模块缓存）。v1 配置必须在 require(main.js) **之前**放好，
 * 迁移跑在 app.on('ready') 的 Promise 链里，因此断言前要等一个宏任务。
 *
 * 运行：npm run test:main
 */
const fs = require('fs');
const path = require('path');
const { loadMainProcess, createChecker, tempDir } = require('./harness.cjs');
const {
  computeFileFingerprint,
  computeFileFingerprints,
} = require('../../electron/lib/fingerprint.cjs');

const { check, section, summary } = createChecker();
const userData = tempDir('pm-userdata-migrate-');
const libDir = tempDir('pm-lib-migrate-');

const CONTENT_A = Buffer.from('photo-content-A');
const CONTENT_B = Buffer.from('photo-content-B');
const a1 = path.join(libDir, 'a1.jpg');
const a2 = path.join(libDir, 'a2.jpg'); // 与 a1 内容相同、路径不同
const b1 = path.join(libDir, 'b1.jpg');
const missing = path.join(libDir, 'gone.jpg');
fs.writeFileSync(a1, CONTENT_A);
fs.writeFileSync(a2, CONTENT_A);
fs.writeFileSync(b1, CONTENT_B);

// v1：收藏 / 隐藏 / 标签 / 时间修正 / AI 结果全部按路径存
const v1Config = {
  version: 1,
  favorites: [a1, a2, missing],
  hidden: [b1],
  tags: { [a1]: ['旅行'], [missing]: ['旧'] },
  dateOverrides: { [a2]: 1700000000000 },
  videoMeta: {},
  preferences: { theme: 'dark' },
};
const v1AiCache = {
  version: 1,
  entries: { [b1]: { description: '一张测试图', tags: ['测试'] } },
};
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(v1Config));
fs.writeFileSync(path.join(userData, 'ai-cache.json'), JSON.stringify(v1AiCache));

const { call } = loadMainProcess({ userData });
const settleStartup = () => new Promise((resolve) => setTimeout(resolve, 250));

(async () => {
  section('1. 内容指纹与路径无关');
  const idA1 = await computeFileFingerprint(a1);
  const idA2 = await computeFileFingerprint(a2);
  const idB1 = await computeFileFingerprint(b1);
  check('同内容不同路径指纹相同', !!idA1 && idA1 === idA2);
  check('不同内容指纹不同', idA1 !== idB1);
  check('指纹是 32 位十六进制', /^[0-9a-f]{32}$/.test(idA1 || ''));
  check('不存在的路径返回 null', (await computeFileFingerprint(missing)) === null);
  const batch = await computeFileFingerprints([a1, b1, missing]);
  check('批量结果只含可读文件', Object.keys(batch).length === 2 && batch[a1] === idA1);

  await settleStartup();

  section('2. v1 → v2 结构迁移');
  const cfg = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
  check('config version 升到 2', cfg.version === 2);
  check('收藏改成内容指纹', cfg.favorites.every((x) => /^[0-9a-f]{32}$/.test(x)));
  check('同内容的两份收藏合并成一条', cfg.favorites.length === 1, JSON.stringify(cfg.favorites));
  check('收藏指纹与内容一致', cfg.favorites[0] === idA1);
  check('隐藏项也换成指纹', cfg.hidden.length === 1 && cfg.hidden[0] === idB1);
  check('标签换成指纹键', !!cfg.tags[idA1] && cfg.tags[idA1][0] === '旅行');
  check('时间修正换成指纹键', cfg.dateOverrides[idA1] === 1700000000000);
  check(
    '不可达路径进 orphans，未静默丢弃',
    cfg.orphans.favorites.includes(missing) && Array.isArray(cfg.orphans.tags[missing])
  );
  check('无关字段保持不变', cfg.preferences.theme === 'dark');

  const ai = JSON.parse(fs.readFileSync(path.join(userData, 'ai-cache.json'), 'utf8'));
  check('ai-cache version 升到 2', ai.version === 2);
  check('AI 结果换成指纹键', !!ai.entries[idB1] && ai.entries[idB1].tags[0] === '测试');

  section('3. 写盘前的配置滚动备份');
  const bakPath = path.join(userData, 'config.json.bak');
  check('生成了 config.json.bak', fs.existsSync(bakPath));
  if (fs.existsSync(bakPath)) {
    const bak = JSON.parse(fs.readFileSync(bakPath, 'utf8'));
    check('备份是迁移前的 v1 内容', bak.version === 1 && bak.favorites.includes(a1));
  }

  section('4. compute-file-ids 的授权边界');
  await call('authorize-paths', [a1, b1]);
  const res = await call('compute-file-ids', [a1, b1, missing]);
  check('返回成功', res.ok === true);
  check('已授权文件能算指纹', res.data[a1] === idA1 && res.data[b1] === idB1);
  check('未授权 / 不存在的路径被跳过', !res.data[missing]);
  const badArgs = await call('compute-file-ids', 'not-an-array');
  check('参数不是数组时返回 fail', badArgs.ok === false);

  process.exit(summary() ? 1 : 0);
})();
