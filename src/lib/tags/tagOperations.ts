/**
 * 批量标签的纯逻辑（v0.7.0 第一批 / D9）。
 *
 * 单张详情面板此前是唯一能加标签的地方，选 100 张就只能点 100 次。
 * 这里把「一次操作作用于整组」的判定抽成可测的纯函数：
 *   - 只有真正发生变化的照片才进变更集（避免给 100 张重复写同样的标签）；
 *   - 快照里保留 before，撤销才能精确还原，而不是「把标签从所有照片上删掉」；
 *   - 标签频次统计同时供详情面板的建议与侧栏的标签列表使用，两边不会各算一套。
 */

import type { Photo } from '@/types';

export type TagOperationKind = 'add' | 'remove';

export interface TagOperation {
  kind: TagOperationKind;
  tag: string;
}

/** 输入归一化：去空白、去掉用户习惯性敲的 # 前缀；空串表示该操作无效 */
export const normalizeTag = (input: string): string => input.trim().replace(/^#+/, '').trim();

export interface TagChange {
  /** 会话内 id，用于批量更新 photos state */
  id: string;
  /** 内容指纹，用于写 tagsRef / config */
  key: string;
  before: string[];
  after: string[];
}

/** 单张照片应用一次标签操作；返回新数组，未变化时返回原数组引用（便于跳过） */
export const applyTagOperation = (current: readonly string[], op: TagOperation): string[] => {
  const tag = normalizeTag(op.tag);
  if (!tag) return [...current];

  if (op.kind === 'add') {
    if (current.includes(tag)) return [...current];
    return [...current, tag];
  }
  const next = current.filter((item) => item !== tag);
  return next.length === current.length ? [...current] : next;
};

/**
 * 为整组照片规划变更。keyOf 由调用方注入（内容指纹），纯函数不依赖渲染层状态。
 * 没有内容指纹的照片（拖放降级）用会话 id 兜底，仍可在本次会话内批量处理。
 */
export const planBatchTagChange = (
  photos: readonly Photo[],
  op: TagOperation,
  keyOf: (photo: Photo) => string
): TagChange[] => {
  if (!normalizeTag(op.tag)) return [];
  const changes: TagChange[] = [];
  for (const photo of photos) {
    const before = [...(photo.tags ?? [])];
    const after = applyTagOperation(before, op);
    if (after.length === before.length && after.every((tag, i) => tag === before[i])) continue;
    changes.push({ id: photo.id, key: keyOf(photo) || photo.id, before, after });
  }
  return changes;
};

export interface RankedTag {
  name: string;
  count: number;
}

/** 按使用频次排序（同频按名称），供侧栏与输入建议共用 */
export const rankTags = (photos: readonly Photo[]): RankedTag[] => {
  const counts = new Map<string, number>();
  for (const photo of photos) {
    for (const tag of photo.tags ?? []) {
      const name = normalizeTag(tag);
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
};

/** 输入建议：优先前缀命中，再按频次排序；已排除完全相同的输入 */
export const suggestTags = (
  ranked: readonly RankedTag[],
  query: string,
  limit = 6
): RankedTag[] => {
  const q = normalizeTag(query).toLowerCase();
  if (!q) return ranked.slice(0, limit);
  return ranked
    .filter((item) => item.name.toLowerCase().includes(q) && item.name.toLowerCase() !== q)
    .slice(0, limit);
};

/** 选中的一组照片里，各标签覆盖了多少张（多选详情面板用来说明「当前选择的情况」） */
export const tagCoverage = (photos: readonly Photo[]): RankedTag[] => rankTags(photos);
