/**
 * 存储损坏恢复的回归测试（P2-24）。
 *
 * 场景：应用启动时 `config.json` / `ai-config.json` 已经是坏文件（写到一半断电、
 * 磁盘错误、手工编辑出错…）。主进程应当：
 *   1. 把损坏文件改名备份留证，而不是直接覆盖 —— 否则用户还有救的收藏/相簿就真没了；
 *   2. 从空配置继续启动，不阻塞；
 *   3. **把这件事告诉用户** —— 否则他只会发现「相册凭空消失」，
 *      既不知道原因，也不知道磁盘上有一份备份可以捞回来。
 *
 * ⚠️ 必须在 `require(main.js)` **之前**就把损坏文件放好：
 * `app.on('ready')` 会预读 config.json / ai-config.json 并写入 storeCache，
 * 加载之后再往目录里放损坏文件是不会被重读的（这正是本测试单独成一个文件的原因）。
 *
 * 运行：npm run test:main
 */
const fs = require('fs');
const path = require('path');
const { loadMainProcess, createChecker, tempDir } = require('./harness.cjs');

const { check, section, summary } = createChecker();

const CORRUPT_CONFIG = '{ "favorites": ["a",  ← 写到一半断电';
const CORRUPT_AI = 'not json at all';

const userData = tempDir('pm-userdata-corrupt-');
fs.writeFileSync(path.join(userData, 'config.json'), CORRUPT_CONFIG);
fs.writeFileSync(path.join(userData, 'ai-config.json'), CORRUPT_AI);

// 损坏文件必须在加载前就位
const { call } = loadMainProcess({ userData });

/**
 * 等启动期的预读落地。
 *
 * `app.on('ready')` 里的 `Promise.all([readStore(...), readStore(...)])` 是
 * fire-and-forget（没有 await），而 readStore 内部要 await readFile / rename。
 * 因此 loadMainProcess 返回时，改名备份可能还没完成 —— 直接 readdirSync 会看不到。
 * 这里等一个宏任务让它们跑完。
 */
const settleStartup = () => new Promise((resolve) => setTimeout(resolve, 80));

(async () => {
  await settleStartup();

  section('1. 损坏文件被备份留证');
  const configBackups = fs.readdirSync(userData).filter((f) => f.startsWith('config.json.corrupt-'));
  const aiBackups = fs.readdirSync(userData).filter((f) => f.startsWith('ai-config.json.corrupt-'));

  check('config.json 被改名备份', configBackups.length === 1, fs.readdirSync(userData).join(', '));
  check('ai-config.json 被改名备份', aiBackups.length === 1, fs.readdirSync(userData).join(', '));
  check('原路径上已不再有损坏的 config.json', !fs.existsSync(path.join(userData, 'config.json')));

  if (configBackups.length === 1) {
    const backup = path.join(userData, configBackups[0]);
    check('备份内容与原始损坏内容一致（没有丢证）', fs.readFileSync(backup, 'utf8') === CORRUPT_CONFIG);
  }
  if (aiBackups.length === 1) {
    const backup = path.join(userData, aiBackups[0]);
    check('ai-config 备份内容一致', fs.readFileSync(backup, 'utf8') === CORRUPT_AI);
  }

  section('2. 从空配置继续启动，不阻塞');
  const configRes = await call('load-config');
  check('load-config 返回成功而不是抛错', configRes.ok === true, JSON.stringify(configRes));
  check('返回的是空配置', configRes.ok && Object.keys(configRes.data).length === 0, JSON.stringify(configRes));

  const cacheRes = await call('load-ai-cache');
  check('load-ai-cache 同样返回成功', cacheRes.ok === true, JSON.stringify(cacheRes));

  section('3. 通知用户（否则数据像是凭空消失）');
  const notices = await call('storage-notices');
  check('产生了存储恢复通知', notices.ok && notices.data.length === 2, JSON.stringify(notices));

  const files = notices.ok ? notices.data.map((n) => n.file).sort() : [];
  check('两个损坏文件都被报告', files.join(',') === 'ai-config.json,config.json', files.join(','));

  const configNotice = notices.ok ? notices.data.find((n) => n.file === 'config.json') : null;
  check('通知里带备份路径', typeof configNotice?.backupPath === 'string' && configNotice.backupPath.length > 0);
  check('通知里的备份路径确实存在', Boolean(configNotice) && fs.existsSync(configNotice.backupPath));
  check('通知里带发生时间', typeof configNotice?.at === 'number' && configNotice.at > 0);

  section('4. 取走即清空（一次性事件不该反复提示）');
  const second = await call('storage-notices');
  check('第二次取走为空', second.ok && second.data.length === 0, JSON.stringify(second));

  section('5. 恢复后仍可正常写入');
  const saveRes = await call('save-config', { version: 1, favorites: ['/tmp/x.jpg'] });
  check('写入成功', saveRes.ok === true, JSON.stringify(saveRes));
  const reload = await call('load-config');
  check('读回的内容包含刚写入的数据', reload.ok && reload.data.favorites?.[0] === '/tmp/x.jpg', JSON.stringify(reload));

  section('6. 没有产生多余的备份');
  // 「文件不存在（首次运行）不该被当成损坏」这一条无法在本进程里验证 ——
  // Node 会缓存已 require 的模块，同一个进程里二次 loadMainProcess 拿不到新 handler。
  // 该场景由 ipc-security.test.cjs 的「正常启动时不产生损坏通知」覆盖（那边是干净目录）。
  const allBackups = fs.readdirSync(userData).filter((f) => f.includes('.corrupt-'));
  check('备份文件数量恰好等于损坏文件数（没有误伤别的存储）', allBackups.length === 2, allBackups.join(', '));
  check(
    'ai-cache.json 未被误报为损坏（它本来就不存在）',
    !allBackups.some((f) => f.startsWith('ai-cache.json')),
    allBackups.join(', ')
  );

  process.exit(summary() === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
