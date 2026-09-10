import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { AiCacheEntry, DuplicateScope, MediaFilter, Photo, PhotoFilters, SmartAlbum, SortConfig, ViewMode, RenameOptions, SortKey } from './types';
import {
  findDuplicatePhotos,
  isDuplicateScanAbort,
  isImageName,
  isVideoName,
  isVideoPhoto,
  mapWithConcurrency,
  markRecommended,
  mediaKindOf,
  clearImageHashCache,
  mediaMimeType,
  pmFileUrl,
  formatDateForNaming,
  folderOfPath,
  repairFileName,
  type DuplicateScanProgress,
} from './utils';
import {
  createLruCache,
  installMemoryPressureListener,
  releaseMemory,
  startHeapWatch,
} from './cacheManager';
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
} from './filters';
import { buildLivePhotoIds, isSelfiePhoto, isScreenshotPhoto } from './mediaTypes';
import {
  getVideoMeta,
  seedVideoMeta,
  snapshotVideoMeta,
  subscribeVideoMeta,
  videoMetaKeyOf,
} from './videoMeta';
import { loadPersistedConfig, savePersistedConfig } from './persistence';
import { loadAiCache, saveAiCache } from './aiCache';
import Sidebar from './components/Sidebar';
import Toolbar from './components/Toolbar';
import ImageGrid, { ImageGridHandle } from './components/ImageGrid';
import DetailsPane from './components/DetailsPane';
import RenameModal from './components/RenameModal';
import DeleteConfirmModal from './components/DeleteConfirmModal';
import QuickLook from './components/QuickLook';
import Toast, { ToastData, type ToastType } from './components/Toast';
import ContextMenu, { ContextMenuItem } from './components/ContextMenu';
import DuplicateDetector, {
  DUPLICATE_SIMILARITY_DEFAULT,
  DUPLICATE_SIMILARITY_MAX,
  DUPLICATE_SIMILARITY_MIN,
  similarityToDistance,
} from './components/DuplicateDetector';
import ExportModal from './components/ExportModal';
import { clearThumbnailCache } from './components/ThumbnailImage';
import ErrorBoundary from './components/ErrorBoundary';
import ActiveFiltersBar from './components/ActiveFiltersBar';
import AdjustDateModal, { type DateAdjustment } from './components/AdjustDateModal';
import SaveAlbumModal from './components/SaveAlbumModal';
import { logger } from './logger';

type Theme = 'dark' | 'light';

/** 主内容区的顶层视图：图库 / 重复图片检测（整页视图，而非弹窗） */
type MainView = 'library' | 'duplicates';

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

/**
 * 日期分组 key 缓存。
 * toLocaleDateString 每次都会构造 Intl 格式化器，几千张照片时是明显的 CPU 热点，
 * 而同一天的照片分组 key 完全相同，因此按「天」缓存。
 */
const dateKeyCache = createLruCache<number, string>('dateGroupKey', 5000, 'volatile');
let dateKeyCacheDay = '';

function getDateGroupKey(timestamp: number, todayKey: string, yesterdayKey: string): string {
  if (!timestamp || Number.isNaN(timestamp)) return 'Unknown Date';

  // 跨天时缓存失效
  if (todayKey !== dateKeyCacheDay) {
    dateKeyCache.clear();
    dateKeyCacheDay = todayKey;
  }

  const date = new Date(timestamp);
  // 用「本地日历日」（yyyymmdd）做 key。
  // 不能用 floor(ts / 86400000)：那是 UTC 日界，东八区里同一天 23:00 与次日 01:00
  // 会落进同一个 UTC 日，导致两天被错误地合并为同一组。
  const dayKey = date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
  const cached = dateKeyCache.get(dayKey);
  if (cached !== undefined) return cached;

  const dateKey = date.toDateString();
  let key: string;
  if (dateKey === todayKey) {
    key = 'Today';
  } else if (dateKey === yesterdayKey) {
    key = 'Yesterday';
  } else {
    key = date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
    });
  }

  dateKeyCache.set(dayKey, key);
  return key;
}

/**
 * 拖放降级路径（拿不到磁盘路径）的缩略图缓存。
 * 值是 base64 dataURL，体积远大于 pm:// 地址，必须限量；
 * 有磁盘路径的照片走主进程磁盘缩略图，不会进这里。
 */
const dragThumbCache = createLruCache<string, Map<number, string>>('dragThumbnail', 120, 'volatile');

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
  /** 图库封面路径；null 表示未设置 */
  const coverRef = useRef<string | null>(null);
  /** AI 分析结果缓存（路径 → 描述 / 标签），持久化在独立的 ai-cache.json */
  const aiCacheRef = useRef<Map<string, AiCacheEntry>>(new Map());
  /** 最近打开过的目录（新在前），用于一键重新打开 */
  const [recentDirectories, setRecentDirectories] = useState<string[]>([]);
  const recentDirectoriesRef = useRef<string[]>([]);
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
  const [theme, setTheme] = useState<Theme>('dark'); // Theme state
  // 主题切换过渡的卸载计时器：连续切换时只保留最后一次
  const themeTransitionTimerRef = useRef<number | null>(null);

  const toggleTheme = () => {
    // 切换的那一瞬间才挂上全局颜色过渡，播完立刻摘掉：
    // 常驻 transition 会拖慢所有 hover / 按下的响应
    if (themeTransitionTimerRef.current !== null) {
      window.clearTimeout(themeTransitionTimerRef.current);
    }
    document.documentElement.classList.add('theme-transition');
    themeTransitionTimerRef.current = window.setTimeout(() => {
      document.documentElement.classList.remove('theme-transition');
      themeTransitionTimerRef.current = null;
    }, 240);

    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };
  
  // New state for UI Feedback & File System
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [directoryPath, setDirectoryPath] = useState<string | null>(null);
  // Toast 队列：支持多条同时展示，错误级常驻
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const toastIdRef = useRef(0);

  // 搜索（文件名 / 相机 / 格式）
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 媒体筛选由 filters 统一承载（侧栏导航与筛选面板共用同一份状态）
  const mediaFilter = filters.mediaFilter;

  // 导出弹层
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  /** 实际进入导出流程的条目（视频不走重编码导出，会被排除） */
  const [exportTargets, setExportTargets] = useState<Photo[]>([]);

  // 网格句柄与列数：方向键导航需要 scrollToPhoto + 步长
  const gridRef = useRef<ImageGridHandle>(null);
  const [gridColumns, setGridColumns] = useState(6);
  
  // Context Menu State
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; photo?: Photo } | null>(null);
  
  // Loading state for large file operations
  const [loading, setLoading] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [loadingTotal, setLoadingTotal] = useState(0);
  const [loadingCurrentFile, setLoadingCurrentFile] = useState('');

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
      setPhotos(prev => prev.filter(p => !ids.has(p.id)));
      setExitingIds(prev => {
        const next = new Set(prev);
        ids.forEach(id => next.delete(id));
        return next;
      });
    }, EXIT_DURATION);
    exitTimersRef.current.push(timer);
  }, []);

  // 卸载时清掉尚未播完的塌陷计时器
  useEffect(() => () => {
    exitTimersRef.current.forEach(t => window.clearTimeout(t));
    exitTimersRef.current = [];
  }, []);

  // 导入取消：目录扫描（主进程 scanId）与分批入库（AbortController）都可中断
  const activeScanIdRef = useRef<string | null>(null);
  const importAbortRef = useRef<AbortController | null>(null);
  const cancelRequestedRef = useRef(false);
  
  // Duplicate detection state
  /** 主内容区当前视图：重复检测是独立整页，而非弹窗 */
  const [mainView, setMainView] = useState<MainView>('library');
  /** 重复检测页是否在前台：键盘快捷键与参数重跑逻辑据此让行 */
  const isDuplicateDetectorOpen = mainView === 'duplicates';
  const [duplicateGroups, setDuplicateGroups] = useState<Photo[][]>([]);
  const [isProcessingDuplicates, setIsProcessingDuplicates] = useState(false);
  const [duplicateProgress, setDuplicateProgress] = useState<DuplicateScanProgress | null>(null);
  // 可调检测参数：相似度阈值（百分比 80–100）与比对范围
  const [duplicateSimilarity, setDuplicateSimilarity] = useState(DUPLICATE_SIMILARITY_DEFAULT);
  const [duplicateScope, setDuplicateScope] = useState<DuplicateScope>('all');
  /** 最近一次实际生效的检测参数：用于判断参数变化后是否需要自动重跑 */
  const lastDuplicateOptionsRef = useRef<{ similarity: number; scope: DuplicateScope } | null>(null);
  const duplicateRecheckTimerRef = useRef<number | null>(null);
  /** 进行中的重复检测：取消时 abort，检测管线会在下一个分片边界停下并释放 */
  const duplicateAbortRef = useRef<AbortController | null>(null);
  
  // 已导入的路径集合：重复打开同一目录时直接跳过，避免重复条目
  const importedPathsRef = useRef<Set<string>>(new Set());

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

      coverRef.current = config.cover ? config.cover : null;

      const storedRecent = Array.isArray(config.recentDirectories)
        ? config.recentDirectories.filter(dir => typeof dir === 'string' && dir.length > 0).slice(0, 8)
        : [];
      recentDirectoriesRef.current = storedRecent;
      setRecentDirectories(storedRecent);

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
        if (prefs.theme === 'light' || prefs.theme === 'dark') setTheme(prefs.theme);
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
            isCover: coverRef.current !== null && photo.path === coverRef.current,
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
  }, [updateFilters]);

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

  // 重复检测参数变更 → 延迟写盘（拖动阈值滑块时同样会连续触发）
  const duplicatePrefsTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!isConfigLoaded) return;

    if (duplicatePrefsTimerRef.current !== null) window.clearTimeout(duplicatePrefsTimerRef.current);
    duplicatePrefsTimerRef.current = window.setTimeout(() => {
      duplicatePrefsTimerRef.current = null;
      void savePersistedConfig({ duplicate: { similarity: duplicateSimilarity, scope: duplicateScope } });
    }, 600);

    return () => {
      if (duplicatePrefsTimerRef.current !== null) {
        window.clearTimeout(duplicatePrefsTimerRef.current);
        duplicatePrefsTimerRef.current = null;
      }
    };
  }, [isConfigLoaded, duplicateSimilarity, duplicateScope]);

  // Selected photo for details pane
  const selectedPhotos = useMemo(() => {
    return photos.filter(p => selectedIds.has(p.id));
  }, [photos, selectedIds]);

  const showToast = useCallback((
    message: string,
    type: ToastType = 'info',
    /** 可选操作按钮（如「重试」）：带按钮的 Toast 不会自动消失 */
    action?: { label: string; onClick: () => void }
  ) => {
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev.slice(-3), { id, message, type, action }]); // 最多同时 4 条
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

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
  }, []);

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
    showToast(removed ? `已删除相簿「${removed.name}」` : '已删除相簿', 'info');
  }, [albums, showToast]);

  /** 记录最近打开的目录（新在前，最多 8 条） */
  const pushRecentDirectory = useCallback((dir: string) => {
    const next = [dir, ...recentDirectoriesRef.current.filter(item => item !== dir)].slice(0, 8);
    recentDirectoriesRef.current = next;
    setRecentDirectories(next);
    void savePersistedConfig({ recentDirectories: next });
  }, []);

  const clearLoading = useCallback(() => {
    setLoading(false);
    setLoadingProgress(0);
    setLoadingTotal(0);
    setLoadingCurrentFile('');
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
    showToast('已取消添加', 'info');
  }, [cancelShowLoading, clearLoading, showToast]);

  // Handle list reset
  const handleResetList = useCallback(() => {
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
    dragThumbCache.clear();
    clearThumbnailCache();
    // 重置图库后指纹也失去意义，一并释放（否则切库后缓存只增不减）
    clearImageHashCache();
    cancelRequestedRef.current = false;
    releaseMemory('soft', 'reset-list');
    showToast('列表已重置', 'info');
  }, [photos, showToast]);

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
  const ingestFiles = useCallback(async (infos: FileInfo[]): Promise<number> => {
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
            isCover: coverRef.current !== null && info.path === coverRef.current,
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

  // Handle adding individual images
  const handleAddImages = async () => {
    try {
      // Check if we're in Electron environment
      if (window.electronAPI) {
        const filePaths = await window.electronAPI.selectFiles();
        if (filePaths && filePaths.length > 0) {
          cancelRequestedRef.current = false;
          // 补齐 size / mtime，避免 size=0 让重复检测退化
          const infos = await window.electronAPI.statFiles(filePaths);
          const added = await ingestFiles(infos);
          showToast(`已添加 ${added} 个项目`, 'success');
        }
      }
    } catch (error) {
      logger.error('Error adding images:', error);
      showToast('添加失败', 'error');
    }
  };

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

  // Helper function to create a smaller thumbnail using canvas with optimized settings for speed
  const createThumbnail = async (input: File | string, maxSize: number = 200): Promise<string> => {
    // Convert File object to base64 first if needed
    let base64Data: string;
    let cacheKey: string;
    
    if (input instanceof File) {
      // For File objects, use a combination of name and last modified time as cache key
      cacheKey = `${input.name}-${input.lastModified}`;
      base64Data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(input);
      });
    } else {
      // For string URLs, use the URL as cache key
      cacheKey = input;
      base64Data = input;
    }

    // Check if thumbnail already exists in cache
    const sizeKey = Math.round(maxSize); // Round to nearest integer to avoid cache misses
    const sizeCache = dragThumbCache.get(cacheKey);
    if (sizeCache?.has(sizeKey)) {
      return sizeCache.get(sizeKey)!;
    }

    const remember = (value: string) => {
      const bucket = dragThumbCache.get(cacheKey) ?? new Map<number, string>();
      bucket.set(sizeKey, value);
      dragThumbCache.set(cacheKey, bucket);
    };

    // Create thumbnail from base64 data
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous'; // Enable CORS for external images if needed
      img.onload = () => {
        // 尺寸已经够小：仍走一次 canvas，保证进缓存的是「缩略图」而不是整份原图 base64
        if (img.width <= maxSize && img.height <= maxSize) {
          remember(base64Data);
          resolve(base64Data);
          return;
        }

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(base64Data); // Fallback to original if canvas fails
          return;
        }

        // Calculate dimensions maintaining aspect ratio
        let width = img.width;
        let height = img.height;
        if (width > height) {
          if (width > maxSize) {
            height *= maxSize / width;
            width = maxSize;
          }
        } else {
          if (height > maxSize) {
            width *= maxSize / height;
            height = maxSize;
          }
        }

        // Ensure dimensions are integers to avoid rendering artifacts
        width = Math.round(width);
        height = Math.round(height);

        canvas.width = width;
        canvas.height = height;

        // Draw image to canvas with optimized settings for speed
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'low';
        ctx.drawImage(img, 0, 0, width, height);

        const isJPEG = base64Data.startsWith('data:image/jpeg') || base64Data.startsWith('data:image/jpg');
        const thumbnail = canvas.toDataURL(isJPEG ? 'image/jpeg' : 'image/png', isJPEG ? 0.7 : 0.75);

        remember(thumbnail);

        // Clean up immediately to free memory
        canvas.width = 0;
        canvas.height = 0;
        canvas.remove();

        resolve(thumbnail);
      };
      img.onerror = () => {
        logger.warn('Thumbnail generation failed, using original image');
        resolve(base64Data); // Fallback to original if image fails to load
      };
      img.src = base64Data;
    });
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
      const infos = await window.electronAPI.scanDirectory(dirPath, scanId);

      // 被取消：丢弃扫描结果，不写入列表
      if (activeScanIdRef.current !== scanId || cancelRequestedRef.current) return;

      if (infos.length === 0) {
        showToast(`文件夹 "${dirName}" 不包含任何图片或视频`, 'info');
        return;
      }

      setLoadingCurrentFile(`正在加入 ${infos.length} 个项目…`);
      const added = await ingestFiles(infos);

      if (activeScanIdRef.current !== scanId || cancelRequestedRef.current) return;

      if (added === 0 && infos.length > 0) {
        showToast(`文件夹 "${dirName}" 中的内容已在列表中`, 'info');
        return;
      }

      setCurrentFolder(dirName);
      setDirectoryPath(dirPath);
      pushRecentDirectory(dirPath);
      showToast(`文件夹 "${dirName}" 已加载 ${added} 个项目`, 'success');
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
  }, [cancelShowLoading, clearLoading, ingestFiles, pushRecentDirectory, showToast]);

  /** 重新打开最近目录（走同一套扫描 + 导入管线，同样可取消） */
  const handleSelectRecentFolder = useCallback((path: string) => {
    cancelRequestedRef.current = false;
    void loadDirectory(path);
  }, [loadDirectory]);

  // Handle Folder Upload using Electron File System API
  const handleOpenDirectory = async (): Promise<boolean> => {
    try {
      // Check if we're in Electron environment
      if (!window.electronAPI) {
        logger.error('Electron API not available');
        return false;
      }

      // Request directory selection using Electron's main process
      const dirPaths = await window.electronAPI.selectDirectory();
      if (dirPaths && dirPaths.length > 0) {
        cancelRequestedRef.current = false;
        // Process each selected directory
        for (const dirPath of dirPaths) {
          if (cancelRequestedRef.current) break;
          await loadDirectory(dirPath);
        }
        return true;
      }

      return false;

    } catch (err) {
      logger.error('Error opening directory:', err);
      showToast('无法打开目录', 'error');
      return false;
    }
  };


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

  // Grouping Logic
  const groupedPhotos = useMemo(() => {
    const sortedPhotos = [...photos].sort((a, b) => {
      if (sortConfig.key === 'dateModified' || sortConfig.key === 'dateTaken') {
        const dateA = a.dateTaken || a.lastModified || 0;
        const dateB = b.dateTaken || b.lastModified || 0;
        return sortConfig.direction === 'asc' ? dateA - dateB : dateB - dateA;
      }
      if (sortConfig.key === 'dateCreated') {
        const dateA = a.dateCreated || a.lastModified || 0;
        const dateB = b.dateCreated || b.lastModified || 0;
        return sortConfig.direction === 'asc' ? dateA - dateB : dateB - dateA;
      }
      if (sortConfig.key === 'name') {
        return sortConfig.direction === 'asc' 
          ? a.name.localeCompare(b.name) 
          : b.name.localeCompare(a.name);
      }
      if (sortConfig.key === 'size') {
        return sortConfig.direction === 'asc' ? a.size - b.size : b.size - a.size;
      }
      return 0;
    });

    if (sortConfig.key !== 'dateModified' && sortConfig.key !== 'dateTaken') {
      return [{ key: 'all', photos: sortedPhotos }];
    }

    const groups: Record<string, Photo[]> = {};
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const todayKey = today.toDateString();
    const yesterdayKey = yesterday.toDateString();

    sortedPhotos.forEach(photo => {
      const key = getDateGroupKey(photo.dateTaken || photo.lastModified, todayKey, yesterdayKey);

      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(photo);
    });

    return Object.entries(groups).map(([key, photos]) => ({ key, photos }));
  }, [photos, sortConfig]);

  // Get sorted photos for display
  // groupedPhotos 内部已完成排序，这里直接展开，避免对同一份数据重复排序
  const sortedPhotos = useMemo(
    () => groupedPhotos.flatMap(group => group.photos),
    [groupedPhotos]
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

  /**
   * QuickLook 的翻页范围跟随当前视图：
   * 图库里按可见列表翻页，重复检测页只在检测结果内翻页。
   */
  const quickLookList = useMemo(
    () => (isDuplicateDetectorOpen ? duplicateGroups.flatMap(group => group) : visiblePhotos),
    [isDuplicateDetectorOpen, duplicateGroups, visiblePhotos]
  );

  // QuickLook 当前索引：缓存结果，避免每次渲染对大列表做线性查找
  const quickLookIndex = useMemo(
    () => (quickLookPhoto ? quickLookList.findIndex(p => p.id === quickLookPhoto.id) : -1),
    [quickLookPhoto, quickLookList]
  );

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

  // 设为封面：全库仅一张，再次点击取消；路径写入配置，重启后仍在
  const handleToggleCover = useCallback((photo: Photo) => {
    const willBeCover = !photo.isCover;
    coverRef.current = willBeCover ? photo.path ?? null : null;
    setPhotos(prev => prev.map(p => ({ ...p, isCover: willBeCover ? p.id === photo.id : false })));
    void savePersistedConfig({ cover: coverRef.current ?? '' });
    showToast(willBeCover ? `已将「${photo.name}」设为封面` : '已取消封面', 'success');
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
      
      let finalPath = newPath;
      let conflicted = false;
      try {
        const result = await window.electronAPI.renameFile(oldPath, newPath);
        logger.debug(`Single rename result:`, result);

        if (result.error) {
          logger.error('Failed to rename file:', result.error);
          showToast(`重命名照片 "${photo.name}" 失败：${result.error}`, 'error');
          return;
        }
        // 主进程在重名时可能自动追加了序号，一律以返回的最终路径为准
        finalPath = result.path || newPath;
        conflicted = Boolean(result.conflicted);
      } catch (electronError) {
        logger.error('Electron rename error:', electronError);
        showToast(`重命名照片 "${photo.name}" 时发生错误：${electronError}`, 'error');
        return;
      }

      const actualName = finalPath.split(/[\\/]/).pop() || finalName;

      // Update the photo in state
      setPhotos(prev => prev.map(p => {
        if (p.id === id) {
          return {
            ...p,
            name: actualName,
            path: finalPath
          };
        }
        return p;
      }));

      if (conflicted) {
        showToast(`「${finalName}」已存在，已自动重命名为「${actualName}」`, 'warning');
      } else {
        showToast(`照片已重命名为 ${actualName}`, 'success');
      }
      setIsRenameModalOpen(false);
    } catch (err) {
      logger.error('Error renaming photo:', err);
      showToast(`重命名照片失败：${(err as Error).message}`, 'error');
    }
  };

  // 日期格式化统一由 utils.formatDateForNaming 提供（与 RenameModal 预览共用同一实现）

  // Helper function to safely join directory and filename, compatible with both Unix and Windows paths
  const joinPath = (dirPath: string, filename: string): string => {
    // Check if path uses backslashes (Windows)
    if (dirPath.includes('\\')) {
      // Remove any trailing backslashes
      dirPath = dirPath.replace(/\\+$/, '');
      return `${dirPath}\\${filename}`;
    } else {
      // Remove any trailing slashes
      dirPath = dirPath.replace(/\/+$/, '');
      return `${dirPath}/${filename}`;
    }
  };

  // Helper function to sanitize filename by removing or replacing invalid characters
  const sanitizeFilename = (filename: string): string => {
    // Remove or replace invalid characters for filenames
    // Invalid characters on Windows: < > : " / \ | ? *
    // Invalid characters on Unix: /
    return filename
      .replace(/[<>:"|?*]/g, '') // Remove invalid Windows characters
      .replace(/\//g, '-'); // Replace slashes with dashes
  };

  // Handle batch rename
  const handleBatchRename = async (options: RenameOptions) => {
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

      const updates = [];
      // 只有同一个目录内才需要担心重名，不同文件夹下的同名文件互不影响
      const usedNames = new Set<string>();
      let renamedCount = 0;
      let unchangedCount = 0; // 名称本来就符合规则、无需改动
      let failedCount = 0;
      let conflictCount = 0; // 因重名被主进程自动追加序号的数量

      for (let i = 0; i < sortedPhotos.length; i++) {
        const photo = sortedPhotos[i];
        if (!photo) continue;
        
        // Check if photo has a valid path
        if (!photo.path || photo.path === '') {
          logger.error('Cannot rename photo without path:', photo.name);
          continue; // Skip photos without path (e.g., dragged files)
        }

        const fileExt = photo.name.split('.').pop();
        if (!fileExt) {
          logger.error('Cannot rename photo without file extension:', photo.name);
          showToast(`无法重命名照片 "${photo.name}"：缺少文件扩展名`, 'error');
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
        
        try {
          const result = await window.electronAPI.renameFile(oldPath, newPath);
          logger.debug(`Rename result:`, result);

          if (result.error) {
            logger.error('Failed to rename file:', result.error);
            showToast(`重命名照片 "${photo.name}" 失败：${result.error}`, 'error');
            failedCount++;
            // Continue with other photos instead of failing all
            continue;
          }

          // 重名时主进程会自动追加序号，以返回的最终路径为准
          const finalPath = result.path || newPath;
          const actualName = finalPath.split(/[\\/]/).pop() || newName;
          if (result.conflicted) conflictCount++;

          updates.push({ id: photo.id, newName: actualName, newPath: finalPath });
          renamedCount++;
        } catch (electronError) {
          logger.error('Electron rename error:', electronError);
          showToast(`重命名照片 "${photo.name}" 时发生错误：${electronError}`, 'error');
          failedCount++;
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
              path: update.newPath
            };
          }
          return p;
        }));
      }

      const summaryParts: string[] = [];
      if (renamedCount > 0) summaryParts.push(`已重命名 ${renamedCount} 项`);
      if (unchangedCount > 0) summaryParts.push(`${unchangedCount} 项无需修改`);
      if (conflictCount > 0) summaryParts.push(`${conflictCount} 项因重名追加了序号`);
      if (failedCount > 0) summaryParts.push(`${failedCount} 项失败`);

      if (failedCount > 0) {
        showToast(summaryParts.join('，'), 'warning');
      } else if (summaryParts.length === 0) {
        showToast('没有需要修改的名称', 'info');
      } else {
        showToast(summaryParts.join('，'), 'success');
      }
      setIsRenameModalOpen(false);
    } catch (err) {
      logger.error('Error batch renaming photos:', err);
      showToast(`批量重命名照片失败：${(err as Error).message}`, 'error');
    }
  };

  /** 批量移入回收站：返回成功删除的 id、失败照片与错误说明（失败项可用于重试） */
  const movePhotosToTrash = async (targets: Photo[]) => {
    const deletedIds = new Set<string>();
    const failedPhotos: Photo[] = [];
    const errors: string[] = [];

    for (const photo of targets) {
      if (!window.electronAPI) {
        failedPhotos.push(photo);
        errors.push(`「${photo.name}」：电子 API 不可用`);
        continue;
      }
      if (!photo.path) {
        failedPhotos.push(photo);
        errors.push(`「${photo.name}」缺少文件路径`);
        continue;
      }
      try {
        const result = await window.electronAPI.deleteFile(photo.path);
        if (result?.error) {
          failedPhotos.push(photo);
          errors.push(`「${photo.name}」：${result.error}`);
        } else {
          deletedIds.add(photo.id);
        }
      } catch (err) {
        failedPhotos.push(photo);
        errors.push(`「${photo.name}」：${(err as Error).message}`);
      }
    }

    return { deletedIds, failedPhotos, errors };
  };

  /** 执行删除并反馈结果；失败项可在 Toast 上点「重试」再删一次 */
  const runDelete = async (targets: Photo[]) => {
    if (targets.length === 0) return;
    if (!window.electronAPI) {
      showToast('电子 API 不可用，无法执行删除操作', 'error');
      return;
    }

    const { deletedIds, failedPhotos, errors } = await movePhotosToTrash(targets);

    // 同步收敛状态：列表、选中项、重复检测结果
    if (deletedIds.size > 0) {
      // 卡片先淡出再摘除：磁盘上的文件已经没了，但界面上要让人看见它离开
      removeWithCollapse(deletedIds);
      setSelectedIds(new Set());
      setDuplicateGroups(prev =>
        prev
          .map(group => group.filter(p => !deletedIds.has(p.id)))
          .filter(group => group.length > 1)
          .map(markRecommended)
      );
    }

    if (failedPhotos.length === 0) {
      showToast(`已将 ${deletedIds.size} 张照片移至回收站`, 'success');
      return;
    }

    errors.forEach(error => logger.error('删除失败：', error));
    const detail = errors[0] + (errors.length > 1 ? ` 等 ${errors.length} 项` : '');
    const retryAction = { label: '重试', onClick: () => { void runDelete(failedPhotos); } };

    if (deletedIds.size > 0) {
      showToast(`已删除 ${deletedIds.size} 张，${failedPhotos.length} 张失败：${detail}`, 'warning', retryAction);
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

    await runDelete(targets);
    setIsDeleteModalOpen(false);
  };

  // Handle duplicate detection：支持传入阈值 / 范围覆盖（参数变化时自动重跑）
  const handleCheckDuplicates = useCallback(async (override?: { similarity?: number; scope?: DuplicateScope }) => {
    // 重复检测只针对图片：视频逐帧比对既慢又无意义
    const imagePhotos = photos.filter(p => !isVideoPhoto(p));
    if (imagePhotos.length === 0) {
      showToast(photos.length > 0 ? '相似检测仅支持图片' : '没有照片可检查相似项', 'info');
      return;
    }

    const runSimilarity = override?.similarity ?? duplicateSimilarity;
    const runScope = override?.scope ?? duplicateScope;

    // 上一轮还在跑就先取消：两轮重叠会同时占用 CPU 与内存，是列表卡顿的主要来源
    duplicateAbortRef.current?.abort();
    const controller = new AbortController();
    duplicateAbortRef.current = controller;

    // 检测是整页流程：先把主内容区切到重复检测页，再开始扫描
    setMainView('duplicates');
    setIsProcessingDuplicates(true);
    setDuplicateGroups([]);
    setDuplicateProgress({
      processed: 0,
      total: imagePhotos.length,
      candidates: 0,
      cached: 0,
      skipped: 0,
      elapsedMs: 0,
      phase: 'hashing',
    });

    try {
      // 复用同一套检测管线；哈希有跨调用缓存，调参后重跑主要是重新分组
      const detectedDuplicates = await findDuplicatePhotos(
        imagePhotos,
        // 界面用相似度百分比，检测管线仍以汉明距离（bit）为准
        { threshold: similarityToDistance(runSimilarity), sameFolderOnly: runScope === 'sameFolder', signal: controller.signal },
        setDuplicateProgress
      );
      setDuplicateGroups(detectedDuplicates);
      lastDuplicateOptionsRef.current = { similarity: runSimilarity, scope: runScope };

      if (detectedDuplicates.length > 0) {
        showToast(`找到 ${detectedDuplicates.length} 组相似照片`, 'info');
      } else {
        showToast('未找到相似照片', 'success');
      }
    } catch (error) {
      // 取消是用户主动行为而非故障：静默收尾，不弹错误
      if (isDuplicateScanAbort(error)) {
        setDuplicateGroups([]);
        return;
      }
      logger.error('Error detecting duplicates:', error);
      showToast('检测相似照片失败', 'error');
    } finally {
      if (duplicateAbortRef.current === controller) duplicateAbortRef.current = null;
      setIsProcessingDuplicates(false);
      setDuplicateProgress(prev =>
        prev ? { ...prev, processed: prev.total, etaMs: undefined, phase: 'done' } : prev
      );
      // 检测结束（或取消）后回收易失缓存，把峰值内存还回去
      releaseMemory('soft', 'duplicate-scan-done');
    }
  }, [photos, duplicateSimilarity, duplicateScope, showToast]);

  /** 取消进行中的重复检测 */
  const handleCancelDuplicates = useCallback(() => {
    if (!duplicateAbortRef.current) return;
    duplicateAbortRef.current.abort();
    duplicateAbortRef.current = null;
    showToast('已取消重复检测', 'info');
  }, [showToast]);

  /** 离开重复检测页：先取消，避免任务在后台继续跑导致图库卡顿 */
  const handleExitDuplicates = useCallback(() => {
    handleCancelDuplicates();
    setMainView('library');
  }, [handleCancelDuplicates]);

  // 卸载时中断仍在跑的检测，防止任务残留在后台
  useEffect(() => () => duplicateAbortRef.current?.abort(), []);

  // 阈值 / 范围调整后自动重新分组（防抖 300ms，避免拖动滑块时反复触发）
  useEffect(() => {
    if (!isDuplicateDetectorOpen || isProcessingDuplicates) return;
    const last = lastDuplicateOptionsRef.current;
    if (!last) return; // 尚未检测过：等用户主动触发
    if (last.similarity === duplicateSimilarity && last.scope === duplicateScope) return;

    if (duplicateRecheckTimerRef.current !== null) {
      window.clearTimeout(duplicateRecheckTimerRef.current);
    }
    duplicateRecheckTimerRef.current = window.setTimeout(() => {
      duplicateRecheckTimerRef.current = null;
      handleCheckDuplicates({ similarity: duplicateSimilarity, scope: duplicateScope });
    }, 300);

    return () => {
      if (duplicateRecheckTimerRef.current !== null) {
        window.clearTimeout(duplicateRecheckTimerRef.current);
        duplicateRecheckTimerRef.current = null;
      }
    };
  }, [duplicateSimilarity, duplicateScope, isDuplicateDetectorOpen, isProcessingDuplicates, handleCheckDuplicates]);

  // 删除用户在重复检测面板中手动勾选的照片；
  // 删除后同步收敛检测结果，并重算每组的「推荐保留」项，弹窗保持打开以便继续处理
  const handleDeleteDuplicates = async (photosToDelete: Photo[]) => {
    if (photosToDelete.length === 0) return;

    if (!window.electronAPI) {
      showToast('电子API不可用，无法执行删除操作', 'error');
      return;
    }

    const { deletedIds, failedPhotos, errors } = await movePhotosToTrash(photosToDelete);

    if (deletedIds.size > 0) {
      removeWithCollapse(deletedIds);
      setSelectedIds(prev => {
        if (prev.size === 0) return prev;
        const next = new Set(prev);
        deletedIds.forEach(id => next.delete(id));
        return next;
      });
      // 分组与图库同步延后收敛，避免「列表先空一格、分组后跳一下」的错位
      const timer = window.setTimeout(() => {
        exitTimersRef.current = exitTimersRef.current.filter(t => t !== timer);
        setDuplicateGroups(prev =>
          prev
            .map(group => group.filter(p => !deletedIds.has(p.id)))
            .filter(group => group.length > 1)
            .map(group => markRecommended(group))
        );
      }, EXIT_DURATION);
      exitTimersRef.current.push(timer);
    }

    if (failedPhotos.length === 0) {
      showToast(`已将 ${deletedIds.size} 张相似照片移至回收站`, 'success');
      return;
    }

    errors.forEach(error => logger.error('删除重复照片失败：', error));
    const detail = errors[0] + (errors.length > 1 ? ` 等 ${errors.length} 项` : '');
    const retryAction = { label: '重试', onClick: () => { void handleDeleteDuplicates(failedPhotos); } };

    if (deletedIds.size > 0) {
      showToast(`已删除 ${deletedIds.size} 张，${failedPhotos.length} 张失败：${detail}`, 'warning', retryAction);
    } else {
      showToast(`删除失败：${detail}`, 'error', retryAction);
    }
  };

  // Context Menu Actions
  const contextMenuActions = useMemo((): ContextMenuItem[] => {
    // 空白区右键：图库级操作
    if (!contextMenu?.photo) {
      return [
        {
          label: '导入图片 / 视频…',
          onClick: () => handleAddImages(),
        },
        {
          label: '打开文件夹…',
          onClick: () => handleOpenDirectory(),
        },
        { separator: true },
        {
          label: '全选',
          shortcut: '⌘A',
          disabled: visiblePhotos.length === 0,
          onClick: () => handleSelectAllVisible(),
        },
        {
          label: '检测相似照片',
          disabled: photos.length === 0,
          onClick: () => handleCheckDuplicates(),
        },
        ...(photos.length > 0 ? [{ separator: true } as ContextMenuItem, {
          label: '重置列表',
          onClick: () => handleResetList(),
        }] : []),
      ];
    }

    // 条目右键：单张 + 选中集操作
    const photo = contextMenu.photo;
    const isVideo = isVideoPhoto(photo);

    // 右键的条目若在选中集内，则对整组生效（与重命名 / 删除一致）
    const targetIds = selectedIds.has(photo.id) && selectedIds.size > 1 ? [...selectedIds] : [photo.id];
    const allHidden = targetIds.every(id => photosRef.current.find(p => p.id === id)?.isHidden);
    const hideLabel =
      targetIds.length > 1
        ? `${allHidden ? '取消隐藏' : '隐藏'} ${targetIds.length} 项`
        : allHidden
          ? '取消隐藏'
          : '隐藏';

    return [
      {
        label: isVideo ? '播放' : '打开',
        shortcut: '␣',
        onClick: () => setQuickLookPhoto(photo),
      },
      {
        label: photo.isFavorite ? '取消收藏' : '收藏',
        shortcut: '⌘⇧F',
        onClick: () => toggleFavorite(photo.id),
      },
      {
        label: hideLabel,
        onClick: () => setHidden(targetIds, !allHidden),
      },
      { separator: true },
      // 视频无法写入图片剪贴板
      ...(isVideo ? [] : [{
        label: '复制图片',
        onClick: () => handleCopyImage(photo),
      } as ContextMenuItem]),
      {
        label: '在访达中显示',
        onClick: () => handleShowInFolder(photo),
      },
      {
        label: '复制路径',
        onClick: () => handleCopyPath(photo),
      },
      {
        label: '用默认应用打开',
        onClick: () => handleOpenInEditor(photo),
      },
      {
        label: photo.isCover ? '取消封面' : '设为封面',
        onClick: () => handleToggleCover(photo),
      },
      // 导出走 canvas 重编码，仅图片可用
      ...(isVideo ? [] : [{
        label: `导出${selectedIds.size > 1 ? ` ${selectedIds.size} 张` : '…'}`,
        onClick: () => handleExportSelected(),
      } as ContextMenuItem]),
      { separator: true },
      {
        label: '调整日期与时间…',
        onClick: () => setIsAdjustDateModalOpen(true),
      },
      {
        label: selectedIds.size > 1 ? `重命名 ${selectedIds.size} 项…` : '重命名…',
        onClick: () => setIsRenameModalOpen(true),
      },
      {
        label: selectedIds.size > 1 ? `删除 ${selectedIds.size} 项` : '删除',
        shortcut: '⌫',
        danger: true,
        onClick: () => setIsDeleteModalOpen(true),
      },
    ];
  }, [contextMenu, visiblePhotos.length, photos.length, selectedIds, toggleFavorite, setHidden, handleCopyImage, handleShowInFolder, handleCopyPath, handleOpenInEditor, handleToggleCover, handleExportSelected, handleSelectAllVisible, handleCheckDuplicates, handleResetList]);

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

  // 筛选面板的可选项（相机 / 格式 / 标签）：随元数据与标签变化动态更新
  const filterOptions = useMemo(
    () => ({ ...buildFilterOptions(photos), tags: buildTagOptions(photos) }),
    [photos]
  );

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

  // 方向键导航：移动单个选中项并让视口跟随（上下键按网格列数跳步）
  const handleArrowNavigation = useCallback((key: string) => {
    if (visiblePhotos.length === 0) return;
    const ids = visiblePhotos.map(p => p.id);
    let currentIndex = selectionAnchorRef.current ? ids.indexOf(selectionAnchorRef.current) : -1;
    if (currentIndex < 0) currentIndex = 0;

    let nextIndex = currentIndex;
    if (key === 'ArrowLeft') nextIndex = Math.max(0, currentIndex - 1);
    else if (key === 'ArrowRight') nextIndex = Math.min(ids.length - 1, currentIndex + 1);
    else if (key === 'ArrowUp') nextIndex = Math.max(0, currentIndex - gridColumns);
    else if (key === 'ArrowDown') nextIndex = Math.min(ids.length - 1, currentIndex + gridColumns);

    if (nextIndex === currentIndex && selectedIds.size === 1) return;
    const nextId = ids[nextIndex];
    setSelectedIds(new Set([nextId]));
    selectionAnchorRef.current = nextId;
    gridRef.current?.scrollToPhoto(nextId);
  }, [visiblePhotos, gridColumns, selectedIds.size]);

  // 主视图键盘闭环：
  // 空格 / Enter → QuickLook；⌘A → 全选当前视图；⌘⇧F → 批量收藏；⌘F → 聚焦搜索；
  // 方向键 → 单选移动；Delete / ⌫ → 删除确认；Esc → 关闭右键菜单，其次清除选择。
  // 弹层打开或焦点在输入框内时全部让行。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // 重复检测页：Esc 返回图库（预览层打开时让行给它）
      if (isDuplicateDetectorOpen) {
        if (e.key === 'Escape' && !quickLookPhoto) {
          e.preventDefault();
          handleExitDuplicates();
        }
        return;
      }
      if (quickLookPhoto || isRenameModalOpen || isDeleteModalOpen || isExportModalOpen) return;

      const target = e.target as HTMLElement | null;
      const isTextInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      const cmd = e.metaKey || e.ctrlKey;

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
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (contextMenu) return;
        e.preventDefault();
        handleArrowNavigation(e.key);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
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
    quickLookPhoto, isRenameModalOpen, isDeleteModalOpen, isDuplicateDetectorOpen, isExportModalOpen,
    contextMenu, visiblePhotos, selectedIds,
    handleSelectAllVisible, handleFavoriteSelected, handleArrowNavigation, handleExitDuplicates,
  ]);

  // ⌘O 应用菜单「打开目录」：主进程发送 directory-selected 事件
  useEffect(() => {
    if (!window.electronAPI) return;
    // preload 未提供取消订阅，监听器随窗口生命周期存在
    window.electronAPI.onDirectorySelected((dirPath: string) => {
      cancelRequestedRef.current = false;
      loadDirectory(dirPath);
    });
  }, [loadDirectory]);

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
        try {
          // 拖放的 File 对象没有创建时间，补一次 stat 才能拿到 birthtime
          if (window.electronAPI) {
            const infos = await window.electronAPI.statFiles(resolved.map(r => r.path));
            const byPath = new Map(infos.map(info => [info.path, info]));
            resolved.forEach(item => {
              const info = byPath.get(item.path);
              if (!info) return;
              item.size = info.size;
              item.mtime = info.mtime;
              item.created = info.created;
            });
          }
          const added = await ingestFiles(resolved);
          // 同一次拖放里混有不支持的文件时一并说明，避免「悄悄少了几个」
          const rejectNote = rejected.length > 0 ? `，已忽略 ${rejected.length} 个不支持的文件` : '';
          showToast(`已添加 ${added} 个项目${rejectNote}`, rejected.length > 0 ? 'warning' : 'success');
        } catch {
          showToast('处理拖拽文件失败', 'error');
        }
      })();
    }

    // 拖入的文件夹：解析真实路径后复用目录扫描管线（可取消）
    if (maybeDirs.length > 0 && window.electronAPI) {
      (async () => {
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
            const infos = await window.electronAPI.scanDirectory(dirPath, scanId);
            if (activeScanIdRef.current !== scanId) return; // 已被取消
            if (infos.length === 0) {
              showToast(`文件夹「${dir.name}」中没有可导入的图片或视频`, 'warning');
              continue;
            }
            const added = await ingestFiles(infos);
            showToast(`已从文件夹「${dir.name}」加入 ${added} 个项目`, 'success');
          } catch (error) {
            logger.error('Error importing dropped folder:', error);
            showToast(`导入文件夹「${dir.name}」失败`, 'error');
          } finally {
            if (activeScanIdRef.current === scanId) activeScanIdRef.current = null;
          }
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
              dateCreated: file.lastModified,
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
  }, [clearLoading, createThumbnail, ingestFiles, showToast]);

  // 空状态 / 情境条文案：区分「完全为空」「全部已隐藏」「收藏夹为空」「搜索无结果」「筛选无结果」「媒体筛选为空」
  const isEmptyLibrary = photos.length === 0;
  const isHiddenView = activeCategory === 'hidden';
  const isSearchEmpty = !isEmptyLibrary && !!searchQuery.trim() && visiblePhotos.length === 0;
  /** 非「已隐藏」视图下，所有项目都被隐藏了 */
  const isAllHidden =
    !isEmptyLibrary &&
    !isHiddenView &&
    counts.hidden === photos.length &&
    !searchQuery.trim() &&
    !hasAdvancedFilters(filters) &&
    !filters.favoritesOnly &&
    mediaFilter === 'all';
  /** 「已隐藏」视图自身为空 */
  const isHiddenEmpty = !isEmptyLibrary && isHiddenView && !isSearchEmpty && visiblePhotos.length === 0;
  const isFilterEmpty =
    !isEmptyLibrary &&
    !isSearchEmpty &&
    !isAllHidden &&
    !isHiddenEmpty &&
    hasAdvancedFilters(filters) &&
    visiblePhotos.length === 0;
  const isFavoritesEmpty =
    !isEmptyLibrary &&
    !isSearchEmpty &&
    !isFilterEmpty &&
    !isHiddenEmpty &&
    filters.favoritesOnly &&
    visiblePhotos.length === 0;
  const isMediaFilterEmpty =
    !isEmptyLibrary &&
    !isSearchEmpty &&
    !isFilterEmpty &&
    !isFavoritesEmpty &&
    !isHiddenEmpty &&
    !isAllHidden &&
    mediaFilter !== 'all' &&
    visiblePhotos.length === 0;
  const gridViewTitle =
    activeCategory === 'hidden'
      ? '已隐藏'
      : activeCategory === 'favorites'
        ? '收藏夹'
        : mediaFilter === 'all'
          ? '所有媒体'
          : MEDIA_FILTER_LABELS[mediaFilter];

  return (
    <div className={`app-container flex h-screen ${theme === 'light' ? 'light-theme' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag and Drop Overlay */}
      {isDragOverlayMounted && (
        <div className={`fixed inset-0 z-50 bg-[var(--bg-overlay)] backdrop-blur-xl flex items-center justify-center pointer-events-none transition-opacity duration-200 ease-entrance ${isDragOverlayActive ? 'opacity-100' : 'opacity-0'}`}>
          <div className={`bg-[var(--bg-modal)] backdrop-blur-xl rounded-3xl shadow-2xl p-14 border border-[var(--border-default)] text-center transition-[transform,opacity] duration-200 ease-entrance ${isDragOverlayActive ? 'scale-100 opacity-100' : 'scale-[0.98] opacity-0'}`}>
            <div className="w-24 h-24 mx-auto mb-8 rounded-full bg-[rgba(var(--accent-blue-rgb),0.12)] flex items-center justify-center shadow-xl shadow-[rgba(var(--accent-blue-rgb),0.15)]">
              <svg className="w-12 h-12 text-[var(--accent-blue)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path>
              </svg>
            </div>
            <h3 className="text-2xl font-semibold text-[var(--text-primary)] mb-3 tracking-wide">拖放图片或视频到此处</h3>
            <p className="text-sm text-[var(--text-tertiary)]">支持 JPG、PNG、WEBP、HEIC 与 MP4、MOV、WEBM、MKV 等格式</p>
          </div>
        </div>
      )}
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
        onRequestSaveAlbum={() => setIsSaveAlbumModalOpen(true)}
        currentFolder={currentFolder}
        currentDirectory={directoryPath}
        onSelectFolder={handleOpenDirectory}
        recentDirectories={recentDirectories}
        onSelectRecentFolder={handleSelectRecentFolder}
        isOpen={isLeftPaneOpen}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      {/* Loading Overlay for Large File Operations */}
      {loading && (
        <div className="fixed inset-0 bg-[var(--bg-overlay)] backdrop-blur-2xl z-[100] flex items-center justify-center">
          <div className="relative">
            <div className="absolute inset-0 bg-gradient-to-br from-[var(--accent-blue)]/20 via-transparent to-[var(--accent-purple)]/20 rounded-3xl blur-3xl animate-pulse"></div>
            
            <div className="relative bg-[var(--bg-modal)] backdrop-blur-xl rounded-3xl shadow-2xl p-8 w-80 border border-[var(--border-default)]">
              <div className="flex flex-col items-center">
                <div className="relative w-20 h-20 mb-6">
                  <div className="absolute inset-0 rounded-full bg-gradient-to-br from-[var(--accent-blue)] to-[var(--accent-purple)] opacity-20 animate-ping"></div>
                  <div className="absolute inset-2 rounded-full bg-[var(--bg-modal)]"></div>
                  <div className="absolute inset-0 rounded-full border-2 border-[var(--border-default)]"></div>
                  <div className="absolute inset-0 rounded-full border-t-2 border-r-2 border-[var(--accent-blue)] animate-spin" style={{ animationDuration: '1.5s' }}></div>
                  <div className="absolute inset-1 rounded-full border-b-2 border-l-2 border-[var(--accent-purple)] animate-spin" style={{ animationDuration: '2s', animationDirection: 'reverse' }}></div>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <svg className="w-8 h-8 text-[var(--accent-cyan)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                  </div>
                </div>

                <h3 className="text-xl font-semibold text-[var(--text-primary)] mb-4 tracking-wide">
                  {loadingTotal > 0 ? '正在处理媒体' : '正在扫描文件夹'}
                </h3>

                <div className="w-full space-y-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-[var(--text-tertiary)]">{loadingTotal > 0 ? '进度' : '状态'}</span>
                    <span className="font-medium bg-gradient-to-r from-[var(--accent-cyan)] to-[var(--accent-purple)] bg-clip-text text-transparent">
                      {loadingTotal > 0 ? `${Math.round((loadingProgress / loadingTotal) * 100)}%` : '扫描中'}
                    </span>
                  </div>

                  <div className="relative h-2.5 bg-[var(--bg-glass-hover)] rounded-full overflow-hidden">
                    {loadingTotal > 0 ? (
                      <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-[var(--accent-blue)] via-[var(--accent-cyan)] to-[var(--accent-purple)] rounded-full transition-all duration-500 ease-out shadow-lg"
                        style={{ width: `${Math.max(5, (loadingProgress / loadingTotal) * 100)}%` }}>
                      </div>
                    ) : (
                      // 扫描阶段无法预知总数：用不确定态动画，避免误导性的百分比
                      <div
                        className="absolute inset-y-0 rounded-full bg-gradient-to-r from-transparent via-[var(--accent-cyan)] to-transparent"
                        style={{ width: '33%', animation: 'loadingSlide 1.4s ease-in-out infinite' }}
                      />
                    )}
                  </div>

                  <div className="flex justify-between items-center">
                    <span className="text-xs text-[var(--text-quaternary)] font-mono">
                      {loadingTotal > 0 ? `${loadingProgress} / ${loadingTotal}` : '—'}
                    </span>
                    <span className="text-xs text-[var(--text-quaternary)]">{loadingTotal > 0 ? '个项目' : '请稍候'}</span>
                  </div>

                  <div className="h-8 mt-2 px-3 py-1.5 bg-[var(--bg-glass)] rounded-xl border border-[var(--border-subtle)] flex items-center justify-center overflow-hidden">
                    <p className="text-xs text-[var(--text-tertiary)] truncate">
                      {loadingCurrentFile || '等待处理...'}
                    </p>
                  </div>

                  <button
                    onClick={handleCancelLoading}
                    className="w-full mt-1 py-2 text-sm font-medium rounded-xl border border-[var(--border-default)] bg-[var(--bg-glass)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] transition-all duration-200 active:scale-[0.98]"
                  >
                    取消添加
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="main-content flex-1 flex flex-col bg-transparent">
        {/* 重复检测：整页接管主内容区，侧边栏与整窗外壳保持不变 */}
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
              progress={duplicateProgress}
              onQuickLook={setQuickLookPhoto}
              onRecheck={() => handleCheckDuplicates()}
              onCancel={handleCancelDuplicates}
              similarity={duplicateSimilarity}
              onSimilarityChange={setDuplicateSimilarity}
              scope={duplicateScope}
              onScopeChange={setDuplicateScope}
            />
          </ErrorBoundary>
        ) : (
          <>
        <Toolbar
          onOpenDirectory={handleOpenDirectory}
          onAddImages={handleAddImages}
          viewMode={viewMode}
          setViewMode={setViewMode}
          onCheckDuplicates={() => handleCheckDuplicates()}
          onResetList={handleResetList}
          hasPhotos={photos.length > 0}
          scale={scale}
          setScale={setScale}
          currentFolder={currentFolder}
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
          hasVideos={counts.videos > 0}
        />
        <ActiveFiltersBar
          filters={filters}
          onPatch={updateFilters}
          onReset={resetFilters}
          onSaveAsAlbum={() => setIsSaveAlbumModalOpen(true)}
          resultCount={visiblePhotos.length}
          totalCount={counts.all}
        />
        <ErrorBoundary
          label="图库"
          fallback={
            <div className="flex-1 flex items-center justify-center p-8 text-center">
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)] mb-1">图库渲染出错</p>
                <p className="text-xs text-[var(--text-tertiary)] mb-4">工具栏与详情面板仍可使用，可尝试切换视图或重置列表。</p>
                <button
                  onClick={handleResetList}
                  className="px-4 py-2 text-sm font-medium rounded-xl text-[var(--text-secondary)] border border-[var(--border-default)] hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] transition-colors"
                >
                  重置列表
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
          onExportSelected={handleExportSelected}
          onColumnsChange={setGridColumns}
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
                ? '把整个文件夹拖进窗口，或使用「打开文件夹」导入。图片与视频都支持，所有整理都在本地完成。'
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
          onOpenDirectory={isEmptyLibrary ? handleOpenDirectory : undefined}
          onAddImages={isEmptyLibrary ? handleAddImages : undefined}
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
        />
      )}
      {isDeleteModalOpen && (
        <DeleteConfirmModal 
          isOpen={isDeleteModalOpen}
          count={selectedIds.size}
          isDiskOperation={true}
          onClose={() => setIsDeleteModalOpen(false)}
          onConfirm={handleConfirmDelete}
        />
      )}
      {/* Export Modal */}
      {isExportModalOpen && (
        <ExportModal
          isOpen={isExportModalOpen}
          photos={exportTargets}
          onClose={() => { setIsExportModalOpen(false); setExportTargets([]); }}
          onFinish={(succeeded, failed, cancelled) => {
            setIsExportModalOpen(false);
            setExportTargets([]);
            const retryExport = { label: '重新导出', onClick: () => setIsExportModalOpen(true) };
            if (cancelled) {
              showToast(`导出已取消：完成 ${succeeded} 张${failed > 0 ? `，失败 ${failed} 张` : ''}`, 'warning');
            } else if (failed === 0) {
              showToast(`已成功导出 ${succeeded} 张照片`, 'success');
            } else if (succeeded > 0) {
              showToast(`已导出 ${succeeded} 张，${failed} 张失败（同名文件已自动加序号）`, 'warning', retryExport);
            } else {
              showToast(`导出失败：${failed} 张照片均未成功`, 'error', retryExport);
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
        />
      )}
    </div>
  );
};

export default App;