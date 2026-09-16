/**
 * 目录监听与外部变动同步 Hook（从 App 抽出，对应 N5）。
 *
 * 主进程只做过滤 + 防抖聚合，语义判定全部在这里：
 *   removed → 统一剔除管线；added → statFiles + ingestFiles（天然去重分批）；
 *   addedDirs → 递归扫描后静默导入。
 *
 * 应用自身操作的回环事件走「双保险」过滤：
 *   1) 操作期间事件暂存（pendingWatcherEventsRef），锁释放后合并应用；
 *   2) 操作发起前把涉及路径登记进 touchedPathsRef（TTL 8s），
 *      覆盖「事件在锁释放后才抵达」的窗口。
 */

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { Photo } from '@/types';
import { logger } from '@/lib/logger';
import type { FsErrorReporter } from '@/lib/fs/ipcGuard';
import { ToastAction, type ToastType } from '@/components/common/Toast';

/** 回环登记的有效期：需覆盖塌陷动画（200ms）+ 事件防抖（主进程 500ms/3s）+ 余量 */
const TOUCHED_TTL = 8000;

export interface UseWatcherSyncParams {
  /** 照片列表镜像：removed 事件要对当前列表做前缀匹配 */
  photosRef: RefObject<Photo[]>;
  /** 已导入路径集合：added / addedDirs 的二次去重 */
  importedPathsRef: RefObject<Set<string>>;
  /** 文件操作提交锁：锁内抵达的 watcher 事件暂存，锁释放后合并应用 */
  fileOpLockRef: RefObject<boolean>;
  /** 「文件已消失」统一剔除管线 */
  fsGuard: FsErrorReporter;
  /** 统一入库管线（added / addedDirs 的落点） */
  ingestFiles: (infos: FileInfo[], onProgress?: (done: number, total: number) => void) => Promise<number>;
  showToast: (message: string, type?: ToastType, action?: ToastAction) => void;
}

export interface WatcherSyncResult {
  /** 操作发起前登记涉及的路径（旧 + 新）；undefined 项静默跳过 */
  markPathsTouched: (paths: Array<string | undefined>) => void;
  /** 让主进程监听 dirPath（切换目录时主进程自动替换旧 watcher） */
  watchCurrentDir: (dirPath: string) => Promise<void>;
  /** 停止监听并清空暂存事件（清空列表 / 卸载时调用） */
  unwatchCurrentDir: () => void;
  /** 操作锁释放后调用：把暂存的 watcher 事件按路径并集合并成一条应用（幂等） */
  flushPendingWatcherEvents: () => void;
  /** 当前正在监听的目录（无则 null）：供「移除来源」等场景判定是否需要停听 */
  getWatchedDir: () => string | null;
}

export function useWatcherSync({
  photosRef,
  importedPathsRef,
  fileOpLockRef,
  fsGuard,
  ingestFiles,
  showToast,
}: UseWatcherSyncParams): WatcherSyncResult {
  const watchedDirRef = useRef<string | null>(null);
  /** 路径 → 过期时间戳：TTL 内的 watcher 事件视为应用自身操作的回环 */
  const touchedPathsRef = useRef<Map<string, number>>(new Map());
  /** 操作进行中抵达的 watcher 事件：锁释放后合并应用，避免与半更新状态踩踏 */
  const pendingWatcherEventsRef = useRef<DirectoryChangeEvent[]>([]);

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
      if (result.ok) watchedDirRef.current = dirPath;
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
        const statRes = await window.electronAPI.statFiles(addedPaths);
        if (statRes.ok && statRes.data.infos.length > 0) {
          addedCount = await ingestFiles(statRes.data.infos);
        }
        // failedPaths：分类后到 stat 之间又消失的文件（TOCTOU），忽略即可
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
          if (result.ok && result.data.files.length > 0) {
            addedFromDirs += await ingestFiles(result.data.files);
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
  }, [fsGuard, importedPathsRef, ingestFiles, photosRef, showToast]);

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
  }, [applyWatcherEvent, fileOpLockRef]);

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
  }, [applyWatcherEvent, fileOpLockRef, showToast]);

  /** 当前正在监听的目录（无则 null） */
  const getWatchedDir = useCallback(() => watchedDirRef.current, []);

  // 卸载兜底：停掉主进程 watcher，防止泄漏
  useEffect(() => () => { unwatchCurrentDir(); }, [unwatchCurrentDir]);

  return { markPathsTouched, watchCurrentDir, unwatchCurrentDir, flushPendingWatcherEvents, getWatchedDir };
}
