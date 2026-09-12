import React, { useEffect, useState } from 'react';
import { Photo } from '@/types';
import { isVideoPhoto } from '@/utils';
import {
  BASE_THUMB_SIZE,
  cacheThumbUrl,
  peekThumbUrl,
  quantizeThumbSize,
  resolveThumbnail,
  withThumbSlot,
} from '@/lib/cache/thumbCache';
import { reportVideoMetaFromElement, videoMetaKeyOf } from '@/lib/media/videoMeta';

/** 缓存实现已下沉到 thumbCache（与感知哈希共用），这里保持原有导出不变 */
export { BASE_THUMB_SIZE, quantizeThumbSize } from '@/lib/cache/thumbCache';
export { clearThumbnailCache } from '@/lib/cache/thumbCache';

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
        window.clearTimeout(handle as number);
      }
    };
  }, [photo.id, photo.path, photo.thumbnail, photo.url, targetSize, isVideo]);

  return src;
}

// ---------------------------------------------------------------------------
// 视频首帧缩略图
// 主进程无法解码视频：渲染进程用 <video> 定位到首帧位置 → canvas 抓帧 →
// 回写主进程落盘缓存（下次启动直接命中 pm:// 缩略图，无需再解码）。
// ---------------------------------------------------------------------------

/** 视频首帧解析中的任务：同 key 去重，避免快速滚动重复抓帧 */
const posterInflight = new Map<string, Promise<string | null>>();

/** 抓帧位置：太靠 0 容易是黑帧/片头，取 0.1s */
const VIDEO_POSTER_TIME = 0.1;
/** 抓帧超时：损坏或无法解码的容器不应让卡片一直转圈 */
const VIDEO_POSTER_TIMEOUT = 12000;

async function captureVideoPoster(photo: Photo, size: number): Promise<string | null> {
  const source = photo.url;
  if (!source) return null;

  return new Promise<string | null>(resolve => {
    const video = document.createElement('video');
    let settled = false;
    let timer = 0;

    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        /* 忽略 */
      }
      video.remove();
    };

    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const drawFrame = async () => {
      if (settled) return;
      try {
        // 抓帧的同时顺手上报时长 / 分辨率：网格卡片的时长角标与详情面板据此展示
        reportVideoMetaFromElement(videoMetaKeyOf(photo), video);

        const width = video.videoWidth;
        const height = video.videoHeight;
        if (!width || !height) {
          finish(null);
          return;
        }

        const ratio = Math.min(1, size / Math.max(width, height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * ratio));
        canvas.height = Math.max(1, Math.round(height * ratio));
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          finish(null);
          return;
        }

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        // 跨源视频会污染 canvas，此时 toDataURL 抛 SecurityError → 走内存兜底失败
        const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        canvas.width = 0;
        canvas.height = 0;

        const base64 = dataUrl.split(',')[1];
        if (!photo.path || !base64 || !window.electronAPI?.cacheThumbnail) {
          finish(dataUrl);
          return;
        }

        const saved = await window.electronAPI.cacheThumbnail(
          photo.path,
          quantizeThumbSize(size),
          base64
        );
        finish(saved?.url || dataUrl);
      } catch {
        finish(null);
      }
    };

    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    // 只有 pm:// 这类跨源地址需要 CORS；blob: / data: 本身同源，
    // 强行设置 crossOrigin 反而会让请求变成 CORS 模式而失败
    if (!/^(blob|data):/i.test(source)) {
      video.crossOrigin = 'anonymous';
    }
    video.style.position = 'fixed';
    video.style.left = '-9999px';
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';

    video.onloadeddata = () => void drawFrame();
    video.onseeked = () => void drawFrame();
    video.onerror = () => finish(null);

    timer = window.setTimeout(() => finish(null), VIDEO_POSTER_TIMEOUT);

    document.body.appendChild(video);
    video.src = `${source}#t=${VIDEO_POSTER_TIME}`;
    // 部分容器不会触发 loadeddata，主动 seek 一次保证有 seeked 回调
    try {
      video.currentTime = VIDEO_POSTER_TIME;
    } catch {
      /* 忽略 */
    }
  });
}

/** 与图片缩略图共用同一份 pm:// 地址缓存，键前缀区分来源 */
async function resolveVideoPoster(photo: Photo, size: number): Promise<string | null> {
  const target = quantizeThumbSize(size);
  const key = `video|${photo.path || photo.id}|${target}`;

  const cached = peekThumbUrl(key);
  if (cached) return cached;

  const pending = posterInflight.get(key);
  if (pending) return pending;

  const task = withThumbSlot(async () => {
    try {
      // 1) 磁盘缓存优先（上一轮已抓过的帧无需重复解码）
      if (photo.path && window.electronAPI) {
        const res = await window.electronAPI.getThumbnail(photo.path, target);
        if (res?.url) {
          cacheThumbUrl(key, res.url);
          return res.url;
        }
      }
      // 2) 渲染进程抓帧（同时回写磁盘缓存）
      const poster = await captureVideoPoster(photo, target);
      if (poster) {
        // data: URL 由 thumbCache 单独限量，避免大量视频首帧的 base64 常驻内存
        cacheThumbUrl(key, poster);
        return poster;
      }
      return null;
    } catch {
      return null;
    }
  });

  const tracked = task.finally(() => {
    posterInflight.delete(key);
  });

  posterInflight.set(key, tracked);
  return tracked;
}

/**
 * 视频首帧：`src` 就绪前不应回退到原视频（列表/网格里大量 <video> 代价极高），
 * 因此额外暴露 `failed`，由调用方决定是否用 <video> 兜底显示画面。
 */
export function useVideoPoster(photo: Photo, targetSize: number): {
  src: string | null;
  failed: boolean;
} {
  const isVideo = isVideoPhoto(photo);
  const [state, setState] = useState<{ src: string | null; failed: boolean }>({
    src: null,
    failed: false,
  });

  useEffect(() => {
    if (!isVideo) {
      setState({ src: null, failed: false });
      return;
    }

    let cancelled = false;
    setState({ src: null, failed: false });

    const run = async () => {
      const src = await resolveVideoPoster(photo, targetSize);
      if (cancelled) return;
      setState(prev => (prev.src === src && prev.failed === !src ? prev : { src, failed: !src }));
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [photo.id, photo.path, photo.url, targetSize, isVideo]);

  return state;
}

/** 列表 / 详情等固定尺寸场景的缩略图 */
export const ThumbImage: React.FC<{
  photo: Photo;
  size: number;
  className?: string;
  alt?: string;
}> = ({ photo, size, className, alt }) => {
  const isVideo = isVideoPhoto(photo);
  const imageSrc = useThumbnailSrc(photo, size);
  const poster = useVideoPoster(photo, size);

  if (isVideo) {
    if (poster.src) {
      return (
        <img
          src={poster.src}
          alt={alt ?? photo.name}
          loading="lazy"
          decoding="async"
          /* 禁止拖拽：<img> 默认可拖，拖动题图标会弹出全局导入遮罩 */
          draggable={false}
          className={className}
        />
      );
    }
    // 抓帧失败（编码不支持 / 跨源污染）：退回到 <video> 直接渲染首帧
    if (poster.failed) {
      return (
        <video
          src={`${photo.url}#t=${VIDEO_POSTER_TIME}`}
          preload="metadata"
          muted
          playsInline
          onLoadedMetadata={e => reportVideoMetaFromElement(videoMetaKeyOf(photo), e.currentTarget)}
          className={className}
          aria-label={alt ?? photo.name}
        />
      );
    }
    return <div className={className} aria-label={alt ?? photo.name} />;
  }

  // 尚未解析出缩略图时不要回退到原图（列表里加载整张原图代价极高），先占位
  if (!imageSrc) {
    return <div className={className} aria-label={alt ?? photo.name} />;
  }

  return (
    <img
      src={imageSrc}
      alt={alt ?? photo.name}
      loading="lazy"
      decoding="async"
      draggable={false}
      className={className}
    />
  );
};
