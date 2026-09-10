/**
 * 视频元数据（时长 / 分辨率）的采集与分发。
 *
 * 主进程用 nativeImage 解不了视频，所以这些信息只能由渲染进程真正加载
 * `<video>` 之后读取。问题是这样拿到的数据分散在各个组件里（网格卡片、详情面板、
 * QuickLook），于是这里做一个极薄的「上报 → 缓存 → 订阅」中枢：
 *
 * - 任何组件加载到视频元数据后 `reportVideoMeta`；
 * - App 订阅一次，把结果回写到 `Photo.duration / dimensions` 并持久化；
 * - 缓存命中的视频（例如重启后）无需再次探测即可显示时长。
 */

import { Photo, VideoMetaRecord } from './types';

export type VideoMeta = VideoMetaRecord;

const cache = new Map<string, VideoMeta>();
const listeners = new Set<(key: string, meta: VideoMeta) => void>();

/** 缓存键：优先磁盘路径（跨重启稳定），无路径时退化为条目 id */
export const videoMetaKeyOf = (photo: Pick<Photo, 'id' | 'path'>): string => photo.path || photo.id;

const isValid = (meta: VideoMeta): boolean =>
  Number.isFinite(meta.duration) &&
  meta.duration > 0 &&
  Number.isFinite(meta.width) &&
  meta.width > 0 &&
  Number.isFinite(meta.height) &&
  meta.height > 0;

/** 读取缓存的视频元数据 */
export const getVideoMeta = (key: string): VideoMeta | undefined => cache.get(key);

/** 批量写入缓存（启动时用持久化的数据预热，不触发监听） */
export const seedVideoMeta = (record: Record<string, VideoMetaRecord> | undefined): void => {
  if (!record) return;
  for (const [key, meta] of Object.entries(record)) {
    if (key && meta && isValid(meta)) cache.set(key, { ...meta });
  }
};

/** 导出当前缓存快照，供持久化使用 */
export const snapshotVideoMeta = (): Record<string, VideoMetaRecord> => {
  const result: Record<string, VideoMetaRecord> = {};
  cache.forEach((meta, key) => {
    result[key] = { ...meta };
  });
  return result;
};

/** 上报并广播；与缓存一致时静默跳过，避免无谓的重渲染 */
export const reportVideoMeta = (key: string, meta: VideoMeta): void => {
  if (!key || !isValid(meta)) return;

  const prev = cache.get(key);
  if (
    prev &&
    prev.duration === meta.duration &&
    prev.width === meta.width &&
    prev.height === meta.height
  ) {
    return;
  }

  cache.set(key, meta);
  listeners.forEach(listener => listener(key, meta));
};

/**
 * 从 `<video>` 元素读取元数据并上报。
 * 部分容器（分片 mp4 / 流式）在 `loadedmetadata` 时 duration 仍为 Infinity，此时视为无效。
 * @returns 是否读到有效元数据
 */
export const reportVideoMetaFromElement = (
  key: string,
  element: HTMLVideoElement | null
): boolean => {
  if (!key || !element) return false;

  const meta: VideoMeta = {
    duration: element.duration,
    width: element.videoWidth,
    height: element.videoHeight,
  };
  if (!isValid(meta)) return false;

  reportVideoMeta(key, meta);
  return true;
};

/** 订阅元数据上报；返回取消订阅函数 */
export const subscribeVideoMeta = (
  listener: (key: string, meta: VideoMeta) => void
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
