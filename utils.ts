
import { MediaKind, Photo, RepairNameOptions } from './types';
import { createLruCache } from './cacheManager';
import { BASE_THUMB_SIZE, cachedThumbUrl } from './thumbCache';

// ---------------------------------------------------------------------------
// 媒体类型判定（与主进程 main.js 的 IMAGE_EXTENSIONS / VIDEO_EXTENSIONS 保持一致）
// ---------------------------------------------------------------------------

/** 图片扩展名（不含点） */
export const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'heic', 'heif', 'avif', 'bmp', 'tif', 'tiff',
]);

/** 视频扩展名（不含点） */
export const VIDEO_EXTENSIONS = new Set([
  'mp4', 'm4v', 'mov', 'webm', 'ogv', 'ogg', 'mkv', 'avi', 'wmv', 'flv',
  '3gp', '3g2', 'mpeg', 'mpg', 'm2ts', 'mts', 'ts', 'asf', 'rm', 'rmvb',
  'vob', 'f4v', 'divx', 'dv', 'mxf',
]);

/** 视频扩展名 → MIME */
const VIDEO_MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  ogg: 'video/ogg',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
  m2ts: 'video/mp2t',
  mts: 'video/mp2t',
  ts: 'video/mp2t',
  asf: 'video/x-ms-asf',
  vob: 'video/dvd',
  f4v: 'video/x-f4v',
  mxf: 'application/mxf',
};

/**
 * 取文件所在目录（保留原分隔符风格）。
 * 用于「同一目录内才算重名」的判断：不同文件夹下的同名文件不应互相加序号。
 */
export const folderOfPath = (fullPath: string): string => {
  if (!fullPath) return '';
  const idx = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'));
  return idx > 0 ? fullPath.slice(0, idx) : '';
};

/** 取文件扩展名（小写，不含点） */
export const extOfName = (name: string): string => {
  const idx = name.lastIndexOf('.');
  if (idx < 0 || idx === name.length - 1) return '';
  return name.slice(idx + 1).toLowerCase();
};

export const isVideoName = (name: string): boolean => VIDEO_EXTENSIONS.has(extOfName(name));
export const isImageName = (name: string): boolean => IMAGE_EXTENSIONS.has(extOfName(name));

/** 文件名 / 路径 → 媒体类型 */
export const mediaKindOf = (name: string): MediaKind => (isVideoName(name) ? 'video' : 'image');

/** 文件名 → MIME（HEIC 统一按 JPEG 处理，因为主进程会转码后提供） */
export const mediaMimeType = (name: string): string => {
  const ext = extOfName(name);
  if (VIDEO_EXTENSIONS.has(ext)) return VIDEO_MIME_BY_EXT[ext] || 'video/mp4';
  if (ext === 'heic' || ext === 'heif') return 'image/jpeg';
  return `image/${ext || 'jpeg'}`;
};

/** 是否为视频条目（兼容旧数据：未写入 kind 时按扩展名推断） */
export const isVideoPhoto = (photo: Photo): boolean =>
  photo.kind ? photo.kind === 'video' : isVideoName(photo.name);

/** 秒 → 「1:23」/「1:02:03」；未知或无效时返回空串 */
export const formatVideoDuration = (seconds?: number): string => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
};

/**
 * Chromium 内置解码器大多能直接播放的容器。
 * 其余容器（mkv / avi / wmv / rmvb …）仍可导入与整理，但能否播放取决于封装内的编码，
 * 因此只在界面上给出「可能无法播放」的提示，而不是直接禁用。
 */
const COMMONLY_PLAYABLE_VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm']);

/** 该视频的容器是否「可播放性不确定」，用于提示用户可能需要外部播放器 */
export const isVideoPlaybackUncertain = (name: string): boolean =>
  isVideoName(name) && !COMMONLY_PLAYABLE_VIDEO_EXTS.has(extOfName(name));

export const formatBytes = (bytes: number, decimals = 2) => {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

export const formatDate = (timestamp: number) => {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

/**
 * 把磁盘绝对路径转成 pm:// 原图地址。
 * 图片通过自定义协议以流方式加载，不再以 base64 data URL 常驻内存。
 * 必须使用 pm://<host>/... 形式（pm:///... 的空 host 会被 Chromium 折叠导致解析错位）。
 */
export const pmFileUrl = (filePath: string): string => {
  const bytes = new TextEncoder().encode(filePath);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64url = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `pm://local/file/${base64url}`;
};

export const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      // Remove data url prefix (e.g. "data:image/jpeg;base64,")
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = error => reject(error);
  });
};

// 重复图片检测相关函数

/** dHash 的固定采样尺寸：9x8，每行 8 次相邻比较 → 64 bit（与主进程实现一致） */
const HASH_WIDTH = 9;
const HASH_HEIGHT = 8;

/** 由 9x8 的 RGBA 像素计算 64 bit dHash（十六进制） */
const dHashFromPixels = (data: Uint8ClampedArray): string => {
  const grayscale: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    grayscale.push(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
  }

  const hashBits: boolean[] = [];
  for (let y = 0; y < HASH_HEIGHT; y++) {
    for (let x = 0; x < HASH_WIDTH - 1; x++) {
      const idx = y * HASH_WIDTH + x;
      hashBits.push(grayscale[idx] > grayscale[idx + 1]);
    }
  }

  let hexHash = '';
  for (let i = 0; i < hashBits.length; i += 4) {
    let nibble = 0;
    if (hashBits[i]) nibble += 8;
    if (hashBits[i + 1]) nibble += 4;
    if (hashBits[i + 2]) nibble += 2;
    if (hashBits[i + 3]) nibble += 1;
    hexHash += nibble.toString(16);
  }

  return hexHash;
};

// 改进的差异哈希(dHash)算法实现，对压缩和尺寸变化更鲁棒
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
const getImageHashFast = async (imageUrl: string): Promise<string> => {
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
 * 计算汉明距离（按 bit 比较）。
 * 注意：哈希是十六进制字符串，一个字符 = 4 bit，
 * 必须逐字符解析后按位异或，不能按字符比较。
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
 * 照片的「原始时间」基准：EXIF 拍摄时间 > 文件创建时间 > 文件修改时间。
 * 重复组里这个值最小的一张，就是最早的原始照片。
 */
export const photoOriginalTime = (photo: Photo): number =>
  photo.dateTaken || photo.dateCreated || photo.lastModified || 0;

/** 单个时间字段的比较：早的在前，缺失的排最后 */
const compareTimeField = (a?: number, b?: number): number => {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a - b;
};

/**
 * 比较两张照片谁更「原始」（越小越原始）。
 * 依次比较：拍摄时间 → 文件创建时间 → 文件修改时间；
 * 完全相同时保留文件更大的那份（通常质量更高）。
 *
 * 拷贝件会继承 EXIF 拍摄时间，所以真正区分原图与拷贝的是创建时间。
 */
export const compareByOriginalTime = (a: Photo, b: Photo): number => {
  return (
    compareTimeField(a.dateTaken, b.dateTaken) ||
    compareTimeField(a.dateCreated, b.dateCreated) ||
    compareTimeField(a.lastModified, b.lastModified) ||
    (b.size || 0) - (a.size || 0)
  );
};

/**
 * 按指定占位符格式把日期转成可用于文件名的字符串。
 * 支持：yyyy / MM / dd / HH / mm / ss。
 * 渲染端（RenameModal 预览）与执行端（App 批量重命名）共用，保证预览即所得。
 */
export const formatDateForNaming = (date: Date, format: string): string => {
  const map: Record<string, string> = {
    yyyy: String(date.getFullYear()),
    MM: String(date.getMonth() + 1).padStart(2, '0'),
    dd: String(date.getDate()).padStart(2, '0'),
    HH: String(date.getHours()).padStart(2, '0'),
    mm: String(date.getMinutes()).padStart(2, '0'),
    ss: String(date.getSeconds()).padStart(2, '0'),
  };
  return format.replace(/yyyy|MM|dd|HH|mm|ss/g, (token) => map[token]);
};

const REPLACEMENT_CHAR = '\uFFFD';

/** 中日韩文字 / 假名：出现即说明这段文本已经是正常可读的中文、日文 */
const CJK_TEXT = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 可读字符：CJK、拉丁字母、数字 */
const READABLE_TEXT = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[A-Za-z0-9]/;

/**
 * 名称是否「看起来像乱码」。
 * 典型场景：UTF-8 或 GBK 编码的中文文件名被按 Latin-1 / Windows-1252 解码，
 * 于是出现成片的 Ã å æ ç º £ µ 等补充区字符（如「æµ·æ»¨」）。
 */
export const looksLikeMojibake = (text: string): boolean => {
  if (!text) return false;
  if (text.includes(REPLACEMENT_CHAR)) return true;
  const hinted = text.match(/[\u00a0-\u00ff]/g)?.length ?? 0;
  if (hinted < 2) return false;
  // 已经含中日韩文字，说明解码正确，不需要修复
  if (CJK_TEXT.test(text)) return false;
  return hinted / text.length >= 0.2 || hinted >= 4;
};

/** 把字符串按「一个字符 = 一个字节」还原成字节序列（Latin-1 误解码的逆操作）；含非单字节字符则返回 null */
const toSingleByteArray = (text: string): Uint8Array | null => {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 0xff) return null;
    bytes[i] = code;
  }
  return bytes;
};

/** 依次尝试常见编码：UTF-8 最普遍，其次中文 GBK，再退到 Big5 / Shift-JIS */
const MOJIBAKE_ENCODINGS = ['utf-8', 'gbk', 'big5', 'shift_jis'];

/** 修复单层乱码；无法修复时返回 null */
export const fixMojibakeOnce = (text: string): string | null => {
  if (!looksLikeMojibake(text)) return null;
  const bytes = toSingleByteArray(text);
  if (!bytes) return null;

  for (const encoding of MOJIBAKE_ENCODINGS) {
    let decoded: string;
    try {
      decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      continue; // 该编码解不出合法字节序列
    }
    if (!decoded || decoded === text) continue;
    if (decoded.includes(REPLACEMENT_CHAR)) continue;
    if (looksLikeMojibake(decoded)) continue; // 还是乱码，换下一种编码
    if (READABLE_TEXT.test(decoded)) return decoded;
  }
  return null;
};

/** 最多修两层，兼容「UTF-8 → Latin-1 → Latin-1」这类双重误解码 */
export const fixMojibake = (text: string): string | null => {
  const once = fixMojibakeOnce(text);
  if (!once) return null;
  return fixMojibakeOnce(once) ?? once;
};

export interface RepairedName {
  /** 处理后的完整文件名（含扩展名） */
  name: string;
  /** 处理说明，用于预览展示 */
  notes: string[];
  /** 是否与原名不同 */
  changed: boolean;
  /** 处理后名称是否仍含可读信息 */
  meaningful: boolean;
}

/**
 * 清理一个文件名：修复乱码 → 去掉重复标记 → 去掉无意义前缀 → 归一化空白，
 * 最终仍无意义时（可选）改用拍摄时间命名。
 * 预览与真正执行都走这个函数，保证「预览即所得」。
 */
export const repairFileName = (
  fileName: string,
  options: RepairNameOptions,
  dateSource?: number
): RepairedName => {
  const ext = extOfName(fileName);
  const extSuffix = ext ? `.${ext}` : '';
  const originalStem = ext ? fileName.slice(0, fileName.length - ext.length - 1) : fileName;

  let stem = originalStem;
  const notes: string[] = [];

  if (options.fixMojibake) {
    const fixed = fixMojibake(stem);
    if (fixed && fixed !== stem) {
      stem = fixed;
      notes.push('乱码已修复');
    }
  }

  if (options.stripCopyMarks) {
    let current = stem;
    // 反复剥离，覆盖「xxx (1) - 副本」这类叠加标记
    for (let guard = 0; guard < 5; guard += 1) {
      let next = current;
      for (const pattern of COPY_MARK_PATTERNS) next = next.replace(pattern, '');
      if (next === current) break;
      current = next;
    }
    if (current !== stem) {
      stem = current;
      notes.push('去掉重复标记');
    }
  }

  if (options.stripJunkPrefix) {
    let next = stem;
    if (MEANINGLESS_STEM_PATTERNS.some((pattern) => pattern.test(next.trim()))) {
      next = ''; // 整段就是自动生成的垃圾名（IMG_2639、纯哈希…）
    } else {
      const stripped = next.replace(NOISE_PREFIX_PATTERN, '');
      if (stripped !== next && READABLE_TEXT.test(stripped)) next = stripped;
    }
    if (next !== stem) {
      stem = next;
      notes.push('去掉无意义前缀');
    }
  }

  const normalized = stem
    .replace(/[\u3000\s]+/g, ' ')
    .replace(/[\s_-]{2,}/g, '_')
    .replace(/^[\s_\-._]+|[\s_\-.]+$/g, '');
  if (normalized !== stem) {
    stem = normalized;
    notes.push('规范化空白');
  }

  let meaningful = READABLE_TEXT.test(stem);
  if (!meaningful) {
    if (options.fallbackToDate) {
      const when = new Date(dateSource || Date.now());
      stem = `${options.datePrefix ?? 'photo_'}${formatDateForNaming(when, options.dateFormat || 'yyyy-MM-dd_HHmmss')}`;
      notes.push('名称无意义，改用拍摄时间');
      meaningful = true;
    } else {
      stem = originalStem;
      notes.push('无法生成可用名称，保持原样');
    }
  }

  const name = `${stem}${extSuffix}`;
  return { name, notes, changed: name !== fileName, meaningful };
};

/**
 * 命中说明这个 stem 已经不含任何可读信息（纯序号 / 哈希 / UUID 等自动命名）。
 * 例如 IMG_2639、DSC01234、mmexport1712345678901、a3f9c2b1d4e5f607、UUID。
 */
const MEANINGLESS_STEM_PATTERNS: RegExp[] = [
  /^(?:img|dsc[nf]?|dji|gopr|p|mvimg|image|photo|pic|picture|mmexport|mm|wx[_-]?camera|wechat(?:image)?|screenshot|screen[_-]?shot|截屏|截图|屏幕快照|微信图片)[\s_-]*\d*$/i,
  /^\d+$/,
  /^[0-9a-f]{16,}$/i,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
];

/**
 * 前缀噪音：命中且「去掉后仍有可读内容」时才剥离。
 * 英文前缀必须跟分隔符或 3 位以上数字，避免误伤 picnic / photos 这类正常名称。
 */
const NOISE_PREFIX_PATTERN =
  /^(?:(?:mmexport|wechat(?:image)?|wx[_-]?camera|screenshot|screen[_-]?shot|img|dsc[nf]?|dji|gopr|mvimg|image|photo|pic|picture)(?:[\s_-]+\d*|\d{3,})|(?:截屏|截图|屏幕快照|微信图片)[\s_-]*\d*)[\s_-]*/i;

/** 重复标记：xxx (1)、xxx - 副本、xxx copy 2 … */
const COPY_MARK_PATTERNS: RegExp[] = [
  /[\s_-]*[（(]\s*\d+\s*[)）]\s*$/,
  /[\s_-]*(?:的副本|副本|拷贝|复件)(?:\s*\d+)?\s*$/,
  /[\s_-]*(?:copy|copia)(?:\s*\d+)?\s*$/i,
];

// --- 重复检测：全局哈希 + 精确分组 + 受控的相似度聚类 ---

type HashedEntry = { photo: Photo; hash: string };

export type DuplicateScanPhase = 'hashing' | 'comparing' | 'done';

/** 重复检测进度：张数、阶段、已用时与预计剩余时间 */
export interface DuplicateScanProgress {
  /** 已处理张数（含缓存命中与预筛跳过） */
  processed: number;
  /** 参与检测的图片总数 */
  total: number;
  /** 需要计算指纹的张数（已排除体积唯一被跳过的图片） */
  candidates: number;
  /** 命中缓存、无需重算的张数 */
  cached: number;
  /** 因体积唯一而跳过比对的张数 */
  skipped: number;
  /** 已耗时（毫秒） */
  elapsedMs: number;
  /** 预计剩余毫秒；无法估算时为 undefined */
  etaMs?: number;
  phase: DuplicateScanPhase;
}

export type DuplicateProgressHandler = (progress: DuplicateScanProgress) => void;

/**
 * 哈希缓存以「路径 + 大小 + 修改时间」为 key。
 * 不再每次检测前清空，重复检测可以增量复用。
 *
 * 必须限量：key 是完整磁盘路径（通常 60~120 字节），
 * 无上限时十万级图库会永久占用几十 MB 且不释放。
 * 这里用 LRU（命中刷新、超限逐项淘汰），淘汰只影响重算一次的代价。
 */
const HASH_CACHE_LIMIT = 20000;
const imageHashCache = createLruCache<string, string>('imageHash', HASH_CACHE_LIMIT, 'sticky');

/** 清空指纹缓存：切换图库 / 释放内存时用 */
export const clearImageHashCache = (): void => imageHashCache.clear();

const hashKeyOf = (photo: Photo): string =>
  photo.path
    ? `${photo.path}|${photo.size}|${photo.lastModified}`
    : `${photo.id}|${photo.lastModified}`;

const getHashWithCache = async (photo: Photo): Promise<string | null> => {
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

/**
 * 并发受控的 map：限制同时进行的任务数，避免一次性解码 / IPC 造成内存或句柄尖峰。
 * 渲染进程的缩略图哈希与元数据补齐共用这一实现。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  /** 返回 true 时停止领取新任务（用于取消），已在跑的任务不被打断 */
  shouldStop?: () => boolean
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(Math.max(concurrency, 1), items.length) }, async () => {
    while (cursor < items.length) {
      if (shouldStop?.()) return;
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

/** 并查集：O(n·α(n)) 归并相似图片 */
class UnionFind {
  private parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[x] !== root) {
      const next = this.parent[x];
      this.parent[x] = root;
      x = next;
    }
    return root;
  }

  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

// 单个体积簇内参与「近似匹配」的上限，超过则只保留精确匹配（防止 O(n²) 退化）
const SIMILAR_CLUSTER_LIMIT = 150;

/** 按文件大小聚类（±10%），把近似比较限制在体积相近的候选集内 */
const clusterBySize = (entries: HashedEntry[]): HashedEntry[][] => {
  const sorted = [...entries].sort((a, b) => (a.photo.size || 0) - (b.photo.size || 0));
  const clusters: HashedEntry[][] = [];
  let current: HashedEntry[] = [];
  let anchor = 0;

  for (const entry of sorted) {
    const size = entry.photo.size || 0;
    if (current.length === 0) {
      current.push(entry);
      anchor = size;
      continue;
    }
    if (anchor > 0 && Math.abs(size - anchor) / anchor <= 0.1) {
      current.push(entry);
    } else {
      clusters.push(current);
      current = [entry];
      anchor = size;
    }
  }

  if (current.length > 0) clusters.push(current);
  return clusters;
};

/**
 * 标注「建议保留」的原始照片，并把组内按时间升序排列，
 * 让最早的原图固定出现在第一位，方便用户直接对比拷贝。
 */
export const markRecommended = (group: Photo[]): Photo[] => {
  const sorted = [...group].sort(compareByOriginalTime);
  const recommended = sorted[0];
  return sorted.map(photo => ({ ...photo, isRecommended: photo.id === recommended.id }));
};

/** 渲染进程并行解码的并发度：Chromium 的解码在工作线程上执行，适度并行即可跑满 CPU */
const HASH_CONCURRENCY = 6;
/** 主进程同一批处理的张数：分批既能让进度条实时走动，也避免单次 IPC 长时间不返回 */
const HASH_IPC_BATCH = 64;
/** 快速路径熔断阈值：前若干张全部失败即认为该环境不支持，不再重试 */
const FAST_PATH_PROBE_LIMIT = 6;

/** 快速解码路径是否可用：null 表示尚未探测 */
let fastHashAvailable: boolean | null = null;

/** 让出主线程一个宏任务：让滚动 / 点击这类交互有机会插进来 */
const yieldToMain = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/**
 * 补全 dHash（按快慢依次降级）：
 * 1. 渲染进程 createImageBitmap —— 解码期直接缩放到 9x8，并行执行，最快；
 * 2. 主进程 nativeImage —— 可复用已落盘缩略图，覆盖浏览器解不了的格式；
 * 3. 渲染进程 <img> + canvas —— SVG 等最后的兜底。
 * 每完成一批就回调一次，保证进度与剩余时间实时更新。
 *
 * 全程支持取消：大库跑一半用户点「取消」时，不应继续占用 CPU / 内存。
 */
async function precomputeHashes(
  photos: Photo[],
  onProgressDelta: (count: number) => void,
  shouldCancel: () => boolean
): Promise<void> {
  const pending: Photo[] = [];

  for (const photo of photos) {
    if (imageHashCache.has(hashKeyOf(photo))) onProgressDelta(1);
    else pending.push(photo);
  }
  if (pending.length === 0) return;

  // 1) 浏览器并行解码（主要提速路径）
  const unresolved: Photo[] = [];
  let fastAttempts = 0;
  let fastFailures = 0;

  await mapWithConcurrency(
    pending,
    HASH_CONCURRENCY,
    async photo => {
      // 已有磁盘缩略图时优先用它做源：解码 320px 小图远比把整张原图拉进内存划算，
      // 也顺带复用了网格已经解析过的那份缓存（不产生额外 IPC）
      const source =
        photo.thumbnail || (photo.path ? cachedThumbUrl(photo.path, BASE_THUMB_SIZE) : '') || photo.url;
      if (fastHashAvailable === false || !source) {
        unresolved.push(photo);
        return;
      }
      fastAttempts += 1;
      try {
        const hash = await getImageHashFast(source);
        if (!hash) throw new Error('empty hash');
        fastHashAvailable = true;
        imageHashCache.set(hashKeyOf(photo), hash);
        onProgressDelta(1);
      } catch {
        fastFailures += 1;
        // 前若干张全部失败 → 判定当前环境不支持，余下直接走兜底，避免整轮无效重试
        if (fastAttempts >= FAST_PATH_PROBE_LIMIT && fastFailures === fastAttempts) {
          fastHashAvailable = false;
        }
        unresolved.push(photo);
      }
    },
    shouldCancel
  );

  if (unresolved.length === 0 || shouldCancel()) return;

  // 2) 主进程兜底（分批，可复用磁盘缩略图）
  const withPath = unresolved.filter(photo => photo.path);
  const attempted = new Set<string>();

  if (window.electronAPI && withPath.length > 0) {
    for (let start = 0; start < withPath.length; start += HASH_IPC_BATCH) {
      if (shouldCancel()) return;
      const slice = withPath.slice(start, start + HASH_IPC_BATCH);
      let hashes: Array<string | null> | null = null;
      try {
        hashes = await window.electronAPI.getImageHashes(slice.map(photo => photo.path as string));
      } catch {
        hashes = null;
      }
      // 主进程不可用：本批不做标记，交给下面的逐张兜底
      if (!hashes || hashes.length !== slice.length) break;

      hashes.forEach((hash, index) => {
        const photo = slice[index];
        attempted.add(photo.id);
        if (hash) imageHashCache.set(hashKeyOf(photo), hash);
      });
      onProgressDelta(slice.length);
    }
  }

  // 3) 渲染进程 <img> + canvas 兜底（SVG 等）
  const lastResort = unresolved.filter(photo => !attempted.has(photo.id));
  if (lastResort.length === 0) return;

  await mapWithConcurrency(
    lastResort,
    HASH_CONCURRENCY,
    async photo => {
      await getHashWithCache(photo);
      onProgressDelta(1);
    },
    shouldCancel
  );
}

/**
 * 体积预筛：只有「与其它照片体积接近」的图片才有可能成组。
 *
 * clusterBySize 的簇跨度不会超过簇内最小体积的 ±10%，
 * 因此某张图若能成组，必然存在另一张与它相差 ≤10%（以较小者为基准）的图片。
 * 排序后只需比较相邻两张即可判定：与前后邻座都不接近的图片
 * 永远不可能出现在重复组里，可以直接跳过哈希计算
 * —— 几千张库中往往能省掉一大半解码。
 * 体积未知（0）的图片不做判断，始终参与检测。
 */
const selectHashCandidates = (photos: Photo[]): { candidates: Photo[]; skipped: number } => {
  const sized: Photo[] = [];
  const unknownSize: Photo[] = [];

  for (const photo of photos) {
    if ((photo.size || 0) > 0) sized.push(photo);
    else unknownSize.push(photo);
  }

  if (sized.length < 2) return { candidates: photos, skipped: 0 };

  const sorted = [...sized].sort((a, b) => (a.size || 0) - (b.size || 0));
  const within10Percent = (smaller: number, larger: number) =>
    smaller > 0 && (larger - smaller) / smaller <= 0.1;

  const candidates: Photo[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const size = sorted[i].size || 0;
    const prevSize = i > 0 ? sorted[i - 1].size || 0 : 0;
    const nextSize = i < sorted.length - 1 ? sorted[i + 1].size || 0 : 0;

    if (
      (i > 0 && within10Percent(prevSize, size)) ||
      (i < sorted.length - 1 && within10Percent(size, nextSize))
    ) {
      candidates.push(sorted[i]);
    }
  }

  return {
    candidates: [...candidates, ...unknownSize],
    skipped: sized.length - candidates.length,
  };
};

/** 重复检测被中止（用户取消 / 关闭页面）时抛出 */
export class DuplicateScanAbortError extends Error {
  constructor() {
    super('duplicate scan aborted');
    this.name = 'DuplicateScanAbortError';
  }
}

/** 判断异常是否为「检测被取消」——取消是预期行为，不应弹错误提示 */
export const isDuplicateScanAbort = (error: unknown): boolean =>
  error instanceof DuplicateScanAbortError ||
  (typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError');

/** 重复检测可调参数 */
export interface DuplicateDetectOptions {
  /** 汉明距离阈值，按 bit 计（dHash 为 64 bit，10 以内视为相似）；值越大匹配越宽松 */
  threshold?: number;
  /** 仅把「同一目录内」的照片视为重复（默认 false：全库跨目录比对） */
  sameFolderOnly?: boolean;
  /**
   * 取消信号。abort 后检测会在下一个分片边界停下并抛出 DuplicateScanAbortError。
   * 大库检测耗时较长，没有它时用户点取消后任务仍会在后台跑完，持续占用 CPU 与内存。
   */
  signal?: AbortSignal;
}

/** 每处理多少个体积簇让出一次主线程：两两比对是同步长任务，不让出会让滚动 / 点击明显卡顿 */
const CLUSTER_YIELD_EVERY = 8;

/** 取照片所在目录（无磁盘路径时归入同一空桶） */
export const photoFolder = (photo: Photo): string => {
  const p = photo.path;
  if (!p) return '';
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx > 0 ? p.slice(0, idx) : p;
};

/** 按目录把一组重复拆开，仅保留同目录内仍 ≥2 张的子组 */
const splitGroupByFolder = (group: Photo[]): Photo[][] => {
  const buckets = new Map<string, Photo[]>();
  for (const photo of group) {
    const dir = photoFolder(photo);
    const bucket = buckets.get(dir);
    if (bucket) bucket.push(photo);
    else buckets.set(dir, [photo]);
  }
  return [...buckets.values()].filter(bucket => bucket.length > 1).map(markRecommended);
};

/**
 * 查找重复照片。
 * - 先做体积预筛，只对可能有重复的图片计算 dHash（并行解码 + 跨调用缓存）
 * - 精确相同：一次 Map 分组，O(n)
 * - 近似相似：仅在「体积相近」的候选簇内两两比较，并用并查集归组
 * - 全程可取消（signal），并在比对分片之间让出主线程
 *
 * @param options 阈值与目录范围（兼容旧签名：直接传 number 视为 threshold）
 */
export const findDuplicatePhotos = async (
  photos: Photo[],
  options: DuplicateDetectOptions | number = {},
  onProgress?: DuplicateProgressHandler
): Promise<Photo[][]> => {
  // 视频不参与重复检测：逐帧比对既慢又无意义
  photos = photos.filter(photo => !isVideoPhoto(photo));
  if (photos.length < 2) return [];

  const { threshold = 10, sameFolderOnly = false, signal } =
    typeof options === 'number' ? { threshold: options, sameFolderOnly: false, signal: undefined } : options;

  const shouldCancel = () => signal?.aborted === true;
  const assertLive = () => {
    if (shouldCancel()) throw new DuplicateScanAbortError();
  };

  const startedAt = Date.now();
  const total = photos.length;

  // 0) 体积预筛：不可能有重复的图片直接跳过
  const { candidates, skipped } = selectHashCandidates(photos);

  let cached = 0;
  for (const photo of candidates) {
    if (imageHashCache.has(hashKeyOf(photo))) cached += 1;
  }

  const needCompute = candidates.length;
  let computed = 0;
  let lastEmitAt = 0;

  const report = (phase: DuplicateScanPhase, force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastEmitAt < 100) return;
    lastEmitAt = now;

    const elapsedMs = now - startedAt;
    const etaMs =
      phase === 'hashing' && computed > 0 && computed < needCompute && elapsedMs > 300
        ? Math.round((elapsedMs / computed) * (needCompute - computed))
        : undefined;

    onProgress({
      processed: skipped + computed,
      total,
      candidates: needCompute,
      cached,
      skipped,
      elapsedMs,
      etaMs,
      phase,
    });
  };

  report('hashing', true);

  // 1) 并行计算哈希（每完成一批上报一次进度）
  await precomputeHashes(
    candidates,
    delta => {
      computed += delta;
      report('hashing');
    },
    shouldCancel
  );
  assertLive();

  computed = needCompute;
  report('hashing', true);

  // 2) 精确相同分组
  report('comparing', true);

  const entries: HashedEntry[] = [];
  for (const photo of photos) {
    const hash = imageHashCache.get(hashKeyOf(photo));
    if (hash) entries.push({ photo, hash });
  }

  // 2) 精确相同分组
  const exactBuckets = new Map<string, HashedEntry[]>();
  for (const entry of entries) {
    const bucket = exactBuckets.get(entry.hash);
    if (bucket) {
      bucket.push(entry);
    } else {
      exactBuckets.set(entry.hash, [entry]);
    }
  }

  const duplicates: Photo[][] = [];
  const consumed = new Set<string>();

  for (const bucket of exactBuckets.values()) {
    if (bucket.length < 2) continue;
    const group = bucket.map(entry => ({ ...entry.photo, hash: entry.hash }));
    group.forEach(photo => consumed.add(photo.id));
    duplicates.push(markRecommended(group));
  }

  // 3) 近似相似聚类（仅在体积相近的簇内）
  const remaining = entries.filter(entry => !consumed.has(entry.photo.id));

  let handledClusters = 0;
  for (const cluster of clusterBySize(remaining)) {
    assertLive();
    if (cluster.length < 2 || cluster.length > SIMILAR_CLUSTER_LIMIT) continue;

    const uf = new UnionFind(cluster.length);
    for (let i = 0; i < cluster.length; i++) {
      for (let j = i + 1; j < cluster.length; j++) {
        if (hammingDistance(cluster[i].hash, cluster[j].hash) <= threshold) {
          uf.union(i, j);
        }
      }
    }

    const groups = new Map<number, HashedEntry[]>();
    for (let i = 0; i < cluster.length; i++) {
      const root = uf.find(i);
      const bucket = groups.get(root) || [];
      bucket.push(cluster[i]);
      groups.set(root, bucket);
    }

    for (const bucket of groups.values()) {
      if (bucket.length < 2) continue;
      duplicates.push(markRecommended(bucket.map(entry => ({ ...entry.photo, hash: entry.hash }))));
    }

    // 大库下「逐簇两两比对」是一长串同步任务，定期让出主线程，避免列表滚动被卡住
    handledClusters += 1;
    if (handledClusters % CLUSTER_YIELD_EVERY === 0) await yieldToMain();
  }

  report('done', true);

  // 仅同目录模式：把跨目录聚合出的重复组按目录重新拆开
  return sameFolderOnly ? duplicates.flatMap(splitGroupByFolder) : duplicates;
};
