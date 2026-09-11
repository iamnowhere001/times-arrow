/**
 * AI 分析结果的本地缓存。
 *
 * 单张图片的描述 + 标签往往有几百字节，上千张就会让 config.json 变得臃肿，
 * 因此单独存成 `userData/ai-cache.json`，并在渲染进程侧强制一个条数上限：
 * 超出时从「最早写入」的条目开始淘汰（Map 的迭代顺序即插入顺序）。
 *
 * 这些结果是「重算代价高但可以丢」的数据：丢掉只是需要重新分析一次，不会损坏任何文件。
 */

import { AiCacheEntry, PersistedAiCache } from '@/types';
import { logger } from '@/lib/logger';

/** 最多保留多少条 AI 结果（约几百 KB） */
export const AI_CACHE_LIMIT = 2000;

const api = () => window.electronAPI;

const normalizeEntry = (entry: AiCacheEntry | undefined): AiCacheEntry | null => {
  if (!entry || typeof entry !== 'object') return null;

  const description = typeof entry.description === 'string' && entry.description ? entry.description : undefined;
  const tags = Array.isArray(entry.tags)
    ? entry.tags.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0)
    : undefined;

  if (!description && (!tags || tags.length === 0)) return null;
  return { description, tags };
};

/** 读取缓存，返回保持插入顺序的 Map（路径 → 结果） */
export const loadAiCache = async (): Promise<Map<string, AiCacheEntry>> => {
  const cache = new Map<string, AiCacheEntry>();
  const electronApi = api();
  if (!electronApi?.loadAiCache) return cache;

  try {
    const store: PersistedAiCache = await electronApi.loadAiCache();
    Object.entries(store?.entries ?? {}).forEach(([key, entry]) => {
      if (!key) return;
      const normalized = normalizeEntry(entry);
      if (normalized) cache.set(key, normalized);
    });
  } catch (error) {
    logger.warn('读取 AI 缓存失败:', error);
  }

  return cache;
};

/**
 * 写入缓存。
 * 会就地淘汰超出上限的最早条目，保证内存与磁盘都不会无限增长。
 */
export const saveAiCache = async (cache: Map<string, AiCacheEntry>): Promise<void> => {
  while (cache.size > AI_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }

  const electronApi = api();
  if (!electronApi?.saveAiCache) return;

  const entries: Record<string, AiCacheEntry> = {};
  cache.forEach((entry, key) => {
    entries[key] = entry;
  });

  try {
    await electronApi.saveAiCache(entries);
  } catch (error) {
    logger.warn('写入 AI 缓存失败:', error);
  }
};
