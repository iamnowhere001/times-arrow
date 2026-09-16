/**
 * dHash（差异哈希）的**唯一实现**。
 *
 * ## 为什么必须只有一份
 *
 * 改造前这个算法有两份独立实现：主进程 `electron/main.js` 的 `dHashFromBitmap`
 * 与渲染层 `src/utils/index.ts` 的 `dHashFromPixels`。两者是同一算法的两次手写，
 * 只要其中任意一处被改动（亮度权重、采样尺寸、比较方向、位打包顺序），
 * 同一张图在两处就会算出**不同的哈希** —— 而重复检测是拿哈希互相比较的，
 * 于是会静默地漏判或误判，且没有任何报错。
 *
 * 现在算法本体只在这里定义一次，两边都从这里取：
 *   - 主进程：`require('./lib/dhash.cjs')`（本文件是 CJS）
 *   - 渲染层：`import { dHashFromRGBA } from '.../dhash.cjs'`（Vite 会做 CJS 互操作）
 * `tests/unit/dhash.test.ts` 用固定向量 + 跨入口一致性断言守着这条约束。
 *
 * ## 仍然存在的差异（不是算法问题）
 *
 * 「把原图缩到 9x8」这一步两边用的工具不同：主进程是 `nativeImage.resize`，
 * 渲染层是 `createImageBitmap` / canvas `drawImage`。重采样算法不同，
 * 极少数处在阈值边界的像素可能翻转，从而让哈希差 1~2 bit。
 * 因此渲染层的实现**只作为主进程不可用时的降级路径**（如主进程解不了的 SVG），
 * 正常流程一律走 `get-image-hashes` 由主进程算。
 */

/** 采样尺寸：9 列 × 8 行，每行 8 次相邻比较 → 64 bit */
const HASH_WIDTH = 9;
const HASH_HEIGHT = 8;

/**
 * 亮度权重（Rec.601）。
 * 两处实现必须完全一致 —— 改这里等于同时改两边，这正是收敛的意义。
 */
const LUMA_R = 0.299;
const LUMA_G = 0.587;
const LUMA_B = 0.114;

/** 64 bit 打包成 16 个十六进制字符 */
const HASH_HEX_LENGTH = ((HASH_WIDTH - 1) * HASH_HEIGHT) / 4;

/**
 * 逐行做相邻比较并打包成十六进制。
 * 每个 nibble 里，**先比较出的 bit 占高位**（与原两份实现一致）。
 */
function bitsToHex(gray, width, height) {
  let hex = '';
  let nibble = 0;
  let filled = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const idx = y * width + x;
      // 严格大于记 1；相等记 0（与原实现一致，别改成 >=）
      nibble = (nibble << 1) | (gray[idx] > gray[idx + 1] ? 1 : 0);
      filled += 1;
      if (filled === 4) {
        hex += nibble.toString(16);
        nibble = 0;
        filled = 0;
      }
    }
  }

  // 位宽不是 4 的倍数时补齐低位。9x8 恰好是 64 bit，走不到这里；
  // 留着是为了换采样尺寸时不会静默产出短哈希。
  if (filled > 0) hex += (nibble << (4 - filled)).toString(16);

  return hex;
}

/**
 * 由 **RGBA** 字节序列计算 64 bit dHash。
 * 渲染层的 canvas `getImageData().data` 就是这个排布。
 * 字节数不足 `width * height * 4` 时返回 null（宁可不给哈希，也不要给出错的）。
 */
function dHashFromRGBA(rgba, width = HASH_WIDTH, height = HASH_HEIGHT) {
  if (!rgba || rgba.length < width * height * 4) return null;

  const gray = new Float64Array(width * height);
  for (let i = 0, p = 0; p < gray.length; i += 4, p += 1) {
    gray[p] = LUMA_R * rgba[i] + LUMA_G * rgba[i + 1] + LUMA_B * rgba[i + 2];
  }
  return bitsToHex(gray, width, height);
}

/**
 * 由 **BGRA** 字节序列计算 64 bit dHash。
 * Electron 的 `nativeImage.toBitmap()` 返回的就是这个排布（B 在前，R 在 i+2）。
 */
function dHashFromBGRA(bgra, width = HASH_WIDTH, height = HASH_HEIGHT) {
  if (!bgra || bgra.length < width * height * 4) return null;

  const gray = new Float64Array(width * height);
  for (let i = 0, p = 0; p < gray.length; i += 4, p += 1) {
    gray[p] = LUMA_R * bgra[i + 2] + LUMA_G * bgra[i + 1] + LUMA_B * bgra[i];
  }
  return bitsToHex(gray, width, height);
}

module.exports = {
  HASH_WIDTH,
  HASH_HEIGHT,
  HASH_HEX_LENGTH,
  dHashFromRGBA,
  dHashFromBGRA,
};
