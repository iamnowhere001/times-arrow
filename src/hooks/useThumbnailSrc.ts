import { useEffect, useState } from 'react';
import { Photo } from '@/types';
import { isVideoPhoto } from '@/utils';
import {
  BASE_THUMB_SIZE,
  quantizeThumbSize,
  resolveThumbnail,
} from '@/lib/cache/thumbCache';

/**
 * 磁盘缩略图的「按需解析」层。
 *
 * 设计要点：
 * - 导入时不再逐张预生成缩略图（几万张会耗掉数分钟并占满磁盘缓存），
 *   改为卡片真正进入视口时才请求；生成结果由主进程落盘缓存，二次访问零成本。
 * - 渲染进程侧有并发闸门 + 同 key 去重，快速滚动不会瞬间灌入大量任务。
 * - 缓存里的 pm:// 地址只是一串短字符串，而视频首帧兜底的 data: URL 是完整
 *   JPEG base64 —— 后者在 thumbCache 里被单独限量，不会被大库撑爆。
 */

/**
 * 解析「当前渲染尺寸下最合适」的缩略图地址：
 * - `photo.thumbnail` 已存在（小批量 / 拖放降级）→ 先立即显示，再按需升级清晰度；
 * - 不存在（大批量导入）→ 直接请求目标尺寸，一次到位。
 * 解析失败时回退到原图地址，保证 SVG 等无法生成缩略图的格式仍能显示。
 */
export function useThumbnailSrc(photo: Photo, targetSize: number): string | null {
  const baseSrc = photo.thumbnail || null;
  const [src, setSrc] = useState<string | null>(baseSrc);
  const isVideo = isVideoPhoto(photo);

  useEffect(() => {
    setSrc(isVideo ? null : photo.thumbnail || null);
  }, [photo.id, photo.thumbnail, isVideo]);

  useEffect(() => {
    // 视频首帧有独立的解析路径（见 useVideoPoster）
    if (isVideo) return;
    const filePath = photo.path;
    if (!filePath) return;

    const want = quantizeThumbSize(targetSize);
    // 已有基础缩略图，且当前渲染尺寸不需要更大分辨率 → 无需请求
    if (photo.thumbnail && want <= BASE_THUMB_SIZE) return;

    let cancelled = false;
    // 预加载用的 Image 必须显式释放：清空 src 才能让浏览器立刻放弃这张图的解码缓存，
    // 否则快速滚动 / 缩放时会有大量“加载中即被弃用”的 Image 滞留在内存里。
    let preload: HTMLImageElement | null = null;

    const releasePreload = () => {
      if (!preload) return;
      preload.onload = null;
      preload.onerror = null;
      preload.src = '';
      preload = null;
    };

    const run = async () => {
      const url = await resolveThumbnail(filePath, want);
      if (cancelled) return;
      if (!url) {
        // 无法生成缩略图（如 SVG）时回退原图，避免卡片一直空着
        setSrc(prev => prev ?? photo.url);
        return;
      }
      // 先预加载，解码完成后再替换，避免出现空白闪烁
      const pre = new Image();
      preload = pre;
      pre.decoding = 'async';
      pre.onload = () => {
        if (cancelled) return;
        setSrc(url);
      };
      // 预加载失败（缩略图已被清理 / 文件被移走 / 协议偶发失败）必须回退到原图，
      // 交给 <img onError> 出占位与重试按钮；否则卡片会永久停在加载骨架上，
      // 而且因为失败不入缓存，每次滚回视口都会再请求一次，没有上限。
      pre.onerror = () => {
        if (cancelled) return;
        setSrc(prev => prev ?? photo.url);
      };
      pre.src = url;
    };

    // 无占位图时立即请求（尽快填满网格，并发闸门已在 resolveThumbnail 内限流）；
    // 已有占位图时用空闲时间升级分辨率，不抢占首屏
    if (!photo.thumbnail) {
      run();
      return () => {
        cancelled = true;
        releasePreload();
      };
    }

    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const hasIdle = typeof w.requestIdleCallback === 'function';
    const handle = hasIdle
      ? w.requestIdleCallback!(run, { timeout: 600 })
      : window.setTimeout(run, 120);

    return () => {
      cancelled = true;
      releasePreload();
      if (hasIdle && typeof w.cancelIdleCallback === 'function') {
        w.cancelIdleCallback(handle);
      } else {
        window.clearTimeout(handle);
      }
    };
  }, [photo.id, photo.path, photo.thumbnail, photo.url, targetSize, isVideo]);

  return src;
}
