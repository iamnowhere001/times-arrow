/**
 * 拖放降级路径的缩略图生成（从 App 抽出的纯逻辑）。
 *
 * 仅用于「拿不到磁盘路径」的拖放文件：这些文件走内存预览，需要本地 canvas 缩放。
 * 有磁盘路径的照片走主进程磁盘缩略图，不会进入这里。
 *
 * 缓存值是 base64 dataURL，体积远大于 pm:// 地址，因此必须限量并支持统一清理。
 */

import { createLruCache } from '@/lib/cache/cacheManager';
import { logger } from '@/lib/logger';

const dragThumbCache = createLruCache<string, Map<number, string>>('dragThumbnail', 120, 'volatile');

/** 清空拖放缩略图缓存（列表重置时调用，释放 blob/base64 常驻内存） */
export const clearDragThumbnailCache = (): void => dragThumbCache.clear();

/**
 * 用 canvas 生成较小尺寸的缩略图（带按尺寸缓存）。
 * 输入可以是 File（拖放）或已经是 base64 / 图片地址的字符串。
 */
export const createThumbnail = async (input: File | string, maxSize: number = 200): Promise<string> => {
  // Convert File object to base64 first if needed
  let base64Data: string;
  let cacheKey: string;

  if (input instanceof File) {
    // For File objects, use a combination of name and last modified time as cache key
    cacheKey = `${input.name}-${input.lastModified}`;
    base64Data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(input);
    });
  } else {
    // For string URLs, use the URL as cache key
    cacheKey = input;
    base64Data = input;
  }

  // Check if thumbnail already exists in cache
  const sizeKey = Math.round(maxSize); // Round to nearest integer to avoid cache misses
  const sizeCache = dragThumbCache.get(cacheKey);
  if (sizeCache?.has(sizeKey)) {
    return sizeCache.get(sizeKey)!;
  }

  const remember = (value: string) => {
    const bucket = dragThumbCache.get(cacheKey) ?? new Map<number, string>();
    bucket.set(sizeKey, value);
    dragThumbCache.set(cacheKey, bucket);
  };

  // Create thumbnail from base64 data
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // Enable CORS for external images if needed
    img.onload = () => {
      // 尺寸已经够小：仍走一次 canvas，保证进缓存的是「缩略图」而不是整份原图 base64
      if (img.width <= maxSize && img.height <= maxSize) {
        remember(base64Data);
        resolve(base64Data);
        return;
      }

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(base64Data); // Fallback to original if canvas fails
        return;
      }

      // Calculate dimensions maintaining aspect ratio
      let width = img.width;
      let height = img.height;
      if (width > height) {
        if (width > maxSize) {
          height *= maxSize / width;
          width = maxSize;
        }
      } else {
        if (height > maxSize) {
          width *= maxSize / height;
          height = maxSize;
        }
      }

      // Ensure dimensions are integers to avoid rendering artifacts
      width = Math.round(width);
      height = Math.round(height);

      canvas.width = width;
      canvas.height = height;

      // Draw image to canvas with optimized settings for speed
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'low';
      ctx.drawImage(img, 0, 0, width, height);

      const isJPEG = base64Data.startsWith('data:image/jpeg') || base64Data.startsWith('data:image/jpg');
      const thumbnail = canvas.toDataURL(isJPEG ? 'image/jpeg' : 'image/png', isJPEG ? 0.7 : 0.75);

      remember(thumbnail);

      // Clean up immediately to free memory
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();

      resolve(thumbnail);
    };
    img.onerror = () => {
      logger.warn('Thumbnail generation failed, using original image');
      resolve(base64Data); // Fallback to original if image fails to load
    };
    img.src = base64Data;
  });
};
