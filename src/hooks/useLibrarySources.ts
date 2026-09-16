/**
 * 常驻来源 Hook（从 App 抽出，对应 N8）。
 *
 * 「打开文件夹 / 添加文件」被记为常驻来源，重启后据此重建图库。
 * 记录时机统一放在「导入成功之后」——失败或取消不写，
 * 因此来源列表恒等于「真正整理过的内容」，恢复时不会再撞空。
 *
 * 移除来源只摘记录：磁盘文件与收藏 / 标签 / 时间修正全部保留，
 * 但当前列表里属于该来源的条目要一并移出（否则会留下「来源已移除、
 * 照片还在列表里、下次启动却不会恢复」的悬空状态）。
 */

import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { LibrarySource, Photo } from '@/types';
import { logger } from '@/lib/logger';
import { savePersistedConfig } from '@/lib/persistence/persistence';
import { basenameOfPath, upsertSources } from '@/lib/persistence/sources';
import { ToastAction, type ToastType } from '@/components/common/Toast';

export interface UseLibrarySourcesParams {
  /** 照片列表镜像：移除来源时要移出属于该来源的条目 */
  photosRef: RefObject<Photo[]>;
  /** 配置是否已读取完成：完成前不弹「恢复上次的图库」询问 */
  isConfigLoaded: boolean;
  /** 摘除已导入路径登记（不动收藏 / 标签） */
  forgetImportedPaths: (paths: Iterable<string>) => void;
  removeWithCollapse: (ids: Set<string>) => void;
  removeIdsFromSelection: (ids: Set<string>) => void;
  pruneDuplicateGroups: (ids: Set<string>) => void;
  /** 正在监听的目录属于被移除来源时，停止监听 */
  unwatchCurrentDir: () => void;
  /** 读取当前正在监听的目录（无则 null），用于判定是否需要停听 */
  getWatchedDir: () => string | null;
  showToast: (message: string, type?: ToastType, action?: ToastAction) => void;
}

export interface LibrarySourcesResult {
  sources: LibrarySource[];
  sourcesRef: RefObject<LibrarySource[]>;
  setSources: Dispatch<SetStateAction<LibrarySource[]>>;
  /** 运行时判定为不可用的来源路径（不存在 / 卷未挂载）；不落盘，每次启动重探 */
  unavailableSourcePaths: Set<string>;
  setUnavailableSourcePaths: Dispatch<SetStateAction<Set<string>>>;
  /** 「恢复上次的图库」确认框：每个会话只问一次 */
  isRestorePromptOpen: boolean;
  setIsRestorePromptOpen: Dispatch<SetStateAction<boolean>>;
  /** 把一批来源写进配置（按路径去重、刷新使用时间），并同步清掉它们的不可用标记 */
  rememberSources: (incoming: Array<Pick<LibrarySource, 'path' | 'kind'>>) => void;
  /** 探测来源是否仍存在（目录被挪走 / 卷未挂载 → 侧栏单独标注「不可用」） */
  refreshSourceAvailability: (list: LibrarySource[]) => Promise<void>;
  /** 移除来源：只摘记录、不动磁盘；列表中的相关条目一并移出 */
  removeSources: (removed: LibrarySource[]) => void;
}

export function useLibrarySources({
  photosRef,
  isConfigLoaded,
  forgetImportedPaths,
  removeWithCollapse,
  removeIdsFromSelection,
  pruneDuplicateGroups,
  unwatchCurrentDir,
  getWatchedDir,
  showToast,
}: UseLibrarySourcesParams): LibrarySourcesResult {
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
      if (!result.ok) {
        logger.warn('来源可用性检查失败:', result.error);
        return;
      }
      const availability = result.data;
      setUnavailableSourcePaths(
        new Set(list.filter(source => availability[source.path] === false).map(source => source.path))
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
    const watched = getWatchedDir();
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
  }, [forgetImportedPaths, getWatchedDir, photosRef, pruneDuplicateGroups, removeIdsFromSelection, removeWithCollapse, showToast, unwatchCurrentDir]);

  // 启动时若存在常驻来源：询问是否恢复上次的图库（每个会话只问一次）
  useEffect(() => {
    if (!isConfigLoaded || restorePromptShownRef.current) return;
    if (photosRef.current.length > 0) return;
    if (sources.length === 0) return;
    restorePromptShownRef.current = true;
    setIsRestorePromptOpen(true);
  }, [isConfigLoaded, photosRef, sources]);

  return {
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
  };
}
