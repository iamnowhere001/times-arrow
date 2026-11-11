/**
 * 崩溃记录与「下次启动提示」的回归测试（v1.0.0 · K4）。
 *
 * 背景：`uncaughtException` / `unhandledRejection` 此前只打日志到终端。
 * 对 DMG 用户来说，一次异常等同于「应用某天悄悄坏了」：没有终端、没有证据、
 * 重启后也没有任何提示。这个测试钉住三件事：
 *   1. 异常同步落盘，且有上限（不会无限增长）；
 *   2. 待提示队列「取走即清空」，不会每次启动都烦人；
 *   3. `open-crash-log` 只由主进程决定路径，渲染层不能借它打开任意文件。
 *
 * 运行：npm run test:main
 */
const fs = require('fs');
const path = require('path');
const { createChecker, loadMainProcess, tempDir } = require('./harness.cjs');

const { check, section, summary } = createChecker();
const { createCrashReporter, LOG_LIMIT } = require('../../electron/main/crash-report.cjs');

(async () => {
  section('1. 记录器：同步落盘、截断与上限');
  const dir = tempDir('pm-crash-');
  const reporter = createCrashReporter({ userDataDir: dir, logger: { warn() {} } });

  const entry = reporter.record('uncaught-exception', new Error('boom'));
  check('record 返回结构化条目', entry.kind === 'uncaught-exception' && entry.message === 'boom');
  check('日志文件已生成', fs.existsSync(reporter.logPath));
  check('消息带发生时间', typeof entry.at === 'number' && entry.at > 0);

  const long = reporter.record('unhandled-rejection', 'x'.repeat(5000));
  check('超长消息被截断到 2000 字符', long.message.length === 2000, String(long.message.length));

  for (let i = 0; i < LOG_LIMIT + 5; i += 1) reporter.record('test', `entry-${i}`);
  const lines = fs.readFileSync(reporter.logPath, 'utf8').split('\n').filter(Boolean);
  check(`日志条数不超过上限 ${LOG_LIMIT}`, lines.length === LOG_LIMIT, String(lines.length));
  check('保留的是最新的条目', lines[lines.length - 1].includes('entry-104'));

  const stats = reporter.stats();
  check('stats 报告条数与最近时间', stats.entries === LOG_LIMIT && stats.lastAt > 0);

  section('2. 取走即清空');
  const firstDrain = reporter.drain();
  check('第一次 drain 返回待提示条目', firstDrain.length === 10, String(firstDrain.length));
  check('第二次 drain 为空', reporter.drain().length === 0);
  check('待提示文件已删除', !fs.existsSync(path.join(dir, 'crash-pending.json')));

  section('3. 主进程 IPC：下次启动能看到上次的异常');
  const userData = tempDir('pm-crash-ipc-');
  const pending = [
    {
      at: Date.now() - 1000,
      kind: 'uncaught-exception',
      message: '渲染前的异常',
      stack: 'Error: 渲染前的异常',
    },
  ];
  fs.writeFileSync(path.join(userData, 'crash-pending.json'), JSON.stringify(pending));
  fs.writeFileSync(path.join(userData, 'crash-log.jsonl'), JSON.stringify(pending[0]) + '\n');

  const app = loadMainProcess({ userData });
  const notices = await app.call('crash-notices');
  check('crash-notices 返回成功', notices.ok === true, JSON.stringify(notices));
  check(
    '取到上次运行的异常',
    notices.ok && notices.data.length === 1 && notices.data[0].message === '渲染前的异常',
    JSON.stringify(notices)
  );
  const again = await app.call('crash-notices');
  check('第二次取走为空（一次性事件不反复提示）', again.ok && again.data.length === 0);

  const opened = await app.call('open-crash-log');
  check('存在日志时 open-crash-log 成功', opened.ok === true, JSON.stringify(opened));
  check(
    '打开的是主进程指定的日志路径',
    app.openPathCalls.length === 1 && app.openPathCalls[0].endsWith('crash-log.jsonl'),
    app.openPathCalls.join(',')
  );

  section('4. 没有日志时明确失败，而不是假装成功');
  fs.unlinkSync(path.join(userData, 'crash-log.jsonl'));
  const missing = await app.call('open-crash-log');
  check('open-crash-log 明确返回失败', missing.ok === false, JSON.stringify(missing));

  process.exit(summary() === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
