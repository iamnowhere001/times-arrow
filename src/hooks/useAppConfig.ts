/**
 * 应用启动与配置持久化 Hook（从 App 抽出）。
 *
 * 三件事围绕同一份 config.json：
 *   1) 启动加载：读取配置并把「导入可能早于配置读取完成」的条目对齐到配置
 *      （收藏 / 隐藏 / 标签 / 时间修正 / 视频元数据 / AI 结果 / 相簿 / 视图偏好），
 *      同时消费「存储损坏已备份」通知并提示用户；
 *   2) 视频元数据回写：播放器上报时长 / 分辨率后写回条目，延迟合并落盘；
 *   3) 视图偏好落盘：主题 / 排序 / 缩放 / 面板开合等变更延迟合并写盘。
 *
 * 配置读取完成前不写偏好（isConfigLoaded 守卫），避免用默认值覆盖已存配置。
 */

import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { AiCacheEntry, LibrarySource, Photo, PhotoFilters, SmartAlbum, SortConfig, ViewMode } from '@/types';
import { normalizeFilters } from '@/lib/filter/filters';
import {
  loadPersistedConfig,
  savePersistedConfig,
  setPersistenceErrorHandler,
} from '@/lib/persistence/persistence';
import { readSourcesFromConfig } from '@/lib/persistence/sources';
import { loadAiCache } from '@/lib/persistence/aiCache';
import { getVideoMeta, seedVideoMeta, snapshotVideoMeta, subscribeVideoMeta, videoMetaKeyOf } from '@/lib/media/videoMeta';
import {
  DUPLICATE_SIMILARITY_MAX,
  DUPLICATE_SIMILARITY_MIN,
} from '@/components/duplicate/DuplicateDetector';
import { ToastAction, type ToastType } from '@/components/common/Toast';
import type { Theme } from '@/hooks/useThemeMode';

export interface UseAppConfigParams {
  photos: Photo[];
  setPhotos: Dispatch<SetStateAction<Photo[]>>;
  /** 照片列表镜像：配置加载完成后再对齐（导入可能更早） */
  photosRef: RefObject<Photo[]>;
  showToast: (message: string, type?: ToastType, action?: ToastAction) => void;
  updateFilters: (patch: Partial<PhotoFilters>) => void;
  refreshSourceAvailability: (list: LibrarySource[]) => Promise<void>;
  // 按路径持久化的数据 refs
  favoritesRef: RefObject<Set<string>>;
  hiddenRef: RefObject<Set<string>>;
  tagsRef: RefObject<Map<string, string[]>>;
  dateOverridesRef: RefObject<Map<string, number>>;
  aiCacheRef: RefObject<Map<string, AiCacheEntry>>;
  // 配置回填的 setter
  setSources: Dispatch<SetStateAction<LibrarySource[]>>;
  /** 来源 ref 也要同步：readSourcesFromConfig 的结果是后续增删的基准 */
  sourcesRef: RefObject<LibrarySource[]>;
  setAlbums: Dispatch<SetStateAction<SmartAlbum[]>>;
  setTheme: Dispatch<SetStateAction<Theme>>;
  setViewMode: Dispatch<SetStateAction<ViewMode>>;
  setSortConfig: Dispatch<SetStateAction<SortConfig>>;
  setScale: Dispatch<SetStateAction<number>>;
  setIsLeftPaneOpen: Dispatch<SetStateAction<boolean>>;
  setIsDetailsPaneOpen: Dispatch<SetStateAction<boolean>>;
  setDuplicateSimilarity: Dispatch<SetStateAction<number>>;
  setDuplicateScope: Dispatch<SetStateAction<'all' | 'sameFolder'>>;
  /** 配置是否已读取完成：完成前不写偏好，避免用默认值覆盖已存配置 */
  isConfigLoaded: boolean;
  setIsConfigLoaded: Dispatch<SetStateAction<boolean>>;
  // 偏好落盘的输入
  theme: Theme;
  viewMode: ViewMode;
  sortConfig: SortConfig;
  scale: number;
  /** 只记媒体类型这一项（日期 / 标签等高级条件不跨启动保留） */
  mediaFilter: PhotoFilters['mediaFilter'];
  isLeftPaneOpen: boolean;
  isDetailsPaneOpen: boolean;
}

export function useAppConfig({
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
}: UseAppConfigParams): void {
  // 配置 / AI 缓存落盘失败时统一提示：这类失败在界面上没有任何征兆，
  // 不提示的话用户只会在下次启动时发现「收藏、相簿、标签全没了」
  useEffect(() => {
    setPersistenceErrorHandler(message => showToast(message, 'error'));
    return () => setPersistenceErrorHandler(null);
  }, [showToast]);

  // 照片列表镜像：事件回调里读取最新值，避免把 photos 塞进每个 useCallback 的依赖
  useEffect(() => {
    photosRef.current = photos;
  }, [photos, photosRef]);

  // 启动时读取本地配置，并把已加载的条目对齐到配置（导入可能早于配置读取完成）
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const config = await loadPersistedConfig();
      if (cancelled) return;

      // 配置损坏时主进程已把原文件备份并改为空配置继续启动。
      // 必须让用户知道 —— 否则他只会发现「相册/收藏凭空消失」，既不知道原因，
      // 也不知道磁盘上有一份备份可以捞回来。
      void (async () => {
        const notices = await window.electronAPI?.storageNotices?.();
        if (cancelled || !notices?.ok || notices.data.length === 0) return;
        const first = notices.data[0];
        const more = notices.data.length > 1 ? ` 等 ${notices.data.length} 个文件` : '';
        showToast(
          `配置文件「${first.file}」${more}已损坏，已重置为默认设置；原文件备份在 ${first.backupPath}`,
          'warning'
        );
      })();

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
  }, [aiCacheRef, dateOverridesRef, favoritesRef, hiddenRef, photosRef, refreshSourceAvailability, setAlbums, setDuplicateScope, setDuplicateSimilarity, setIsConfigLoaded, setIsDetailsPaneOpen, setIsLeftPaneOpen, setPhotos, setScale, setSortConfig, setSources, setTheme, setViewMode, showToast, tagsRef, updateFilters]);

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
  }, [setPhotos]);

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
          mediaFilter,
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
    mediaFilter,
    isLeftPaneOpen,
    isDetailsPaneOpen,
  ]);
}
