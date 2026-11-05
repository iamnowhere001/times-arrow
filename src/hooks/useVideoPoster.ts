import { useEffect, useState } from 'react';
import { Photo } from '@/types';
import { isVideoPhoto } from '@/utils';
import {
  cacheThumbUrl,
  fetchDiskThumbnail,
  peekThumbUrl,
  quantizeThumbSize,
  storeThumbnail,
  withThumbSlot,
} from '@/lib/cache/thumbCache';
import { reportVideoMetaFromElement, videoMetaKeyOf } from '@/lib/media/videoMeta';

// ---------------------------------------------------------------------------
// 视频首帧缩略图
// 主进程无法解码视频：渲染进程用 <video> 定位到首帧位置 → canvas 抓帧 →
// 回写主进程落盘缓存（下次启动直接命中 pm:// 缩略图，无需再解码）。
// ---------------------------------------------------------------------------

/** 视频首帧解析中的任务：同 key 去重，避免快速滚动重复抓帧 */
const posterInflight = new Map<string, Promise<string | null>>();

/** 抓帧位置：太靠 0 容易是黑帧/片头，取 0.1s */
export const VIDEO_POSTER_TIME = 0.1;
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
        if (!photo.path || !base64) {
          finish(dataUrl);
          return;
        }

        // 落盘失败（接口不可用 / 写盘失败）时退回内存 data URL，至少当次能显示
        const saved = await storeThumbnail(photo.path, size, base64);
        finish(saved ?? dataUrl);
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
      if (photo.path) {
        const url = await fetchDiskThumbnail(photo.path, target);
        if (url) {
          cacheThumbUrl(key, url);
          return url;
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps — 解析只依赖 id/path/url，photo 对象身份变化不应触发重新抓帧
  }, [photo.id, photo.path, photo.url, targetSize, isVideo]);

  return state;
}
