/**
 * 图库派生数据 Hook（从 App 抽出）。
 *
 * 把「照片列表 + 排序 + 筛选 + 搜索 + 相簿」派生出的全部只读数据集中一处：
 * 日期分组序列、时间线序列、实况照片配对、当前可见列表、侧栏统计、
 * 相簿命中计数、筛选面板可选项，以及六种空状态判定。
 *
 * 这些计算彼此有依赖（可见列表依赖分组排序，统计依赖实况配对），
 * 集中后依赖链一眼可见；对外仍是逐项 useMemo，等价于拆分前 App 中的各段计算。
 */

import { useMemo } from 'react';
import { Photo, PhotoFilters, SmartAlbum, SortConfig } from '@/types';
import { groupPhotos, sortPhotosByTimeline } from '@/lib/media/photoGrouping';
import { buildLivePhotoIds, isSelfiePhoto, isScreenshotPhoto } from '@/lib/media/mediaTypes';
import { isVideoPhoto } from '@/utils';
import {
  applyPhotoFilters,
  buildFilterOptions,
  buildTagOptions,
  filtersEqual,
  hasAdvancedFilters,
  matchesFilters,
} from '@/lib/filter/filters';
import { deriveLibraryViewState, type EmptyKind } from '@/lib/filter/libraryViewState';

export interface UseLibraryDerivedParams {
  photos: Photo[];
  sortConfig: SortConfig;
  filters: PhotoFilters;
  /** 搜索关键词（文件名 / 相机 / 格式） */
  searchQuery: string;
  /** 智能相簿（只存筛选条件，命中数随图库实时变化） */
  albums: SmartAlbum[];
  /** 侧栏分类（全部 / 收藏 / 已隐藏）：由筛选状态派生 */
  activeCategory: string;
}

export interface LibraryDerivedResult {
  /** 排序 + 日期分组后的照片（网格 / 列表渲染源） */
  groupedPhotos: ReturnType<typeof groupPhotos>;
  /** 分组内展开的排序序列（供可见筛选复用，避免重复排序） */
  sortedPhotos: Photo[];
  /**
   * 时光画廊：按拍摄时间升序排列的全部照片（忽略筛选 / 搜索）。
   * 已隐藏项一律不参与；缺失时间戳的条目排到末尾。
   */
  timelinePhotos: Photo[];
  /** 实况照片 id 集合（「同目录同名视频配对」上下文，随照片集合预计算） */
  livePhotoIds: Set<string>;
  /**
   * 当前视图真正展示的照片：可组合筛选 + 关键词搜索。
   * 统一驱动网格渲染 / 全选 / QuickLook 翻页 / 区间连选 / 方向键导航。
   */
  visiblePhotos: Photo[];
  /** 媒体统计（侧栏「图库 / 媒体类型」与顶部筛选共用；隐藏项只计入「已隐藏」） */
  counts: {
    all: number;
    favorites: number;
    hidden: number;
    videos: number;
    images: number;
    selfies: number;
    screenshots: number;
    livePhotos: number;
  };
  /** 每个智能相簿当前命中的数量 */
  albumCounts: Record<string, number>;
  /** 当前视图恰好等价于哪个相簿（用于侧栏高亮）；非相簿视图为 null */
  activeAlbumId: string | null;
  /** 筛选面板的可选项（相机 / 格式 / 标签）；口径与 matchesFilters 一致 */
  filterOptions: { cameras: string[]; formats: string[]; tags: string[] };
  /** 图库完全没有内容 */
  isEmptyLibrary: boolean;
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
  /** 当前空状态的种类（仅当可见列表为 0 时有意义，判定与取值见 libraryViewState） */
  emptyKind: EmptyKind;
  /** 当前是否处于「已隐藏」视图 */
  isHiddenView: boolean;
}

export function useLibraryDerived({
  photos,
  sortConfig,
  filters,
  searchQuery,
  albums,
  activeCategory,
}: UseLibraryDerivedParams): LibraryDerivedResult {
  // Grouping Logic：排序 + 日期分组（实现见 photoGrouping.ts）
  const groupedPhotos = useMemo(() => groupPhotos(photos, sortConfig), [photos, sortConfig]);

  // groupedPhotos 内部已完成排序，这里直接展开，避免对同一份数据重复排序
  const sortedPhotos = useMemo(
    () => groupedPhotos.flatMap(group => group.photos),
    [groupedPhotos]
  );

  const timelinePhotos = useMemo(
    () => sortPhotosByTimeline(photos.filter(p => !p.isHidden)),
    [photos]
  );

  const livePhotoIds = useMemo(() => buildLivePhotoIds(photos), [photos]);

  const visiblePhotos = useMemo(
    () => applyPhotoFilters(sortedPhotos, filters, searchQuery, { livePhotoIds }),
    [sortedPhotos, filters, searchQuery, livePhotoIds]
  );

  // 媒体统计：隐藏项不计入任何常规分类，只计入「已隐藏」，与 macOS 照片一致
  const counts = useMemo(() => {
    let videos = 0;
    let favorites = 0;
    let hidden = 0;
    let selfies = 0;
    let screenshots = 0;
    let livePhotos = 0;

    for (const p of photos) {
      if (p.isHidden) {
        hidden += 1;
        continue;
      }
      if (p.isFavorite) favorites += 1;
      if (isVideoPhoto(p)) {
        videos += 1;
        continue;
      }
      // 智能分类（自拍 / 截屏 / 实况照片）只针对图片
      if (isSelfiePhoto(p)) selfies += 1;
      if (isScreenshotPhoto(p)) screenshots += 1;
      if (livePhotoIds.has(p.id)) livePhotos += 1;
    }

    const visible = photos.length - hidden;
    return {
      all: visible,
      favorites,
      hidden,
      videos,
      images: visible - videos,
      selfies,
      screenshots,
      livePhotos,
    };
  }, [photos, livePhotoIds]);

  const albumCounts = useMemo(() => {
    const result: Record<string, number> = {};
    for (const album of albums) {
      let matched = 0;
      for (const photo of photos) {
        if (matchesFilters(photo, album.filters, { livePhotoIds })) matched += 1;
      }
      result[album.id] = matched;
    }
    return result;
  }, [albums, photos, livePhotoIds]);

  /** 当前视图恰好等价于哪个相簿（用于侧栏高亮） */
  const activeAlbumId = useMemo(
    () => albums.find(album => filtersEqual(album.filters, filters))?.id ?? null,
    [albums, filters]
  );

  // 筛选面板的可选项（相机 / 格式 / 标签）：随元数据与标签变化动态更新。
  // 口径必须与 matchesFilters 一致 —— 隐藏项本来就不会出现在结果里，
  // 若把「只存在于隐藏项」的相机 / 标签列成可选，用户选中后必然得到 0 条结果。
  const filterOptions = useMemo(() => {
    const candidates = photos.filter(p => !p.isHidden);
    return { ...buildFilterOptions(candidates), tags: buildTagOptions(candidates) };
  }, [photos]);

  // 空状态 / 情境条文案派生（实现见 libraryViewState.ts）。
  // 与重构前一致：每次渲染直接计算，不做 memo。
  const viewState = deriveLibraryViewState({
    photoCount: photos.length,
    hiddenCount: counts.hidden,
    visibleCount: visiblePhotos.length,
    searchQuery,
    activeCategory,
    mediaFilter: filters.mediaFilter,
    hasAdvancedFilters: hasAdvancedFilters(filters),
    favoritesOnly: filters.favoritesOnly,
  });

  return {
    groupedPhotos,
    sortedPhotos,
    timelinePhotos,
    livePhotoIds,
    visiblePhotos,
    counts,
    albumCounts,
    activeAlbumId,
    filterOptions,
    ...viewState,
  };
}
