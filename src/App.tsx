import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { MediaFilter, Photo, PhotoFilters, SortConfig, ViewMode, SortKey } from '@/types';
import { isVideoPhoto, clearImageHashCache } from '@/utils';
import {
  installMemoryPressureListener,
  releaseMemory,
  startHeapWatch,
} from '@/lib/cache/cacheManager';
import { clearDragThumbnailCache } from '@/lib/cache/dragThumbnail';
import { buildContextMenuActions } from '@/lib/contextMenuActions';
import { createFsErrorReporter } from '@/lib/fs/ipcGuard';
import { useToasts } from '@/hooks/useToasts';
import { useThemeMode } from '@/hooks/useThemeMode';
import { useDuplicateDetection } from '@/hooks/useDuplicateDetection';
import { MEDIA_FILTER_LABELS, createEmptyFilters } from '@/lib/filter/filters';
import { savePersistedConfig } from '@/lib/persistence/persistence';
import { basenameOfPath } from '@/lib/persistence/sources';
import Sidebar from '@/components/layout/Sidebar';
import Toolbar from '@/components/layout/Toolbar';
import ImageGrid, { ImageGridHandle } from '@/components/grid/ImageGrid';
import DetailsPane from '@/components/detail/DetailsPane';
import RenameModal from '@/components/modal/RenameModal';
import DeleteConfirmModal from '@/components/modal/DeleteConfirmModal';
import ClearListConfirmModal from '@/components/modal/ClearListConfirmModal';
import QuickLook from '@/components/detail/QuickLook';
import ToastStack from '@/components/layout/ToastStack';
import ViewErrorFallback from '@/components/common/ViewErrorFallback';
import ContextMenu, { ContextMenuItem } from '@/components/common/ContextMenu';
import DuplicateDetector from '@/components/duplicate/DuplicateDetector';
import ExportModal from '@/components/modal/ExportModal';
import TimelineGallery from '@/components/timeline/TimelineGallery';
import LocationMap from '@/components/map/LocationMap';
import { clearThumbnailCache } from '@/components/grid/ThumbnailImage';
import ErrorBoundary from '@/components/common/ErrorBoundary';
import DragOverlay from '@/components/common/DragOverlay';
import LoadingOverlay from '@/components/common/LoadingOverlay';
import ActiveFiltersBar from '@/components/layout/ActiveFiltersBar';
import AdjustDateModal, { type DateAdjustment } from '@/components/modal/AdjustDateModal';
import SaveAlbumModal from '@/components/modal/SaveAlbumModal';
import RestoreLibraryModal from '@/components/modal/RestoreLibraryModal';
import AiSettingsModal from '@/components/modal/AiSettingsModal';
import ShortcutsOverlay from '@/components/common/ShortcutsOverlay';
import { logger } from '@/lib/logger';
import { useAppConfig } from '@/hooks/useAppConfig';
import { useCollapseAnimation } from '@/hooks/useCollapseAnimation';
import { useDragAndDrop } from '@/hooks/useDragAndDrop';
import { useFileOpFeedback } from '@/hooks/useFileOpFeedback';
import { useFileOperations } from '@/hooks/useFileOperations';
import { useIngestPipeline } from '@/hooks/useIngestPipeline';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useLibraryDerived } from '@/hooks/useLibraryDerived';
import { useLibraryImport } from '@/hooks/useLibraryImport';
import { useLibrarySources } from '@/hooks/useLibrarySources';
import { usePersistedLibraryData } from '@/hooks/usePersistedLibraryData';
import { useQuickLook } from '@/hooks/useQuickLook';
import { useSelection } from '@/hooks/useSelection';
import { useSmartAlbums } from '@/hooks/useSmartAlbums';
import { useWatcherSync } from '@/hooks/useWatcherSync';

/** 主内容区的顶层视图：图库 / 时光画廊 / 按地点浏览 / 重复图片检测（整页视图，而非弹窗） */
type MainView = 'library' | 'timeline' | 'map' | 'duplicates';

const App: React.FC = () => {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  // Default to dateTaken desc so the grouped view is active by default for new users
const [sortConfig, setSortConfig] = useState<SortConfig>({ key: 'dateTaken', direction: 'desc' });
  const [scale, setScale] = useState(1);
  const [isRenameModalOpen, setIsRenameModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  // 可组合筛选（N3）：统一承载收藏 / 隐藏 / 媒体类型 / 标签 / 日期 / 相机 / 格式 / 大小 / 时长
  const [filters, setFilters] = useState<PhotoFilters>(createEmptyFilters);
  /** 侧栏分类（全部 / 收藏 / 已隐藏）：由筛选状态派生，保持与筛选面板一致 */
  const activeCategory = filters.hiddenOnly ? 'hidden' : filters.favoritesOnly ? 'favorites' : 'all';

  const updateFilters = useCallback((patch: Partial<PhotoFilters>) => {
    setFilters(prev => ({ ...prev, ...patch }));
  }, []);

  const resetFilters = useCallback(() => {
    setFilters(createEmptyFilters());
  }, []);

  /** 事件回调需读取最新照片列表：用 ref 避免闭包过期与依赖抖动 */
  const photosRef = useRef<Photo[]>([]);
  const [isAdjustDateModalOpen, setIsAdjustDateModalOpen] = useState(false);
  const [isSaveAlbumModalOpen, setIsSaveAlbumModalOpen] = useState(false);
  /** 清空照片列表二次确认：入口在侧栏底部，这里统一收口确认与执行 */
  const [isClearListConfirmOpen, setIsClearListConfirmOpen] = useState(false);
  /**
   * 筛选面板是否展开（状态在 Toolbar 内，由其上报）。
   * 全局快捷键需要据此让行：面板里的胶囊是普通按钮，不隔离的话
   * 按 Delete 会在面板之上再叠一个「移至回收站」确认框，⌘A 还会静默改写选中集。
   */
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);
  const handleFilterOpenChange = useCallback((open: boolean) => setIsFilterPanelOpen(open), []);
  /** AI 设置弹窗（配置 DeepSeek API Key / 接口地址 / 模型） */
  const [isAiSettingsOpen, setIsAiSettingsOpen] = useState(false);
  // 快捷键总览层（? 唤出，Esc 关闭）
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  // 常驻来源的状态与增删（sources / unavailableSourcePaths / 恢复确认框）见 hooks/useLibrarySources
  /** 配置是否已读取完成：完成前不写偏好，避免用默认值覆盖已存配置 */
  const [isConfigLoaded, setIsConfigLoaded] = useState(false);
  // 拖拽状态（isDraggingFile / 遮罩进出场）见 hooks/useDragAndDrop
  const [isDetailsPaneOpen, setIsDetailsPaneOpen] = useState(true); // Control details pane visibility
  // 左栏承载分类导航（含图片 / 视频筛选）与文件夹来源，默认展开
  const [isLeftPaneOpen, setIsLeftPaneOpen] = useState(true); // Control sidebar visibility
  // 外观模式（明亮 / 暗黑 / 跟随系统）与系统深浅色监听：见 hooks/useThemeMode
  const { theme, setTheme, isLight } = useThemeMode();

  // Toast 队列：支持多条同时展示，错误级常驻（见 hooks/useToasts）
  const { toasts, showToast, dismissToast } = useToasts();

  // 按路径持久化的图库数据：收藏 / 隐藏 / 标签 / 时间修正 / AI 缓存 / 已导入路径，
  // 以及路径迁移与清理的收口（见 hooks/usePersistedLibraryData）
  const {
    favoritesRef,
    hiddenRef,
    tagsRef,
    dateOverridesRef,
    aiCacheRef,
    importedPathsRef,
    forgetImportedPaths,
    setFavorite,
    toggleFavorite,
    setHidden,
    rekeyPathData,
    dropPathData,
    persistPathData,
    handleUpdatePhoto,
  } = usePersistedLibraryData({ setPhotos, photosRef, showToast, setFilters });

  // 落盘失败统一提示 / 启动配置加载 / 视频元数据 / 偏好落盘 见 hooks/useAppConfig

  // 搜索（文件名 / 相机 / 格式）
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 媒体筛选由 filters 统一承载（侧栏导航与筛选面板共用同一份状态）
  const mediaFilter = filters.mediaFilter;

  // 智能相簿：只存一组筛选条件，内容随图库实时求值（见 hooks/useSmartAlbums）
  const { albums, setAlbums, handleSaveAlbum, handleSelectAlbum, handleDeleteAlbum } = useSmartAlbums({
    filters,
    setFilters,
    setSearchQuery,
    showToast,
  });

  // 图库派生数据：分组 / 排序 / 时间线 / 可见列表 / 统计 / 相簿计数 / 空状态（见 hooks/useLibraryDerived）
  const {
    timelinePhotos,
    visiblePhotos,
    counts,
    albumCounts,
    activeAlbumId,
    filterOptions,
    isEmptyLibrary,
    isSearchEmpty,
    isAllHidden,
    isHiddenEmpty,
    isFilterEmpty,
    isFavoritesEmpty,
    isMediaFilterEmpty,
    gridViewTitle,
    emptyKind,
  } = useLibraryDerived({
    photos,
    sortConfig,
    filters,
    searchQuery,
    albums,
    activeCategory,
  });

  // 选择集与其交互（见 hooks/useSelection）：单击 / Shift 连选 / 全选 / 筛选变化后收敛。
  // 调用点必须在 useDuplicateDetection 之前：删除流程要把「从选中集中摘除」注入给它。
  const {
    selectedIds,
    setSelectedIds,
    selectedPhotos,
    selectionAnchorRef,
    handleToggleSelect,
    handleRangeSelect,
    handleSelectAllVisible,
    handleClearSelection,
    removeIdsFromSelection,
  } = useSelection({ photos, visiblePhotos });

  // 导出弹层
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  /** 实际进入导出流程的条目（视频不走重编码导出，会被排除） */
  const [exportTargets, setExportTargets] = useState<Photo[]>([]);

  // 网格句柄：方向键导航需要 scrollToPhoto + 按真实行几何取上下邻居
  const gridRef = useRef<ImageGridHandle>(null);
  
  // Context Menu State
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; photo?: Photo } | null>(null);
  
  // Loading 遮罩与导入管线：入库 / 元数据补齐 / 延迟显示 / 取消链路（见 hooks/useIngestPipeline）
  const {
    loading,
    loadingProgress,
    loadingTotal,
    loadingCurrentFile,
    loadingKind,
    setLoading,
    setLoadingProgress,
    setLoadingTotal,
    setLoadingCurrentFile,
    setLoadingKind,
    activeScanIdRef,
    cancelRequestedRef,
    showLoadingSoon,
    cancelShowLoading,
    clearLoading,
    beginDropWork,
    endDropWork,
    handleCancelLoading,
    loadMetadata,
    ingestFiles,
  } = useIngestPipeline({
    setPhotos,
    showToast,
    dateOverridesRef,
    favoritesRef,
    hiddenRef,
    tagsRef,
    aiCacheRef,
    importedPathsRef,
  });

  // K19：批量文件操作（重命名 / 删除 / 移动）的反馈状态（见 hooks/useFileOpFeedback）：
  // isFileOpBusy 同步置位 → 弹层主按钮置灰；fileOpOverlay 延迟升起 → 小批量不闪遮罩。
  const { isFileOpBusy, fileOpOverlay, beginFileOp, reportFileOp, endFileOp } = useFileOpFeedback();

  // 卡片塌陷动画：删除后先淡出再移除，并回收降级路径的 blob URL（见 hooks/useCollapseAnimation）
  const { exitingIds, removeWithCollapse, scheduleAfterExit } = useCollapseAnimation({ photosRef, setPhotos });

  // 选中集的增删（removeIdsFromSelection 等）已迁至 hooks/useSelection

  /** 文件操作（重命名 / 删除）的提交锁：防止确认按钮被连点导致同一批文件提交两次 */
  const fileOpLockRef = useRef(false);
  
  /** 主内容区当前视图：重复检测是独立整页，而非弹窗 */
  const [mainView, setMainView] = useState<MainView>('library');
  /** 重复检测页是否在前台：键盘快捷键与参数重跑逻辑据此让行 */
  const isDuplicateDetectorOpen = mainView === 'duplicates';
  /** 时光画廊是否在前台：工具栏 / 详情面板据此让行 */
  const isTimelineOpen = mainView === 'timeline';
  /** 「按地点浏览」是否在前台 */
  const isMapOpen = mainView === 'map';
  /**
   * 左栏（侧边栏）是否真正占据左侧空间。
   *
   * 时光画廊 / 相似检测都是自带导航的「整页视图」，且它们的照片集合与图库不是同一份
   * （时光画廊按时间线排列全部照片、相似检测只看检测结果）。左栏的分类 / 相簿入口
   * 全部指向图库的那份数据，留在整页视图里既会「两个条目同时高亮」，点下去也只会
   * 悄悄改掉回到图库后看到的筛选，因此这两个视图不渲染左栏。
   * 左栏缺席后，左上角红绿灯直接压在内容上，两个整页视图的顶栏要自行留出空间
   * ——这就是把 false 传下去的含义（见各自的 `isLeftPaneOpen ? 'px-4' : 'pl-[78px] pr-4'`）。
   */
  const isLeftPaneVisible = mainView === 'library' && isLeftPaneOpen;

  // 主视图切换回调需保持稳定：Hook 内 effect 依赖它，避免每次渲染重建导致防抖被反复重置
  const enterDuplicatesView = useCallback(() => setMainView('duplicates'), []);
  const exitDuplicatesView = useCallback(() => setMainView('library'), []);

  // 重复检测领域状态与流程（见 hooks/useDuplicateDetection）
  const {
    duplicateGroups,
    isProcessingDuplicates,
    isRepartitioningDuplicates,
    duplicateProgress,
    duplicateSimilarity,
    setDuplicateSimilarity,
    duplicateScope,
    setDuplicateScope,
    handleCheckDuplicates,
    handleCancelDuplicates,
    handleExitDuplicates,
    handleDeleteDuplicates,
    pruneDuplicateGroups,
  } = useDuplicateDetection({
    photos,
    showToast,
    isConfigLoaded,
    isDuplicateDetectorOpen,
    onEnterDuplicates: enterDuplicatesView,
    onExitDuplicates: exitDuplicatesView,
    removeWithCollapse,
    removeIdsFromSelection,
    scheduleAfterExit,
  });
  
  // 已导入路径集合与 forgetImportedPaths 已迁至 hooks/usePersistedLibraryData

  // N5：IPC 失败统一上报 + 「文件已消失」自动剔除。
  // 依赖全是稳定回调（showToast / removeWithCollapse / removeIdsFromSelection /
  // forgetImportedPaths / pruneDuplicateGroups），只在首次渲染创建一次。
  const fsGuard = useMemo(() => createFsErrorReporter({
    showToast,
    removeWithCollapse,
    removeIdsFromSelection,
    forgetImportedPaths,
    pruneDuplicateGroups,
  }), [showToast, removeWithCollapse, removeIdsFromSelection, forgetImportedPaths, pruneDuplicateGroups]);

  // ---------------------------------------------------------------------------
  // 目录监听（N5）：事件应用与订阅见 hooks/useWatcherSync —— 主进程只做过滤 +
  // 防抖聚合，语义判定（剔除 / 入库 / 回环过滤）与「锁内暂存、锁释放合并应用」
  // 的双保险都在 Hook 内实现。
  // ---------------------------------------------------------------------------
  const { markPathsTouched, watchCurrentDir, unwatchCurrentDir, flushPendingWatcherEvents, getWatchedDir } = useWatcherSync({
    photosRef,
    importedPathsRef,
    fileOpLockRef,
    fsGuard,
    ingestFiles,
    showToast,
  });

  // ---------------------------------------------------------------------------
  // 库来源（N8）：记录 / 可用性探测 / 移除（见 hooks/useLibrarySources）——
  // 记录时机统一放在「导入成功之后」，失败或取消不写，
  // 因此来源列表恒等于「真正整理过的内容」，恢复时不会再撞空。
  // ---------------------------------------------------------------------------
  const {
    sources,
    sourcesRef,
    setSources,
    unavailableSourcePaths,
    setUnavailableSourcePaths,
    isRestorePromptOpen,
    setIsRestorePromptOpen,
    rememberSources,
    refreshSourceAvailability,
    removeSources,
  } = useLibrarySources({
    photosRef,
    isConfigLoaded,
    forgetImportedPaths,
    removeWithCollapse,
    removeIdsFromSelection,
    pruneDuplicateGroups,
    unwatchCurrentDir,
    getWatchedDir,
    showToast,
  });

  // 内存压力响应：主进程广播 + 渲染进程堆占用兜底，统一裁剪已登记的缓存
  useEffect(() => {
    const offPressure = installMemoryPressureListener();
    const stopHeapWatch = startHeapWatch();
    return () => {
      offPressure();
      stopHeapWatch();
    };
  }, []);

  // ---------------------------------------------------------------------------
  // 启动配置加载（含存储损坏通知）/ 视频元数据回写 / 视图偏好落盘
  // 统一收口在 hooks/useAppConfig，这里只做装配
  // ---------------------------------------------------------------------------
  useAppConfig({
    photos,
    setPhotos,
    photosRef,
    showToast,
    updateFilters,
    refreshSourceAvailability,
    favoritesRef,
    hiddenRef,
    tagsRef,
    dateOverridesRef,
    aiCacheRef,
    setSources,
    sourcesRef,
    setAlbums,
    setTheme,
    setViewMode,
    setSortConfig,
    setScale,
    setIsLeftPaneOpen,
    setIsDetailsPaneOpen,
    setDuplicateSimilarity,
    setDuplicateScope,
    isConfigLoaded,
    setIsConfigLoaded,
    theme,
    viewMode,
    sortConfig,
    scale,
    mediaFilter,
    isLeftPaneOpen,
    isDetailsPaneOpen,
  });

  // 视频元数据回写（延迟合并落盘）与视图偏好落盘已随 hooks/useAppConfig 一并迁出

  // 重复检测参数持久化已随 hooks/useDuplicateDetection 一并迁出

  // 选中项（selectedPhotos）已迁至 hooks/useSelection

  // ---------------- 收藏 / 隐藏 / 标签 / 拍摄时间修正 / 智能相簿（见对应 hooks） ----------------

  // setHidden（批量隐藏 / 取消隐藏）已迁至 hooks/usePersistedLibraryData

  // 路径迁移（rekeyPathData）/ 清理（dropPathData）/ 落盘（persistPathData）已迁至 hooks/usePersistedLibraryData

  /** 应用拍摄时间修正：写入 override 并落盘（不改动原文件） */
  const handleApplyDateAdjustment = useCallback(async (adjustments: DateAdjustment[]) => {
    const byId = new Map<string, number>();
    let applied = 0;
    let skipped = 0;

    for (const { photo, timestamp } of adjustments) {
      if (!photo.path) {
        skipped += 1;
        continue;
      }
      dateOverridesRef.current.set(photo.path, timestamp);
      byId.set(photo.id, timestamp);
      applied += 1;
    }

    if (applied > 0) {
      setPhotos(prev =>
        prev.map(p => {
          const ts = byId.get(p.id);
          return ts === undefined ? p : { ...p, dateTaken: ts, dateAdjusted: true };
        })
      );
      await savePersistedConfig({ dateOverrides: Object.fromEntries(dateOverridesRef.current) });
    }

    setIsAdjustDateModalOpen(false);

    if (applied === 0) {
      showToast('所选项目没有磁盘路径，无法调整时间', 'warning');
    } else if (skipped > 0) {
      showToast(`已调整 ${applied} 项，${skipped} 项无磁盘路径已跳过`, 'warning');
    } else {
      showToast(`已调整 ${applied} 项的日期与时间`, 'success');
    }
  }, [showToast]);

  /** 保存相簿：关闭弹层后交给 hooks/useSmartAlbums 的 handleSaveAlbum */
  const handleSaveAlbumAndClose = useCallback((name: string) => {
    setIsSaveAlbumModalOpen(false);
    handleSaveAlbum(name);
  }, [handleSaveAlbum]);

  // clearLoading / showLoadingSoon / handleCancelLoading 等导入反馈已收口在 hooks/useIngestPipeline

  // K19 的批量文件操作反馈（beginFileOp / reportFileOp / endFileOp）已迁至 hooks/useFileOpFeedback

  // 延迟显示遮罩 / 拖放计数 / 取消中断（showLoadingSoon、beginDropWork、handleCancelLoading 等）
  // 已全部收口在 hooks/useIngestPipeline，这里只保留调用点与返回值解构

  // 清空照片列表：只清空列表与派生缓存，磁盘文件不动
  const handleClearList = useCallback(() => {
    // 释放降级路径（拖放无磁盘路径）创建的 ObjectURL，避免 blob 常驻内存
    photos.forEach(photo => {
      if (photo.url && photo.url.startsWith('blob:')) {
        URL.revokeObjectURL(photo.url);
      }
    });

    setPhotos([]);
    setSelectedIds(new Set());
    setQuickLookPhoto(null);
    setContextMenu(null);
    setFilters(createEmptyFilters());
    setSearchQuery('');
    importedPathsRef.current.clear();
    // N8：来源记录一并清空 —— 清空列表的语义是「重新开始」，
    // 留下来源会让下次启动又把刚清掉的库恢复回来
    sourcesRef.current = [];
    setSources([]);
    setUnavailableSourcePaths(new Set());
    void savePersistedConfig({ sources: [] });
    clearDragThumbnailCache();
    clearThumbnailCache();
    // 列表清空后指纹也失去意义，一并释放（否则切库后缓存只增不减）
    clearImageHashCache();
    cancelRequestedRef.current = false;
    releaseMemory('soft', 'clear-list');
    // 列表已清空：停掉目录监听，避免外部变动事件打到空列表上产生噪音提示
    unwatchCurrentDir();
    showToast('已清空照片列表', 'info');
  }, [photos, showToast, unwatchCurrentDir]);

  // 卸载兜底（停掉主进程 watcher）已随 hooks/useWatcherSync 一并迁出

  // 清空照片列表：入口只负责「请求」，确认与执行分开走。
  // 侧栏底部与右键菜单共用这一条路径，都会先停下来确认一次
  const handleRequestClearList = useCallback(() => setIsClearListConfirmOpen(true), []);
  const handleConfirmClearList = useCallback(() => {
    setIsClearListConfirmOpen(false);
    handleClearList();
  }, [handleClearList]);

  // 元数据批量补齐（loadMetadata）与统一入库管线（ingestFiles）已迁至 hooks/useIngestPipeline

  // 目录变动事件的应用（applyWatcherEvent）、暂存合并（flushPendingWatcherEvents）
  // 与订阅 effect 均已迁至 hooks/useWatcherSync

  // QuickLook 的翻页函数已随 hooks/useQuickLook 一并迁出（见下方调用处）

  // ---------------------------------------------------------------------------
  // 高层导入编排（打开目录 / 恢复图库 / 按路径导入 / 统一导入对话框）与来源交互
  // （点来源重扫、移除来源）统一收口在 hooks/useLibraryImport
  // ---------------------------------------------------------------------------
  const {
    loadDirectory,
    restoreLibrary,
    importFilePaths,
    importPickedPaths,
    handleImport,
    handleSelectSource,
    handleSelectDirectorySource,
    handleRemoveDirectorySource,
    handleSelectFileSources,
    handleRemoveFileSources,
  } = useLibraryImport({
    ingestFiles,
    activeScanIdRef,
    cancelRequestedRef,
    showLoadingSoon,
    cancelShowLoading,
    clearLoading,
    setLoadingTotal,
    setLoadingProgress,
    setLoadingCurrentFile,
    setLoadingKind,
    beginDropWork,
    endDropWork,
    sourcesRef,
    unavailableSourcePaths,
    rememberSources,
    removeSources,
    refreshSourceAvailability,
    watchCurrentDir,
    showToast,
  });

  // 按路径导入 / 统一导入对话框 / 来源交互（点击重扫、移除）
  // 与「恢复上次的图库」询问均已迁至 hooks/useLibraryImport 与 hooks/useLibrarySources

  // 选择集的交互（单击 / Shift 连选 / 全选）与收敛逻辑见下方 hooks/useSelection 调用

  // Sorting Logic
  const handleSortChange = useCallback((key: SortKey) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
  }, []);

  // 图库派生数据与选择集 Hook 的调用已提前到基础状态之后（见上方 useLibraryDerived / useSelection）

  // 全屏预览：状态、翻页范围与前后预加载（见 hooks/useQuickLook）
  const {
    quickLookPhoto,
    setQuickLookPhoto,
    setQuickLookScope,
    quickLookList,
    quickLookIndex,
    quickLookPreloadSources,
    handleQuickLookNext,
    handleQuickLookPrev,
  } = useQuickLook({
    visiblePhotos,
    timelinePhotos,
    isDuplicateDetectorOpen,
    isTimelineOpen,
    duplicateGroups,
  });

  // Shift 区间选择 / 全选 / 清空选择已迁至 hooks/useSelection

  // 批量收藏 / 取消收藏：选中项全部是收藏时 → 全部取消，否则 → 全部收藏
  const handleFavoriteSelected = useCallback(() => {
    const chosen = photos.filter(p => selectedIds.has(p.id));
    if (chosen.length === 0) return;
    const flipTo = !chosen.every(p => p.isFavorite);
    setFavorite(chosen.map(p => p.id), flipTo);
    showToast(
      flipTo ? `已收藏 ${chosen.length} 个项目` : `已取消收藏 ${chosen.length} 个项目`,
      'success'
    );
  }, [photos, selectedIds, setFavorite, showToast]);

  // 复制图片到系统剪贴板
  const handleCopyImage = useCallback(async (photo: Photo) => {
    if (!window.electronAPI) return;
    if (isVideoPhoto(photo)) {
      showToast('视频无法复制到剪贴板，可改用「复制路径」', 'warning');
      return;
    }
    if (!photo.path) {
      showToast('该文件没有磁盘路径，无法复制', 'warning');
      return;
    }
    const result = await window.electronAPI.copyImage(photo.path);
    if (!result.ok) {
      showToast(`复制失败：${result.error}`, 'error');
    } else {
      showToast(`已复制 "${photo.name}" 到剪贴板`, 'success');
    }
  }, [showToast]);

  // 在访达中定位文件
  const handleShowInFolder = useCallback(async (photo: Photo) => {
    if (!window.electronAPI || !photo.path) {
      showToast('该照片没有磁盘路径，无法在访达中显示', 'warning');
      return;
    }
    const result = await window.electronAPI.showInFolder(photo.path);
    if (!result.ok) {
      showToast(`无法打开所在文件夹：${result.error}`, 'error');
    }
  }, [showToast]);

  // 复制文件路径到剪贴板（Electron 下走主进程 clipboard，Web 降级到 navigator.clipboard）
  const handleCopyPath = useCallback(async (photo: Photo) => {
    const target = photo.path;
    if (!target) {
      showToast('该照片没有磁盘路径，无法复制路径', 'warning');
      return;
    }
    try {
      if (window.electronAPI?.copyText) {
        const result = await window.electronAPI.copyText(target);
        if (!result.ok) throw new Error(result.error);
      } else {
        await navigator.clipboard.writeText(target);
      }
      showToast('路径已复制到剪贴板', 'success');
    } catch (error) {
      logger.error('复制路径失败:', error);
      showToast('复制路径失败', 'error');
    }
  }, [showToast]);

  // 用系统默认应用 / 外部编辑器打开文件
  const handleOpenInEditor = useCallback(async (photo: Photo) => {
    if (!window.electronAPI || !photo.path) {
      showToast('该照片没有磁盘路径，无法打开', 'warning');
      return;
    }
    const result = await window.electronAPI.openPath(photo.path);
    if (!result.ok) {
      showToast(`打开失败：${result.error}`, 'error');
    }
  }, [showToast]);

  // 打开导出弹层（默认导出当前选中项；视频不参与重编码导出）
  const handleExportSelected = useCallback(() => {
    if (selectedPhotos.length === 0) {
      showToast('请先选择要导出的项目', 'info');
      return;
    }
    const targets = selectedPhotos.filter(p => !isVideoPhoto(p));
    if (targets.length === 0) {
      showToast('视频暂不支持导出，可在访达中直接复制原文件', 'info');
      return;
    }
    if (targets.length < selectedPhotos.length) {
      showToast(`已跳过 ${selectedPhotos.length - targets.length} 个视频`, 'info');
    }
    setExportTargets(targets);
    setIsExportModalOpen(true);
  }, [selectedPhotos, showToast]);

  // Context Menu Actions 定义在 handleCheckDuplicates 之后（见下方），
  // 避免引用尚未初始化的函数。

  // ---------------------------------------------------------------------------
  // 批量文件操作（重命名 / 删除 / 移动）见 hooks/useFileOperations —— 提交锁、
  // 回环登记、路径迁移、失败分流与 K19 进度反馈都在 Hook 内实现。
  // ---------------------------------------------------------------------------
  const { handleRenamePhoto, handleBatchRename, handleConfirmDelete, handleMoveSelected   } = useFileOperations({
    photos,
    photosRef,
    selectedIds,
    setSelectedIds,
    setPhotos,
    setIsRenameModalOpen,
    setIsDeleteModalOpen,
    showToast,
    fileOpLockRef,
    markPathsTouched,
    flushPendingWatcherEvents,
    fsGuard,
    beginFileOp,
    reportFileOp,
    endFileOp,
    removeWithCollapse,
    pruneDuplicateGroups,
    rekeyPathData,
    dropPathData,
    persistPathData,
  });

  // handleBatchRename（批量重命名）已迁至 hooks/useFileOperations

  // runDelete（回收站删除与失败分流）与 handleConfirmDelete 已迁至 hooks/useFileOperations

  // 移动（doRunMove / runMove / handleMoveSelected）已迁至 hooks/useFileOperations

  // 重复检测的完整流程（检测 / 取消 / 退出 / 结果内删除）已迁至 hooks/useDuplicateDetection

  // Context Menu Actions（菜单项构造逻辑见 contextMenuActions.ts）
  const contextMenuActions = useMemo((): ContextMenuItem[] => buildContextMenuActions({
    contextPhoto: contextMenu?.photo ?? null,
    visibleCount: visiblePhotos.length,
    photoCount: photos.length,
    selectedIds,
    getPhotoById: (id) => photosRef.current.find(p => p.id === id),
    onImport: handleImport,
    onSelectAllVisible: handleSelectAllVisible,
    onCheckDuplicates: handleCheckDuplicates,
    onClearList: handleRequestClearList,
    onOpenQuickLook: setQuickLookPhoto,
    onToggleFavorite: toggleFavorite,
    onSetHidden: setHidden,
    onCopyImage: handleCopyImage,
    onShowInFolder: handleShowInFolder,
    onCopyPath: handleCopyPath,
    onOpenInEditor: handleOpenInEditor,
    onExportSelected: handleExportSelected,
    onMovePhotos: handleMoveSelected,
    onOpenAdjustDate: () => setIsAdjustDateModalOpen(true),
    onOpenRename: () => setIsRenameModalOpen(true),
    onOpenDelete: () => setIsDeleteModalOpen(true),
  }), [contextMenu, visiblePhotos.length, photos.length, selectedIds, toggleFavorite, setHidden, handleCopyImage, handleShowInFolder, handleCopyPath, handleOpenInEditor, handleExportSelected, handleMoveSelected, handleSelectAllVisible, handleCheckDuplicates, handleRequestClearList, handleImport]);

  // 媒体统计 / 相簿命中数 / 侧栏高亮已并入 hooks/useLibraryDerived

  // 侧栏「文件夹」来源区：目录逐个列出，单独添加的文件聚合为一行
  const directorySources = useMemo(
    () => sources.filter(source => source.kind === 'directory'),
    [sources]
  );
  const fileSources = useMemo(() => sources.filter(source => source.kind === 'file'), [sources]);
  const unavailableSourceCount = unavailableSourcePaths.size;

  // 筛选面板可选项（相机 / 格式 / 标签）已并入 hooks/useLibraryDerived

  // 传给 memo 组件（Toolbar / Sidebar）的回调必须保持引用稳定，
  // 否则每次 App 渲染都会生成新函数，React.memo 直接失效。
  /**
   * 点顶部日期胶囊 → 把筛选收敛到「这一天」。
   * 走的是与筛选面板完全相同的 dateFrom / dateTo 条件（闭区间，本地日历日），
   * 因此条件条上会出现可逐条清除的胶囊，不会变成一条看不见的暗规则。
   */
  const handleFilterByDate = useCallback((timestamp: number) => {
    const d = new Date(timestamp);
    if (Number.isNaN(d.getTime())) return;
    updateFilters({
      dateFrom: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime(),
      dateTo: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime(),
    });
  }, [updateFilters]);

  const handleOpenSaveAlbum = useCallback(() => setIsSaveAlbumModalOpen(true), []);
  const handleSelectTimeline = useCallback(() => setMainView('timeline'), []);
  const handleSelectMap = useCallback(() => setMainView('map'), []);
  /** 地图照片条 → QuickLook：翻页范围限定在该地点的照片内 */
  const handleMapQuickLook = useCallback((photo: Photo, scope: Photo[]) => {
    setQuickLookScope(scope);
    setQuickLookPhoto(photo);
  }, []);
  const handleOpenShortcuts = useCallback(() => setIsShortcutsOpen(true), []);
  const handleOpenAiSettings = useCallback(() => setIsAiSettingsOpen(true), []);
  const handleCheckDuplicatesClick = useCallback(() => {
    void handleCheckDuplicates();
  }, [handleCheckDuplicates]);

  // 侧栏分类选择：分类与媒体类型一起写入筛选状态（与筛选面板共用同一份数据）
  const handleSelectNav = useCallback((category: string, filter: MediaFilter) => {
    setFilters(prev => ({
      ...prev,
      favoritesOnly: category === 'favorites',
      hiddenOnly: category === 'hidden',
      mediaFilter: filter,
    }));
  }, []);
  
  // handleUpdatePhoto（标签 / AI 结果落盘）已迁至 hooks/usePersistedLibraryData

  // ---------------------------------------------------------------------------
  // 全局键盘交互（快捷键闭环 / 方向键导航 / 指针失焦）见 hooks/useKeyboardShortcuts
  // ---------------------------------------------------------------------------
  const handleExitToLibrary = useCallback(() => setMainView('library'), []);
  useKeyboardShortcuts({
    visiblePhotos,
    selectedIds,
    setSelectedIds,
    selectionAnchorRef,
    gridRef,
    viewMode,
    contextMenu,
    setContextMenu,
    quickLookPhoto,
    setQuickLookPhoto,
    isRenameModalOpen,
    isDeleteModalOpen,
    isExportModalOpen,
    isAiSettingsOpen,
    isAdjustDateModalOpen,
    isSaveAlbumModalOpen,
    isFilterPanelOpen,
    isClearListConfirmOpen,
    isShortcutsOpen,
    setIsShortcutsOpen,
    isDuplicateDetectorOpen,
    isTimelineOpen,
    isMapOpen,
    onExitToLibrary: handleExitToLibrary,
    handleExitDuplicates,
    searchInputRef,
    handleSelectAllVisible,
    handleFavoriteSelected,
    setIsDeleteModalOpen,
  });

  // ⌘O 应用菜单「导入图片或文件夹」：主进程弹出选择框后回传分类好的路径
  useEffect(() => {
    if (!window.electronAPI) return;
    return window.electronAPI.onImportPaths((picked: PickedPaths) => {
      void importPickedPaths(picked);
    });
  }, [importPickedPaths]);

  // 应用菜单「AI 分析设置…」（⌘,）：任意视图下都能唤出配置弹窗
  useEffect(() => {
    return window.electronAPI?.onOpenAiSettings?.(handleOpenAiSettings);
  }, [handleOpenAiSettings]);

  // ---------------------------------------------------------------------------
  // 拖放导入（遮罩进出场 / 文件与文件夹分流 / 内存预览降级）见 hooks/useDragAndDrop
  // ---------------------------------------------------------------------------
  const {
    isDraggingFile,
    isDragOverlayMounted,
    isDragOverlayActive,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = useDragAndDrop({
    setPhotos,
    ingestFiles,
    rememberSources,
    watchCurrentDir,
    showToast,
    activeScanIdRef,
    cancelRequestedRef,
    beginDropWork,
    endDropWork,
    setLoading,
    setLoadingProgress,
    setLoadingTotal,
    setLoadingCurrentFile,
    clearLoading,
  });

  // 空状态 / 情境条文案的派生（isEmptyLibrary / gridViewTitle 等）已并入 hooks/useLibraryDerived

  return (
    <div className={`app-container flex h-screen ${isLight ? 'light-theme' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag and Drop Overlay */}
      <DragOverlay mounted={isDragOverlayMounted} active={isDragOverlayActive} />
      {/* 左栏只在图库视图出现：时光画廊 / 相似照片是自带导航的整页视图，
          它们的照片集合与图库不同一份，保留左栏会同时高亮两个条目并误导点击 */}
      {mainView === 'library' && (
        <Sidebar
          counts={counts}
          activeCategory={activeCategory}
          mediaFilter={mediaFilter}
          onSelectNav={handleSelectNav}
          albums={albums}
          albumCounts={albumCounts}
          activeAlbumId={activeAlbumId}
          onSelectAlbum={handleSelectAlbum}
          onDeleteAlbum={handleDeleteAlbum}
          onRequestSaveAlbum={handleOpenSaveAlbum}
          directorySources={directorySources}
          fileSources={fileSources}
          unavailableSourcePaths={unavailableSourcePaths}
          onSelectDirectorySource={handleSelectDirectorySource}
          onRemoveDirectorySource={handleRemoveDirectorySource}
          onSelectFileSources={handleSelectFileSources}
          onRemoveFileSources={handleRemoveFileSources}
          onSelectTimeline={handleSelectTimeline}
          isTimelineActive={isTimelineOpen}
          onSelectMap={handleSelectMap}
          isMapActive={isMapOpen}
          onCheckDuplicates={handleCheckDuplicatesClick}
          onRequestReset={handleRequestClearList}
          hasPhotos={photos.length > 0}
          onOpenShortcuts={handleOpenShortcuts}
          isOpen={isLeftPaneOpen}
          themeMode={theme}
          onThemeModeChange={setTheme}
        />
      )}
      {/* Loading Overlay for Large File Operations */}
      {loading && (
        <LoadingOverlay
          total={loadingTotal}
          progress={loadingProgress}
          currentFile={loadingCurrentFile}
          onCancel={handleCancelLoading}
          cancelLabel={loadingKind === 'restore' ? '取消恢复' : undefined}
        />
      )}
      {/* K19：批量文件操作（重命名 / 删除 / 移动）的大操作遮罩 —— 延迟升起，覆盖弹层防连点 */}
      {fileOpOverlay && (
        <LoadingOverlay
          total={fileOpOverlay.total}
          progress={fileOpOverlay.done}
          currentFile={fileOpOverlay.file}
          title={fileOpOverlay.title}
          hint={fileOpOverlay.hint}
        />
      )}
      <div className="main-content flex-1 flex flex-col bg-transparent">
        {/* 重复检测：整页接管主内容区；左栏在整页视图里不渲染（见 isLeftPaneVisible） */}
        {mainView === 'duplicates' ? (
          <ErrorBoundary
            label="重复检测"
            fallback={
              <ViewErrorFallback
                title="相似检测视图出错"
                description="图库内容仍然完好，可返回图库继续整理。"
                onAction={() => setMainView('library')}
              />
            }
          >
            <DuplicateDetector
              onBack={handleExitDuplicates}
              duplicateGroups={duplicateGroups}
              onDeleteDuplicates={handleDeleteDuplicates}
              isProcessing={isProcessingDuplicates}
              isRepartitioning={isRepartitioningDuplicates}
              progress={duplicateProgress}
              onQuickLook={setQuickLookPhoto}
              onRecheck={() => handleCheckDuplicates()}
              onCancel={handleCancelDuplicates}
              similarity={duplicateSimilarity}
              onSimilarityChange={setDuplicateSimilarity}
              scope={duplicateScope}
              onScopeChange={setDuplicateScope}
              isLeftPaneOpen={isLeftPaneVisible}
            />
          </ErrorBoundary>
        ) : mainView === 'timeline' ? (
          <ErrorBoundary
            label="时光画廊"
            fallback={
              <ViewErrorFallback
                title="时光画廊渲染出错"
                description="图库内容仍然完好，可返回图库继续浏览。"
                onAction={() => setMainView('library')}
              />
            }
          >
            <TimelineGallery
              photos={timelinePhotos}
              onQuickLook={setQuickLookPhoto}
              onBack={() => setMainView('library')}
              isLeftPaneOpen={isLeftPaneVisible}
            />
          </ErrorBoundary>
        ) : mainView === 'map' ? (
          <ErrorBoundary
            label="按地点浏览"
            fallback={
              <ViewErrorFallback
                title="地图视图出错"
                description="图库内容仍然完好，可返回图库继续浏览。"
                onAction={() => setMainView('library')}
              />
            }
          >
            {/* 与时光画廊同源：非隐藏的全部照片（带 GPS 的会落成光点） */}
            <LocationMap
              photos={timelinePhotos}
              onQuickLook={handleMapQuickLook}
              onBack={() => setMainView('library')}
              isLeftPaneOpen={isLeftPaneVisible}
              isLight={isLight}
            />
          </ErrorBoundary>
        ) : (
          <>
        <Toolbar
          onImport={handleImport}
          viewMode={viewMode}
          setViewMode={setViewMode}
          isDetailsPaneOpen={isDetailsPaneOpen}
          setIsDetailsPaneOpen={setIsDetailsPaneOpen}
          isLeftPaneOpen={isLeftPaneOpen}
          setIsLeftPaneOpen={setIsLeftPaneOpen}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          searchInputRef={searchInputRef}
          filters={filters}
          onFiltersChange={updateFilters}
          onResetFilters={resetFilters}
          filterOptions={filterOptions}
          hasVideos={counts.videos > 0 || filters.durationFilter !== 'any'}
          onFilterOpenChange={handleFilterOpenChange}
        />
        {/* 「已隐藏」视图里分子是隐藏项数，分母必须也用隐藏总数，
            否则会显示成「5 / 100 项」这种两个互斥集合相除的假比例 */}
        <ActiveFiltersBar
          filters={filters}
          onPatch={updateFilters}
          onReset={resetFilters}
          onSaveAsAlbum={() => setIsSaveAlbumModalOpen(true)}
          resultCount={visiblePhotos.length}
          totalCount={filters.hiddenOnly ? counts.hidden : counts.all}
        />
        <ErrorBoundary
          label="图库"
          fallback={
            <ViewErrorFallback
              title="图库渲染出错"
              description="工具栏与详情面板仍可使用，可尝试切换视图或清空照片列表。"
              actionLabel="清空照片列表"
              onAction={handleClearList}
            />
          }
        >
        <ImageGrid
          ref={gridRef}
          photos={visiblePhotos}
          selectedIds={selectedIds}
          onToggleSelect={handleToggleSelect}
          onRangeSelect={handleRangeSelect}
          onSelectAll={handleSelectAllVisible}
          onClearSelection={handleClearSelection}
          onFavoriteSelected={handleFavoriteSelected}
          viewMode={viewMode}
          scale={scale}
          onScaleChange={setScale}
          sortConfig={sortConfig}
          onSort={(key) => handleSortChange(key)}
          onToggleFavorite={toggleFavorite}
          onQuickLook={setQuickLookPhoto}
          onContextMenu={(e, photo) => {
            e.preventDefault();
            // 右键点击未选中的照片时，先把它变成唯一选中项，
            // 让菜单里的「重命名 / 删除」作用目标与视觉直觉一致
            if (photo && !selectedIds.has(photo.id)) {
              setSelectedIds(new Set([photo.id]));
              selectionAnchorRef.current = photo.id;
            }
            setContextMenu({ x: e.clientX, y: e.clientY, photo });
          }}
          onShowDeleteConfirm={() => setIsDeleteModalOpen(true)}
          onBatchRename={() => setIsRenameModalOpen(true)}
          onMoveSelected={() => handleMoveSelected()}
          onExportSelected={handleExportSelected}
          onFilterByDate={handleFilterByDate}
          viewTitle={gridViewTitle}
          emptyKind={emptyKind}
          emptyHint={
            emptyKind === 'library' || emptyKind === 'allHidden'
              ? undefined
              : `库中 ${counts.all} 项，当前条件下没有匹配`
          }
          emptyTitle={
            isSearchEmpty ? '没有匹配的结果'
              : isEmptyLibrary ? '打开你的图库'
              : isAllHidden ? '所有项目都已隐藏'
              : isHiddenEmpty ? '没有已隐藏的项目'
              : isFilterEmpty ? '没有符合筛选条件的结果'
              : isMediaFilterEmpty
                ? `还没有${MEDIA_FILTER_LABELS[mediaFilter]}`
                : '收藏夹还是空的'
          }
          emptyDescription={
            isSearchEmpty
              ? `找不到与「${searchQuery}」匹配的内容。试着换个关键词，或清除搜索。`
              : isEmptyLibrary
                ? '把整个文件夹拖进窗口，或使用「打开文件夹」导入。打开过的文件夹会被记住，重启后可一键恢复；所有整理都在本地完成。'
                : isAllHidden
                  ? '当前图库里的项目都被隐藏了，它们收在「已隐藏」里，可在那里取消隐藏。'
                  : isHiddenEmpty
                    ? '在照片上点右键选择「隐藏」，被隐藏的项目就会收在这里，不打扰日常浏览。'
                    : isFilterEmpty
                      ? '当前筛选条件没有匹配项，放宽条件或清除筛选后再试。'
                      : isMediaFilterEmpty
                        ? `当前图库中没有${MEDIA_FILTER_LABELS[mediaFilter]}，切回「全部」可以查看其他内容。`
                        : '在「所有照片」中点击照片角落的心形按钮，就能把喜欢的照片收进这里。'
          }
          onImport={isEmptyLibrary ? handleImport : undefined}
          onShowAll={
            isAllHidden
              ? () => handleSelectNav('hidden', 'all')
              : isFilterEmpty
                ? resetFilters
                : isFavoritesEmpty
                  ? () => handleSelectNav('all', 'all')
                  : isMediaFilterEmpty
                    ? () => updateFilters({ mediaFilter: 'all' })
                    : undefined
          }
          showAllLabel={isAllHidden ? '查看「已隐藏」' : isFilterEmpty ? '清除筛选' : '前往「所有照片」'}
          onClearSearch={isSearchEmpty ? () => setSearchQuery('') : undefined}
          exitingIds={exitingIds}
        />
        </ErrorBoundary>
          </>
        )}
      </div>
      {/* Details Pane：仅图库视图展示，重复检测页把整幅宽度让给分组列表 */}
      {mainView === 'library' && (
      <ErrorBoundary
        label="详情面板"
        fallback={
          <div className="w-80 shrink-0 border-l border-[var(--border-subtle)] p-6 text-sm text-[var(--text-tertiary)]">
            详情面板渲染出错
          </div>
        }
      >
        <DetailsPane
          selectedPhotos={selectedPhotos}
          onUpdatePhoto={handleUpdatePhoto}
          onRenamePhoto={handleRenamePhoto}
          isDetailsPaneOpen={isDetailsPaneOpen}
          onNotify={showToast}
          onOpenAiSettings={handleOpenAiSettings}
        />
      </ErrorBoundary>
      )}
      {contextMenu && (
        <ContextMenu 
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={() => setContextMenu(null)}
            actions={contextMenuActions}
        />
      )}
      {/* Toast 队列：底部居中堆叠，避免遮挡工具栏（渲染见 ToastStack） */}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      {isRenameModalOpen && (
        <RenameModal 
          isOpen={isRenameModalOpen}
          onClose={() => setIsRenameModalOpen(false)}
          onConfirm={handleBatchRename}
          photos={photos.filter(p => selectedIds.has(p.id))}
          count={selectedIds.size}
          isBusy={isFileOpBusy}
        />
      )}
      {isDeleteModalOpen && (
        <DeleteConfirmModal 
          isOpen={isDeleteModalOpen}
          count={selectedIds.size}
          isDiskOperation={true}
          onClose={() => setIsDeleteModalOpen(false)}
          onConfirm={handleConfirmDelete}
          isBusy={isFileOpBusy}
        />
      )}
      {/* 清空照片列表二次确认：侧栏底部入口与右键菜单都走这里 */}
      <ClearListConfirmModal
        isOpen={isClearListConfirmOpen}
        count={photos.length}
        onClose={() => setIsClearListConfirmOpen(false)}
        onConfirm={handleConfirmClearList}
      />
      {/* 「恢复上次的图库」确认框（N8）：启动时存在常驻来源才出现 */}
      <RestoreLibraryModal
        isOpen={isRestorePromptOpen}
        sourceCount={sources.length}
        directoryCount={directorySources.length}
        fileCount={fileSources.length}
        directoryNames={directorySources.map(source => basenameOfPath(source.path))}
        unavailableCount={unavailableSourceCount}
        onClose={() => {
          setIsRestorePromptOpen(false);
          showToast('可在侧栏「文件夹」中随时重新打开来源', 'info');
        }}
        onConfirm={() => {
          setIsRestorePromptOpen(false);
          void restoreLibrary(sourcesRef.current);
        }}
      />
      {/* AI 分析设置：应用内配置 DeepSeek API Key / 接口地址 / 模型 */}
      <AiSettingsModal
        isOpen={isAiSettingsOpen}
        onClose={() => setIsAiSettingsOpen(false)}
        onNotify={showToast}
      />
      {/* Export Modal */}
      {isExportModalOpen && (
        <ExportModal
          isOpen={isExportModalOpen}
          photos={exportTargets}
          onClose={() => { setIsExportModalOpen(false); setExportTargets([]); }}
          onFinish={({ succeeded, failed, cancelled, firstError, targetDir, gonePhotos }) => {
            setIsExportModalOpen(false);
            // 源文件已被外部删除 / 移动的条目：剔除出列表，且不进「重新导出」集合
            const gone = gonePhotos ?? [];
            if (gone.length > 0) fsGuard.reportGone(gone);
            // 重试必须带着目标重新打开弹层：只开弹层会得到一个空的「已选择 0 张照片」
            const goneIds = new Set(gone.map(p => p.id));
            const retryTargets = exportTargets.filter(p => !goneIds.has(p.id));
            setExportTargets([]);
            const retryExport = {
              label: '重新导出',
              onClick: () => {
                setExportTargets(retryTargets);
                setIsExportModalOpen(true);
              },
            };
            // 失败原因不再一律归咎于重名：实际原因（解码失败 / 无权限 / 磁盘满）由弹层回传
            const reason = firstError ? `：${firstError}` : '';
            const dirName = targetDir.split(/[\\/]/).filter(Boolean).pop() ?? '';
            const where = dirName ? `到「${dirName}」` : '';
            // 汇总里的「失败」只算真正可重试的：文件消失的条目已单独提示并剔除
            const retriableFailed = failed - gone.length;
            if (cancelled) {
              showToast(`导出已取消：完成 ${succeeded} 张${retriableFailed > 0 ? `，失败 ${retriableFailed} 张${reason}` : ''}`, 'warning');
            } else if (retriableFailed === 0) {
              showToast(`已导出 ${succeeded} 张${where}`, 'success');
            } else if (succeeded > 0) {
              showToast(`已导出 ${succeeded} 张，${retriableFailed} 张失败${reason}`, 'warning', retryExport);
            } else {
              showToast(`导出失败：${retriableFailed} 张照片均未成功${reason}`, 'error', retryExport);
            }
          }}
        />
      )}
      {/* 调整日期与时间 */}
      {isAdjustDateModalOpen && (
        <AdjustDateModal
          isOpen={isAdjustDateModalOpen}
          photos={selectedPhotos}
          onClose={() => setIsAdjustDateModalOpen(false)}
          onApply={handleApplyDateAdjustment}
        />
      )}
      {/* 存为智能相簿 */}
      {isSaveAlbumModalOpen && (
        <SaveAlbumModal
          isOpen={isSaveAlbumModalOpen}
          filters={filters}
          onClose={() => setIsSaveAlbumModalOpen(false)}
          onSave={handleSaveAlbumAndClose}
        />
      )}
      {/* 快捷键总览层 */}
      {isShortcutsOpen && <ShortcutsOverlay onClose={() => setIsShortcutsOpen(false)} />}
      {/* QuickLook Component */}
      {quickLookPhoto && (
        <QuickLook
          photo={quickLookPhoto}
          onClose={() => setQuickLookPhoto(null)}
          onNext={handleQuickLookNext}
          onPrev={handleQuickLookPrev}
          onFirst={quickLookList.length > 0 ? () => setQuickLookPhoto(quickLookList[0]) : undefined}
          hasNext={quickLookIndex >= 0 && quickLookIndex < quickLookList.length - 1}
          hasPrev={quickLookIndex > 0}
          currentIndex={quickLookIndex}
          totalCount={quickLookList.length}
          onToggleFavorite={toggleFavorite}
          preloadSources={quickLookPreloadSources}
        />
      )}
    </div>
  );
};

export default App;