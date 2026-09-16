/**
 * `dhash.cjs` 的类型声明。
 *
 * 实现是 CommonJS（主进程要 `require` 它），而渲染层以 ESM 具名导入的方式使用它 ——
 * Vite 会做 CJS 互操作，TypeScript 则需要这份 `.d.cts` 才能解析出具名导出。
 * 声明与实现必须同步修改。
 */

/** 采样列数（9） */
export declare const HASH_WIDTH: number;
/** 采样行数（8） */
export declare const HASH_HEIGHT: number;
/** 输出十六进制字符数（16，即 64 bit） */
export declare const HASH_HEX_LENGTH: number;

/**
 * 由 RGBA 字节序列计算 64 bit dHash。
 * 字节数不足 `width * height * 4` 时返回 null。
 */
export declare function dHashFromRGBA(
  rgba: Uint8ClampedArray | Uint8Array | Buffer | null | undefined,
  width?: number,
  height?: number
): string | null;

/**
 * 由 BGRA 字节序列计算 64 bit dHash（Electron `nativeImage.toBitmap()` 的排布）。
 * 字节数不足 `width * height * 4` 时返回 null。
 */
export declare function dHashFromBGRA(
  bgra: Uint8ClampedArray | Uint8Array | Buffer | null | undefined,
  width?: number,
  height?: number
): string | null;
