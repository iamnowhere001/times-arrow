import { createLruCache } from './cacheManager';

/**
 * 磁盘缩略图的「按需解析」层（与 React 无关，供图片与感知哈希共用）。
 *
 * 设计要点：
 * - 导入时不再逐张预生成缩略图（几万张会耗掉数分钟并占满磁盘缓存），
 *   改为卡片真正进入视口时才请求；生成结果由主进程落盘缓存，二次访问零成本。
 * - 渲染进程侧有并发闸门 + 同 key 去重，快速滚动不会瞬间灌入大量任务。
 * - 缓存区分两类值：pm:// 地址（只是一串短字符串，可以多留）与 data: URL
 *   （视频首帧兜底时是完整 JPEG base64，必须严格限量，否则几百个视频就能吃掉几百 MB）。
 */

/** 与主进程默认缩略图尺寸保持一致 */
export const BASE_THUMB_SIZE = 320;
const THUMB_SIZE_STEP = 160;
const MAX_THUMB_SIZE = 1280;

/** 渲染进程侧并发上限：略高于主进程 thumbLimiter，保证主进程始终处于饱和 */
const MAX_CONCURRENT_REQUESTS = 12;

/**
 * 缓存上限。早先的做法是「超过上限直接 clear()」，
 * 大库下会造成整屏缩略图重新请求，这里改为逐项 LRU 淘汰。
 */
const MAX_RESOLVED_CACHE = 6000;
/** data: URL 体积远大于 pm:// 地址，单独设一个很小的上限 */
const MAX_DATA_URL_CACHE = 96;

const resolvedCache = createLruCache<string, string>('thumbUrl', MAX_RESOLVED_CACHE, 'volatile');
const dataUrlCache = createLruCache<string, string>('thumbDataUrl', MAX_DATA_URL_CACHE, 'volatile');

/** 解析中的任务：同 key 去重，避免快速滚动时重复请求同一张图 */
const inflight = new Map<string, Promise<string | null>>();

let activeRequests = 0;
const waiters: Array<() => void> = [];

/**
 * 缓存世代：清空缓存后自增。
 * 用于丢弃「清空前已发出、清空后才返回」的结果 —— 否则刚清掉的缓存会立刻被旧任务写回。
 */
let generation = 0;

function acquireSlot(): Promise<void> {
  if (activeRequests < MAX_CONCURRENT_REQUESTS) {
    activeRequests += 1;
    return Promise.resolve();
  }
  return new Promise<void>(resolve => {
    waiters.push(() => {
      activeRequests += 1;
      resolve();
    });
  });
}

function releaseSlot() {
  activeRequests = Math.max(0, activeRequests - 1);
  const next = waiters.shift();
  if (next) next();
}

/**
 * 借用缩略图并发闸门执行任意任务。
 * 视频抓帧与图片缩略图共享同一个闸门，避免两者叠加把解码线程灌满。
 */
export async function withThumbSlot<T>(task: () => Promise<T>): Promise<T> {
  await acquireSlot();
  try {
    return await task();
  } finally {
    releaseSlot();
  }
}

/** 把目标像素对齐到固定档位，让不同缩放级别 / 窗口宽度复用同一份磁盘缓存 */
export function quantizeThumbSize(px: number): number {
  const clamped = Math.max(BASE_THUMB_SIZE, Math.min(MAX_THUMB_SIZE, Math.round(px || 0)));
  return Math.round(clamped / THUMB_SIZE_STEP) * THUMB_SIZE_STEP;
}

const isDataUrl = (url: string): boolean => url.startsWith('data:');

/** 写入缓存：data: URL 走小容量分区，pm:// 地址走常规分区 */
export function cacheThumbUrl(key: string, url: string): void {
  if (isDataUrl(url)) dataUrlCache.set(key, url);
  else resolvedCache.set(key, url);
}

/** 读取缓存（刷新 LRU 顺序） */
export function peekThumbUrl(key: string): string | undefined {
  return resolvedCache.get(key) ?? dataUrlCache.get(key);
}

/** 读取缓存但不改变 LRU 顺序：用于「顺手复用」的场景（如感知哈希取源图） */
export function touchThumbUrl(key: string): string | undefined {
  return resolvedCache.peek(key) ?? dataUrlCache.peek(key);
}

/**
 * 解析某张图的磁盘缩略图地址（按需生成 + 落盘缓存）。
 * 失败返回 null，且不缓存失败结果，下次进入视口可重试。
 */
export async function resolveThumbnail(filePath: string, size: number): Promise<string | null> {
  const target = quantizeThumbSize(size);
  const key = `${filePath}|${target}`;

  const cached = peekThumbUrl(key);
  if (cached) return cached;

  const pending = inflight.get(key);
  if (pending) return pending;

  const born = generation;
  const task = (async () => {
    await acquireSlot();
    try {
      const res = await window.electronAPI.getThumbnail(filePath, target);
      if (!res?.url) return null;
      // 缓存已被清空：丢弃这次结果，否则刚释放的内存立刻被写回
      if (born !== generation) return res.url;
      cacheThumbUrl(key, res.url);
      return res.url;
    } catch {
      return null;
    } finally {
      releaseSlot();
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

/** 仅查询本地缓存中的缩略图地址，不发请求（感知哈希优先用小图做源） */
export function cachedThumbUrl(filePath: string, size: number): string | undefined {
  return touchThumbUrl(`${filePath}|${quantizeThumbSize(size)}`);
}

/** 清空缓存（重置列表时调用） */
export function clearThumbnailCache(): void {
  generation += 1;
  resolvedCache.clear();
  dataUrlCache.clear();
  inflight.clear();
}
