/**
 * 按内容指纹持久化的图库数据 Hook（从 App 抽出）。
 *
 * 收藏 / 隐藏 / 标签 / 拍摄时间修正 / AI 结果 / 视频元数据一律以
 * `assetKeyOf(photo)`（内容指纹 fileId）为键，唯一入口见 photoIdentity.ts。
 * 路径不再承载身份：重命名、移动、删除后重新导入都不需要任何迁移逻辑，
 * 标注会随内容自动回到同一张照片上 —— 这正是 v2 数据结构要根治的问题。
 *
 * 唯一仍按路径工作的是 importedPathsRef：它是**会话内去重集合**、不落盘，
 * 所以文件改名 / 移动时仍要跟着改（rekeyImportedPaths）。
 */

import { useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { AiCacheEntry, Photo, PhotoFilters } from '@/types';
import { savePersistedConfig } from '@/lib/persistence/persistence';
import { saveAiCache } from '@/lib/persistence/aiCache';
import { assetKeyOf } from '@/lib/media/photoIdentity';
import { ToastAction, type ToastType } from '@/types/toast';

export interface UsePersistedLibraryDataParams {
  setPhotos: Dispatch<SetStateAction<Photo[]>>;
  /** 照片列表镜像：读取最新条目，避免把 photos 塞进每个 useCallback 的依赖 */
  photosRef: RefObject<Photo[]>;
  showToast: (message: string, type?: ToastType, action?: ToastAction) => void;
  /** 「已隐藏」提示里的「查看」按钮需要切到隐藏视图 */
  setFilters: Dispatch<SetStateAction<PhotoFilters>>;
}

export interface PersistedLibraryDataResult {
  /** 收藏项的内容指纹集合 */
  favoritesRef: RefObject<Set<string>>;
  /** 已隐藏项的内容指纹集合 */
  hiddenRef: RefObject<Set<string>>;
  /** 用户标签：内容指纹 → 标签数组 */
  tagsRef: RefObject<Map<string, string[]>>;
  /** 拍摄时间修正：内容指纹 → 毫秒时间戳 */
  dateOverridesRef: RefObject<Map<string, number>>;
  /** AI 分析结果缓存（内容指纹 → 描述 / 标签），持久化在独立的 ai-cache.json */
  aiCacheRef: RefObject<Map<string, AiCacheEntry>>;
  /** 会话级按路径去重集合（不落盘） */
  importedPathsRef: RefObject<Set<string>>;
  /** 只摘 importedPaths 登记：文件消失后的重新导入需要这条路径空出来 */
  forgetImportedPaths: (paths: Iterable<string>) => void;
  /** 改名 / 移动后同步会话去重集合；持久化标注按内容指纹自动跟随，无需迁移 */
  rekeyImportedPaths: (from: string, to: string) => void;
  /** 批量设置收藏并落盘 */
  setFavorite: (ids: string[], value: boolean) => void;
  toggleFavorite: (id: string) => void;
  /** 批量隐藏 / 取消隐藏 */
  setHidden: (ids: string[], value: boolean) => void;
  /** 更新照片信息（标签 / AI 结果变更时同步落盘） */
  handleUpdatePhoto: (id: string, data: Partial<Photo>) => void;
}

export function usePersistedLibraryData({
  setPhotos,
  photosRef,
  showToast,
  setFilters,
}: UsePersistedLibraryDataParams): PersistedLibraryDataResult {
  // ---- 持久化数据（以内容指纹为键）----
  const favoritesRef = useRef<Set<string>>(new Set());
  const hiddenRef = useRef<Set<string>>(new Set());
  const tagsRef = useRef<Map<string, string[]>>(new Map());
  const dateOverridesRef = useRef<Map<string, number>>(new Map());
  const aiCacheRef = useRef<Map<string, AiCacheEntry>>(new Map());
  const importedPathsRef = useRef<Set<string>>(new Set());

  const forgetImportedPaths = useCallback((paths: Iterable<string>) => {
    for (const p of paths) importedPathsRef.current.delete(p);
  }, []);

  /** 会话去重集合跟随路径变化；标注资产不用动 */
  const rekeyImportedPaths = useCallback((from: string, to: string) => {
    if (!from || !to || from === to) return;
    if (importedPathsRef.current.delete(from)) importedPathsRef.current.add(to);
  }, []);

  const setFavorite = useCallback(
    (ids: string[], value: boolean) => {
      if (ids.length === 0) return;
      const idSet = new Set(ids);
      for (const photo of photosRef.current) {
        if (!idSet.has(photo.id)) continue;
        const key = assetKeyOf(photo);
        if (value) favoritesRef.current.add(key);
        else favoritesRef.current.delete(key);
      }
      setPhotos((prev) => prev.map((p) => (idSet.has(p.id) ? { ...p, isFavorite: value } : p)));
      void savePersistedConfig({ favorites: [...favoritesRef.current] });
    },
    [photosRef, setPhotos]
  );

  const toggleFavorite = useCallback(
    (id: string) => {
      const photo = photosRef.current.find((p) => p.id === id);
      if (!photo) return;
      setFavorite([id], !photo.isFavorite);
    },
    [photosRef, setFavorite]
  );

  const setHidden = useCallback(
    (ids: string[], value: boolean) => {
      if (ids.length === 0) return;
      const idSet = new Set(ids);
      for (const photo of photosRef.current) {
        if (!idSet.has(photo.id)) continue;
        const key = assetKeyOf(photo);
        if (value) hiddenRef.current.add(key);
        else hiddenRef.current.delete(key);
      }
      setPhotos((prev) =>
        prev.map((p) => (idSet.has(p.id) ? { ...p, isHidden: value || undefined } : p))
      );
      void savePersistedConfig({ hidden: [...hiddenRef.current] });

      // 隐藏是唯一「静默消失」的整理动作（收藏有提示、删除有塌陷动画）。
      // 不说明去向的话，用户分不清是被隐藏还是被删除。
      showToast(
        value ? `已隐藏 ${ids.length} 项，可在「已隐藏」中找回` : `已取消隐藏 ${ids.length} 项`,
        'info',
        value
          ? {
              label: '查看',
              onClick: () =>
                setFilters((prev) => ({ ...prev, hiddenOnly: true, favoritesOnly: false })),
            }
          : undefined
      );
    },
    [photosRef, setPhotos, setFilters, showToast]
  );

  const handleUpdatePhoto = useCallback(
    (id: string, data: Partial<Photo>) => {
      setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, ...data } : p)));

      const target = photosRef.current.find((p) => p.id === id);
      if (!target) return;
      const key = assetKeyOf(target);

      if (data.tags !== undefined) {
        if (data.tags.length > 0) tagsRef.current.set(key, data.tags);
        else tagsRef.current.delete(key);
        void savePersistedConfig({ tags: Object.fromEntries(tagsRef.current) });
      }

      // AI 结果存独立的 ai-cache.json：重算代价高但可丢，单独限量
      if (data.aiDescription !== undefined || data.aiTags !== undefined) {
        aiCacheRef.current.set(key, {
          description: data.aiDescription ?? target.aiDescription,
          tags: data.aiTags ?? target.aiTags,
        });
        void saveAiCache(aiCacheRef.current);
      }
    },
    [photosRef, setPhotos]
  );

  return {
    favoritesRef,
    hiddenRef,
    tagsRef,
    dateOverridesRef,
    aiCacheRef,
    importedPathsRef,
    forgetImportedPaths,
    rekeyImportedPaths,
    setFavorite,
    toggleFavorite,
    setHidden,
    handleUpdatePhoto,
  };
}
