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
                : // 兜底：列表为空但不属于以上任何一类（例如只剩隐藏项），
                  // 按「没找到」处理，语气与搜索一致。
                  'search';

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

/** 空状态主按钮要做的事；具体回调由调用方按动作分发（纯函数不持有 setState） */
export type EmptyStateAction =
  'import' | 'clearSearch' | 'clearFilters' | 'showHidden' | 'showAll' | 'showAllMedia' | 'none';

export interface EmptyStateCopy {
  title: string;
  description: string;
  /** 旁注读数：给「是没找到还是本来就没有」一个参照 */
  hint?: string;
  action: EmptyStateAction;
  actionLabel?: string;
}

export interface EmptyStateCopyInput {
  kind: EmptyKind;
  searchQuery: string;
  mediaFilter: MediaFilter;
  /** 图库条目总数（counts.all），仅用于旁注读数 */
  totalCount: number;
}

/**
 * 空状态的文案与主按钮。
 *
 * 之前这段是 App.tsx 里一组 50 行的嵌套三元 —— 标题、描述、按钮、动作四个维度
 * 各自按同一组条件分支，改一处文案要横着读四遍。抽成纯函数后：文案集中、可单测，
 * App 只负责把 action 映射成回调。
 */
export function deriveEmptyStateCopy({
  kind,
  searchQuery,
  mediaFilter,
  totalCount,
}: EmptyStateCopyInput): EmptyStateCopy {
  const mediaLabel = MEDIA_FILTER_LABELS[mediaFilter];
  const copy = ((): EmptyStateCopy => {
    switch (kind) {
      case 'library':
        return {
          title: '打开你的图库',
          description:
            '把整个文件夹拖进窗口，或使用「打开文件夹」导入。打开过的文件夹会被记住，重启后可一键恢复；所有整理都在本地完成。',
          action: 'import',
        };
      case 'search':
        return {
          title: '没有匹配的结果',
          description: `找不到与「${searchQuery}」匹配的内容。试着换个关键词，或清除搜索。`,
          action: 'clearSearch',
        };
      case 'allHidden':
        return {
          title: '所有项目都已隐藏',
          description: '当前图库里的项目都被隐藏了，它们收在「已隐藏」里，可在那里取消隐藏。',
          action: 'showHidden',
          actionLabel: '查看「已隐藏」',
        };
      case 'hiddenEmpty':
        return {
          title: '没有已隐藏的项目',
          description: '在照片上点右键选择「隐藏」，被隐藏的项目就会收在这里，不打扰日常浏览。',
          action: 'none',
        };
      case 'filter':
        return {
          title: '没有符合筛选条件的结果',
          description: '当前筛选条件没有匹配项，放宽条件或清除筛选后再试。',
          action: 'clearFilters',
          actionLabel: '清除筛选',
        };
      case 'media':
        return {
          title: `还没有${mediaLabel}`,
          description: `当前图库中没有${mediaLabel}，切回「全部」可以查看其他内容。`,
          action: 'showAllMedia',
          actionLabel: '前往「所有照片」',
        };
      case 'favorites':
        return {
          title: '收藏夹还是空的',
          description: '在「所有照片」中点击照片角落的心形按钮，就能把喜欢的照片收进这里。',
          action: 'showAll',
          actionLabel: '前往「所有照片」',
        };
    }
  })();

  // 首屏与「全部隐藏」不显示旁注：前者还没有库，后者的总数就在描述里
  const hint =
    kind === 'library' || kind === 'allHidden'
      ? undefined
      : `库中 ${totalCount} 项，当前条件下没有匹配`;

  return hint ? { ...copy, hint } : copy;
}
