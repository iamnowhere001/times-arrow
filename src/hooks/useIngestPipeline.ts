/**
 * 导入管线 Hook（从 App 抽出）。
 *
 * 负责「把文件登记进图库」的完整链路：
 *   - loading 浮层的状态与延迟显示（小文件夹扫描一瞬间完成，延迟 350ms 出现避免闪一下）；
 *   - 取消链路（主进程 scanId + 渲染层 AbortController 双通道，随时可中断）；
 *   - ingestFiles 统一入库管线（按路径去重、分批提交、进度回调、可取消）；
 *   - 元数据（尺寸 / EXIF / 拍摄时间）批量补齐（节流合并提交，避免大库反复重排）。
 *
 * 目录扫描、来源记录、恢复图库等「编排」逻辑不在这里，见 hooks/useLibraryImport。
 */

import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { AiCacheEntry, Photo } from '@/types';
import { mapWithConcurrency, mediaKindOf, mediaMimeType, pmFileUrl } from '@/utils';
import { getVideoMeta } from '@/lib/media/videoMeta';
import { ToastAction, type ToastType } from '@/components/common/Toast';

export interface UseIngestPipelineParams {
  setPhotos: Dispatch<SetStateAction<Photo[]>>;
  showToast: (message: string, type?: ToastType, action?: ToastAction) => void;
  /** 拍摄时间修正：入库与元数据补齐时优先于 EXIF */
  dateOverridesRef: RefObject<Map<string, number>>;
  favoritesRef: RefObject<Set<string>>;
  hiddenRef: RefObject<Set<string>>;
  tagsRef: RefObject<Map<string, string[]>>;
  aiCacheRef: RefObject<Map<string, AiCacheEntry>>;
  /** 已导入路径集合：入库去重的依据 */
  importedPathsRef: RefObject<Set<string>>;
}

export interface IngestPipelineResult {
  loading: boolean;
  loadingProgress: number;
  loadingTotal: number;
  loadingCurrentFile: string;
  /** 遮罩承载的操作类型：只影响取消按钮与取消提示的文案（导入 / 恢复上次的图库） */
  loadingKind: 'import' | 'restore';
  /** 立即显示遮罩（拖拽降级路径直接置位，不走延迟） */
  setLoading: Dispatch<SetStateAction<boolean>>;
  setLoadingProgress: Dispatch<SetStateAction<number>>;
  setLoadingTotal: Dispatch<SetStateAction<number>>;
  setLoadingCurrentFile: Dispatch<SetStateAction<string>>;
  setLoadingKind: Dispatch<SetStateAction<'import' | 'restore'>>;
  /** 进行中的目录扫描 id（主进程侧取消用） */
  activeScanIdRef: RefObject<string | null>;
  /** 用户是否请求取消：分批入库在各批边界据此停下 */
  cancelRequestedRef: RefObject<boolean>;
  /** 延迟显示 loading 遮罩（避免小文件夹「闪一下」） */
  showLoadingSoon: () => void;
  /** 取消尚未显示的 loading 定时器 */
  cancelShowLoading: () => void;
  clearLoading: () => void;
  /** 一次拖放可能同时走「文件」与「文件夹」两条异步分支：计数归零才收起遮罩 */
  beginDropWork: () => void;
  endDropWork: () => void;
  /** 中断进行中的「扫描 + 入库」：主进程停止扫描，渲染进程停止分批提交 */
  handleCancelLoading: () => void;
  /** 元数据（尺寸 / EXIF / 拍摄时间）批量补齐：主进程一次读取，渲染层按批合并成一次 setState */
  loadMetadata: (targets: Photo[]) => Promise<void>;
  /** 统一导入管线：只登记「磁盘路径 + pm:// 原图地址」，返回真正加入列表的条目数 */
  ingestFiles: (infos: FileInfo[], onProgress?: (done: number, total: number) => void) => Promise<number>;
}

export function useIngestPipeline({
  setPhotos,
  showToast,
  dateOverridesRef,
  favoritesRef,
  hiddenRef,
  tagsRef,
  aiCacheRef,
  importedPathsRef,
}: UseIngestPipelineParams): IngestPipelineResult {
  // Loading state for large file operations
  const [loading, setLoading] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [loadingTotal, setLoadingTotal] = useState(0);
  const [loadingCurrentFile, setLoadingCurrentFile] = useState('');
  /** 遮罩承载的操作类型：只影响取消按钮与取消提示的文案（导入 / 恢复上次的图库） */
  const [loadingKind, setLoadingKind] = useState<'import' | 'restore'>('import');

  // 导入取消：目录扫描（主进程 scanId）与分批入库（AbortController）都可中断
  const activeScanIdRef = useRef<string | null>(null);
  const importAbortRef = useRef<AbortController | null>(null);
  const cancelRequestedRef = useRef(false);

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
        const metaRes = await window.electronAPI.getMetadata(photo.path);
        // 拿不到元数据（未授权 / 已删除 / 解码失败）只是少了几项信息，不打断整批导入
        if (!metaRes.ok) return;
        const meta = metaRes.data;
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
  }, [dateOverridesRef, setPhotos]);

  // 统一导入管线：
  // 只向主进程索取「磁盘缩略图 + pm:// 原图地址」，不再把整张图片以 base64 读进内存
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
  }, [aiCacheRef, dateOverridesRef, favoritesRef, hiddenRef, importedPathsRef, loadMetadata, setPhotos, tagsRef]);

  return {
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
  };
}
