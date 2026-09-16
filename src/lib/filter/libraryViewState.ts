/**
 * 图库空状态与标题派生（从 App 抽出的纯逻辑）。
 *
 * 图库需要区分多种「空」：完全为空 / 全部已隐藏 / 收藏夹为空 / 搜索无结果 /
 * 筛选无结果 / 媒体筛选为空。这些判断彼此有优先级依赖，集中在一处便于阅读与核对，
 * 输出结果供 App 的空状态文案与网格标题直接使用。
 */

import { MediaFilter } from '@/types';
import { MEDIA_FILTER_LABELS } from '@/lib/filter/filters';

/**
 * 空状态的种类。
 *
 * 定义在这里而不是组件里：判定优先级是本文件的事，组件只负责按种类挑图形与语气。
 * `library` 走单独设计的首屏，其余五种共用克制模板。
 */
export type EmptyKind =
  | 'library' // 图库完全为空
  | 'search' // 有关键词但无匹配
  | 'filter' // 高级筛选条件下无匹配
  | 'media' // 当前媒体类型没有内容
  | 'allHidden' // 全部项目都被隐藏了
  | 'hiddenEmpty' // 「已隐藏」视图自身为空
  | 'favorites'; // 收藏夹为空

export interface LibraryViewState {
  /**
   * 当前属于哪一种空状态（非空时无意义，仅当可见列表为 0 时参考）。
   * 优先级与下面各布尔判定一致，集中一处避免调用方再排一次顺序。
   */
  emptyKind: EmptyKind;
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

  // 空状态种类：与上面各判定的优先级一致，集中排一次序，
  // 避免 App 与空状态组件各排一遍、将来改一处忘另一处。
  const emptyKind: EmptyKind = isEmptyLibrary
    ? 'library'
    : isSearchEmpty
      ? 'search'
      : isAllHidden
        ? 'allHidden'
        : isHiddenEmpty
          ? 'hiddenEmpty'
          : isFilterEmpty
            ? 'filter'
            : isFavoritesEmpty
              ? 'favorites'
              : isMediaFilterEmpty
                ? 'media'
                // 兜底：列表为空但不属于以上任何一类（例如只剩隐藏项），
                // 按「没找到」处理，语气与搜索一致。
                : 'search';

  return {
    emptyKind,
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
