/**
 * 按路径持久化的图库数据 Hook（从 App 抽出）。
 *
 * 收藏 / 隐藏 / 标签 / 拍摄时间修正 / AI 分析结果 / 已导入路径集合
 * 全部「以磁盘路径为键」：本 Hook 集中持有这些 refs 与读写逻辑，包括
 *   - 重命名 / 移动后的路径迁移（rekeyPathData）与落盘（persistPathData）；
 *   - 文件从磁盘消失后的清理（dropPathData）；
 *   - 标签 / AI 结果的更新入口（handleUpdatePhoto）。
 * 任何一处只改 photo.path 不改键，重启后就会表现为「收藏、标签凭空消失」，
 * 因此迁移与清理必须与键的读写放在一起。
 */

import { useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { AiCacheEntry, PersistedConfig, Photo, PhotoFilters } from '@/types';
import { savePersistedConfig } from '@/lib/persistence/persistence';
import { saveAiCache } from '@/lib/persistence/aiCache';
import { forgetVideoMeta, rekeyVideoMeta, snapshotVideoMeta } from '@/lib/media/videoMeta';
import { ToastAction, type ToastType } from '@/components/common/Toast';

export interface UsePersistedLibraryDataParams {
  setPhotos: Dispatch<SetStateAction<Photo[]>>;
  /** 照片列表镜像：读取最新条目，避免把 photos 塞进每个 useCallback 的依赖 */
  photosRef: RefObject<Photo[]>;
  showToast: (message: string, type?: ToastType, action?: ToastAction) => void;
  /** 「已隐藏」提示里的「查看」按钮需要切到隐藏视图 */
  setFilters: Dispatch<SetStateAction<PhotoFilters>>;
}

export interface PersistedLibraryDataResult {
  /** 收藏项路径 */
  favoritesRef: RefObject<Set<string>>;
  /** 已隐藏项路径 */
  hiddenRef: RefObject<Set<string>>;
  /** 用户标签：路径 → 标签数组 */
  tagsRef: RefObject<Map<string, string[]>>;
  /** 拍摄时间修正：路径 → 毫秒时间戳 */
  dateOverridesRef: RefObject<Map<string, number>>;
  /** AI 分析结果缓存（路径 → 描述 / 标签），持久化在独立的 ai-cache.json */
  aiCacheRef: RefObject<Map<string, AiCacheEntry>>;
  /** 已导入的路径集合：重复打开同一目录时直接跳过，避免重复条目 */
  importedPathsRef: RefObject<Set<string>>;
  /** 只摘 importedPaths 登记、不动收藏 / 标签：文件消失后的重新导入需要这条路径空出来 */
  forgetImportedPaths: (paths: Iterable<string>) => void;
  /** 批量设置收藏并落盘（收藏跨重启保持） */
  setFavorite: (ids: string[], value: boolean) => void;
  toggleFavorite: (id: string) => void;
  /** 批量隐藏 / 取消隐藏：隐藏项默认不出现在任何视图，仅在「已隐藏」中可见 */
  setHidden: (ids: string[], value: boolean) => void;
  /** 路径迁移：file 的磁盘路径变化时迁移全部按路径存储的数据；返回值标记哪些分段发生了变化 */
  rekeyPathData: (from: string, to: string) => { video: boolean; ai: boolean };
  /** 文件从磁盘消失后摘掉残留的按路径数据（避免同名文件回来时继承上一份标记） */
  dropPathData: (paths: Iterable<string>) => { video: boolean; ai: boolean };
  /** 路径迁移 / 清理后落盘：只写真正变化的分段，避免整份配置重写 */
  persistPathData: (changed: { video: boolean; ai: boolean }) => Promise<void>;
  /** 更新照片信息（标签 / AI 结果变更时同步落盘） */
  handleUpdatePhoto: (id: string, data: Partial<Photo>) => void;
}

export function usePersistedLibraryData({
  setPhotos,
  photosRef,
  showToast,
  setFilters,
}: UsePersistedLibraryDataParams): PersistedLibraryDataResult {
  // ---- 持久化数据（以磁盘路径为键）：收藏 / 隐藏 / 标签 / 拍摄时间修正 ----
  const favoritesRef = useRef<Set<string>>(new Set());
  const hiddenRef = useRef<Set<string>>(new Set());
  const tagsRef = useRef<Map<string, string[]>>(new Map());
  const dateOverridesRef = useRef<Map<string, number>>(new Map());
  const aiCacheRef = useRef<Map<string, AiCacheEntry>>(new Map());
  const importedPathsRef = useRef<Set<string>>(new Set());

  const forgetImportedPaths = useCallback((paths: Iterable<string>) => {
    for (const p of paths) importedPathsRef.current.delete(p);
  }, []);

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
  }, [photosRef, setPhotos]);

  const toggleFavorite = useCallback((id: string) => {
    const photo = photosRef.current.find(p => p.id === id);
    if (!photo) return;
    setFavorite([id], !photo.isFavorite);
  }, [photosRef, setFavorite]);

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
  }, [photosRef, setPhotos, setFilters, showToast]);

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
  }, [photosRef, setPhotos]);

  return {
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
  };
}
