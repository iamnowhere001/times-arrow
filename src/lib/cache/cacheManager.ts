/**
 * 统一缓存治理。
 *
 * 目标：所有「会随时间增长的进程内缓存」都在这里登记，
 * 从而可以按需（列表重置 / 重型任务结束 / 系统内存告警）统一裁剪或释放，
 * 而不是各写各的 clear()，最后谁也没被真正回收。
 *
 * 设计要点：
 * - 统一提供真 LRU（命中后刷新最近使用），淘汰「最久未用」而不是整表清空；
 *   整表清空会让刚滚动过的缩略图全部重新请求，表现为一次明显的卡顿尖峰。
 * - 缓存分两级：volatile（可随时丢弃，重算代价低）与 sticky（重算代价高，尽量保留）。
 * - 主进程检测到内存压力时通过 IPC 广播，渲染进程据此统一释放。
 */

import { logger } from '@/lib/logger';

/**
 * volatile：缩略图地址 / 日期分组文案之类，丢了最多重新算一次，优先释放。
 * sticky：感知哈希之类重算代价高的结果，仅在硬释放时才裁剪。
 */
export type CacheVolatility = 'volatile' | 'sticky';

/** soft = 常规回收（裁掉一半易失缓存）；hard = 内存吃紧（清空易失、大幅裁剪常驻） */
export type ReleaseLevel = 'soft' | 'hard';

export interface LruCache<K, V> {
  readonly name: string;
  readonly limit: number;
  readonly volatility: CacheVolatility;
  /** 读取并刷新为「最近使用」 */
  get(key: K): V | undefined;
  /** 只读取，不刷新 LRU 顺序 */
  peek(key: K): V | undefined;
  has(key: K): boolean;
  set(key: K, value: V): void;
  delete(key: K): boolean;
  clear(): void;
  /** 只保留 keepRatio 比例的最新条目，返回被淘汰数量 */
  trim(keepRatio: number): number;
  /** 迭代 [key, value]（插入顺序 = LRU 顺序，末尾为最近使用） */
  entries(): IterableIterator<[K, V]>;
  readonly size: number;
}

export function createLruCache<K, V>(
  name: string,
  limit: number,
  volatility: CacheVolatility = 'volatile',
  onEvict?: (value: V, key: K) => void
): LruCache<K, V> {
  const map = new Map<K, V>();

  const evictOldest = () => {
    const oldest = map.keys().next();
    if (oldest.done) return;
    const key = oldest.value;
    const value = map.get(key) as V;
    map.delete(key);
    onEvict?.(value, key);
  };

  const cache: LruCache<K, V> = {
    name,
    limit,
    volatility,

    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key) as V;
      // 重新插入 → 移到 Map 末尾（迭代顺序 = 插入顺序，末尾即最近使用）
      map.delete(key);
      map.set(key, value);
      return value;
    },

    peek: key => map.get(key),

    has: key => map.has(key),

    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > limit) evictOldest();
    },

    delete(key) {
      if (!map.has(key)) return false;
      const value = map.get(key) as V;
      map.delete(key);
      onEvict?.(value, key);
      return true;
    },

    clear() {
      if (onEvict) {
        map.forEach((value, key) => onEvict(value, key));
      }
      map.clear();
    },

    trim(keepRatio) {
      const keep = Math.max(0, Math.min(map.size, Math.floor(map.size * keepRatio)));
      let removed = 0;
      while (map.size > keep) {
        evictOldest();
        removed += 1;
      }
      return removed;
    },

    entries: () => map.entries(),

    get size() {
      return map.size;
    },
  };

  registerCache(cache as LruCache<unknown, unknown>);
  return cache;
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

const registry: Array<LruCache<unknown, unknown>> = [];

export function registerCache(cache: LruCache<unknown, unknown>): void {
  if (!registry.some(item => item === cache)) registry.push(cache);
}

export interface CacheReleaseReport {
  name: string;
  before: number;
  after: number;
}

/**
 * 统一释放内存。
 * - soft：易失缓存裁到一半，常驻缓存仅在接近上限时轻裁；
 * - hard：易失缓存全部清空，常驻缓存裁到 1/4。
 */
export function releaseMemory(level: ReleaseLevel = 'soft', reason = 'manual'): CacheReleaseReport[] {
  const reports: CacheReleaseReport[] = [];

  for (const cache of registry) {
    const before = cache.size;
    if (before === 0) continue;

    if (level === 'hard') {
      if (cache.volatility === 'volatile') cache.clear();
      else cache.trim(0.25);
    } else {
      // soft：易失缓存裁半；常驻缓存只在逼近上限时回收，避免白丢重算代价高的结果
      if (cache.volatility === 'volatile') cache.trim(0.5);
      else if (before > cache.limit * 0.9) cache.trim(0.8);
    }

    if (cache.size !== before) {
      reports.push({ name: cache.name, before, after: cache.size });
    }
  }

  if (reports.length > 0) {
    logger.info(
      `[cache] release(${level}, ${reason})`,
      reports.map(r => `${r.name}: ${r.before}→${r.after}`).join(', ')
    );
  }
  return reports;
}

// ---------------------------------------------------------------------------
// 自动触发：主进程广播 + 渲染进程堆占用兜底
// ---------------------------------------------------------------------------

/**
 * 监听主进程的内存压力广播。
 * 主进程持有磁盘缩略图与感知哈希，比渲染进程更早感知到整机内存吃紧。
 * @returns 反注册函数
 */
export function installMemoryPressureListener(): () => void {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!api?.onMemoryPressure) return () => {};

  const off = api.onMemoryPressure(level => {
    releaseMemory(level === 'hard' ? 'hard' : 'soft', 'memory-pressure');
  });
  return typeof off === 'function' ? off : () => {};
}

/** 堆占用超过该比例即触发硬释放（仅 Chrome 暴露 performance.memory 时有效） */
const HEAP_PRESSURE_RATIO = 0.82;
const HEAP_WATCH_INTERVAL = 60_000;

interface PerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

/**
 * 渲染进程堆占用兜底巡检。
 * 没有主进程广播时（例如浏览器里跑）也能自我回收，避免长时间滚动后堆只增不减。
 * @returns 停止巡检的函数
 */
export function startHeapWatch(intervalMs: number = HEAP_WATCH_INTERVAL): () => void {
  if (typeof window === 'undefined') return () => {};

  const timer = window.setInterval(() => {
    const memory = (performance as Performance & { memory?: PerformanceMemory }).memory;
    if (!memory || !memory.jsHeapSizeLimit) return;

    const ratio = memory.usedJSHeapSize / memory.jsHeapSizeLimit;
    if (ratio >= HEAP_PRESSURE_RATIO) {
      // 连续高压时逐步加大力度：先软后硬，避免一次清空导致满屏缩略图重解码
      const level: ReleaseLevel = ratio >= 0.92 ? 'hard' : 'soft';
      releaseMemory(level, `heap:${Math.round(ratio * 100)}%`);
    }
  }, intervalMs);

  return () => window.clearInterval(timer);
}
