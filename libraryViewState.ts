/**
 * 图库空状态与标题派生（从 App 抽出的纯逻辑）。
 *
 * 图库需要区分多种「空」：完全为空 / 全部已隐藏 / 收藏夹为空 / 搜索无结果 /
 * 筛选无结果 / 媒体筛选为空。这些判断彼此有优先级依赖，集中在一处便于阅读与核对，
 * 输出结果供 App 的空状态文案与网格标题直接使用。
 */

import { MediaFilter } from './types';
import { MEDIA_FILTER_LABELS } from './filters';

export interface LibraryViewState {
  /** 图库完全没有内容 */
  isEmptyLibrary: boolean;
  /** 当前处于「已隐藏」视图 */
  isHiddenView: boolean;
  /** 有关键词但无匹配 */
  isSearchEmpty: boolean;
  /** 非「已隐藏」视图下，所有项目都被隐藏了 */
  isAllHidden: boolean;
  /** 「已隐藏」视图自身为空 */
  isHiddenEmpty: boolean;
  /** 高级筛选条件下无匹配 */
  isFilterEmpty: boolean;
  /** 收藏夹为空 */
  isFavoritesEmpty: boolean;
  /** 媒体类型筛选下为空 */
  isMediaFilterEmpty: boolean;
  /** 网格视图标题（已隐藏 / 收藏夹 / 所有媒体 / 具体媒体类型） */
  gridViewTitle: string;
}

export interface LibraryViewStateInput {
  /** 图库条目总数（photos.length） */
  photoCount: number;
  /** 已隐藏条目数（counts.hidden） */
  hiddenCount: number;
  /** 当前可见条目数（visiblePhotos.length） */
  visibleCount: number;
  /** 搜索关键词 */
  searchQuery: string;
  /** 侧栏分类：all / favorites / hidden */
  activeCategory: string;
  /** 媒体类型筛选 */
  mediaFilter: MediaFilter;
  /** 是否存在高级筛选条件 */
  hasAdvancedFilters: boolean;
  /** 是否仅显示收藏 */
  favoritesOnly: boolean;
}

export function deriveLibraryViewState(input: LibraryViewStateInput): LibraryViewState {
  const {
    photoCount,
    hiddenCount,
    visibleCount,
    searchQuery,
    activeCategory,
    mediaFilter,
    hasAdvancedFilters,
    favoritesOnly,
  } = input;

  const isEmptyLibrary = photoCount === 0;
  const isHiddenView = activeCategory === 'hidden';
  const isSearchEmpty = !isEmptyLibrary && !!searchQuery.trim() && visibleCount === 0;
  /** 非「已隐藏」视图下，所有项目都被隐藏了 */
  const isAllHidden =
    !isEmptyLibrary &&
    !isHiddenView &&
    hiddenCount === photoCount &&
    !searchQuery.trim() &&
    !hasAdvancedFilters &&
    !favoritesOnly &&
    mediaFilter === 'all';
  /** 「已隐藏」视图自身为空 */
  const isHiddenEmpty = !isEmptyLibrary && isHiddenView && !isSearchEmpty && visibleCount === 0;
  const isFilterEmpty =
    !isEmptyLibrary &&
    !isSearchEmpty &&
    !isAllHidden &&
    !isHiddenEmpty &&
    hasAdvancedFilters &&
    visibleCount === 0;
  const isFavoritesEmpty =
    !isEmptyLibrary &&
    !isSearchEmpty &&
    !isFilterEmpty &&
    !isHiddenEmpty &&
    favoritesOnly &&
    visibleCount === 0;
  const isMediaFilterEmpty =
    !isEmptyLibrary &&
    !isSearchEmpty &&
    !isFilterEmpty &&
    !isFavoritesEmpty &&
    !isHiddenEmpty &&
    !isAllHidden &&
    mediaFilter !== 'all' &&
    visibleCount === 0;
  const gridViewTitle =
    activeCategory === 'hidden'
      ? '已隐藏'
      : activeCategory === 'favorites'
        ? '收藏夹'
        : mediaFilter === 'all'
          ? '所有媒体'
          : MEDIA_FILTER_LABELS[mediaFilter];

  return {
    isEmptyLibrary,
    isHiddenView,
    isSearchEmpty,
    isAllHidden,
    isHiddenEmpty,
    isFilterEmpty,
    isFavoritesEmpty,
    isMediaFilterEmpty,
    gridViewTitle,
  };
}
