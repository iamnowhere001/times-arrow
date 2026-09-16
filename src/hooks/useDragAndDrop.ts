/**
 * 拖放导入 Hook（从 App 抽出）。
 *
 * 一次拖放可能同时包含媒体文件、文件夹与不支持的文件，分流规则：
 *   - 媒体文件（有磁盘路径）→ authorizePaths + stat 补 birthtime → ingestFiles 入库；
 *   - 文件夹 → 复用递归扫描管线（可与文件分支并行，各自计数）；
 *   - 拿不到磁盘路径的文件 → 内存预览降级（blob URL + 渲染进程生成缩略图）。
 *
 * 遮罩的进出场：拖入时先挂载再隔一帧淡入（否则初始态会被跳过），
 * 拖出时先淡出、动画结束才卸载 —— 与卡片塌陷同档时长（EXIT_DURATION）。
 */

import { useCallback, useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { Photo } from '@/types';
import { createThumbnail } from '@/lib/cache/dragThumbnail';
import { humanizeFsError } from '@/lib/fs/fileOperations';
import { EXIT_DURATION } from '@/hooks/useCollapseAnimation';
import { isImageName, isVideoName, mediaKindOf, mediaMimeType } from '@/utils';
import { logger } from '@/lib/logger';
import { ToastAction, type ToastType } from '@/components/common/Toast';

export interface UseDragAndDropParams {
  setPhotos: Dispatch<SetStateAction<Photo[]>>;
  ingestFiles: (infos: FileInfo[], onProgress?: (done: number, total: number) => void) => Promise<number>;
  rememberSources: (incoming: Array<{ path: string; kind: 'directory' | 'file' }>) => void;
  watchCurrentDir: (dirPath: string) => Promise<void>;
  showToast: (message: string, type?: ToastType, action?: ToastAction) => void;
  /** 进行中的扫描 id：拖入的文件夹扫描也要支持取消 */
  activeScanIdRef: RefObject<string | null>;
  cancelRequestedRef: RefObject<boolean>;
  /** 一次拖放可能有多条异步分支：计数归零才收起遮罩 */
  beginDropWork: () => void;
  endDropWork: () => void;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setLoadingProgress: Dispatch<SetStateAction<number>>;
  setLoadingTotal: Dispatch<SetStateAction<number>>;
  setLoadingCurrentFile: Dispatch<SetStateAction<string>>;
  clearLoading: () => void;
}

export interface DragAndDropResult {
  isDraggingFile: boolean;
  /** 拖拽遮罩是否在 DOM 里（决定淡入 / 淡出） */
  isDragOverlayMounted: boolean;
  /** 拖拽遮罩是否处于激活态（淡入后为 true） */
  isDragOverlayActive: boolean;
  handleDragOver: (e: React.DragEvent) => void;
  handleDragLeave: (e: React.DragEvent) => void;
  handleDrop: (e: React.DragEvent) => void;
}

export function useDragAndDrop({
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
}: UseDragAndDropParams): DragAndDropResult {
  const [isDraggingFile, setIsDraggingFile] = useState(false); // Global drag state
  // 拖拽遮罩需要完整的进出场：mounted 决定它是否在 DOM 里，active 决定它是淡入还是淡出
  const [isDragOverlayMounted, setIsDragOverlayMounted] = useState(false);
  const [isDragOverlayActive, setIsDragOverlayActive] = useState(false);

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
          // 拖放不经过系统对话框，主进程无从判断这些路径来自用户主动操作，
          // 因此先显式登记为「本次会话可访问」，否则后续 stat / 缩略图 / pm:// 都会被拒绝。
          if (window.electronAPI) {
            try {
              await window.electronAPI.authorizePaths(resolved.map(item => item.path));
            } catch (authError) {
              logger.error('Failed to authorize dropped paths:', authError);
            }
            // 拖放的 File 对象没有创建时间，补一次 stat 才能拿到 birthtime
            const statRes = await window.electronAPI.statFiles(resolved.map(r => r.path));
            if (statRes.ok) {
              const stat = statRes.data;
              const byPath = new Map(stat.infos.map(info => [info.path, info]));
              resolved.forEach(item => {
                const info = byPath.get(item.path);
                if (!info) return;
                item.size = info.size;
                item.mtime = info.mtime;
                item.created = info.created;
              });
              statFailedCount = stat.failedPaths.length;
            } else {
              // stat 整体失败：拖放自带的 size/mtime 仍可用，仅缺创建时间，不阻塞导入
              logger.warn('拖放文件 stat 失败:', statRes.error);
              statFailedCount = resolved.length;
            }
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
              const scanRes = await window.electronAPI.scanDirectory(dirPath, scanId);
              if (activeScanIdRef.current !== scanId) return; // 已被取消
              if (!scanRes.ok) {
                showToast(`无法读取文件夹「${dir.name}」：${humanizeFsError(scanRes.error)}`, 'error');
                continue;
              }
              const infos = scanRes.data.files;
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
              const failedCount = (scanRes.data.failedDirs ?? 0) + (scanRes.data.failedFiles ?? 0);
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
  }, [activeScanIdRef, beginDropWork, cancelRequestedRef, clearLoading, endDropWork, ingestFiles, rememberSources, setLoading, setLoadingCurrentFile, setLoadingProgress, setLoadingTotal, setPhotos, showToast, watchCurrentDir]);

  return {
    isDraggingFile,
    isDragOverlayMounted,
    isDragOverlayActive,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}
