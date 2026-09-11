/**
 * 照片排序与日期分组（从 App 抽出的纯逻辑）。
 *
 * 之前这部分逻辑内联在 App 的 useMemo 中，既负责排序又负责按「今天 / 昨天 / 具体日期」
 * 分组。抽成模块后行为完全不变，但可以被独立阅读、复用与测试。
 */

import { Photo, SortConfig } from '@/types';
import { createLruCache } from '@/lib/cache/cacheManager';

/**
 * 日期分组 key 缓存。
 * toLocaleDateString 每次都会构造 Intl 格式化器，几千张照片时是明显的 CPU 热点，
 * 而同一天的照片分组 key 完全相同，因此按「天」缓存。
 */
const dateKeyCache = createLruCache<number, string>('dateGroupKey', 5000, 'volatile');
let dateKeyCacheDay = '';

export function getDateGroupKey(timestamp: number, todayKey: string, yesterdayKey: string): string {
  if (!timestamp || Number.isNaN(timestamp)) return 'Unknown Date';

  // 跨天时缓存失效
  if (todayKey !== dateKeyCacheDay) {
    dateKeyCache.clear();
    dateKeyCacheDay = todayKey;
  }

  const date = new Date(timestamp);
  // 用「本地日历日」（yyyymmdd）做 key。
  // 不能用 floor(ts / 86400000)：那是 UTC 日界，东八区里同一天 23:00 与次日 01:00
  // 会落进同一个 UTC 日，导致两天被错误地合并为同一组。
  const dayKey = date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
  const cached = dateKeyCache.get(dayKey);
  if (cached !== undefined) return cached;

  const dateKey = date.toDateString();
  let key: string;
  if (dateKey === todayKey) {
    key = 'Today';
  } else if (dateKey === yesterdayKey) {
    key = 'Yesterday';
  } else {
    key = date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
    });
  }

  dateKeyCache.set(dayKey, key);
  return key;
}

/** 一个日期分组：key 为「Today / Yesterday / 具体日期」，photos 为该组照片（已排序） */
export interface PhotoGroup {
  key: string;
  photos: Photo[];
}

/**
 * 按当前排序配置对照片排序，返回新数组（不修改入参）。
 * 与 UI 上「按名称 / 大小 / 各类时间排序」一一对应。
 */
export function sortPhotos(photos: Photo[], sortConfig: SortConfig): Photo[] {
  return [...photos].sort((a, b) => {
    if (sortConfig.key === 'dateModified' || sortConfig.key === 'dateTaken') {
      const dateA = a.dateTaken || a.lastModified || 0;
      const dateB = b.dateTaken || b.lastModified || 0;
      return sortConfig.direction === 'asc' ? dateA - dateB : dateB - dateA;
    }
    if (sortConfig.key === 'dateCreated') {
      const dateA = a.dateCreated || a.lastModified || 0;
      const dateB = b.dateCreated || b.lastModified || 0;
      return sortConfig.direction === 'asc' ? dateA - dateB : dateB - dateA;
    }
    if (sortConfig.key === 'name') {
      return sortConfig.direction === 'asc'
        ? a.name.localeCompare(b.name)
        : b.name.localeCompare(a.name);
    }
    if (sortConfig.key === 'size') {
      return sortConfig.direction === 'asc' ? a.size - b.size : b.size - a.size;
    }
    return 0;
  });
}

/**
 * 排序 + 按日期分组。
 * 仅在按「修改 / 拍摄时间」排序时切分成日期分组；其它排序方式返回单个 `all` 组，
 * 由调用方直接展开即可（保持与重构前完全一致的行为）。
 */
export function groupPhotos(photos: Photo[], sortConfig: SortConfig): PhotoGroup[] {
  const sorted = sortPhotos(photos, sortConfig);

  if (sortConfig.key !== 'dateModified' && sortConfig.key !== 'dateTaken') {
    return [{ key: 'all', photos: sorted }];
  }

  const groups: Record<string, Photo[]> = {};
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const todayKey = today.toDateString();
  const yesterdayKey = yesterday.toDateString();

  sorted.forEach(photo => {
    const key = getDateGroupKey(photo.dateTaken || photo.lastModified, todayKey, yesterdayKey);

    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(photo);
  });

  return Object.entries(groups).map(([key, groupPhotos]) => ({ key, photos: groupPhotos }));
}

/**
 * 时光画廊数据源：按拍摄时间升序排列的全部照片（忽略筛选 / 搜索），
 * 缺失时间戳的条目排到末尾。
 */
export function sortPhotosByTimeline(photos: Photo[]): Photo[] {
  return [...photos].sort((a, b) => {
    const ta = a.dateTaken || a.lastModified || 0;
    const tb = b.dateTaken || b.lastModified || 0;
    return ta - tb;
  });
}
