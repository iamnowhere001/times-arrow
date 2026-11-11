/**
 * 重复检测的「忽略此组」与清理报告（v0.6.2 批次 3 / F8 前半）。
 *
 * 抽成纯函数是为了让两件容易出错的事可被测试：
 *   1. **组的跨会话身份**。检测结果 `Photo[][]` 每次都是新数组，`Photo.id` 只在会话内唯一，
 *      拿下标或 id 当身份都会让「忽略」在重启后失配。这里只认内容指纹 / 磁盘路径。
 *   2. **报告数字**。扫描张数、成组数、可释放体积、已删除张数散落在组件里时，
 *      很容易出现「顶栏说 14 组、报告说 12 组」这种自相矛盾（K29 要解决的正是这类问题）。
 *
 * ## 已知取舍（TODO「现实约束」第 5 条）
 * 组身份由**当前成员集合**决定：调阈值、删图、新增照片导致成员变化时，身份随之改变，
 * 旧忽略记录不再命中，组会重新出现。我们接受这个失效，而不是做模糊匹配续接 ——
 * 后者会把「用户明确说不是重复」悄悄套到另一组照片上，风险更大。UI 必须把这条写清楚。
 */

import type { IgnoredDuplicateGroup, Photo } from '@/types';

// 类型在 types/ 统一定义，这里重导出，让调用方不必同时 import 两处
export type { IgnoredDuplicateGroup } from '@/types';

/** 忽略集上限：防止长期使用后把 config.json 撑大；超出时淘汰最旧的记录 */
export const MAX_IGNORED_GROUPS = 500;

/**
 * 成员稳定标识：优先内容指纹（改名 / 移动后仍不变），其次磁盘路径。
 * 拖放降级且未算出指纹的照片两者都没有，返回空串 —— 这类组不允许持久化忽略。
 */
export const stableIdentityOf = (photo: Photo): string => {
  if (photo.fileId) return `f:${photo.fileId}`;
  if (photo.path) return `p:${photo.path}`;
  return '';
};

/** 只有全部成员都可跨会话识别、且至少两张时，忽略才有意义 */
export const isGroupStable = (group: Photo[]): boolean =>
  group.length >= 2 && group.every((photo) => stableIdentityOf(photo) !== '');

/**
 * FNV-1a 32bit。两轮不同种子拼成 64bit hex，把一长串成员 id 压成定长 key。
 * 逐字符取低/高两个字节，避免路径里的中文被 `& 0xff` 截掉后碰撞率上升。
 */
const fnv1a = (input: string, seed: number): string => {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    hash = Math.imul(hash ^ (code & 0xff), 0x01000193) >>> 0;
    hash = Math.imul(hash ^ ((code >>> 8) & 0xff), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

/**
 * 组身份 = 成员稳定标识排序 → 拼接 → 压缩。
 * 排序保证组内顺序变化（阈值重分组、时间回填）不改变身份；不稳定组返回空串。
 */
export const groupIdentityKey = (group: Photo[]): string => {
  if (!isGroupStable(group)) return '';
  const joined = group.map(stableIdentityOf).sort().join('|');
  return `${fnv1a(joined, 0x811c9dc5)}${fnv1a(joined, 0x9e3779b9)}`;
};

export const isGroupIgnored = (
  group: Photo[],
  ignored: readonly IgnoredDuplicateGroup[]
): boolean => {
  const key = groupIdentityKey(group);
  return key !== '' && ignored.some((item) => item.key === key);
};

/** 过滤掉已忽略的组，并回报被过滤的数量（报告里的「已忽略」一项） */
export const filterIgnoredGroups = (
  groups: Photo[][],
  ignored: readonly IgnoredDuplicateGroup[]
): { visible: Photo[][]; ignoredCount: number } => {
  const visible = groups.filter((group) => !isGroupIgnored(group, ignored));
  return { visible, ignoredCount: groups.length - visible.length };
};

/**
 * 记录一次忽略。返回新数组；组不稳定或已经记录过时返回 null，
 * 让调用方可以据此给出「这组无法跨重启记住」的明确反馈，而不是静默当成功。
 */
export const recordIgnoredGroup = (
  ignored: readonly IgnoredDuplicateGroup[],
  group: Photo[],
  now: number = Date.now()
): IgnoredDuplicateGroup[] | null => {
  const key = groupIdentityKey(group);
  if (!key || ignored.some((item) => item.key === key)) return null;

  const entry: IgnoredDuplicateGroup = {
    key,
    memberCount: group.length,
    label: group[0]?.name || '未命名照片',
    ignoredAt: now,
  };
  // 新的在前；达到上限时淘汰最旧的几条，保持配置体积有界
  return [entry, ...ignored].slice(0, MAX_IGNORED_GROUPS);
};

export const removeIgnoredGroup = (
  ignored: readonly IgnoredDuplicateGroup[],
  key: string
): IgnoredDuplicateGroup[] => ignored.filter((item) => item.key !== key);

/**
 * 从配置里安全读出忽略集。旧版本没有这个字段，手工编辑也可能写坏，
 * 因此逐条校验而不是直接断言类型 —— 一份坏配置不该让整个检测页崩掉。
 */
export const normalizeIgnoredGroups = (raw: unknown): IgnoredDuplicateGroup[] => {
  if (!Array.isArray(raw)) return [];
  const result: IgnoredDuplicateGroup[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Partial<IgnoredDuplicateGroup>;
    if (
      typeof candidate.key !== 'string' ||
      candidate.key.length === 0 ||
      seen.has(candidate.key)
    ) {
      continue;
    }
    seen.add(candidate.key);
    result.push({
      key: candidate.key,
      memberCount:
        typeof candidate.memberCount === 'number' && Number.isFinite(candidate.memberCount)
          ? candidate.memberCount
          : 0,
      label: typeof candidate.label === 'string' ? candidate.label : '未命名照片',
      ignoredAt:
        typeof candidate.ignoredAt === 'number' && Number.isFinite(candidate.ignoredAt)
          ? candidate.ignoredAt
          : 0,
    });
    if (result.length >= MAX_IGNORED_GROUPS) break;
  }
  return result;
};

/** 一组里除「建议保留」项之外的可清理张数与体积 */
export const releasableSizeOf = (groups: readonly Photo[][]): { count: number; bytes: number } => {
  let count = 0;
  let bytes = 0;
  for (const group of groups) {
    const original = group.find((photo) => photo.isRecommended) || group[0];
    for (const photo of group) {
      if (photo.id !== original.id) {
        count += 1;
        bytes += photo.size || 0;
      }
    }
  }
  return { count, bytes };
};

/** 一次检测的报告：数字全部由同一份结果算出来，避免各处各自统计后对不上 */
export interface DuplicateScanReport {
  /** 参与本轮检测的图片张数（未扣除体积预筛跳过） */
  scanned: number;
  /** 检测管线实际给出的组数（含被忽略的） */
  groupsFound: number;
  /** 用户已标记的「不是重复」记录数（跨检测累计，不等于本轮被过滤的组数） */
  ignoredGroups: number;
  /** 当前列表里可见的组数 */
  visibleGroups: number;
  /** 可见组里可清理的张数 */
  releasableCount: number;
  /** 可见组里可清理的体积（字节） */
  releasableBytes: number;
  /** 本次会话实际移入回收站的张数（跨多次删除累加） */
  deletedCount: number;
  /** 本次会话实际释放的体积（字节） */
  deletedBytes: number;
}

export const EMPTY_SCAN_REPORT: DuplicateScanReport = {
  scanned: 0,
  groupsFound: 0,
  ignoredGroups: 0,
  visibleGroups: 0,
  releasableCount: 0,
  releasableBytes: 0,
  deletedCount: 0,
  deletedBytes: 0,
};

export const buildScanReport = (input: {
  scanned: number;
  groupsFound: number;
  ignoredGroups: number;
  groups: readonly Photo[][];
  deletedCount?: number;
  deletedBytes?: number;
}): DuplicateScanReport => {
  const { count, bytes } = releasableSizeOf(input.groups);
  return {
    scanned: Math.max(0, input.scanned),
    groupsFound: Math.max(0, input.groupsFound),
    ignoredGroups: Math.max(0, input.ignoredGroups),
    visibleGroups: input.groups.length,
    releasableCount: count,
    releasableBytes: bytes,
    deletedCount: Math.max(0, input.deletedCount ?? 0),
    deletedBytes: Math.max(0, input.deletedBytes ?? 0),
  };
};
