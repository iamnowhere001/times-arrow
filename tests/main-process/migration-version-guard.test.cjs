/**
 * v0.6.1 发布收尾 · 配置迁移的版本守卫回归测试。
 *
 * 发现的缺陷：migrateAllStores 原先要求「config 与 ai-cache **都** >= v2」才 no-op。
 * ai-cache.json 缺失（readStore 返回 {}）或损坏被改名备份时，version 为 undefined，
 * 于是每次启动都会把已经是 v2 的 config 再迁一遍 —— 32 位内容指纹被当成 v1 路径，
 * 收藏 / 隐藏 / 标签 / 时间修正全部被清空并塞进 orphans。orphans 里存的是 hex 字符串，
 * 路径重连按目录前缀匹配永远找不回来，属不可逆的数据丢失。
 *
 * 这里直接测 migrateAllStores（依赖注入，不启动 Electron），因此可以在同一进程里
 * 覆盖多组「config 版本 × ai-cache 版本」组合，不受 harness 只能加载一次主进程的限制。
 *
 * 运行：npm run test:main
 */
const fs = require('fs');
const path = require('path');
const { createChecker, tempDir } = require('./harness.cjs');
const { migrateAllStores, CONFIG_VERSION } = require('../../electron/main/migrations.cjs');
const { computeFileFingerprint } = require('../../electron/lib/fingerprint.cjs');

const { check, section, summary } = createChecker();

const libDir = tempDir('pm-migration-guard-');
const photoPath = path.join(libDir, 'photo.jpg');
fs.writeFileSync(photoPath, 'MIGRATION-GUARD-CONTENT');

/** 一个假的、但格式合法的 v2 内容指纹 */
const FINGERPRINT = 'a'.repeat(32);

const v2Config = () => ({
  version: 2,
  favorites: [FINGERPRINT],
  hidden: [FINGERPRINT],
  tags: { [FINGERPRINT]: ['旅行'] },
  dateOverrides: { [FINGERPRINT]: 1700000000000 },
  videoMeta: {},
  preferences: { theme: 'dark' },
});

/**
 * 内存版 store：readStore 对不存在的 store 返回 {}（与真实 readStore 一致），
 * mergeStore 记录被写过的文件名，便于断言「不该动的那份一个字都没写」。
 * 传 null 表示该 store 的文件根本不存在。
 */
function makeStores(config, aiCache) {
  const data = {};
  if (config !== null) data['config.json'] = JSON.parse(JSON.stringify(config));
  if (aiCache !== null) data['ai-cache.json'] = JSON.parse(JSON.stringify(aiCache));
  const writes = [];
  return {
    data,
    writes,
    readStore: async (fileName) => data[fileName] ?? {},
    mergeStore: async (fileName, patch) => {
      data[fileName] = { ...(data[fileName] ?? {}), ...patch };
      writes.push(fileName);
      return true;
    },
  };
}

const run = (stores) => migrateAllStores({ ...stores, logger: null });

(async () => {
  const realId = await computeFileFingerprint(photoPath);
  check('夹具照片可算出真实指纹', !!realId);

  // -------------------------------------------------------------------------
  section('1. config 已是 v2、ai-cache.json 不存在：绝不重迁 config');
  {
    const s = makeStores(v2Config(), null);
    const r = await run(s);
    check('判定为 no-op', r.changed === false);
    check('一次盘都没写', s.writes.length === 0, s.writes.join(','));
    check('收藏仍是内容指纹', s.data['config.json'].favorites[0] === FINGERPRINT);
    check('隐藏项仍是内容指纹', s.data['config.json'].hidden[0] === FINGERPRINT);
    check('标签没被清空', s.data['config.json'].tags[FINGERPRINT][0] === '旅行');
    check('时间修正没被清空', s.data['config.json'].dateOverrides[FINGERPRINT] === 1700000000000);
    check('没有产生 hex 形态的 orphans', !s.data['config.json'].orphans);
    check('偏好等无关字段保持不变', s.data['config.json'].preferences.theme === 'dark');
    check('没有凭空创建 ai-cache.json', !s.data['ai-cache.json']);
  }

  // -------------------------------------------------------------------------
  section('2. config 已是 v2、ai-cache 刚从损坏中恢复成空：同样不许重迁');
  {
    const s = makeStores(v2Config(), {});
    const r = await run(s);
    check('判定为 no-op', r.changed === false);
    check('config 未被写盘', !s.writes.includes('config.json'));
    check(
      '收藏 / 标签完好',
      s.data['config.json'].favorites[0] === FINGERPRINT &&
        s.data['config.json'].tags[FINGERPRINT][0] === '旅行'
    );
  }

  // -------------------------------------------------------------------------
  section('3. config 已是 v2、ai-cache 仍是 v1：只迁 ai-cache');
  {
    const s = makeStores(v2Config(), {
      version: 1,
      entries: { [photoPath]: { tags: ['AI 测试'] } },
    });
    const r = await run(s);
    check('迁移确实发生了', r.changed === true);
    check('config 一个字都没写', !s.writes.includes('config.json'), s.writes.join(','));
    check('config 标注完好', s.data['config.json'].favorites[0] === FINGERPRINT);
    check('ai-cache 被写入', s.writes.includes('ai-cache.json'));
    check(
      'AI 结果换成内容指纹键',
      s.data['ai-cache.json'].entries[realId]?.tags?.[0] === 'AI 测试'
    );
    check('ai-cache 版本升到 v2', s.data['ai-cache.json'].version === CONFIG_VERSION);
  }

  // -------------------------------------------------------------------------
  section('4. 正常 v1 迁移仍然有效（不能被守卫误伤）');
  {
    const s = makeStores(
      {
        version: 1,
        favorites: [photoPath],
        tags: { [photoPath]: ['旧标签'] },
        dateOverrides: { [photoPath]: 1700000000000 },
      },
      null
    );
    const r = await run(s);
    check('迁移确实发生了', r.changed === true);
    check('config 版本升到 v2', s.data['config.json'].version === CONFIG_VERSION);
    check('收藏换成真实指纹', s.data['config.json'].favorites.includes(realId));
    check('标签续接到真实指纹', s.data['config.json'].tags[realId]?.[0] === '旧标签');
    check('时间修正续接到真实指纹', s.data['config.json'].dateOverrides[realId] === 1700000000000);
  }

  // -------------------------------------------------------------------------
  section('5. config 是 v1、ai-cache 已是 v2：不要重写已有的 AI 结果');
  {
    const s = makeStores(
      { version: 1, favorites: [photoPath] },
      { version: 2, entries: { [realId]: { tags: ['已分析'] } } }
    );
    await run(s);
    check('ai-cache 未被写盘', !s.writes.includes('ai-cache.json'), s.writes.join(','));
    check('已有 AI 结果保持不变', s.data['ai-cache.json'].entries[realId].tags[0] === '已分析');
    check('config 正常迁移', s.data['config.json'].favorites.includes(realId));
  }

  // -------------------------------------------------------------------------
  section('6. 两份都是 v2：完全不写盘');
  {
    const s = makeStores(v2Config(), { version: 2, entries: {} });
    const r = await run(s);
    check('判定为 no-op', r.changed === false);
    check('零写盘', s.writes.length === 0, s.writes.join(','));
    check('标注完好', s.data['config.json'].favorites[0] === FINGERPRINT);
  }

  process.exit(summary() === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
