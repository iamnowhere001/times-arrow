'use strict';

/**
 * config.json / ai-cache.json 的结构迁移。
 *
 * v1：收藏 / 隐藏 / 标签 / 时间修正 / 视频元数据 / AI 结果都以**磁盘路径**为键。
 *     文件一挪，标注就失联（rekeyPathData 只能救应用内的重命名 / 移动）。
 * v2：统一以**内容指纹 fileId**为键。启动时把仍能访问到的路径换算成 id，
 *     访问不到的路径连同原值存进 `orphans`，交给「路径重连」续接，绝不静默丢弃。
 *
 * 迁移会写盘，而写盘前 store.cjs 会轮转 config.json.bak —— 也就是说旧配置
 * 在结构升级之前已经留了一份可回退的副本，这是这个执行顺序刻意要求的。
 */

const { computeFileFingerprints } = require('../lib/fingerprint.cjs');

const CONFIG_VERSION = 2;
const STORE_CONFIG = 'config.json';
const STORE_AI_CACHE = 'ai-cache.json';

function collectPaths(config, aiCache) {
  const paths = new Set();
  const add = (p) => {
    if (typeof p === 'string' && p) paths.add(p);
  };
  const cfg = config ?? {};
  (Array.isArray(cfg.favorites) ? cfg.favorites : []).forEach(add);
  (Array.isArray(cfg.hidden) ? cfg.hidden : []).forEach(add);
  Object.keys(cfg.tags ?? {}).forEach(add);
  Object.keys(cfg.dateOverrides ?? {}).forEach(add);
  Object.keys(cfg.videoMeta ?? {}).forEach(add);
  Object.keys((aiCache ?? {}).entries ?? {}).forEach(add);
  return [...paths];
}

/** 数组型字段：换成 id 并去重；匹配不到的路径进 orphans */
function remapArray(list, idByPath, orphans) {
  const out = [];
  const seen = new Set();
  for (const p of Array.isArray(list) ? list : []) {
    if (typeof p !== 'string' || !p) continue;
    const id = idByPath[p];
    if (!id) {
      if (!orphans.includes(p)) orphans.push(p);
      continue;
    }
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** 记录型字段：换成 id 键；同一 id 已存在时保留先写入的值，不静默覆盖 */
function remapRecord(record, idByPath, orphans) {
  const out = {};
  for (const [p, value] of Object.entries(record ?? {})) {
    const id = idByPath[p];
    if (!id) {
      orphans[p] = value;
      continue;
    }
    if (!(id in out)) out[id] = value;
  }
  return out;
}

/**
 * 在启动预读之后、创建窗口之前调用。
 * @returns {{changed: boolean, stats: object|null}}
 */
async function migrateAllStores({ readStore, mergeStore, logger }) {
  const config = await readStore(STORE_CONFIG);
  const aiCache = await readStore(STORE_AI_CACHE);

  // 两个 store **各自**判断版本，不能用「都 >= v2」做整体的 no-op 条件。
  // ai-cache.json 不存在或刚从损坏中恢复时 readStore 返回 {}（version 为 undefined），
  // 若据此把 config 也重迁一遍，v2 的 32 位内容指纹会被当成 v1 路径：
  // 收藏 / 标签 / 时间修正全部被清空并塞进 orphans，而 orphans 里存的是 hex 字符串，
  // 路径重连按目录前缀匹配永远找不回来 —— 这是不可逆的数据丢失。
  // 缺失 / 损坏的 store 视为 v0；不要靠 Number(undefined) 的 NaN 比较碰巧得出「不用迁移」
  const versionOf = (store) =>
    Number.isFinite(Number(store?.version)) ? Number(store.version) : 0;
  const configNeeds = versionOf(config) < CONFIG_VERSION;
  const aiNeeds = versionOf(aiCache) < CONFIG_VERSION;
  if (!configNeeds && !aiNeeds) {
    return { changed: false, stats: null };
  }

  // 只收集需要迁移的那一份里的路径，已是 v2 的字段一个都不碰
  const paths = collectPaths(configNeeds ? config : null, aiNeeds ? aiCache : null);
  // 没有任何按路径存的旧数据时不必写盘：配置可能刚从损坏中恢复成空，
  // 此时顺手写一份新 config.json 只会让「原文件已改名留证」的语义变复杂。
  // 跳过是安全的 —— 之后任意一次 savePersistedConfig 都会把 version 提到 v2。
  if (paths.length === 0) return { changed: false, stats: null };

  const idByPath = await computeFileFingerprints(paths, 8);

  const configOrphans = {
    favorites: [],
    hidden: [],
    tags: {},
    dateOverrides: {},
    videoMeta: {},
  };
  const favorites = configNeeds
    ? remapArray(config?.favorites, idByPath, configOrphans.favorites)
    : (config?.favorites ?? []);
  const hidden = configNeeds
    ? remapArray(config?.hidden, idByPath, configOrphans.hidden)
    : (config?.hidden ?? []);
  const tags = configNeeds
    ? remapRecord(config?.tags, idByPath, configOrphans.tags)
    : (config?.tags ?? {});
  const dateOverrides = configNeeds
    ? remapRecord(config?.dateOverrides, idByPath, configOrphans.dateOverrides)
    : (config?.dateOverrides ?? {});
  const videoMeta = configNeeds
    ? remapRecord(config?.videoMeta, idByPath, configOrphans.videoMeta)
    : (config?.videoMeta ?? {});

  const aiOrphans = {};
  const entries = aiNeeds
    ? remapRecord((aiCache ?? {}).entries, idByPath, aiOrphans)
    : ((aiCache ?? {}).entries ?? {});

  if (configNeeds) {
    await mergeStore(STORE_CONFIG, {
      version: CONFIG_VERSION,
      favorites,
      hidden,
      tags,
      dateOverrides,
      videoMeta,
      orphans: configOrphans,
    });
  }
  if (aiNeeds) {
    await mergeStore(STORE_AI_CACHE, {
      version: CONFIG_VERSION,
      entries,
      orphans: aiOrphans,
    });
  }

  const stats = {
    paths: paths.length,
    matched: Object.keys(idByPath).length,
    orphans:
      configOrphans.favorites.length +
      configOrphans.hidden.length +
      Object.keys(configOrphans.tags).length +
      Object.keys(configOrphans.dateOverrides).length +
      Object.keys(configOrphans.videoMeta).length +
      Object.keys(aiOrphans).length,
  };
  logger?.info?.('[migrate] v1 → v2 完成:', stats);
  return { changed: true, stats };
}

module.exports = { CONFIG_VERSION, migrateAllStores };
