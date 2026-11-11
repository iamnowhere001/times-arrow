/**
 * 当前视图的「上下文」：搜索词、当前相簿、已启用筛选、侧栏高亮（K20）。
 *
 * K20 的根因不是「一个入口清搜索词、另一个不清」这么简单，而是**叠在一起的条件看不见**：
 * 点「收藏夹」会保留搜索词与高级筛选，界面却没有任何稳定位置说明还叠了什么；
 * 点智能相簿又反过来把搜索词清掉。于是同一个动作在两种入口下结果不同。
 *
 * 本版统一口径（ROADMAP P0-2 的第一档）：**所有入口都保留搜索词，条件条完整展示上下文**。
 * 相簿仍会覆盖「筛选条件」，因为「一组保存的条件」就是相簿的定义 —— 这是语义差异，
 * 不是两套规则；差异由条件条显式呈现，用户可逐条清除。
 */

import type { MediaFilter, PhotoFilters } from '@/types';
import { buildFilterChips, isFilterActive } from '@/lib/filter/filters';

export interface NavDescriptor {
  category: string;
  filter: MediaFilter;
}

/**
 * 侧栏高亮：分类维度与媒体维度**独立**判定。
 *
 * 旧规则要求 `activeCategory === item.category && mediaFilter === item.filter` 同时成立，
 * 「收藏夹 + 视频」这种合法组合下两项都不高亮，侧栏看起来像什么都没选。
 * 规则：
 *   - 分类项（收藏夹 / 已隐藏）：只看分类；
 *   - 媒体项（图片 / 视频 / 自拍 / 实况 / 截屏）：只看媒体类型；
 *   - 「所有照片」（两个维度都是 all）：仅在默认状态高亮。
 */
export const navItemActive = (
  item: NavDescriptor,
  activeCategory: string,
  mediaFilter: MediaFilter
): boolean => {
  if (item.category !== 'all') return activeCategory === item.category;
  if (item.filter === 'all') return activeCategory === 'all' && mediaFilter === 'all';
  return mediaFilter === item.filter;
};

export type ViewContextChipKind = 'search' | 'album' | 'filter';

export interface ViewContextChip {
  key: string;
  label: string;
  kind: ViewContextChipKind;
  /** kind='filter' 时才需要：清除该条件的补丁 */
  patch?: Partial<PhotoFilters>;
}

export interface ViewContext {
  /** 是否有任何会缩小结果集的上下文（含只有搜索词的情况） */
  active: boolean;
  /** 当前视图是否恰好等于某个智能相簿的条件 */
  albumName: string;
  chips: ViewContextChip[];
}

export const buildViewContext = (input: {
  filters: PhotoFilters;
  searchQuery: string;
  albumName?: string;
}): ViewContext => {
  const query = input.searchQuery.trim();
  const albumName = input.albumName?.trim() ?? '';
  const filterChips: ViewContextChip[] = buildFilterChips(input.filters).map((chip) => ({
    key: chip.key,
    label: chip.label,
    kind: 'filter',
    patch: chip.patch,
  }));

  const chips: ViewContextChip[] = [];
  if (query) chips.push({ key: 'search', label: `搜索：${query}`, kind: 'search' });
  if (albumName) chips.push({ key: 'album', label: `相簿：${albumName}`, kind: 'album' });
  chips.push(...filterChips);

  return {
    active: isFilterActive(input.filters) || query.length > 0 || albumName.length > 0,
    albumName,
    chips,
  };
};
