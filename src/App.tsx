import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { AiCacheEntry, LibrarySource, MediaFilter, PersistedConfig, Photo, PhotoFilters, SmartAlbum, SortConfig, ViewMode, RenameOptions, SortKey } from '@/types';
import {
  isImageName,
  isVideoName,
  isVideoPhoto,
  mapWithConcurrency,
  mediaKindOf,
  clearImageHashCache,
  mediaMimeType,
  pmFileUrl,
  formatDateForNaming,
  folderOfPath,
  repairFileName,
} from '@/utils';
import {
  installMemoryPressureListener,
  releaseMemory,
  startHeapWatch,
} from '@/lib/cache/cacheManager';
import { groupPhotos, sortPhotosByTimeline } from '@/lib/media/photoGrouping';
import { createThumbnail, clearDragThumbnailCache } from '@/lib/cache/dragThumbnail';
import { joinPath, sanitizeFilename } from '@/lib/fs/pathUtils';
import { deriveLibraryViewState } from '@/lib/filter/libraryViewState';
import { buildContextMenuActions } from '@/lib/contextMenuActions';
import { humanizeFsError, movePhotosToTrash, isFileGoneError, type TrashResult } from '@/lib/fs/fileOperations';
import { createFsErrorReporter } from '@/lib/fs/ipcGuard';
import { useToasts } from '@/hooks/useToasts';
import { useThemeMode } from '@/hooks/useThemeMode';
import { useDuplicateDetection } from '@/hooks/useDuplicateDetection';
import {
  MEDIA_FILTER_LABELS,
  applyPhotoFilters,
  buildFilterOptions,
  buildTagOptions,
  createEmptyFilters,
  filtersEqual,
  hasAdvancedFilters,
  matchesFilters,
  normalizeFilters,
} from '@/lib/filter/filters';
import { buildLivePhotoIds, isSelfiePhoto, isScreenshotPhoto } from '@/lib/media/mediaTypes';
import {
  forgetVideoMeta,
  getVideoMeta,
  rekeyVideoMeta,
  seedVideoMeta,
  snapshotVideoMeta,
  subscribeVideoMeta,
  videoMetaKeyOf,
} from '@/lib/media/videoMeta';
import {
  loadPersistedConfig,
  savePersistedConfig,
  setPersistenceErrorHandler,
} from '@/lib/persistence/persistence';
import { basenameOfPath, readSourcesFromConfig, upsertSources } from '@/lib/persistence/sources';
import { loadAiCache, saveAiCache } from '@/lib/persistence/aiCache';
import Sidebar from '@/components/layout/Sidebar';
import Toolbar from '@/components/layout/Toolbar';
import ImageGrid, { ImageGridHandle } from '@/components/grid/ImageGrid';
import DetailsPane from '@/components/detail/DetailsPane';
import RenameModal from '@/components/modal/RenameModal';
import DeleteConfirmModal from '@/components/modal/DeleteConfirmModal';
import ClearListConfirmModal from '@/components/modal/ClearListConfirmModal';
import QuickLook from '@/components/detail/QuickLook';
import Toast from '@/components/common/Toast';
import ContextMenu, { ContextMenuItem } from '@/components/common/ContextMenu';
import DuplicateDetector, {
  DUPLICATE_SIMILARITY_MAX,
  DUPLICATE_SIMILARITY_MIN,
} from '@/components/duplicate/DuplicateDetector';
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

/** 主内容区的顶层视图：图库 / 时光画廊 / 按地点浏览 / 重复图片检测（整页视图，而非弹窗） */
type MainView = 'library' | 'timeline' | 'map' | 'duplicates';

/** 导入所需的最小文件信息（来自主进程扫描 / stat） */
interface FileInfo {
  path: string;
  name: string;
  size: number;
  mtime: number;
  /** 文件系统创建时间（birthtime），用于重复检测时判断「原始照片」 */
  created?: number;
}

/** 卡片塌陷动画时长：与 ImageGrid 中卡片淡出的 duration 保持一致 */
const EXIT_DURATION = 200;

const App: React.FC = () => {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
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

  // ---- 持久化数据（以磁盘路径为键）：收藏 / 隐藏 / 标签 / 拍摄时间修正 ----
  const favoritesRef = useRef<Set<string>>(new Set());
  const hiddenRef = useRef<Set<string>>(new Set());
  const tagsRef = useRef<Map<string, string[]>>(new Map());
  const dateOverridesRef = useRef<Map<string, number>>(new Map());
  /** 智能相簿（只存筛选条件，内容随图库自动更新） */
  const [albums, setAlbums] = useState<SmartAlbum[]>([]);
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
  /** AI 分析结果缓存（路径 → 描述 / 标签），持久化在独立的 ai-cache.json */
  const aiCacheRef = useRef<Map<string, AiCacheEntry>>(new Map());
  /**
   * 常驻来源（N8）：打开的文件夹与单独添加的文件都记在这里，重启后据此重建图库。
   * 顺序（最近使用在前）、去重与条数上限由 sources.ts 统一维护。
   */
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const sourcesRef = useRef<LibrarySource[]>([]);
  /** 运行时判定为不可用的来源路径（不存在 / 卷未挂载）；不落盘，每次启动重探 */
  const [unavailableSourcePaths, setUnavailableSourcePaths] = useState<Set<string>>(new Set());
  /** 「恢复上次的图库」确认框：每个会话只问一次 */
  const [isRestorePromptOpen, setIsRestorePromptOpen] = useState(false);
  const restorePromptShownRef = useRef(false);
  /** 配置是否已读取完成：完成前不写偏好，避免用默认值覆盖已存配置 */
  const [isConfigLoaded, setIsConfigLoaded] = useState(false);
  const [quickLookPhoto, setQuickLookPhoto] = useState<Photo | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false); // Global drag state
  // 拖拽遮罩需要完整的进出场：mounted 决定它是否在 DOM 里，active 决定它是淡入还是淡出
  const [isDragOverlayMounted, setIsDragOverlayMounted] = useState(false);
  const [isDragOverlayActive, setIsDragOverlayActive] = useState(false);
  const [isDetailsPaneOpen, setIsDetailsPaneOpen] = useState(true); // Control details pane visibility
  // 左栏承载分类导航（含图片 / 视频筛选）与文件夹来源，默认展开
  const [isLeftPaneOpen, setIsLeftPaneOpen] = useState(true); // Control sidebar visibility
  // 外观模式（明亮 / 暗黑 / 跟随系统）与系统深浅色监听：见 hooks/useThemeMode
  const { theme, setTheme, isLight } = useThemeMode();

  // Toast 队列：支持多条同时展示，错误级常驻（见 hooks/useToasts）
  const { toasts, showToast, dismissToast } = useToasts();

  // 配置 / AI 缓存落盘失败时统一提示：这类失败在界面上没有任何征兆，
  // 不提示的话用户只会在下次启动时发现「收藏、相簿、标签全没了」
  useEffect(() => {
    setPersistenceErrorHandler(message => showToast(message, 'error'));
    return () => setPersistenceErrorHandler(null);
  }, [showToast]);

  // 搜索（文件名 / 相机 / 格式）
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 媒体筛选由 filters 统一承载（侧栏导航与筛选面板共用同一份状态）
  const mediaFilter = filters.mediaFilter;

  // 导出弹层
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  /** 实际进入导出流程的条目（视频不走重编码导出，会被排除） */
  const [exportTargets, setExportTargets] = useState<Photo[]>([]);

  // 网格句柄：方向键导航需要 scrollToPhoto + 按真实行几何取上下邻居
  const gridRef = useRef<ImageGridHandle>(null);
  
  // Context Menu State
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; photo?: Photo } | null>(null);
  
  // Loading state for large file operations
  const [loading, setLoading] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [loadingTotal, setLoadingTotal] = useState(0);
  const [loadingCurrentFile, setLoadingCurrentFile] = useState('');
  /** 遮罩承载的操作类型：只影响取消按钮与取消提示的文案（导入 / 恢复上次的图库） */
  const [loadingKind, setLoadingKind] = useState<'import' | 'restore'>('import');

  // K19：批量文件操作（重命名 / 删除 / 移动）的状态。
  // isFileOpBusy 同步置位 → 弹层主按钮置灰；fileOpOverlay 延迟升起 → 小批量不闪遮罩。
  const [isFileOpBusy, setIsFileOpBusy] = useState(false);
  const [fileOpOverlay, setFileOpOverlay] = useState<{
    title: string;
    hint: string;
    total: number;
    done: number;
    file: string;
  } | null>(null);

  // 已从磁盘删除、正在播塌陷动画的条目：卡片还在，但已淡出且不可交互
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set());
  const exitTimersRef = useRef<number[]>([]);

  /**
   * 删除后的塌陷：先让卡片播完淡出，再真正从列表里移除。
   * 文件此刻已经进了回收站，但视觉上必须让人看见「它消失了」，而不是凭空不见。
   */
  const removeWithCollapse = useCallback((ids: Set<string>) => {
    if (ids.size === 0) return;
    setExitingIds(prev => new Set([...prev, ...ids]));

    const timer = window.setTimeout(() => {
      exitTimersRef.current = exitTimersRef.current.filter(t => t !== timer);

      // 释放降级路径（拖放无磁盘路径）产生的 blob: URL。
      // 这些条目在磁盘上没有对应文件，若不在这里回收，ObjectURL 会一直常驻内存，
      // 直到「清空照片列表」才被清掉 —— 长时间增删就是典型的内存只增不减。
      const blobUrls: string[] = [];
      photosRef.current.forEach(photo => {
        if (ids.has(photo.id) && photo.url.startsWith('blob:')) blobUrls.push(photo.url);
      });

      setPhotos(prev => prev.filter(p => !ids.has(p.id)));
      setExitingIds(prev => {
        const next = new Set(prev);
        ids.forEach(id => next.delete(id));
        return next;
      });

      // 等卡片卸载后再释放，避免淡出动画过程中图片变成破图
      if (blobUrls.length > 0) {
        window.requestAnimationFrame(() => {
          blobUrls.forEach(url => URL.revokeObjectURL(url));
        });
      }
    }, EXIT_DURATION);
    exitTimersRef.current.push(timer);
  }, []);

  // 卸载时清掉尚未播完的塌陷计时器
  useEffect(() => () => {
    exitTimersRef.current.forEach(t => window.clearTimeout(t));
    exitTimersRef.current = [];
  }, []);

  /** 卡片塌陷动画结束后执行回调（复用 exitTimersRef，卸载时统一清理） */
  const scheduleAfterExit = useCallback((callback: () => void) => {
    const timer = window.setTimeout(() => {
      exitTimersRef.current = exitTimersRef.current.filter(t => t !== timer);
      callback();
    }, EXIT_DURATION);
    exitTimersRef.current.push(timer);
  }, []);

  /** 从当前选中集中移除指定 id（保留其它选中项） */
  const removeIdsFromSelection = useCallback((ids: Set<string>) => {
    setSelectedIds(prev => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      ids.forEach(id => next.delete(id));
      return next;
    });
  }, []);

  // 导入取消：目录扫描（主进程 scanId）与分批入库（AbortController）都可中断
  const activeScanIdRef = useRef<string | null>(null);
  const importAbortRef = useRef<AbortController | null>(null);
  const cancelRequestedRef = useRef(false);
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
  
  // 已导入的路径集合：重复打开同一目录时直接跳过，避免重复条目
  const importedPathsRef = useRef<Set<string>>(new Set());

  // 只摘 importedPaths 登记、不动收藏 / 标签：文件消失后的重新导入需要这条路径空出来
  const forgetImportedPaths = useCallback((paths: Iterable<string>) => {
    for (const p of paths) importedPathsRef.current.delete(p);
  }, []);

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
  // 目录监听（N5）：主进程只做过滤 + 防抖聚合，语义判定全部在这里：
  //   removed → 统一剔除管线；added → statFiles + ingestFiles（天然去重分批）。
  //   应用自身操作的回环事件走「双保险」过滤：
  //     1) 操作期间事件暂存（pendingWatcherEventsRef），锁释放后合并应用；
  //     2) 操作发起前把涉及路径登记进 touchedPathsRef（TTL 8s），
  //        覆盖「事件在锁释放后才抵达」的窗口。
  // ---------------------------------------------------------------------------
  const watchedDirRef = useRef<string | null>(null);
  /** 路径 → 过期时间戳：TTL 内的 watcher 事件视为应用自身操作的回环 */
  const touchedPathsRef = useRef<Map<string, number>>(new Map());
  /** 操作进行中抵达的 watcher 事件：锁释放后合并应用，避免与半更新状态踩踏 */
  const pendingWatcherEventsRef = useRef<DirectoryChangeEvent[]>([]);
  /** 回环登记的有效期：需覆盖塌陷动画（EXIT_DURATION）+ 事件防抖（主进程 500ms/3s）+ 余量 */
  const TOUCHED_TTL = 8000;

  /** 操作发起前登记涉及的路径（旧 + 新）；undefined 项静默跳过 */
  const markPathsTouched = useCallback((paths: Array<string | undefined>) => {
    const expiry = Date.now() + TOUCHED_TTL;
    for (const p of paths) {
      if (p) touchedPathsRef.current.set(p, expiry);
    }
  }, []);

  /** 让主进程监听 dirPath（切换目录时主进程自动替换旧 watcher） */
  const watchCurrentDir = useCallback(async (dirPath: string) => {
    const api = window.electronAPI;
    if (!api) return;
    try {
      const result = await api.watchDirectory(dirPath);
      if (result?.success) watchedDirRef.current = dirPath;
    } catch (error) {
      // 监听失败不影响正常使用，只是失去外部变动感知
      logger.warn('目录监听失败:', error);
    }
  }, []);

  /** 停止监听并清空暂存事件（清空列表 / 卸载时调用） */
  const unwatchCurrentDir = useCallback(() => {
    const api = window.electronAPI;
    if (!api || !watchedDirRef.current) return;
    watchedDirRef.current = null;
    pendingWatcherEventsRef.current = [];
    void api.unwatchDirectory().catch(() => undefined);
  }, []);

  // ---------------------------------------------------------------------------
  // 库来源（N8）：把「打开文件夹 / 添加文件」记为常驻来源，重启后据此重建图库。
  // 记录时机统一放在「导入成功之后」——失败或取消不写，
  // 因此来源列表恒等于「真正整理过的内容」，恢复时不会再撞空。
  // ---------------------------------------------------------------------------

  /** 把一批来源写进配置（按路径去重、刷新使用时间），并同步清掉它们的不可用标记 */
  const rememberSources = useCallback((incoming: Array<Pick<LibrarySource, 'path' | 'kind'>>) => {
    if (incoming.length === 0) return;
    const next = upsertSources(sourcesRef.current, incoming);
    sourcesRef.current = next;
    setSources(next);
    setUnavailableSourcePaths(prev => {
      if (prev.size === 0) return prev;
      const updated = new Set(prev);
      let changed = false;
      incoming.forEach(entry => {
        if (updated.delete(entry.path)) changed = true;
      });
      return changed ? updated : prev;
    });
    void savePersistedConfig({ sources: next });
  }, []);

  /** 探测来源是否仍存在（目录被挪走 / 卷未挂载 → 侧栏单独标注「不可用」） */
  const refreshSourceAvailability = useCallback(async (list: LibrarySource[]) => {
    const api = window.electronAPI;
    if (!api?.checkPaths) return;
    if (list.length === 0) {
      setUnavailableSourcePaths(new Set());
      return;
    }
    try {
      const result = await api.checkPaths(list.map(source => source.path));
      setUnavailableSourcePaths(
        new Set(list.filter(source => result[source.path] === false).map(source => source.path))
      );
    } catch (error) {
      logger.warn('来源可用性检查失败:', error);
    }
  }, []);

  /**
   * 移除来源：只摘掉「记住的来源」，磁盘文件与收藏 / 标签 / 时间修正全部保留
   * （重新打开同一文件夹即可按路径对上）。
   *
   * 当前列表里属于这些来源的条目一并移出 —— 否则会留下「来源已移除、
   * 照片还在列表里、下次启动却不会恢复」的悬空状态。
   */
  const removeSources = useCallback((removed: LibrarySource[]) => {
    if (removed.length === 0) return;
    const removedPaths = new Set(removed.map(source => source.path));
    const dirPrefixes = removed
      .filter(source => source.kind === 'directory')
      .map(source => `${source.path}/`);

    const next = sourcesRef.current.filter(source => !removedPaths.has(source.path));
    sourcesRef.current = next;
    setSources(next);
    void savePersistedConfig({ sources: next });
    setUnavailableSourcePaths(prev => {
      if (prev.size === 0) return prev;
      const updated = new Set(prev);
      let changed = false;
      removedPaths.forEach(path => {
        if (updated.delete(path)) changed = true;
      });
      return changed ? updated : prev;
    });

    const targets = photosRef.current.filter(photo => {
      const p = photo.path;
      if (!p) return false;
      return removedPaths.has(p) || dirPrefixes.some(prefix => p.startsWith(prefix));
    });
    if (targets.length > 0) {
      const ids = new Set(targets.map(photo => photo.id));
      forgetImportedPaths(targets.map(photo => photo.path as string).filter(Boolean));
      removeWithCollapse(ids);
      removeIdsFromSelection(ids);
      pruneDuplicateGroups(ids);
    }

    // 正在监听的目录属于被移除来源：停止监听，避免继续对已移除来源报外部变动
    const watched = watchedDirRef.current;
    if (watched && (removedPaths.has(watched) || dirPrefixes.some(prefix => watched.startsWith(prefix)))) {
      unwatchCurrentDir();
    }

    const label = removed.length === 1 ? `「${basenameOfPath(removed[0].path)}」` : `${removed.length} 个来源`;
    showToast(
      targets.length > 0
        ? `已移除来源${label}，列表中的 ${targets.length} 项一并移出（磁盘文件与收藏 / 标签保留）`
        : `已移除来源${label}`,
      'info'
    );
  }, [forgetImportedPaths, pruneDuplicateGroups, removeIdsFromSelection, removeWithCollapse, showToast, unwatchCurrentDir]);

  // 内存压力响应：主进程广播 + 渲染进程堆占用兜底，统一裁剪已登记的缓存
  useEffect(() => {
    const offPressure = installMemoryPressureListener();
    const stopHeapWatch = startHeapWatch();
    return () => {
      offPressure();
      stopHeapWatch();
    };
  }, []);

  // 照片列表镜像：事件回调里读取最新值，避免把 photos 塞进每个 useCallback 的依赖
  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);

  // 启动时读取本地配置，并把已加载的条目对齐到配置（导入可能早于配置读取完成）
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const config = await loadPersistedConfig();
      if (cancelled) return;

      (config.favorites ?? []).forEach(path => favoritesRef.current.add(path));
      (config.hidden ?? []).forEach(path => hiddenRef.current.add(path));
      Object.entries(config.tags ?? {}).forEach(([path, tags]) => {
        if (Array.isArray(tags) && tags.length > 0) tagsRef.current.set(path, tags);
      });
      Object.entries(config.dateOverrides ?? {}).forEach(([path, ts]) => {
        if (typeof ts === 'number' && Number.isFinite(ts)) dateOverridesRef.current.set(path, ts);
      });
      // 视频元数据预热：命中缓存的视频无需再次探测即可显示时长
      seedVideoMeta(config.videoMeta);

      // 常驻来源：旧配置没有 sources 时由「最近打开」升级而来（见 sources.ts）。
      // 可用性探测放到后台：启动不被磁盘 stat 拖慢，结果到了侧栏自然更新。
      const storedSources = readSourcesFromConfig(config);
      sourcesRef.current = storedSources;
      setSources(storedSources);
      void refreshSourceAvailability(storedSources);
      // 迁移结果立刻落盘：否则每次启动都要从旧字段重新推导（且清空过来源的配置会复活）
      if (!Array.isArray(config.sources) && storedSources.length > 0) {
        void savePersistedConfig({ sources: storedSources });
      }

      setAlbums(
        Array.isArray(config.albums)
          ? config.albums
              .filter(album => album && typeof album.name === 'string' && album.name.trim().length > 0)
              .map(album => ({ ...album, filters: normalizeFilters(album.filters) }))
          : []
      );

      // 视图偏好：决定「重启后打开看到什么样」
      const prefs = config.preferences;
      if (prefs) {
        if (prefs.theme === 'light' || prefs.theme === 'dark' || prefs.theme === 'system') setTheme(prefs.theme);
        if (prefs.viewMode === 'grid' || prefs.viewMode === 'list') setViewMode(prefs.viewMode);
        if (prefs.sortKey) {
          setSortConfig({
            key: prefs.sortKey,
            direction: prefs.sortDirection === 'asc' ? 'asc' : 'desc',
          });
        }
        if (typeof prefs.scale === 'number' && Number.isFinite(prefs.scale)) {
          setScale(Math.min(2, Math.max(0.5, prefs.scale)));
        }
        if (prefs.mediaFilter) updateFilters({ mediaFilter: prefs.mediaFilter });
        if (typeof prefs.leftPaneOpen === 'boolean') setIsLeftPaneOpen(prefs.leftPaneOpen);
        if (typeof prefs.detailsPaneOpen === 'boolean') setIsDetailsPaneOpen(prefs.detailsPaneOpen);
      }

      const duplicate = config.duplicate;
      if (duplicate) {
        if (typeof duplicate.similarity === 'number' && Number.isFinite(duplicate.similarity)) {
          setDuplicateSimilarity(
            Math.min(DUPLICATE_SIMILARITY_MAX, Math.max(DUPLICATE_SIMILARITY_MIN, duplicate.similarity))
          );
        }
        if (duplicate.scope === 'all' || duplicate.scope === 'sameFolder') {
          setDuplicateScope(duplicate.scope);
        }
      }

      // AI 结果缓存在独立文件里，单独读取（可能较大，不阻塞其它配置）
      const aiCache = await loadAiCache();
      if (cancelled) return;
      aiCacheRef.current = aiCache;

      setPhotos(prev => {
        if (prev.length === 0) return prev;
        return prev.map(photo => {
          if (!photo.path) return photo;
          const override = dateOverridesRef.current.get(photo.path);
          const video = getVideoMeta(photo.path);
          const ai = aiCacheRef.current.get(photo.path);
          return {
            ...photo,
            isFavorite: favoritesRef.current.has(photo.path),
            isHidden: hiddenRef.current.has(photo.path) || undefined,
            tags: tagsRef.current.get(photo.path),
            ...(override !== undefined ? { dateTaken: override, dateAdjusted: true } : null),
            ...(video
              ? { duration: video.duration, dimensions: { width: video.width, height: video.height } }
              : null),
            ...(ai ? { aiDescription: ai.description, aiTags: ai.tags } : null),
          };
        });
      });

      setIsConfigLoaded(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshSourceAvailability, updateFilters]);

  // 视频元数据上报：回写到对应条目（时长 / 分辨率）。
  // 写入延迟合并，避免同时加载多个视频时反复落盘。
  const videoMetaSaveTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const unsubscribe = subscribeVideoMeta((key, meta) => {
      setPhotos(prev => {
        let changed = false;
        const next = prev.map(photo => {
          if (videoMetaKeyOf(photo) !== key) return photo;
          if (
            photo.duration === meta.duration &&
            photo.dimensions?.width === meta.width &&
            photo.dimensions?.height === meta.height
          ) {
            return photo;
          }
          changed = true;
          return { ...photo, duration: meta.duration, dimensions: { width: meta.width, height: meta.height } };
        });
        return changed ? next : prev;
      });

      if (videoMetaSaveTimerRef.current === null) {
        videoMetaSaveTimerRef.current = window.setTimeout(() => {
          videoMetaSaveTimerRef.current = null;
          void savePersistedConfig({ videoMeta: snapshotVideoMeta() });
        }, 1500);
      }
    });

    return () => {
      unsubscribe();
      if (videoMetaSaveTimerRef.current !== null) {
        window.clearTimeout(videoMetaSaveTimerRef.current);
        videoMetaSaveTimerRef.current = null;
      }
    };
  }, []);

  // 视图偏好变更 → 延迟合并写盘（缩放滑块 / 面板开合会连续触发）
  const prefsSaveTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!isConfigLoaded) return;

    if (prefsSaveTimerRef.current !== null) window.clearTimeout(prefsSaveTimerRef.current);
    prefsSaveTimerRef.current = window.setTimeout(() => {
      prefsSaveTimerRef.current = null;
      void savePersistedConfig({
        preferences: {
          theme,
          viewMode,
          sortKey: sortConfig.key,
          sortDirection: sortConfig.direction,
          scale,
          mediaFilter: filters.mediaFilter,
          leftPaneOpen: isLeftPaneOpen,
          detailsPaneOpen: isDetailsPaneOpen,
        },
      });
    }, 600);

    return () => {
      if (prefsSaveTimerRef.current !== null) {
        window.clearTimeout(prefsSaveTimerRef.current);
        prefsSaveTimerRef.current = null;
      }
    };
  }, [
    isConfigLoaded,
    theme,
    viewMode,
    sortConfig,
    scale,
    filters.mediaFilter,
    isLeftPaneOpen,
    isDetailsPaneOpen,
  ]);

  // 重复检测参数持久化已随 hooks/useDuplicateDetection 一并迁出

  // Selected photo for details pane
  const selectedPhotos = useMemo(() => {
    return photos.filter(p => selectedIds.has(p.id));
  }, [photos, selectedIds]);

  // ---------------- 收藏 / 隐藏 / 标签 / 拍摄时间修正 / 智能相簿 ----------------

  /** 批量设置收藏并落盘（收藏跨重启保持） */
  const setFavorite = useCallback((ids: string[], value: boolean) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    for (const photo of photosRef.current) {
      if (!idSet.has(photo.id) || !photo.path) continue;
      if (value) favoritesRef.current.add(photo.path);
      else favoritesRef.current.delete(photo.path);
    }
    setPhotos(prev => prev.map(p => (idSet.has(p.id) ? { ...p, isFavorite: value } : p)));
    void savePersistedConfig({ favorites: [...favoritesRef.current] });
  }, []);

  const toggleFavorite = useCallback((id: string) => {
    const photo = photosRef.current.find(p => p.id === id);
    if (!photo) return;
    setFavorite([id], !photo.isFavorite);
  }, [setFavorite]);

  /** 批量隐藏 / 取消隐藏：隐藏项默认不出现在任何视图，仅在「已隐藏」中可见 */
  const setHidden = useCallback((ids: string[], value: boolean) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    for (const photo of photosRef.current) {
      if (!idSet.has(photo.id) || !photo.path) continue;
      if (value) hiddenRef.current.add(photo.path);
      else hiddenRef.current.delete(photo.path);
    }
    setPhotos(prev => prev.map(p => (idSet.has(p.id) ? { ...p, isHidden: value || undefined } : p)));
    void savePersistedConfig({ hidden: [...hiddenRef.current] });

    // 隐藏是唯一「静默消失」的整理动作（收藏有提示、删除有塌陷动画）。
    // 不说明去向的话，用户分不清是被隐藏还是被删除，容易反复操作或跑去回收站找。
    showToast(
      value ? `已隐藏 ${ids.length} 项，可在「已隐藏」中找回` : `已取消隐藏 ${ids.length} 项`,
      'info',
      value
        ? {
            label: '查看',
            onClick: () => setFilters(prev => ({ ...prev, hiddenOnly: true, favoritesOnly: false })),
          }
        : undefined
    );
  }, [showToast]);

  /**
   * 单个文件的磁盘路径发生变化时，迁移所有「按路径存储」的数据。
   *
   * 收藏 / 隐藏 / 标签 / 时间修正 / 视频元数据 / AI 缓存全部以路径为键，
   * 重命名或移动后如果只改 `photo.path` 而不改键，这些标记就指向了不存在的路径：
   * 重启后表现为「收藏、标签凭空消失」，而旧键会一直滞留在 config.json 里。
   *
   * @returns 哪些分段数据因此发生了变化，供调用方决定是否需要落盘
   */
  const rekeyPathData = useCallback((from: string, to: string) => {
    if (!from || !to || from === to) return { video: false, ai: false };

    if (favoritesRef.current.delete(from)) favoritesRef.current.add(to);
    if (hiddenRef.current.delete(from)) hiddenRef.current.add(to);

    const tags = tagsRef.current.get(from);
    if (tags !== undefined) {
      tagsRef.current.delete(from);
      if (!tagsRef.current.has(to)) tagsRef.current.set(to, tags);
    }

    const override = dateOverridesRef.current.get(from);
    if (override !== undefined) {
      dateOverridesRef.current.delete(from);
      if (!dateOverridesRef.current.has(to)) dateOverridesRef.current.set(to, override);
    }

    const video = rekeyVideoMeta(from, to);

    let ai = false;
    const aiEntry = aiCacheRef.current.get(from);
    if (aiEntry) {
      aiCacheRef.current.delete(from);
      if (!aiCacheRef.current.has(to)) aiCacheRef.current.set(to, aiEntry);
      ai = true;
    }

    // 已导入路径集合同步跟随：否则改名后再次导入同一目录会把它当成新文件，产生重复条目
    if (importedPathsRef.current.delete(from)) importedPathsRef.current.add(to);

    return { video, ai };
  }, []);

  /**
   * 文件从磁盘消失（删除 / 移出）后，摘掉它残留的按路径数据。
   *
   * 不清的话，日后只要有同名文件回到同一目录，就会立刻继承上一份的收藏 / 隐藏 /
   * 时间修正 —— 最坏情况是「新导入的照片被隐藏，在库里根本找不到」。
   */
  const dropPathData = useCallback((paths: Iterable<string>) => {
    let video = false;
    let ai = false;

    for (const p of paths) {
      if (!p) continue;
      favoritesRef.current.delete(p);
      hiddenRef.current.delete(p);
      tagsRef.current.delete(p);
      dateOverridesRef.current.delete(p);
      if (forgetVideoMeta(p)) video = true;
      if (aiCacheRef.current.delete(p)) ai = true;
      importedPathsRef.current.delete(p);
    }

    return { video, ai };
  }, []);

  /**
   * 路径迁移 / 清理后落盘：只写真正变化的分段，避免每次都把整份配置重写一遍。
   * @param changed rekeyPathData / dropPathData 的变化标记（多次调用按位或累加）
   */
  const persistPathData = useCallback(
    async (changed: { video: boolean; ai: boolean }) => {
      const patch: Partial<PersistedConfig> = {
        favorites: [...favoritesRef.current],
        hidden: [...hiddenRef.current],
        tags: Object.fromEntries(tagsRef.current),
        dateOverrides: Object.fromEntries(dateOverridesRef.current),
      };
      if (changed.video) patch.videoMeta = snapshotVideoMeta();

      await savePersistedConfig(patch);
      if (changed.ai) await saveAiCache(aiCacheRef.current);
    },
    []
  );

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

  /** 把当前筛选条件存成智能相簿 */
  const handleSaveAlbum = useCallback((name: string) => {
    const album: SmartAlbum = {
      id: `album-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      filters: normalizeFilters(filters),
      createdAt: Date.now(),
    };
    const next = [...albums, album];
    setAlbums(next);
    void savePersistedConfig({ albums: next });
    setIsSaveAlbumModalOpen(false);
    showToast(`已保存相簿「${name}」`, 'success');
  }, [albums, filters, showToast]);

  const handleSelectAlbum = useCallback((album: SmartAlbum) => {
    setFilters(normalizeFilters(album.filters));
    setSearchQuery('');
  }, []);

  const handleDeleteAlbum = useCallback((id: string) => {
    const removed = albums.find(album => album.id === id);
    const next = albums.filter(album => album.id !== id);
    setAlbums(next);
    void savePersistedConfig({ albums: next });
    // 删掉的正是当前在看的相簿时，界面会停在它留下的筛选条件上，
    // 侧栏再无任何高亮、用户不知道自己在看什么，所以顺手把视图复位
    if (removed && filtersEqual(normalizeFilters(removed.filters), filters)) {
      setFilters(createEmptyFilters());
      setSearchQuery('');
    }
    showToast(removed ? `已删除相簿「${removed.name}」` : '已删除相簿', 'info');
  }, [albums, filters, showToast]);

  const clearLoading = useCallback(() => {
    setLoading(false);
    setLoadingProgress(0);
    setLoadingTotal(0);
    setLoadingCurrentFile('');
  }, []);

  /* ---------------------------------------------------------------------------
   * K19 · 批量文件操作的统一反馈
   * 重命名 / 删除 / 移动都要等一段时间，此前除导出外都没有反馈，用户容易以为卡死而重复点击。
   * beginFileOp 同步置 busy（弹层按钮置灰、提交锁之外的二道防线），
   * 超过 320ms 才升起遮罩（小批量瞬间完成就不闪），endFileOp 一并收起。
   * ------------------------------------------------------------------------- */
  const fileOpTimerRef = useRef<number | null>(null);
  const fileOpLatestRef = useRef({ done: 0, file: '' });

  const beginFileOp = useCallback((title: string, hint: string, total: number) => {
    setIsFileOpBusy(true);
    fileOpLatestRef.current = { done: 0, file: '' };
    if (fileOpTimerRef.current !== null) window.clearTimeout(fileOpTimerRef.current);
    fileOpTimerRef.current = window.setTimeout(() => {
      fileOpTimerRef.current = null;
      setFileOpOverlay({
        title,
        hint,
        total,
        done: fileOpLatestRef.current.done,
        file: fileOpLatestRef.current.file,
      });
    }, 320);
  }, []);

  const reportFileOp = useCallback((done: number, file: string) => {
    fileOpLatestRef.current = { done, file };
    setFileOpOverlay(prev => (prev ? { ...prev, done, file } : prev));
  }, []);

  const endFileOp = useCallback(() => {
    if (fileOpTimerRef.current !== null) {
      window.clearTimeout(fileOpTimerRef.current);
      fileOpTimerRef.current = null;
    }
    setIsFileOpBusy(false);
    setFileOpOverlay(null);
  }, []);

  useEffect(() => () => {
    if (fileOpTimerRef.current !== null) window.clearTimeout(fileOpTimerRef.current);
  }, []);

  // 小文件夹扫描通常一瞬间完成，延迟出现遮罩可避免「闪一下」的糟糕观感
  const loadingTimerRef = useRef<number | null>(null);
  const cancelShowLoading = useCallback(() => {
    if (loadingTimerRef.current !== null) {
      window.clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = null;
    }
  }, []);
  const showLoadingSoon = useCallback(() => {
    cancelShowLoading();
    loadingTimerRef.current = window.setTimeout(() => {
      loadingTimerRef.current = null;
      setLoading(true);
      setLoadingProgress(0);
      setLoadingTotal(0); // 0 表示「扫描阶段」，进度条展示为不确定态
      setLoadingCurrentFile('正在扫描文件夹…');
    }, 350);
  }, [cancelShowLoading]);

  useEffect(() => () => cancelShowLoading(), [cancelShowLoading]);

  /**
   * 一次拖放可能同时走「文件」与「文件夹」两条异步分支。
   * 用计数保证只有全部结束才收起遮罩，否则先完成的分支会把还在跑的遮罩提前关掉。
   */
  const dropBusyRef = useRef(0);
  const beginDropWork = useCallback(() => {
    dropBusyRef.current += 1;
    showLoadingSoon();
  }, [showLoadingSoon]);
  const endDropWork = useCallback(() => {
    dropBusyRef.current = Math.max(0, dropBusyRef.current - 1);
    if (dropBusyRef.current === 0) {
      cancelShowLoading();
      clearLoading();
    }
  }, [cancelShowLoading, clearLoading]);

  /** 中断进行中的「扫描 + 入库」：主进程停止扫描，渲染进程停止分批提交 */
  const handleCancelLoading = useCallback(() => {
    cancelRequestedRef.current = true;

    const scanId = activeScanIdRef.current;
    activeScanIdRef.current = null;
    if (scanId && window.electronAPI) {
      window.electronAPI.cancelScan(scanId);
    }

    importAbortRef.current?.abort();
    importAbortRef.current = null;

    cancelShowLoading();
    clearLoading();
    showToast(loadingKind === 'restore' ? '已取消恢复' : '已取消添加', 'info');
  }, [cancelShowLoading, clearLoading, loadingKind, showToast]);

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

  // 卸载兜底：停掉主进程 watcher，防止泄漏
  useEffect(() => () => { unwatchCurrentDir(); }, [unwatchCurrentDir]);

  // 清空照片列表：入口只负责「请求」，确认与执行分开走。
  // 侧栏底部与右键菜单共用这一条路径，都会先停下来确认一次
  const handleRequestClearList = useCallback(() => setIsClearListConfirmOpen(true), []);
  const handleConfirmClearList = useCallback(() => {
    setIsClearListConfirmOpen(false);
    handleClearList();
  }, [handleClearList]);

  // 元数据（尺寸 / EXIF / 拍摄时间）批量补齐：
  // 主进程一次读取返回全部信息，渲染层按批合并成一次 setState
  const loadMetadata = useCallback(async (targets: Photo[]) => {
    if (!window.electronAPI || targets.length === 0) return;

    // 节流合并提交：每次 setPhotos 都会触发全量排序 + 分组，
    // 逐小批提交在大库下会产生上百次 O(n log n) 重排。
    const FLUSH_INTERVAL = 400;
    let pending = new Map<string, Partial<Photo>>();
    let scheduled = false;
    let lastFlush = 0;

    const flush = () => {
      scheduled = false;
      lastFlush = Date.now();
      if (pending.size === 0) return;

      const patch = pending;
      pending = new Map();
      setPhotos(prev =>
        prev.map(p => {
          const update = patch.get(p.id);
          return update ? { ...p, ...update } : p;
        })
      );
    };

    const scheduleFlush = () => {
      if (scheduled) return;
      scheduled = true;
      const wait = Math.max(0, FLUSH_INTERVAL - (Date.now() - lastFlush));
      window.setTimeout(flush, wait);
    };

    await mapWithConcurrency(targets, 8, async photo => {
      if (!photo.path) return;
      try {
        const meta = await window.electronAPI.getMetadata(photo.path);
        if (!meta.dimensions && !meta.dateTaken && !meta.exif) return;

        const updates: Partial<Photo> = {};
        if (meta.dimensions) updates.dimensions = meta.dimensions;
        if (meta.exif) updates.exif = meta.exif;
        // 手动修正过的时间优先于 EXIF，避免被读盘结果覆盖
        const override = dateOverridesRef.current.get(photo.path);
        if (override !== undefined) {
          updates.dateTaken = override;
          updates.dateAdjusted = true;
        } else if (meta.dateTaken) {
          updates.dateTaken = meta.dateTaken;
        }

        pending.set(photo.id, updates);
        scheduleFlush();
      } catch {
        /* 单张失败不影响整体导入 */
      }
    });

    // 收尾：提交剩余更新
    flush();
  }, []);

  // 统一导入管线：
  // 只向主进程索取「磁盘缩略图 + pm:// 原图地址」，不再把整张图片以 base64 读进内存
  // 统一导入管线：
  // 只登记「磁盘路径 + pm:// 原图地址」，缩略图改为卡片进入视口时按需生成。
  // 这样几万张也能秒级入库，且不会一次性占满 CPU / 磁盘缓存。
  const ingestFiles = useCallback(async (
    infos: FileInfo[],
    /** 每批提交后回调（已处理数 / 总数），供遮罩显示真实进度 */
    onProgress?: (done: number, total: number) => void
  ): Promise<number> => {
    if (!infos || infos.length === 0) return 0;

    // 按路径去重，重复打开同一目录时不再产生重复条目
    const fresh = infos.filter(info => !importedPathsRef.current.has(info.path));
    if (fresh.length === 0) return 0;

    const total = fresh.length;
    const session = Date.now();
    const controller = new AbortController();
    importAbortRef.current = controller;
    const isCancelled = () => controller.signal.aborted || cancelRequestedRef.current;

    const created: Photo[] = [];
    // 分批提交：每批一次 setState（每次都会触发全量排序 / 分组），批越大重排次数越少
    const COMMIT_SIZE = 2000;

    try {
      for (let start = 0; start < total; start += COMMIT_SIZE) {
        if (isCancelled()) break;

        const end = Math.min(start + COMMIT_SIZE, total);
        const batch: Photo[] = [];
        for (let i = start; i < end; i += 1) {
          const info = fresh[i];
          // 配置里已有的收藏 / 隐藏 / 标签 / 时间修正 / 视频元数据，在入库时就一并带上
          const override = dateOverridesRef.current.get(info.path);
          const video = getVideoMeta(info.path);
          const ai = aiCacheRef.current.get(info.path);
          batch.push({
            id: `photo-${session}-${i}`,
            name: info.name,
            url: pmFileUrl(info.path),
            path: info.path,
            size: info.size,
            type: mediaMimeType(info.name),
            kind: mediaKindOf(info.name),
            lastModified: info.mtime,
            dateCreated: info.created || undefined,
            isFavorite: favoritesRef.current.has(info.path),
            isHidden: hiddenRef.current.has(info.path) || undefined,
            tags: tagsRef.current.get(info.path),
            ...(override !== undefined ? { dateTaken: override, dateAdjusted: true } : null),
            ...(video
              ? { duration: video.duration, dimensions: { width: video.width, height: video.height } }
              : null),
            ...(ai ? { aiDescription: ai.description, aiTags: ai.tags } : null),
          } as Photo);
        }

        // 只有真正进入列表的路径才标记为已导入，取消后可以重新添加
        batch.forEach(photo => importedPathsRef.current.add(photo.path as string));
        created.push(...batch);
        setPhotos(prev => prev.concat(batch));
        onProgress?.(end, total);

        // 让出主线程：保证进度条与「取消」按钮始终可响应
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    } finally {
      if (importAbortRef.current === controller) importAbortRef.current = null;
    }

    // 元数据后台补齐，不阻塞首屏
    loadMetadata(created);

    return created.length;
  }, [loadMetadata]);

  // ---------------------------------------------------------------------------
  // 目录监听：事件应用与订阅（依赖 ingestFiles / fsGuard，均稳定）
  // ---------------------------------------------------------------------------

  /**
   * 应用一条（已过滤回环的）外部变动事件：
   *   removed → 前缀匹配（目录删除只报目录路径）后走统一剔除管线（silent，由汇总提示）；
   *   added → stat 补全后走 ingestFiles；
   *   addedDirs → 拖入监听范围的文件夹，走完整扫描管线（静默导入）。
   * 有实际变动时给一条 info 汇总；均 0 则完全静默。
   */
  const applyWatcherEvent = useCallback(async (e: DirectoryChangeEvent) => {
    const now = Date.now();
    const touched = touchedPathsRef.current;
    // 双保险的第二层：subscription 已滤过一轮，这里再滤一次（合并事件可能带来新路径）
    const isLoop = (p: string) => {
      const expiry = touched.get(p);
      if (expiry === undefined) return false;
      if (expiry <= now) {
        touched.delete(p);
        return false;
      }
      return true;
    };

    // 1) 消失：文件与目录统一按前缀匹配剔除
    let removedCount = 0;
    const gonePrefixes = e.removed.filter(p => !isLoop(p));
    if (gonePrefixes.length > 0) {
      const targets = photosRef.current.filter(photo => {
        const p = photo.path;
        return p !== undefined && gonePrefixes.some(prefix => p === prefix || p.startsWith(`${prefix}/`));
      });
      if (targets.length > 0) {
        fsGuard.reportGone(targets, { silent: true });
        removedCount = targets.length;
      }
    }

    // 2) 新增文件：过滤回环与已登记路径 → stat → 统一入库（ingestFiles 内部再去重分批）
    let addedCount = 0;
    const addedPaths = e.added.filter(p => !isLoop(p) && !importedPathsRef.current.has(p));
    if (addedPaths.length > 0 && window.electronAPI) {
      try {
        const stat = await window.electronAPI.statFiles(addedPaths);
        if (stat.infos.length > 0) {
          addedCount = await ingestFiles(stat.infos);
        }
        // stat.failedPaths：分类后到 stat 之间又消失的文件（TOCTOU），忽略即可
      } catch (error) {
        logger.warn('处理外部新增文件失败:', error);
      }
    }

    // 3) 新增目录：拖入监听范围的文件夹，走完整扫描管线（静默，不弹 loading / 成功提示）
    let addedFromDirs = 0;
    const addedDirs = e.addedDirs.filter(d => !isLoop(d) && !importedPathsRef.current.has(d));
    if (addedDirs.length > 0 && window.electronAPI) {
      for (const dir of addedDirs) {
        try {
          const result = await window.electronAPI.scanDirectory(dir, `watch-${Date.now()}`);
          // 部分子目录读不了（K1 字段）：监听场景静默跳过，不追加重试提示
          if (result.files.length > 0) {
            addedFromDirs += await ingestFiles(result.files);
          }
        } catch (error) {
          logger.warn('处理外部新增目录失败:', error);
        }
      }
    }

    const totalAdded = addedCount + addedFromDirs;
    if (totalAdded > 0 || removedCount > 0) {
      const parts: string[] = [];
      if (totalAdded > 0) parts.push(`新增 ${totalAdded} 项`);
      if (removedCount > 0) parts.push(`移除 ${removedCount} 项`);
      showToast(`外部变动：${parts.join('，')}`, 'info');
    }
  }, [fsGuard, ingestFiles, showToast]);

  /** 操作锁释放后调用：把暂存的 watcher 事件按路径并集合并成一条应用（幂等） */
  const flushPendingWatcherEvents = useCallback(() => {
    if (fileOpLockRef.current) return; // 锁又被拿了（连续操作）：继续暂存
    const pending = pendingWatcherEventsRef.current;
    if (pending.length === 0) return;
    pendingWatcherEventsRef.current = [];

    // 同一事件内 / 跨事件的同路径：后到者优先（removed → added = 重建，added → removed = 得而复失）
    const addedSet = new Set<string>();
    const addedDirsSet = new Set<string>();
    const removedSet = new Set<string>();
    let dir: string | null = null;
    for (const e of pending) {
      dir = e.dir;
      e.added.forEach(p => { removedSet.delete(p); addedSet.add(p); });
      e.addedDirs.forEach(p => { removedSet.delete(p); addedDirsSet.add(p); });
      e.removed.forEach(p => { addedSet.delete(p); addedDirsSet.delete(p); removedSet.add(p); });
    }

    void applyWatcherEvent({
      dir: dir ?? '',
      added: [...addedSet],
      addedDirs: [...addedDirsSet],
      removed: [...removedSet],
    });
  }, [applyWatcherEvent]);

  // 挂载即订阅 watcher 事件（卸载时取消）；旧目录残响直接丢弃
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const filterLoopPaths = (paths: string[]): string[] => {
      const now = Date.now();
      return paths.filter(p => {
        const expiry = touchedPathsRef.current.get(p);
        if (expiry === undefined) return true;
        if (expiry <= now) {
          touchedPathsRef.current.delete(p);
          return false;
        }
        return false; // TTL 内：应用自身操作的回环
      });
    };

    const offChanged = api.onDirectoryChanged(event => {
      if (event.dir !== watchedDirRef.current) return;

      const filtered: DirectoryChangeEvent = {
        dir: event.dir,
        added: filterLoopPaths(event.added),
        addedDirs: filterLoopPaths(event.addedDirs),
        removed: filterLoopPaths(event.removed),
      };
      if (filtered.added.length === 0 && filtered.addedDirs.length === 0 && filtered.removed.length === 0) return;

      // 操作进行中：暂存，等锁释放后合并应用
      if (fileOpLockRef.current) {
        pendingWatcherEventsRef.current.push(filtered);
        return;
      }
      void applyWatcherEvent(filtered);
    });

    const offWatchError = api.onDirectoryWatchError(({ dir }) => {
      if (dir !== watchedDirRef.current) return;
      watchedDirRef.current = null;
      pendingWatcherEventsRef.current = [];
      showToast('目录已不可访问，已停止监听外部变动', 'error');
    });

    return () => {
      offChanged();
      offWatchError();
    };
  }, [applyWatcherEvent, showToast]);

  // QuickLook navigation functions
  // 翻页范围跟随「当前可见列表」（收藏夹内只翻收藏），不会跳到分类之外；
  // 在重复检测页则只在本次检测结果内翻页
  const handleQuickLookNext = () => {
    if (quickLookIndex < 0 || quickLookIndex >= quickLookList.length - 1) return;
    setQuickLookPhoto(quickLookList[quickLookIndex + 1]);
  };

  const handleQuickLookPrev = () => {
    if (quickLookIndex <= 0) return;
    setQuickLookPhoto(quickLookList[quickLookIndex - 1]);
  };

  // 打开目录：主进程递归扫描（可取消）→ 统一导入管线（同样可取消）
  const loadDirectory = useCallback(async (dirPath: string) => {
    if (!window.electronAPI) return;
    if (cancelRequestedRef.current) return;

    const dirName = dirPath.split('/').pop() || 'Unknown Folder';
    const scanId = `scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeScanIdRef.current = scanId;

    showLoadingSoon();

    try {
      // K1：返回结果区分「为空 / 根目录不可访问 / 部分内容失败」，不再一律冒充空数组
      const scan = await window.electronAPI.scanDirectory(dirPath, scanId);

      // 被取消：丢弃扫描结果，不写入列表
      if (activeScanIdRef.current !== scanId || cancelRequestedRef.current || scan.cancelled) return;

      // 根目录级错误（不存在 / 无权限 / 不是文件夹）：与「空目录」明确区分
      if (scan.error) {
        logger.error('Scan directory failed:', scan.error);
        showToast(`无法读取目录「${dirName}」：${humanizeFsError(scan.error)}`, 'error', {
          label: '重试',
          onClick: () => { void loadDirectory(dirPath); },
        });
        return;
      }

      const infos = scan.files;
      if (infos.length === 0) {
        showToast(`文件夹 "${dirName}" 不包含任何图片或视频`, 'info');
        return;
      }

      // 扫描阶段 loadingTotal 为 0（不确定态），这里换成真实总数让进度条能走完
      setLoadingTotal(infos.length);
      setLoadingCurrentFile(`正在加入 ${infos.length} 个项目…`);
      const added = await ingestFiles(infos, (done, total) => {
        if (total > 0) setLoadingProgress(Math.min(done, total));
      });

      if (activeScanIdRef.current !== scanId || cancelRequestedRef.current) return;

      // N8：目录打开成功即记入常驻来源（已在列表也记 —— 来源记的是「你整理哪些目录」）
      rememberSources([{ path: dirPath, kind: 'directory' }]);

      if (added === 0 && infos.length > 0) {
        showToast(`文件夹 "${dirName}" 中的内容已在列表中`, 'info');
      } else {
        showToast(`文件夹 "${dirName}" 已加载 ${added} 个项目`, 'success');
      }

      // K1：部分子目录 / 文件读取失败（无权限 / 瞬时占用）——给一条可重试的提示。
      // 重试重跑整次扫描：importedPathsRef 按路径去重，只会补进此前漏掉的项。
      const failedDirs = scan.failedDirs ?? 0;
      const failedFiles = scan.failedFiles ?? 0;
      if (failedDirs > 0 || failedFiles > 0) {
        showToast(`「${dirName}」有 ${failedDirs} 个子目录 / ${failedFiles} 个文件无法读取，已跳过`, 'warning', {
          label: '重试',
          onClick: () => { void loadDirectory(dirPath); },
        });
      }

      // N5：目录就绪后开始监听外部增删（切换目录时主进程自动替换旧 watcher）
      void watchCurrentDir(dirPath);
    } catch (err) {
      logger.error('Error loading directory contents:', err);
      showToast(`无法加载目录「${dirName}」`, 'error', {
        label: '重试',
        onClick: () => { void loadDirectory(dirPath); },
      });
    } finally {
      if (activeScanIdRef.current === scanId) {
        activeScanIdRef.current = null;
        cancelShowLoading();
        clearLoading();
      }
    }
  }, [cancelShowLoading, clearLoading, ingestFiles, rememberSources, showToast, watchCurrentDir]);

  /**
   * 恢复上次的图库（N8）：按来源逐项重扫 / 补 stat，走统一导入管线。
   * 复用现有的进度浮层与取消链路：目录逐个扫描（浮层显示当前目录与序号），
   * 单独文件一次 stat 后整批入库；失败的来源标记为「不可用」，不静默丢弃。
   */
  const restoreLibrary = useCallback(async (targets: LibrarySource[]) => {
    const api = window.electronAPI;
    if (!api || targets.length === 0) return;

    cancelRequestedRef.current = false;
    const dirs = targets.filter(source => source.kind === 'directory');
    const files = targets.filter(source => source.kind === 'file');
    const totalSteps = dirs.length + (files.length > 0 ? 1 : 0);
    const failedPaths = new Set<string>();
    let addedTotal = 0;
    let step = 0;

    setLoadingKind('restore');
    showLoadingSoon();
    setLoadingTotal(0); // 0 = 扫描阶段（不确定态）
    setLoadingCurrentFile('正在准备恢复…');

    try {
      for (const source of dirs) {
        if (cancelRequestedRef.current) break;
        step += 1;
        const name = basenameOfPath(source.path);
        setLoadingTotal(0);
        setLoadingProgress(0);
        setLoadingCurrentFile(`正在扫描「${name}」（${step}/${totalSteps}）…`);

        const scanId = `restore-${Date.now()}-${step}`;
        activeScanIdRef.current = scanId;
        try {
          const scan = await api.scanDirectory(source.path, scanId);
          if (activeScanIdRef.current !== scanId || cancelRequestedRef.current || scan.cancelled) break;
          if (scan.error) {
            // 目录不存在 / 卷未挂载：标注不可用，但来源本身保留
            logger.warn(`恢复来源失败「${source.path}」:`, scan.error);
            failedPaths.add(source.path);
            continue;
          }
          if (scan.files.length > 0) {
            setLoadingTotal(scan.files.length);
            setLoadingCurrentFile(`正在恢复「${name}」（${step}/${totalSteps}）…`);
            addedTotal += await ingestFiles(scan.files, (done, total) => {
              if (total > 0) setLoadingProgress(Math.min(done, total));
            });
          }
        } catch (error) {
          logger.warn(`恢复来源失败「${source.path}」:`, error);
          failedPaths.add(source.path);
        } finally {
          if (activeScanIdRef.current === scanId) activeScanIdRef.current = null;
        }
      }

      // 单独添加的文件：一次 stat 补齐后走同一入库管线
      if (files.length > 0 && !cancelRequestedRef.current) {
        step += 1;
        setLoadingTotal(0);
        setLoadingProgress(0);
        setLoadingCurrentFile(`正在恢复 ${files.length} 个单独添加的文件（${step}/${totalSteps}）…`);
        const paths = files.map(source => source.path);
        try {
          const stat = await api.statFiles(paths);
          stat.failedPaths.forEach(path => failedPaths.add(path));
          if (!cancelRequestedRef.current && stat.infos.length > 0) {
            setLoadingTotal(stat.infos.length);
            addedTotal += await ingestFiles(stat.infos, (done, total) => {
              if (total > 0) setLoadingProgress(Math.min(done, total));
            });
          }
        } catch (error) {
          logger.warn('恢复单独添加的文件失败:', error);
          paths.forEach(path => failedPaths.add(path));
        }
      }

      // 重新探测一次可用性：目录挪回来 / 磁盘重新挂载要能自动脱掉「不可用」
      void refreshSourceAvailability(sourcesRef.current);

      // 恢复出的第一个可用目录接管监听：外部增删照常感知
      const primaryDir = dirs.find(source => !failedPaths.has(source.path));
      if (primaryDir && !cancelRequestedRef.current) void watchCurrentDir(primaryDir.path);

      if (cancelRequestedRef.current) {
        // 取消提示由 handleCancelLoading 统一给出，这里只在已有入库结果时补充说明
        if (addedTotal > 0) showToast(`已取消恢复：已加入 ${addedTotal} 个项目`, 'info');
      } else if (failedPaths.size > 0) {
        showToast(
          addedTotal > 0
            ? `已恢复 ${addedTotal} 个项目；${failedPaths.size} 个来源不可用（已移动或未挂载），可在侧栏「文件夹」中移除`
            : `${failedPaths.size} 个来源不可用（已移动或未挂载），可在侧栏「文件夹」中移除`,
          'warning'
        );
      } else if (addedTotal === 0) {
        showToast('来源内容已在列表中，无需重复恢复', 'info');
      } else {
        showToast(`已恢复 ${addedTotal} 个项目`, 'success');
      }
    } finally {
      cancelShowLoading();
      clearLoading();
      setLoadingKind('import');
    }
  }, [cancelShowLoading, clearLoading, ingestFiles, refreshSourceAvailability, showToast, watchCurrentDir]);

  /**
   * 按文件路径导入：stat 补齐元数据后走统一入库管线。
   * K1：stat 失败的路径显式回传（failedPaths），不再静默过滤成空结果；
   * 部分失败时单独给一条可重试提示 —— 重试只对 failedPaths 再 stat + 入库，天然只补漏。
   */
  const importFilePaths = useCallback(async (files: string[], ignored: number) => {
    if (!window.electronAPI || files.length === 0) return;
    beginDropWork();
    try {
      const stat = await window.electronAPI.statFiles(files);
      const infos = stat.infos;
      setLoadingTotal(infos.length);
      const added = await ingestFiles(infos, (done, total) => {
        if (total > 0) setLoadingProgress(Math.min(done, total));
      });

      // 一个都没读到：整体性错误（K1 不再冒充「空」），带原因与重试
      if (infos.length === 0) {
        showToast(`无法读取所选文件：${humanizeFsError(stat.error)}`, 'error', {
          label: '重试',
          onClick: () => { void importFilePaths(files, ignored); },
        });
        return;
      }

      // N8：成功读到的文件记为常驻来源，下次启动可原地补回
      if (added > 0) {
        rememberSources(infos.map(info => ({ path: info.path, kind: 'file' as const })));
      }

      const ignoreNote = ignored > 0 ? `，已忽略 ${ignored} 个不支持的文件` : '';
      if (added === 0) {
        showToast(`已选中的 ${infos.length} 个项目已在列表中${ignoreNote}`, ignored > 0 ? 'warning' : 'info');
      } else {
        showToast(`已添加 ${added} 个项目${ignoreNote}`, ignored > 0 ? 'warning' : 'success');
      }

      // 部分失败：单独一条提示，避免挤掉成功汇总（失败原因可能是已被外部移动 / 删除）
      if (stat.failedPaths.length > 0) {
        showToast(`${stat.failedPaths.length} 个文件无法读取，可能已被移动或删除`, 'warning', {
          label: '重试',
          onClick: () => { void importFilePaths(stat.failedPaths, 0); },
        });
      }
    } catch (error) {
      logger.error('Error importing files:', error);
      showToast('导入文件失败', 'error');
    } finally {
      endDropWork();
    }
  }, [beginDropWork, endDropWork, ingestFiles, rememberSources, showToast]);

  /**
   * 统一导入：一个对话框可同时多选图片 / 视频文件与文件夹（可混合）。
   * 文件走 stat + ingestFiles；文件夹复用递归扫描管线（可取消、各自 toast）。
   * 分流方式与拖放导入保持一致。
   */
  const importPickedPaths = useCallback(async (picked: PickedPaths) => {
    if (!window.electronAPI) return;
    cancelRequestedRef.current = false;

    if (picked.files.length > 0) {
      await importFilePaths(picked.files, picked.ignored);
    } else if (picked.ignored > 0 && picked.directories.length === 0) {
      showToast(`已忽略 ${picked.ignored} 个不支持的文件（仅支持图片与视频）`, 'warning');
    }

    for (const dirPath of picked.directories) {
      if (cancelRequestedRef.current) break;
      await loadDirectory(dirPath);
    }
  }, [importFilePaths, loadDirectory, showToast]);

  /** 工具栏 / 空状态 / 右键菜单统一入口 */
  const handleImport = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      const picked = await window.electronAPI.selectPaths();
      if (!picked) return;
      if (picked.files.length > 0 || picked.directories.length > 0) {
        await importPickedPaths(picked);
      } else if (picked.ignored > 0) {
        showToast(`已忽略 ${picked.ignored} 个不支持的文件（仅支持图片与视频）`, 'warning');
      }
    } catch (error) {
      logger.error('Error importing:', error);
      showToast('导入失败', 'error');
    }
  }, [importPickedPaths, showToast]);

  // ---------------------------------------------------------------------------
  // 库来源交互（N8）：点来源 = 重新扫描 / 补进列表；移除来源 = 只摘记录、不动磁盘
  // ---------------------------------------------------------------------------

  /** 点单个来源：不可用时给出说明与「移除来源」入口，可用时走原导入管线 */
  const handleSelectSource = useCallback((source: LibrarySource) => {
    if (unavailableSourcePaths.has(source.path)) {
      const name = basenameOfPath(source.path);
      showToast(
        source.kind === 'directory'
          ? `「${name}」不可用：文件夹不存在或所在磁盘未挂载`
          : `「${name}」不可用：文件已被移动或删除`,
        'warning',
        { label: '移除来源', onClick: () => removeSources([source]) }
      );
      return;
    }
    cancelRequestedRef.current = false;
    if (source.kind === 'directory') void loadDirectory(source.path);
    else void importFilePaths([source.path], 0);
  }, [importFilePaths, loadDirectory, removeSources, showToast, unavailableSourcePaths]);

  const handleSelectDirectorySource = useCallback((path: string) => {
    const source = sourcesRef.current.find(item => item.path === path);
    if (source) handleSelectSource(source);
  }, [handleSelectSource]);

  const handleRemoveDirectorySource = useCallback((path: string) => {
    removeSources(sourcesRef.current.filter(item => item.path === path));
  }, [removeSources]);

  const handleSelectFileSources = useCallback(() => {
    const files = sourcesRef.current.filter(item => item.kind === 'file');
    if (files.length === 0) return;
    // 全部不可用：给出与单个来源一致的说明与移除入口，不再走注定失败的导入
    if (files.every(item => unavailableSourcePaths.has(item.path))) {
      showToast(`${files.length} 个单独添加的文件都不可用（已被移动或删除）`, 'warning', {
        label: '移除来源',
        onClick: () => removeSources(files),
      });
      return;
    }
    cancelRequestedRef.current = false;
    // 部分缺失由 importFilePaths 的失败提示逐条说明，不会静默少几个
    void importFilePaths(files.map(item => item.path), 0);
  }, [importFilePaths, removeSources, showToast, unavailableSourcePaths]);

  const handleRemoveFileSources = useCallback(() => {
    removeSources(sourcesRef.current.filter(item => item.kind === 'file'));
  }, [removeSources]);

  // 启动时若存在常驻来源：询问是否恢复上次的图库（每个会话只问一次）
  useEffect(() => {
    if (!isConfigLoaded || restorePromptShownRef.current) return;
    if (photosRef.current.length > 0) return;
    if (sources.length === 0) return;
    restorePromptShownRef.current = true;
    setIsRestorePromptOpen(true);
  }, [isConfigLoaded, sources]);

  // Selection Logic
  // 区间选择的锚点：最近一次「单击」的照片 id（Shift 连选以它为起点）
  const selectionAnchorRef = useRef<string | null>(null);

  const handleToggleSelect = useCallback((id: string, multiSelect: boolean) => {
    setSelectedIds(prev => {
      const newSet = new Set(multiSelect ? prev : []);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
    // 普通单击更新锚点；⌘/Ctrl 追加选择与 Shift 区间不会动锚点
    if (!multiSelect) selectionAnchorRef.current = id;
  }, []);

  // Sorting Logic
  const handleSortChange = useCallback((key: SortKey) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
  }, []);

  // Grouping Logic：排序 + 日期分组（实现见 photoGrouping.ts）
  const groupedPhotos = useMemo(() => groupPhotos(photos, sortConfig), [photos, sortConfig]);

  // Get sorted photos for display
  // groupedPhotos 内部已完成排序，这里直接展开，避免对同一份数据重复排序
  const sortedPhotos = useMemo(
    () => groupedPhotos.flatMap(group => group.photos),
    [groupedPhotos]
  );

  // 时光画廊：按拍摄时间升序排列的全部照片（忽略筛选 / 搜索），
  // 是「沿时间线回顾整段记忆」的数据源。缺失时间戳的条目排到末尾。
  // 已隐藏项一律不参与：隐藏是跨视图的语义，不能因为换了视图就重新可见
  //（这一份数据同时决定 QuickLook 在时间线上的翻页范围）。
  const timelinePhotos = useMemo(
    () => sortPhotosByTimeline(photos.filter(p => !p.isHidden)),
    [photos]
  );

  // 实况照片需要「同目录同名视频配对」上下文，随照片集合变化预计算一次
  const livePhotoIds = useMemo(() => buildLivePhotoIds(photos), [photos]);

  // 当前视图真正展示的照片：可组合筛选 + 关键词搜索。
  // 它统一驱动 网格渲染 / 全选 / QuickLook 翻页 / 区间连选 / 方向键导航，
  // 避免出现「切到收藏夹却仍显示全部」这类失效交互。
  const visiblePhotos = useMemo(
    () => applyPhotoFilters(sortedPhotos, filters, searchQuery, { livePhotoIds }),
    [sortedPhotos, filters, searchQuery, livePhotoIds]
  );

  // 筛选条件变化后收敛选择：防止「选中 A → 筛选把 A 隐藏 → 删除却仍把 A 删掉」
  useEffect(() => {
    setSelectedIds(prev => {
      if (prev.size === 0) return prev;
      const visible = new Set(visiblePhotos.map(p => p.id));
      let changed = false;
      const next = new Set<string>();
      prev.forEach(id => {
        if (visible.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [visiblePhotos]);

  // 选区收敛后，锚点若已不在可见列表里（被筛掉 / 被删除）要跟着挪走。
  // 否则下一次方向键导航会因为找不到锚点而从列表第一项重新开始。
  useEffect(() => {
    const anchor = selectionAnchorRef.current;
    if (anchor && visiblePhotos.some(p => p.id === anchor)) return;
    selectionAnchorRef.current = selectedIds.values().next().value ?? null;
  }, [visiblePhotos, selectedIds]);

  /**
   * 「按地点浏览」里点开某张照片时的临时翻页范围：收窄到该地点的照片。
   * QuickLook 关闭后自动释放（见下方 effect），不会影响其它视图的翻页。
   */
  const [quickLookScope, setQuickLookScope] = useState<Photo[] | null>(null);

  /**
   * QuickLook 的翻页范围跟随当前视图：
   * 图库里按可见列表翻页，重复检测页只在检测结果内翻页，
   * 时光画廊按时间排序的全部照片翻页，地图里则限定在同一点位内。
   */
  const quickLookList = useMemo(
    () => {
      if (quickLookScope) return quickLookScope;
      if (isDuplicateDetectorOpen) return duplicateGroups.flatMap(group => group);
      if (isTimelineOpen) return timelinePhotos;
      return visiblePhotos;
    },
    [quickLookScope, isDuplicateDetectorOpen, isTimelineOpen, duplicateGroups, visiblePhotos, timelinePhotos]
  );

  // 预览关闭即释放地点范围：否则回到图库再打开预览，翻页仍被困在上一个地点
  useEffect(() => {
    if (!quickLookPhoto) setQuickLookScope(null);
  }, [quickLookPhoto]);

  // QuickLook 当前索引：缓存结果，避免每次渲染对大列表做线性查找
  const quickLookIndex = useMemo(
    () => (quickLookPhoto ? quickLookList.findIndex(p => p.id === quickLookPhoto.id) : -1),
    [quickLookPhoto, quickLookList]
  );

  /**
   * 预览层的前后预加载源：只预热紧邻的图片（视频由播放器自行管理），
   * 翻页时直接命中已解码的位图，避免每张都出现「黑屏 → 亮起」。
   */
  const quickLookPreloadSources = useMemo(() => {
    if (quickLookIndex < 0) return [];
    const neighbors = [quickLookList[quickLookIndex - 1], quickLookList[quickLookIndex + 1]];
    return neighbors
      .filter((item): item is Photo => Boolean(item) && !isVideoPhoto(item))
      .map(item => item.url);
  }, [quickLookIndex, quickLookList]);

  // Shift 区间选择：从锚点一路选到目标照片（在当前可见列表的顺序中取区间）
  const handleRangeSelect = useCallback((targetId: string) => {
    const anchor = selectionAnchorRef.current ?? targetId;
    const ids = visiblePhotos.map(p => p.id);
    const a = ids.indexOf(anchor);
    const b = ids.indexOf(targetId);
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (a < 0 || b < 0) {
        next.add(targetId);
        return next;
      }
      const [start, end] = a < b ? [a, b] : [b, a];
      for (let i = start; i <= end; i++) next.add(ids[i]);
      return next;
    });
    // 锚点保持不变：连续 Shift 点击会以最初的照片向两端延伸
  }, [visiblePhotos]);

  // 全选 / 反选：作用域是「当前视图」
  const handleSelectAllVisible = useCallback(() => {
    if (visiblePhotos.length === 0) return;
    setSelectedIds(prev => {
      const allPicked = visiblePhotos.every(p => prev.has(p.id));
      return allPicked ? new Set() : new Set(visiblePhotos.map(p => p.id));
    });
  }, [visiblePhotos]);

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

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
    if (result.error) {
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
    if (result.error) {
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
        if (result.error) throw new Error(result.error);
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
    if (result.error) {
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

  // Handle single photo rename
  const handleRenamePhoto = async (id: string, newName: string) => {
    // 提交锁：确认按钮在异步执行期间仍可点击，连点会把同一批文件提交两次
    //（第二轮拿到的还是闭包里的旧路径，必然整批 ENOENT）
    if (fileOpLockRef.current) return;
    fileOpLockRef.current = true;
    try {
      // Check if we're in Electron environment
      if (!window.electronAPI) {
        logger.error('Electron API not available');
        showToast('电子API不可用，无法执行重命名操作', 'error');
        return;
      }

      const photo = photos.find(p => p.id === id);
      if (!photo) {
        showToast('找不到要重命名的照片', 'error');
        return;
      }
      
      if (!photo.path) {
        showToast('照片没有有效的文件路径，无法重命名', 'error');
        return;
      }

      // Sanitize filename to remove invalid characters
      const sanitizedName = sanitizeFilename(newName);
      
      // Get original file extension to preserve it
      const originalExt = photo.name.includes('.') ? photo.name.substring(photo.name.lastIndexOf('.')) : '';
      const finalName = sanitizedName.includes('.') ? sanitizedName : (sanitizedName + originalExt);
      
      // Rename the file using Electron API
      const oldPath = photo.path;
      logger.debug(`Attempting to rename single photo: ${oldPath} to ${finalName}`);
      
      const dirPath = folderOfPath(oldPath);
      const newPath = joinPath(dirPath, finalName);
      logger.debug(`Generated new path for single rename: ${newPath}`);
      
      // Skip if new name is the same as old name
      if (newPath === oldPath) {
        logger.debug(`Skipping single rename for ${oldPath} - same name`);
        showToast('新名称与原名称相同，无需重命名', 'info');
        setIsRenameModalOpen(false);
        return;
      }
      
      // 回环防护：改名涉及的新旧路径登记进 touchedPathsRef（主进程 watcher 会立刻看到这次改名）
      markPathsTouched([oldPath, newPath]);

      let finalPath = newPath;
      let conflicted = false;
      try {
        const result = await window.electronAPI.renameFile(oldPath, newPath);
        logger.debug(`Single rename result:`, result);

        if (result.error) {
          logger.error('Failed to rename file:', result.error);
          // 文件已被外部删除 / 移动：自动从列表剔除，不再弹常规失败提示
          if (!fsGuard.handleGone([photo], result.error)) {
            showToast(`重命名「${photo.name}」失败：${humanizeFsError(result.error)}`, 'error');
          }
          return;
        }
        // 主进程在重名时可能自动追加了序号，一律以返回的最终路径为准
        finalPath = result.path || newPath;
        markPathsTouched([finalPath]);
        conflicted = Boolean(result.conflicted);
      } catch (electronError) {
        logger.error('Electron rename error:', electronError);
        const message = (electronError as Error).message;
        if (!fsGuard.handleGone([photo], message)) {
          showToast(`重命名「${photo.name}」失败：${humanizeFsError(message)}`, 'error');
        }
        return;
        }

      const actualName = finalPath.split(/[\\/]/).pop() || finalName;

      // 更新条目：pm:// 原图地址要跟着新路径走，缩略图按新路径重新生成
      setPhotos(prev => prev.map(p => {
        if (p.id === id) {
          return {
            ...p,
            name: actualName,
            path: finalPath,
            url: pmFileUrl(finalPath),
            thumbnail: undefined,
          };
        }
        return p;
      }));

      // 按路径存储的用户数据一起迁移：不迁移的话，重启后收藏 / 标签会全部丢失
      await persistPathData(rekeyPathData(oldPath, finalPath));

      if (conflicted) {
        showToast(`「${finalName}」已存在，已自动重命名为「${actualName}」`, 'warning');
      } else {
        showToast(`照片已重命名为 ${actualName}`, 'success');
      }
      setIsRenameModalOpen(false);
    } catch (err) {
      logger.error('Error renaming photo:', err);
      showToast(`重命名照片失败：${(err as Error).message}`, 'error');
    } finally {
      fileOpLockRef.current = false;
      // 操作期间抵达的外部变动事件此刻才应用（重命名的新路径已被去重，天然幂等）
      flushPendingWatcherEvents();
    }
  };

  // 日期格式化统一由 utils.formatDateForNaming 提供（与 RenameModal 预览共用同一实现）

  // Handle batch rename
  const handleBatchRename = async (options: RenameOptions) => {
    if (fileOpLockRef.current) return;
    fileOpLockRef.current = true;
    try {
      // Check if we're in Electron environment
      if (!window.electronAPI) {
        logger.error('Electron API not available');
        showToast('电子API不可用，无法执行重命名操作', 'error');
        return;
      }

      const selectedPhotos = Array.from(selectedIds).map(id => photos.find(p => p.id === id)).filter(Boolean);
      if (selectedPhotos.length === 0) {
        showToast('没有选择要重命名的照片', 'info');
        return;
      }

      // Sort photos by date to maintain consistent numbering
      const sortedPhotos = [...selectedPhotos].sort((a, b) => {
        const dateA = a!.dateTaken || a!.lastModified || 0;
        const dateB = b!.dateTaken || b!.lastModified || 0;
        return dateA - dateB;
      });

      const updates: Array<{ id: string; oldPath: string; newName: string; newPath: string }> = [];
      // 只有同一个目录内才需要担心重名，不同文件夹下的同名文件互不影响
      const usedNames = new Set<string>();
      let renamedCount = 0;
      let unchangedCount = 0; // 名称本来就符合规则、无需改动
      let failedCount = 0;
      let conflictCount = 0; // 因重名被主进程自动追加序号的数量
      // 文件已被外部删除 / 移动的条目：剔除出列表，不算普通失败、不进失败汇总
      const gonePhotos: Photo[] = [];
      // 循环内不逐条弹 Toast（队列上限 4 条，会把汇总顶掉、还看不到是哪些失败），
      // 只留首个失败原因，结束后给一条统一汇总
      let firstError: string | null = null;

      // K19：批量重命名较慢时给出进度，避免看起来像卡死
      beginFileOp('正在重命名', '个项目', sortedPhotos.length);

      for (let i = 0; i < sortedPhotos.length; i++) {
        const photo = sortedPhotos[i];
        if (!photo) continue;
        reportFileOp(i, photo.name);

        // Check if photo has a valid path
        if (!photo.path || photo.path === '') {
          logger.error('Cannot rename photo without path:', photo.name);
          continue; // Skip photos without path (e.g., dragged files)
        }

        const fileExt = photo.name.split('.').pop();
        if (!fileExt) {
          logger.error('Cannot rename photo without file extension:', photo.name);
          failedCount++;
          firstError ??= `「${photo.name}」缺少文件扩展名`;
          continue;
        }
        
        let newName = '';

        if (options.mode === 'sequence') {
          // Generate sequential name with prefix and number
          const padding = options.numberPadding && options.numberPadding > 0 ? options.numberPadding : 3;
          newName = `${options.prefix}${(options.startNumber + i).toString().padStart(padding, '0')}.${fileExt}`;
        } else if (options.mode === 'replace') {
          // Replace text in filename
          let baseName = photo.name.replace(new RegExp(`\.${fileExt}$`), '');
          
          if (options.useRegex) {
            try {
              const regex = new RegExp(options.findText, 'g');
              baseName = baseName.replace(regex, options.replaceText);
            } catch (e) {
              logger.error('Invalid regex:', e);
              showToast('无效的正则表达式', 'error');
              return;
            }
          } else {
            baseName = baseName.split(options.findText).join(options.replaceText);
          }
          
          newName = `${baseName}.${fileExt}`;
        } else if (options.mode === 'date') {
          // Get the photo's creation date
          const photoDate = new Date(photo.dateTaken || photo.lastModified || Date.now());
          
          // Format the date according to the specified format
          const dateStr = formatDateForNaming(photoDate, options.dateFormat || 'yyyy-MM-dd_HHmmss');
          
          // Generate base name with date（前缀可由用户自定义，默认 photo_）
          newName = `${options.datePrefix ?? 'photo_'}${dateStr}.${fileExt}`;
        } else if (options.mode === 'repair') {
          // 清理乱码 / 无意义名称：与弹窗预览共用同一实现，保证「预览即所得」
          const repairOptions = options.repair ?? {
            fixMojibake: true,
            stripJunkPrefix: true,
            stripCopyMarks: true,
            fallbackToDate: true,
            dateFormat: options.dateFormat,
            datePrefix: options.datePrefix,
          };
          newName = repairFileName(
            photo.name,
            repairOptions,
            photo.dateTaken || photo.lastModified
          ).name;
        }

        // 批内重名统一处理：在扩展名前追加 _1、_2…（磁盘上同名由主进程兜底）
        const dirKey = folderOfPath(photo.path);
        {
          const dotIndex = newName.lastIndexOf('.');
          const stem = dotIndex > 0 ? newName.slice(0, dotIndex) : newName;
          const ext = dotIndex > 0 ? newName.slice(dotIndex) : '';
          let counter = 1;
          while (usedNames.has(`${dirKey}\u0000${newName}`)) {
            newName = `${stem}_${counter}${ext}`;
            counter++;
          }
        }

        // Sanitize filename to remove invalid characters
        newName = sanitizeFilename(newName);
        
        // Add to used names set
        usedNames.add(`${dirKey}\u0000${newName}`);

        // Rename the file using Electron API
        const oldPath = photo.path;
        logger.debug(`Attempting to rename: ${oldPath} to ${newName}`);

        const dirPath = folderOfPath(oldPath);
        const newPath = joinPath(dirPath, newName);
        logger.debug(`Generated new path: ${newPath}`);

        // Skip if new name is the same as old name
        if (newPath === oldPath) {
          logger.debug(`Skipping rename for ${oldPath} - same name`);
          unchangedCount++;
          continue;
        }

        // 回环防护：登记本次改名的新旧路径
        markPathsTouched([oldPath, newPath]);

        try {
          const result = await window.electronAPI.renameFile(oldPath, newPath);
          logger.debug(`Rename result:`, result);

          if (result.error) {
            logger.error('Failed to rename file:', result.error);
            if (isFileGoneError(result.error)) {
              gonePhotos.push(photo);
            } else {
              failedCount++;
              firstError ??= `「${photo.name}」${humanizeFsError(result.error)}`;
            }
            // Continue with other photos instead of failing all
            continue;
          }

          // 重名时主进程会自动追加序号，以返回的最终路径为准
          const finalPath = result.path || newPath;
          markPathsTouched([finalPath]);
          const actualName = finalPath.split(/[\\/]/).pop() || newName;
          if (result.conflicted) conflictCount++;

          updates.push({ id: photo.id, oldPath, newName: actualName, newPath: finalPath });
          renamedCount++;
        } catch (electronError) {
          logger.error('Electron rename error:', electronError);
          if (isFileGoneError((electronError as Error).message)) {
            gonePhotos.push(photo);
          } else {
            failedCount++;
            firstError ??= `「${photo.name}」${humanizeFsError((electronError as Error).message)}`;
          }
          continue;
        }
      }

      // Update all renamed photos in state
      if (updates.length > 0) {
        setPhotos(prev => prev.map(p => {
          const update = updates.find(u => u.id === p.id);
          if (update) {
            return { 
              ...p, 
              name: update.newName, 
              path: update.newPath,
              url: pmFileUrl(update.newPath),
              thumbnail: undefined,
            };
          }
          return p;
        }));

        // 批量改名同样要做路径迁移：收藏 / 隐藏 / 标签 / 时间修正 / AI 缓存都按路径存储
        let changed = { video: false, ai: false };
        for (const update of updates) {
          const one = rekeyPathData(update.oldPath, update.newPath);
          changed = {
            video: changed.video || one.video,
            ai: changed.ai || one.ai,
          };
        }
        await persistPathData(changed);
      }

      // 文件已不在原位的条目：统一剔除（塌陷动画 + 收敛选中 + 收藏标签保留）
      if (gonePhotos.length > 0) fsGuard.reportGone(gonePhotos);

      const summaryParts: string[] = [];
      if (renamedCount > 0) summaryParts.push(`已重命名 ${renamedCount} 项`);
      if (unchangedCount > 0) summaryParts.push(`${unchangedCount} 项无需修改`);
      if (conflictCount > 0) summaryParts.push(`${conflictCount} 项因重名追加了序号`);
      // 失败项带上首个原因，让用户知道是「文件不见了」还是「没权限」
      if (failedCount > 0) {
        summaryParts.push(`${failedCount} 项失败${firstError ? `（如 ${firstError}）` : ''}`);
      }

      if (failedCount > 0) {
        showToast(summaryParts.join('，'), 'warning');
      } else if (summaryParts.length === 0) {
        // 全部条目因文件消失被剔除：reportGone 的提示已经说明，不再补一条误导性的「无需修改」
        if (gonePhotos.length === 0) showToast('没有需要修改的名称', 'info');
      } else {
        showToast(summaryParts.join('，'), 'success');
      }
      setIsRenameModalOpen(false);
    } catch (err) {
      logger.error('Error batch renaming photos:', err);
      showToast(`批量重命名照片失败：${(err as Error).message}`, 'error');
    } finally {
      endFileOp();
      fileOpLockRef.current = false;
      flushPendingWatcherEvents();
    }
  };

  /** 执行删除并反馈结果；失败项可在 Toast 上点「重试」再删一次 */
  const runDelete = async (targets: Photo[]) => {
    if (targets.length === 0) return;
    if (!window.electronAPI) {
      showToast('电子 API 不可用，无法执行删除操作', 'error');
      return;
    }

    // 回环防护：删除会让 watcher 看到一波 removed，登记后由双保险过滤掉
    markPathsTouched(targets.map(p => p.path));

    // K19：逐项回收站操作有真实进度可报，大库批量删除不再像卡死
    beginFileOp('正在移至回收站', '个项目', targets.length);
    let trash: TrashResult;
    try {
      trash = await movePhotosToTrash(targets, (done) => reportFileOp(done, ''));
    } finally {
      endFileOp();
    }
    const { deletedIds, failedPhotos, errors, pathlessRemoved } = trash;

    // 同步收敛状态：列表、选中项、重复检测结果
    if (deletedIds.size > 0) {
      // 磁盘上已经没有这个文件了，它残留的收藏 / 隐藏 / 标签 / 时间修正等按路径数据
      // 也要一并摘掉：否则日后同名的文件回到同一目录，会直接继承上一份标记
      //（最坏情况是「新导入的照片一进来就是隐藏状态，在库里根本找不到」）
      const removedPaths = targets
        .filter(p => deletedIds.has(p.id) && p.path)
        .map(p => p.path as string);
      await persistPathData(dropPathData(removedPaths));

      // 卡片先淡出再摘除：磁盘上的文件已经没了，但界面上要让人看见它离开
      removeWithCollapse(deletedIds);
      setSelectedIds(new Set());
      // 重复检测分组同步收敛（实现见 hooks/useDuplicateDetection）
      pruneDuplicateGroups(deletedIds);
    }

    // 无磁盘路径的条目（拖放降级预览）不会进回收站，必须说明，否则会给人「还能找回」的错觉
    const pathlessNote = pathlessRemoved > 0
      ? `，另有 ${pathlessRemoved} 项无磁盘文件，仅从列表移除`
      : '';

    // ENOENT 的失败项说明文件早已不在磁盘（外部删除 / 移动）：剔除条目，
    // 不进「重试」（重试只会再失败一次）；其余失败项维持原有重试入口
    const gonePhotos: Photo[] = [];
    const retryPhotos: Photo[] = [];
    const retryErrors: string[] = [];
    failedPhotos.forEach((photo, i) => {
      if (isFileGoneError(errors[i])) {
        gonePhotos.push(photo);
      } else {
        retryPhotos.push(photo);
        retryErrors.push(errors[i]);
      }
    });
    if (gonePhotos.length > 0) fsGuard.reportGone(gonePhotos);

    if (retryPhotos.length === 0) {
      showToast(`已将 ${deletedIds.size - pathlessRemoved} 张照片移至回收站${pathlessNote}`, 'success');
      return;
    }

    retryErrors.forEach(error => logger.error('删除失败：', error));
    const detail = retryErrors[0] + (retryErrors.length > 1 ? ` 等 ${retryErrors.length} 项` : '');
    const retryAction = { label: '重试', onClick: () => { void runDelete(retryPhotos); } };

    if (deletedIds.size > 0) {
      showToast(
        `已删除 ${deletedIds.size - pathlessRemoved} 张，${retryPhotos.length} 张失败${pathlessNote}：${detail}`,
        'warning',
        retryAction
      );
    } else {
      showToast(`删除失败：${detail}`, 'error', retryAction);
    }
  };

  // Handle delete photo
  const handleConfirmDelete = async () => {
    if (!window.electronAPI) {
      logger.error('Electron API not available');
      showToast('电子API不可用，无法执行删除操作', 'error');
      return;
    }

    const targets = Array.from(selectedIds)
      .map(id => photos.find(p => p.id === id))
      .filter((p): p is Photo => Boolean(p));
    if (targets.length === 0) {
      showToast('没有选择要删除的照片', 'info');
      return;
    }

    // 连点「移至回收站」会让第二轮拿着已删除的路径重试，整批失败并刷屏
    if (fileOpLockRef.current) return;
    fileOpLockRef.current = true;
    try {
      await runDelete(targets);
      setIsDeleteModalOpen(false);
    } finally {
      fileOpLockRef.current = false;
      flushPendingWatcherEvents();
    }
  };

  /**
   * 批量移动到指定文件夹。
   * 磁盘移动成功后，条目状态（路径 / 文件名 / pm:// 地址）与所有「按路径存储」
   * 的用户数据（收藏 / 隐藏 / 标签 / 日期修正 / 视频元数据 / AI 缓存）
   * 都要一起迁移，否则移动后这些标记会凭空消失。
   */
  const doRunMove = async (
    targets: Photo[],
    targetDir: string,
    /** K2 幂等重试：源路径 → 上次跨卷移动已落盘的副本路径（只补删源，不重复复制） */
    priorTargets?: Record<string, string>
  ) => {
    if (!window.electronAPI) {
      showToast('电子 API 不可用，无法执行移动操作', 'error');
      return;
    }

    // 拖放导入、尚未落盘的条目没有磁盘路径，无法参与文件移动
    const movable = targets.filter((p): p is Photo => Boolean(p.path));
    const pathlessCount = targets.length - movable.length;
    if (movable.length === 0) {
      showToast('所选项目没有磁盘路径，无法移动', 'warning');
      return;
    }

    // 回环防护：源路径的移出会被 watcher 看到，先登记（目标路径在拿到结果后登记）
    markPathsTouched(movable.map(p => p.path));

    const result = await window.electronAPI.moveFiles(
      movable.map(p => p.path as string),
      targetDir,
      priorTargets
    );
    if (result?.error) {
      showToast(`移动失败：${result.error}`, 'error');
      return;
    }

    const moved = result.results.filter(r => r.success && r.to);
    const skipped = result.results.filter(r => r.skipped);
    // K2 中间态：副本已落盘但源文件删除失败 —— 源仍在原位，列表条目保持不动，
    // 单独汇总并允许「重试」只补删源（回传 priorTargets，绝不重复复制）
    const partialPhotos: Photo[] = [];
    const partialRetryTargets: Record<string, string> = {};
    for (const r of result.results) {
      if (!r.partial) continue;
      const photo = movable.find(p => p.path === r.from);
      if (photo && r.to) {
        partialPhotos.push(photo);
        partialRetryTargets[r.from] = r.to;
      }
    }
    // 文件已被外部删除 / 移动：剔除条目，不进重试
    const gonePhotos: Photo[] = [];
    const failedResults: MoveFileResult[] = [];
    for (const r of result.results) {
      if (r.success || r.skipped || r.partial) continue;
      const photo = movable.find(p => p.path === r.from);
      if (isFileGoneError(r.error) && photo) {
        gonePhotos.push(photo);
      } else {
        failedResults.push(r);
      }
    }
    if (gonePhotos.length > 0) fsGuard.reportGone(gonePhotos);
    // 目标路径也登记：跨卷复制落盘同样会被 watcher 看到
    markPathsTouched([...moved.map(r => r.to), ...Object.values(partialRetryTargets)]);
    let conflictCount = 0;

    if (moved.length > 0) {
      // 旧路径 → 新路径；条目 id → 新路径与新文件名
      const pathMap = new Map<string, string>();
      const updates = new Map<string, { path: string; name: string }>();
      for (const r of moved) {
        if (!r.to) continue;
        pathMap.set(r.from, r.to);
        if (r.conflicted) conflictCount += 1;
        const photo = movable.find(p => p.path === r.from);
        if (photo) {
          updates.set(photo.id, {
            path: r.to,
            name: r.to.split(/[\\/]/).pop() || photo.name,
          });
        }
      }

      // 1) 列表条目跟随到新路径：pm:// 原图地址同步替换，缩略图按新路径重新生成
      setPhotos(prev => prev.map(p => {
        const next = updates.get(p.id);
        return next
          ? { ...p, path: next.path, name: next.name, url: pmFileUrl(next.path), thumbnail: undefined }
          : p;
      }));

      // 2) 迁移按路径存储的用户数据（收藏 / 隐藏 / 标签 / 时间修正 / 视频元数据 / AI 缓存）
      let changed = { video: false, ai: false };
      for (const [from, to] of pathMap) {
        const one = rekeyPathData(from, to);
        changed = {
          video: changed.video || one.video,
          ai: changed.ai || one.ai,
        };
      }
      await persistPathData(changed);
    }

    // 失败项映射回条目，供 Toast「重试」继续移动到同一目标
    const failedPhotos: Photo[] = failedResults
      .map(r => movable.find(p => p.path === r.from))
      .filter((p): p is Photo => Boolean(p));
    failedResults.forEach(r => logger.error('移动失败：', r.from, r.error));

    const dirName = targetDir.split(/[\\/]/).filter(Boolean).pop() || targetDir;
    const notes: string[] = [];
    if (conflictCount > 0) notes.push(`${conflictCount} 项重名已自动加序号`);
    if (skipped.length > 0) notes.push(`${skipped.length} 项已在该文件夹中`);
    if (pathlessCount > 0) notes.push(`${pathlessCount} 项无磁盘路径已跳过`);
    const noteText = notes.length > 0 ? `（${notes.join('，')}）` : '';

    // 重试集合 = 普通失败（正常重走移动）+ partial（回传 priorTargets 只补删源）；
    // 同一批里两类并存时，priorTargets 只作用于 partial 项，互不干扰
    const retryPhotos = [...failedPhotos, ...partialPhotos];
    const retryPriors = partialPhotos.length > 0 ? partialRetryTargets : undefined;
    const retryAction = retryPhotos.length > 0
      ? { label: '重试', onClick: () => { void runMove(retryPhotos, targetDir, retryPriors); } }
      : undefined;

    if (moved.length > 0 && retryPhotos.length === 0) {
      showToast(`已移动 ${moved.length} 项到「${dirName}」${noteText}`, 'success');
    } else if (moved.length > 0 || partialPhotos.length > 0) {
      const head = moved.length > 0
        ? `已移动 ${moved.length} 项到「${dirName}」`
        : `已复制 ${partialPhotos.length} 项到「${dirName}」`;
      const partialText = moved.length > 0 && partialPhotos.length > 0
        ? `，另有 ${partialPhotos.length} 项已复制到目标位置，但原文件删除失败`
        : '';
      const failText = failedPhotos.length > 0
        ? `，${failedPhotos.length} 项失败：${humanizeFsError(failedResults[0]?.error)}`
        : '';
      showToast(`${head}${failText}${partialText}${noteText}`, 'warning', retryAction);
    } else if (skipped.length > 0 && retryPhotos.length === 0) {
      showToast(`所选项目都已在「${dirName}」中，无需移动`, 'info');
    } else if (retryPhotos.length > 0) {
      const detail = humanizeFsError(failedResults[0]?.error);
      showToast(`移动失败：${detail}`, 'error', retryAction);
    }
    // else：全部条目已按「文件不在原位」剔除 —— reportGone 的提示已覆盖，不再补报错
  };

  /** 移动的提交锁包装：连点防护 + 操作期间抵达的 watcher 事件在锁释放后统一应用 */
  const runMove = async (
    targets: Photo[],
    targetDir: string,
    priorTargets?: Record<string, string>
  ) => {
    if (fileOpLockRef.current) return;
    fileOpLockRef.current = true;
    // K19：移动由主进程一次性完成，无法回报逐项进度，用不确定态说明「在处理 N 项」
    beginFileOp('正在移动文件', `${targets.length} 个项目`, 0);
    try {
      await doRunMove(targets, targetDir, priorTargets);
    } finally {
      endFileOp();
      fileOpLockRef.current = false;
      flushPendingWatcherEvents();
    }
  };

  /** 批量移动入口：先选目标文件夹（macOS 面板里可直接新建文件夹），再执行移动 */
  const handleMoveSelected = (targets?: Photo[]) => {
    if (!window.electronAPI) {
      showToast('电子 API 不可用，无法执行移动操作', 'error');
      return;
    }
    const chosen = targets
      ?? Array.from(selectedIds)
        .map(id => photos.find(p => p.id === id))
        .filter((p): p is Photo => Boolean(p));
    if (chosen.length === 0) {
      showToast('没有选择要移动的照片', 'info');
      return;
    }
    void (async () => {
      const targetDir = await window.electronAPI.chooseDirectory({ allowCreate: true });
      if (!targetDir) return; // 用户取消了文件夹面板
      await runMove(chosen, targetDir);
    })();
  };

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

  // 计算媒体统计数据（侧栏「图库 / 媒体类型」与顶部筛选共用）
  // 隐藏项不计入任何常规分类，只计入「已隐藏」，与 macOS 照片一致
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

  // 每个智能相簿当前命中的数量（相簿只存条件，因此随图库实时变化）
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

  // 侧栏「文件夹」来源区：目录逐个列出，单独添加的文件聚合为一行
  const directorySources = useMemo(
    () => sources.filter(source => source.kind === 'directory'),
    [sources]
  );
  const fileSources = useMemo(() => sources.filter(source => source.kind === 'file'), [sources]);
  const unavailableSourceCount = unavailableSourcePaths.size;

  // 筛选面板的可选项（相机 / 格式 / 标签）：随元数据与标签变化动态更新。
  // 口径必须与 matchesFilters 一致 —— 隐藏项本来就不会出现在结果里，
  // 若把「只存在于隐藏项」的相机 / 标签列成可选，用户选中后必然得到 0 条结果。
  const filterOptions = useMemo(() => {
    const candidates = photos.filter(p => !p.isHidden);
    return { ...buildFilterOptions(candidates), tags: buildTagOptions(candidates) };
  }, [photos]);

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
  
  // 更新照片信息（标签 / AI 结果变更时同步落盘）
  const handleUpdatePhoto = useCallback((id: string, data: Partial<Photo>) => {
    setPhotos(prev => prev.map(p => (p.id === id ? { ...p, ...data } : p)));

    const target = photosRef.current.find(p => p.id === id);
    if (!target?.path) return;

    if (data.tags !== undefined) {
      if (data.tags.length > 0) tagsRef.current.set(target.path, data.tags);
      else tagsRef.current.delete(target.path);
      void savePersistedConfig({ tags: Object.fromEntries(tagsRef.current) });
    }

    // AI 结果存独立的 ai-cache.json：重算代价高但可丢，单独限量
    if (data.aiDescription !== undefined || data.aiTags !== undefined) {
      aiCacheRef.current.set(target.path, {
        description: data.aiDescription ?? target.aiDescription,
        tags: data.aiTags ?? target.aiTags,
      });
      void saveAiCache(aiCacheRef.current);
    }
  }, []);

  // 指针落在非交互区域时，把焦点从按钮上移开：
  // 避免「上次点过工具栏按钮 → 按空格/回车误触发那个按钮」的经典问题
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || typeof t.closest !== 'function') return;
      if (t.closest('button, a, input, textarea, select, label, [contenteditable="true"]')) return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && ae !== document.body && typeof ae.blur === 'function') ae.blur();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, []);

  // 方向键导航：移动单个选中项并让视口跟随（网格上下键按真实行几何找落点）
  const handleArrowNavigation = useCallback((key: string) => {
    if (visiblePhotos.length === 0) return;
    const ids = visiblePhotos.map(p => p.id);
    const currentIndex = selectionAnchorRef.current ? ids.indexOf(selectionAnchorRef.current) : -1;

    // 还没有任何选中项时，任意方向键都先选中第一项并停住。
    // 若照常叠加步长，会变成「按 → 从第 2 张开始、按 ↓ 跳掉一整行」，左右上下不对称。
    if (currentIndex < 0) {
      const firstId = ids[0];
      setSelectedIds(new Set([firstId]));
      selectionAnchorRef.current = firstId;
      gridRef.current?.scrollToPhoto(firstId);
      return;
    }

    // 左右键在任意视图里都是顺序步进。
    // 上下键：列表视图一次一行；网格视图交给布局按真实行几何找目标 ——
    // justified 布局每行张数随照片宽高比变化，固定列数硬跳会跳错列。
    let nextIndex = currentIndex;
    if (key === 'ArrowLeft') {
      nextIndex = Math.max(0, currentIndex - 1);
    } else if (key === 'ArrowRight') {
      nextIndex = Math.min(ids.length - 1, currentIndex + 1);
    } else if (viewMode === 'list') {
      nextIndex = key === 'ArrowUp'
        ? Math.max(0, currentIndex - 1)
        : Math.min(ids.length - 1, currentIndex + 1);
    } else {
      const neighbor = gridRef.current?.getVerticalNeighbor(ids[currentIndex], key === 'ArrowUp' ? 'up' : 'down');
      const neighborIndex = neighbor ? ids.indexOf(neighbor) : -1;
      // 已在首 / 末行（没有相邻行）时保持原位，不再用固定列数硬跳
      if (neighborIndex >= 0) nextIndex = neighborIndex;
    }

    if (nextIndex === currentIndex && selectedIds.size === 1) return;
    const nextId = ids[nextIndex];
    setSelectedIds(new Set([nextId]));
    selectionAnchorRef.current = nextId;
    gridRef.current?.scrollToPhoto(nextId);
  }, [visiblePhotos, selectedIds.size, viewMode]);

  // 主视图键盘闭环：
  // 空格 / Enter → QuickLook；⌘A → 全选当前视图；⌘⇧F → 批量收藏；⌘F → 聚焦搜索；
  // 方向键 → 单选移动；⌘⌫ / Delete → 删除确认；Esc → 关闭右键菜单，其次清除选择。
  // 弹层打开或焦点在输入框内时全部让行。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // 快捷键总览已打开：Esc 或再按 ? 关闭，并吞掉其余按键，避免背后交互被误触
      if (isShortcutsOpen) {
        if (e.key === 'Escape' || e.key === '?') {
          e.preventDefault();
          setIsShortcutsOpen(false);
        }
        return;
      }
      // 重复检测页：Esc 返回图库（预览层打开时让行给它）
      if (isDuplicateDetectorOpen) {
        if (e.key === 'Escape' && !quickLookPhoto) {
          e.preventDefault();
          handleExitDuplicates();
        }
        return;
      }
      // 时光画廊：Esc 返回图库（预览层打开时让行给它）
      if (isTimelineOpen) {
        if (e.key === 'Escape' && !quickLookPhoto) {
          e.preventDefault();
          setMainView('library');
        }
        return;
      }
      // 按地点浏览：同上（地图自身的方向键平移 / 缩放由地图容器处理）
      if (isMapOpen) {
        if (e.key === 'Escape' && !quickLookPhoto) {
          e.preventDefault();
          setMainView('library');
        }
        return;
      }
      // 弹层打开时全局快捷键一律让行：尤其是 Delete / Backspace，
      // 否则会在当前弹层之上再叠一个「移至回收站」确认框
      if (
        quickLookPhoto ||
        isRenameModalOpen ||
        isDeleteModalOpen ||
        isExportModalOpen ||
        isAiSettingsOpen ||
        isAdjustDateModalOpen ||
        isSaveAlbumModalOpen ||
        isFilterPanelOpen ||
        isClearListConfirmOpen
      ) return;

      const target = e.target as HTMLElement | null;
      const isTextInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      const cmd = e.metaKey || e.ctrlKey;

      // ?（⇧/）：唤出快捷键总览。放在输入框守卫之后，确保在搜索框内打「？」不会被误触发
      if (!isTextInput && e.key === '?') {
        e.preventDefault();
        setIsShortcutsOpen(true);
        return;
      }

      // ⌘F：聚焦搜索框（输入框内也允许接管）
      if (cmd && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if (isTextInput) return;

      if (cmd && !e.shiftKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        handleSelectAllVisible();
        return;
      }
      if (cmd && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        if (selectedIds.size > 0) handleFavoriteSelected();
        return;
      }
      if (e.key === 'Escape') {
        if (contextMenu) {
          setContextMenu(null);
        } else if (selectedIds.size > 0) {
          setSelectedIds(new Set());
        }
        return;
      }
      if (e.key === ' ' || e.key === 'Enter') {
        if (contextMenu) return;
        if (visiblePhotos.length === 0) return;
        e.preventDefault();
        const targetPhoto = visiblePhotos.find(p => selectedIds.has(p.id)) ?? visiblePhotos[0];
        setQuickLookPhoto(targetPhoto);
        return;
      }
      // Home / End：大库里逐行按方向键太慢，直接跳首尾
      if (e.key === 'Home' || e.key === 'End') {
        if (contextMenu) return;
        if (visiblePhotos.length === 0) return;
        e.preventDefault();
        const target = e.key === 'Home' ? visiblePhotos[0] : visiblePhotos[visiblePhotos.length - 1];
        setSelectedIds(new Set([target.id]));
        selectionAnchorRef.current = target.id;
        gridRef.current?.scrollToPhoto(target.id);
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (contextMenu) return;
        e.preventDefault();
        handleArrowNavigation(e.key);
        return;
      }
      // 破坏性操作对齐 macOS 习惯：⌘⌫ 删除（Finder 语义），Delete 键保留兼容。
      // 单按 ⌫ 不再触发删除，避免与「重命名」等肌肉记忆冲突导致误删。
      if (e.key === 'Delete' || (cmd && e.key === 'Backspace')) {
        if (selectedIds.size > 0) {
          e.preventDefault();
          setIsDeleteModalOpen(true);
        }
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    quickLookPhoto, isRenameModalOpen, isDeleteModalOpen, isDuplicateDetectorOpen, isTimelineOpen, isMapOpen,
    isExportModalOpen,
    isShortcutsOpen, isAiSettingsOpen, isAdjustDateModalOpen, isSaveAlbumModalOpen, isFilterPanelOpen,
    isClearListConfirmOpen,
    contextMenu, visiblePhotos, selectedIds,
    handleSelectAllVisible, handleFavoriteSelected, handleArrowNavigation, handleExitDuplicates,
  ]);

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

  // 拖拽遮罩的进出场：拖入时先挂载再隔一帧淡入（否则初始态会被跳过），
  // 拖出时先淡出、动画结束才卸载 —— 与卡片塌陷同档时长
  useEffect(() => {
    if (isDraggingFile) {
      setIsDragOverlayMounted(true);
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setIsDragOverlayActive(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }

    setIsDragOverlayActive(false);
    const timer = window.setTimeout(() => setIsDragOverlayMounted(false), EXIT_DURATION);
    return () => window.clearTimeout(timer);
  }, [isDraggingFile]);

  // Handle drag events for file upload
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 只有「从访达拖入文件」才亮起导入遮罩。
    // 否则在网格里按住缩略图拖动（<img> 默认可拖）也会弹出一整屏「拖放图片或视频到此处」，
    // 让人误以为误触了导入。
    if (!e.dataTransfer.types.includes('Files')) return;
    setIsDraggingFile(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only hide drag overlay if mouse leaves the entire app container
    if (e.currentTarget.contains(e.relatedTarget as Node)) {
      return;
    }
    setIsDraggingFile(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFile(false);

    const files = Array.from(e.dataTransfer.files) as File[];
    if (files.length === 0) return;

    // 分类：媒体文件（图片 / 视频）/ 可能是文件夹（拖入目录时没有 MIME 且 size 为 0）/ 其它
    const mediaFiles: File[] = [];
    const maybeDirs: File[] = [];
    const rejected: File[] = [];
    for (const file of files) {
      // 拖放时部分容器（如 .mkv）拿不到 MIME，用扩展名兜底
      const looksLikeMedia =
        file.type.startsWith('image/') ||
        file.type.startsWith('video/') ||
        isImageName(file.name) ||
        isVideoName(file.name);
      if (looksLikeMedia) mediaFiles.push(file);
      else if (!file.type && file.size === 0) maybeDirs.push(file);
      else rejected.push(file);
    }

    if (mediaFiles.length === 0 && maybeDirs.length === 0) {
      showToast(
        `已忽略 ${rejected.length} 个不支持的文件（仅支持图片与视频）`,
        'warning'
      );
      return;
    }

    // 拖放的文件尽量解析出真实路径：有路径才能重命名/删除/重复检测
    const resolved: FileInfo[] = [];
    const unresolved: File[] = [];

    for (const file of mediaFiles) {
      const filePath = window.electronAPI ? window.electronAPI.getFilePath(file) : '';
      if (filePath) {
        resolved.push({ path: filePath, name: file.name, size: file.size, mtime: file.lastModified });
      } else {
        unresolved.push(file);
      }
    }

    cancelRequestedRef.current = false;

    if (resolved.length > 0) {
      (async () => {
        beginDropWork();
        // K1：stat 失败的文件不阻塞导入 —— 拖放自带的 size/mtime 兜底，仅缺 birthtime
        let statFailedCount = 0;
        try {
          // 拖放的 File 对象没有创建时间，补一次 stat 才能拿到 birthtime
          if (window.electronAPI) {
            const stat = await window.electronAPI.statFiles(resolved.map(r => r.path));
            const byPath = new Map(stat.infos.map(info => [info.path, info]));
            resolved.forEach(item => {
              const info = byPath.get(item.path);
              if (!info) return;
              item.size = info.size;
              item.mtime = info.mtime;
              item.created = info.created;
            });
            statFailedCount = stat.failedPaths.length;
          }
          setLoadingTotal(resolved.length);
          const added = await ingestFiles(resolved, (done, total) => {
            if (total > 0) setLoadingProgress(Math.min(done, total));
          });
          // N8：拖入的文件同样记为常驻来源
          if (added > 0) {
            rememberSources(resolved.map(item => ({ path: item.path, kind: 'file' as const })));
          }
          // 同一次拖放里混有不支持的文件 / stat 失败的文件时一并说明，避免「悄悄少了几个」
          const rejectNote = rejected.length > 0 ? `，已忽略 ${rejected.length} 个不支持的文件` : '';
          const statNote = statFailedCount > 0 ? `，${statFailedCount} 个文件无法读取完整信息` : '';
          if (added === 0) {
            // 「已添加 0 个项目」会让人怀疑是导入失败，这里说清楚是重复
            showToast(
              `已选中的 ${resolved.length} 个项目已在列表中${statNote}${rejectNote}`,
              rejected.length > 0 ? 'warning' : 'info'
            );
          } else {
            showToast(`已添加 ${added} 个项目${statNote}${rejectNote}`, rejected.length > 0 ? 'warning' : 'success');
          }
        } catch {
          showToast('处理拖拽文件失败', 'error');
        } finally {
          endDropWork();
        }
      })();
    }

    // 拖入的文件夹：解析真实路径后复用目录扫描管线（可取消）
    if (maybeDirs.length > 0 && window.electronAPI) {
      (async () => {
        beginDropWork();
        try {
          for (let i = 0; i < maybeDirs.length; i++) {
            const dir = maybeDirs[i];
            const dirPath = window.electronAPI.getFilePath(dir);
            if (!dirPath) {
              rejected.push(dir);
              continue;
            }
            const scanId = `drop-${Date.now()}-${i}`;
            activeScanIdRef.current = scanId;
            try {
              // K1：新返回形状区分「为空 / 根目录不可访问 / 部分内容失败」
              const scan = await window.electronAPI.scanDirectory(dirPath, scanId);
              if (activeScanIdRef.current !== scanId) return; // 已被取消
              if (scan.error) {
                showToast(`无法读取文件夹「${dir.name}」：${humanizeFsError(scan.error)}`, 'error');
                continue;
              }
              const infos = scan.files;
              if (infos.length === 0) {
                showToast(`文件夹「${dir.name}」中没有可导入的图片或视频`, 'warning');
                continue;
              }
              setLoadingTotal(infos.length);
              setLoadingCurrentFile(`正在加入 ${infos.length} 个项目…`);
              const added = await ingestFiles(infos, (done, total) => {
                if (total > 0) setLoadingProgress(Math.min(done, total));
              });
              // N8：拖入的文件夹记为常驻来源；监听目录一并切到它（外部增删照常感知）
              rememberSources([{ path: dirPath, kind: 'directory' }]);
              void watchCurrentDir(dirPath);
              // 部分子目录 / 文件读取失败时一并说明，避免「悄悄少了几个」
              const failedCount = (scan.failedDirs ?? 0) + (scan.failedFiles ?? 0);
              const failNote = failedCount > 0 ? `（${failedCount} 项无法读取已跳过）` : '';
              showToast(
                added === 0
                  ? `文件夹「${dir.name}」中的内容已在列表中${failNote}`
                  : `已从文件夹「${dir.name}」加入 ${added} 个项目${failNote}`,
                added === 0 ? 'info' : 'success'
              );
            } catch (error) {
              logger.error('Error importing dropped folder:', error);
              showToast(`导入文件夹「${dir.name}」失败`, 'error');
            } finally {
              if (activeScanIdRef.current === scanId) activeScanIdRef.current = null;
            }
          }
        } finally {
          endDropWork();
        }
      })();
    }

    // 拿不到路径的文件（非 Electron / 受限来源）走内存预览降级方案
    if (unresolved.length === 0) return;

    setLoading(true);
    setLoadingProgress(0);
    setLoadingTotal(unresolved.length);
    setLoadingCurrentFile('');

    (async () => {
      try {
        const newPhotos: Photo[] = [];
        for (let i = 0; i < unresolved.length; i++) {
          if (cancelRequestedRef.current) break;
          const file = unresolved[i];
          setLoadingProgress(i);
          setLoadingCurrentFile(file.name);
          try {
            const isVideo = mediaKindOf(file.name) === 'video';
            newPhotos.push({
              id: `photo-${Date.now()}-${i}`,
              name: file.name,
              url: URL.createObjectURL(file),
              // 视频无法用 canvas 逐帧处理：交给卡片侧的首帧解析逻辑
              thumbnail: isVideo ? undefined : await createThumbnail(file),
              path: '',
              size: file.size,
              type: file.type || mediaMimeType(file.name),
              kind: mediaKindOf(file.name),
              lastModified: file.lastModified,
              // 浏览器 File 只暴露 lastModified，没有创建时间。
              // 这里刻意不拿 lastModified 冒充 dateCreated —— 否则详情面板里
              // 「创建时间」和「修改时间」必然逐字相同，真值和兜底值无法区分
              isFavorite: false,
            });
          } catch (error) {
            logger.error('Error processing dropped file:', file.name, error);
          }
        }
        if (newPhotos.length > 0) {
          setPhotos(prevPhotos => [...prevPhotos, ...newPhotos]);
        }
        showToast(
          resolved.length > 0
            ? `另有 ${newPhotos.length} 个项目无磁盘路径，仅可预览`
            : `已添加 ${newPhotos.length} 个项目`,
          'info'
        );
      } catch (error) {
        logger.error('Error processing dropped files:', error);
        showToast('处理拖拽文件失败', 'error');
      } finally {
        clearLoading();
      }
    })();
  }, [clearLoading, createThumbnail, ingestFiles, rememberSources, showToast, watchCurrentDir]);

  // 空状态 / 情境条文案派生（实现见 libraryViewState.ts）。
  // 与重构前一致：每次渲染直接计算，不做 memo。
  const {
    isEmptyLibrary,
    isSearchEmpty,
    isAllHidden,
    isHiddenEmpty,
    isFilterEmpty,
    isFavoritesEmpty,
    isMediaFilterEmpty,
    gridViewTitle,
  } = deriveLibraryViewState({
    photoCount: photos.length,
    hiddenCount: counts.hidden,
    visibleCount: visiblePhotos.length,
    searchQuery,
    activeCategory,
    mediaFilter,
    hasAdvancedFilters: hasAdvancedFilters(filters),
    favoritesOnly: filters.favoritesOnly,
  });

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
              <div className="flex-1 flex items-center justify-center p-8 text-center">
                <div>
                  <p className="text-sm font-medium text-[var(--text-primary)] mb-1">相似检测视图出错</p>
                  <p className="text-xs text-[var(--text-tertiary)] mb-4">图库内容仍然完好，可返回图库继续整理。</p>
                  <button
                    onClick={() => setMainView('library')}
                    className="px-4 py-2 text-sm font-medium rounded-xl text-[var(--text-secondary)] border border-[var(--border-default)] hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] transition-colors"
                  >
                    返回图库
                  </button>
                </div>
              </div>
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
              <div className="flex-1 flex items-center justify-center p-8 text-center">
                <div>
                  <p className="text-sm font-medium text-[var(--text-primary)] mb-1">时光画廊渲染出错</p>
                  <p className="text-xs text-[var(--text-tertiary)] mb-4">图库内容仍然完好，可返回图库继续浏览。</p>
                  <button
                    onClick={() => setMainView('library')}
                    className="px-4 py-2 text-sm font-medium rounded-xl text-[var(--text-secondary)] border border-[var(--border-default)] hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] transition-colors"
                  >
                    返回图库
                  </button>
                </div>
              </div>
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
              <div className="flex-1 flex items-center justify-center p-8 text-center">
                <div>
                  <p className="text-sm font-medium text-[var(--text-primary)] mb-1">地图视图出错</p>
                  <p className="text-xs text-[var(--text-tertiary)] mb-4">图库内容仍然完好，可返回图库继续浏览。</p>
                  <button
                    onClick={() => setMainView('library')}
                    className="px-4 py-2 text-sm font-medium rounded-xl text-[var(--text-secondary)] border border-[var(--border-default)] hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] transition-colors"
                  >
                    返回图库
                  </button>
                </div>
              </div>
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
            <div className="flex-1 flex items-center justify-center p-8 text-center">
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)] mb-1">图库渲染出错</p>
                <p className="text-xs text-[var(--text-tertiary)] mb-4">工具栏与详情面板仍可使用，可尝试切换视图或清空照片列表。</p>
                <button
                  onClick={handleClearList}
                  className="px-4 py-2 text-sm font-medium rounded-xl text-[var(--text-secondary)] border border-[var(--border-default)] hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] transition-colors"
                >
                  清空照片列表
                </button>
              </div>
            </div>
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
      {/* Toast 队列：底部居中堆叠，避免遮挡工具栏 */}
      {toasts.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] flex flex-col items-center gap-2 pointer-events-none w-[min(440px,90vw)]">
          {toasts.map(toast => (
            <Toast
              key={toast.id}
              message={toast.message}
              type={toast.type}
              action={toast.action}
              onClose={() => dismissToast(toast.id)}
            />
          ))}
        </div>
      )}
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
          onSave={handleSaveAlbum}
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