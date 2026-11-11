/**
 * 数据健康检查回归测试（v1.0.0）。
 *
 * 这条链路是「能不能长期把照片库交给它」的可见证据：
 *   - 备份是否存在、是否还能解析（不能解析的备份等于没有备份）；
 *   - 迁移留下的 orphans、缩略图缓存占用、操作日志与崩溃记录；
 *   - 有风险时汇总成 warnings，而不是让用户自己逐个面板翻。
 *
 * 运行：npm run test:main
 */
const fs = require('fs');
const path = require('path');
const { createChecker, loadMainProcess, tempDir } = require('./harness.cjs');

const { check, section, summary } = createChecker();

const userData = tempDir('pm-health-');

const config = {
  version: 2,
  favorites: ['fid-1'],
  hidden: [],
  tags: { 'fid-2': ['旅行'] },
  dateOverrides: {},
  videoMeta: {},
  albums: [],
  sources: [],
  preferences: {},
  orphans: { favorites: ['/old/a.jpg'], tags: { '/old/b.jpg': ['旧标签'] } },
};
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config, null, 2));
fs.writeFileSync(path.join(userData, 'config.json.bak'), JSON.stringify(config, null, 2));
fs.writeFileSync(path.join(userData, 'config.json.bak.1'), 'not json');

const thumbDir = path.join(userData, 'thumbnails');
fs.mkdirSync(thumbDir, { recursive: true });
fs.writeFileSync(path.join(thumbDir, 'a.jpg'), Buffer.alloc(100));
fs.writeFileSync(path.join(thumbDir, 'b.jpg'), Buffer.alloc(200));

const ops = [
  { id: '1', at: Date.now() - 3000, type: 'rename', from: '/x/a.jpg', to: '/x/b.jpg' },
  { id: '2', at: Date.now() - 2000, type: 'delete', from: '/x/c.jpg' },
  { id: '3', at: Date.now() - 1000, type: 'undo', target: '2' },
];
fs.writeFileSync(
  path.join(userData, 'operation-log.jsonl'),
  ops.map((o) => JSON.stringify(o)).join('\n') + '\n'
);

const crashAt = Date.now() - 5000;
fs.writeFileSync(
  path.join(userData, 'crash-log.jsonl'),
  JSON.stringify({ at: crashAt, kind: 'uncaught-exception', message: 'boom' }) + '\n'
);
fs.writeFileSync(
  path.join(userData, 'crash-pending.json'),
  JSON.stringify([{ at: crashAt, kind: 'uncaught-exception', message: 'boom' }])
);

fs.writeFileSync(
  path.join(userData, 'migration-report.json'),
  JSON.stringify({
    at: Date.now() - 10000,
    changed: true,
    stats: { paths: 12, matched: 10, orphans: 2 },
  })
);

// 损坏备份留证（只应出现在 warnings 与 corruptBackups 里）
fs.writeFileSync(path.join(userData, 'config.json.corrupt-1'), '{ broken');

const app = loadMainProcess({ userData });

(async () => {
  // ready 回调会异步跑一次迁移并把本次结果写进 migration-report.json；
  // 等它落地后再放回我们准备的「上次迁移」记录，断言才有确定对象。
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.writeFileSync(
    path.join(userData, 'migration-report.json'),
    JSON.stringify({
      at: Date.now() - 10000,
      changed: true,
      stats: { paths: 12, matched: 10, orphans: 2 },
    })
  );

  section('1. 报告结构完整');
  const res = await app.call('get-data-health');
  check('get-data-health 返回成功', res.ok === true, JSON.stringify(res));
  const report = res.ok ? res.data : null;
  check('带检查时间', typeof report?.checkedAt === 'number');
  check('识别当前配置版本 v2', report?.config.version === 2, String(report?.config.version));
  check('当前配置可解析', report?.config.parseOk === true);
  check(
    '识别备份文件',
    report?.config.backups?.length === 2,
    String(report?.config.backups?.length)
  );

  section('2. 备份可解析性');
  const bak = report?.config.backups?.find((b) => b.name === 'config.json.bak');
  const bak1 = report?.config.backups?.find((b) => b.name === 'config.json.bak.1');
  check('config.json.bak 存在且可解析', bak?.exists === true && bak?.parseOk === true);
  check('config.json.bak.1 存在但不可解析', bak1?.exists === true && bak1?.parseOk === false);

  section('3. 数据量统计');
  check('orphans 计数正确（1 + 1）', report?.orphans === 2, String(report?.orphans));
  check(
    '缩略图缓存统计文件数与字节数',
    report?.thumbCache.files === 2 && report.thumbCache.bytes === 300,
    JSON.stringify(report?.thumbCache)
  );
  check(
    '操作日志条数 / 最近时间',
    report?.operationLog.entries === 3 && report?.operationLog.lastAt === ops[2].at
  );
  check(
    '崩溃日志条数 / 最近时间',
    report?.crashLog.entries === 1 && report?.crashLog.lastAt === crashAt
  );

  section('4. 迁移记录');
  check('读到最近一次迁移结果', report?.migration?.changed === true);
  check('迁移统计完整', report?.migration?.stats?.orphans === 2);

  section('5. 风险汇总（warnings）');
  const warnings = report?.warnings ?? [];
  const text = warnings.join(' | ');
  check('备份不可解析进入 warnings', text.includes('config.json.bak.1'));
  check('待重连孤儿进入 warnings', text.includes('2 条标注等待路径重连'));
  check('崩溃记录进入 warnings', text.includes('崩溃日志里有 1 条记录'));
  check('损坏备份进入 warnings', text.includes('损坏备份'));

  section('6. 不误清空待提示队列');
  const notices = await app.call('crash-notices');
  check(
    '健康检查之后崩溃提示仍在',
    notices.ok && notices.data.length === 1,
    JSON.stringify(notices)
  );

  process.exit(summary() === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
