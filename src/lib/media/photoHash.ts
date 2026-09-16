/**
 * 感知哈希（dHash）与汉明距离。
 *
 * ## 算法本体在哪
 * 真正的算法在 `electron/lib/dhash.cjs` —— **主进程与渲染层共用同一份实现**。
 * 改造前两处各有一份手写副本，任一处被改动都会让同一张图算出不同哈希，
 * 而重复检测正是拿哈希互相比较的，于是会静默漏判或误判。
 *
 * ## 三级解码降级
 * 计算哈希需要先把图缩到 9x8，不同来源的解码能力不同，因此依次尝试：
 *   1. 渲染进程 `createImageBitmap` —— 解码期直接缩放到 9x8，并行执行，最快；
 *   2. 主进程 `nativeImage` —— 可复用已落盘缩略图，覆盖浏览器解不了的格式（HEIC 等）；
 *   3. 渲染进程 `<img>` + canvas —— SVG 等最后的兜底。
 * 本模块提供第 1、3 级；第 2 级由调用方经 `get-image-hashes` IPC 走主进程。
 */

import { Photo } from '@/types';
import { createLruCache } from '@/lib/cache/cacheManager';
import { HASH_WIDTH, HASH_HEIGHT, dHashFromRGBA } from '../../../electron/lib/dhash.cjs';

/** 由 9x8 的 RGBA 像素计算 64 bit dHash（十六进制） */
const dHashFromPixels = (data: Uint8ClampedArray): string => {
  const hash = dHashFromRGBA(data, HASH_WIDTH, HASH_HEIGHT);
  if (!hash) {
    throw new Error(
      `dHash 输入尺寸不合法：期望 ${HASH_WIDTH * HASH_HEIGHT * 4} 字节，实际 ${data?.length ?? 0}`
    );
  }
  return hash;
};

/**
 * 改进的差异哈希(dHash)算法实现，对压缩和尺寸变化更鲁棒。
 * 走 `<img>` + canvas：兼容性最好（含 SVG），但需要先物化整张图。
 */
export const getImageHash = async (imageUrl: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to get canvas context'));
        return;
      }

      canvas.width = HASH_WIDTH;
      canvas.height = HASH_HEIGHT;
      ctx.drawImage(img, 0, 0, HASH_WIDTH, HASH_HEIGHT);

      resolve(dHashFromPixels(ctx.getImageData(0, 0, HASH_WIDTH, HASH_HEIGHT).data));
    };

    img.onerror = () => {
      reject(new Error(`Failed to load image`));
    };

    img.src = imageUrl;
  });
};

/**
 * 更快的 dHash：用 createImageBitmap 让浏览器在「解码阶段」就把图像缩到 9x8，
 * 不再物化整张全尺寸位图。相比「完整解码 → canvas 缩小」可快数倍，
 * 且 Chromium 的解码在工作线程上并行执行，几千张时是主要的提速点。
 *
 * 少数格式（SVG、部分 HEIC）不支持该路径，会抛错交由调用方兜底。
 */
export const getImageHashFast = async (imageUrl: string): Promise<string> => {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
  const blob = await response.blob();

  const bitmap = await createImageBitmap(blob, {
    resizeWidth: HASH_WIDTH,
    resizeHeight: HASH_HEIGHT,
    // 用 medium 而非 low：9x8 的降采样跨度极大，过低质量会引入混叠噪声，
    // 使本不相似的图片哈希距离变小（假重复）
    resizeQuality: 'medium',
  });

  try {
    const canvas = document.createElement('canvas');
    canvas.width = HASH_WIDTH;
    canvas.height = HASH_HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get canvas context');

    ctx.drawImage(bitmap, 0, 0, HASH_WIDTH, HASH_HEIGHT);
    return dHashFromPixels(ctx.getImageData(0, 0, HASH_WIDTH, HASH_HEIGHT).data);
  } finally {
    bitmap.close?.();
  }
};

/**
 * 汉明距离：两个 16 进制哈希之间不同 bit 的数量。
 *
 * 必须逐字符解析后按位异或，不能按字符比较 —— 一个 nibble 差 1 bit 与差 4 bit
 * 在字符串比较里都是「不相等」，但相似度差了四倍。
 * 任一哈希缺失或含非法字符时返回 `MAX_SAFE_INTEGER`（视为最不相似）。
 */
export const hammingDistance = (hash1: string, hash2: string): number => {
  if (!hash1 || !hash2) return Number.MAX_SAFE_INTEGER;

  let distance = 0;
  const length = Math.max(hash1.length, hash2.length);

  for (let i = 0; i < length; i++) {
    const a = parseInt(hash1[i] || '0', 16);
    const b = parseInt(hash2[i] || '0', 16);
    if (Number.isNaN(a) || Number.isNaN(b)) return Number.MAX_SAFE_INTEGER;

    let xor = a ^ b;
    while (xor !== 0) {
      distance += xor & 1;
      xor >>= 1;
    }
  }

  return distance;
};

/**
 * 哈希缓存以「路径 + 大小 + 修改时间」为 key。
 * 不每次检测前清空，重复检测可以增量复用。
 *
 * 必须限量：key 是完整磁盘路径（通常 60~120 字节），
 * 无上限时十万级图库会永久占用几十 MB 且不释放。
 * 这里用 LRU（命中刷新、超限逐项淘汰），淘汰只影响重算一次的代价。
 */
const HASH_CACHE_LIMIT = 20000;
export const imageHashCache = createLruCache<string, string>('imageHash', HASH_CACHE_LIMIT, 'sticky');

/** 清空指纹缓存：切换图库 / 释放内存时用 */
export const clearImageHashCache = (): void => imageHashCache.clear();

/** 缓存 key：优先用「路径 + 大小 + 修改时间」（文件换内容即失效），无路径时退回 id */
export const hashKeyOf = (photo: Photo): string =>
  photo.path
    ? `${photo.path}|${photo.size}|${photo.lastModified}`
    : `${photo.id}|${photo.lastModified}`;

/** 取哈希（命中缓存直接返回），失败返回 null —— 单张算不出哈希不该中断整轮检测 */
export const getHashWithCache = async (photo: Photo): Promise<string | null> => {
  const key = hashKeyOf(photo);
  const cached = imageHashCache.get(key);
  if (cached) return cached;

  // 优先用缩略图计算 dHash：解码成本远低于全尺寸图
  const source = photo.thumbnail || photo.url;
  if (!source) return null;

  try {
    const hash = await getImageHash(source);
    imageHashCache.set(key, hash);
    return hash;
  } catch {
    return null;
  }
};
