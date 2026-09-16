/**
 * 文件名清理：乱码修复 + 无意义前缀/重复标记剥离 + 无意义时改用拍摄时间命名。
 *
 * 预览（RenameModal）与执行（App 批量重命名）**共用同一实现** ——
 * 两边各写一份的话，预览显示的名字与磁盘上落地的名字就会不一致，
 * 而用户是照着预览做决定的。
 */

import { RepairNameOptions } from '@/types';
import { extOfName } from '@/lib/fs/pathUtils';
import { formatDateForNaming } from '@/lib/format/format';

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

/**
 * 清理一个文件名：修复乱码 → 去掉重复标记 → 去掉无意义前缀 → 归一化空白，
 * 最终仍无意义时（可选）改用拍摄时间命名。
 * 预览与真正执行都走这个函数，保证「预览即所得」。
 *
 * ⚠️ 扩展名会被转成小写（`photo.JPG` → `photo.jpg`）—— 因为 `extOfName` 返回小写。
 * 在大小写不敏感的文件系统（macOS 默认）上这是同一条目，影响仅限于显示。
 *
 * ⚠️ 「无意义」判定挂在 `options.stripJunkPrefix` 下：关掉它时 `meaningful`
 * 只反映「有没有可读字符」，`IMG_2639` 会被算作有意义。
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
