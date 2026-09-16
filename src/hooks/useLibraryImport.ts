/**
 * 高层导入编排 Hook（从 App 抽出）。
 *
 * 把「用户发起的导入」统一收口到一条链路：对话框 / 拖放 / 菜单 / 点击来源
 * 最终都落到 loadDirectory（递归扫描）或 importFilePaths（按路径 stat + 入库），
 * 两者共用 useIngestPipeline 的入库管线与取消链路。
 *
 * 同时承载「恢复上次的图库」（按来源逐项重扫 / 补 stat）与来源交互
 * （点来源 = 重新扫描 / 补进列表；不可用时给出说明与移除入口）。
 */

import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { LibrarySource } from '@/types';
import { logger } from '@/lib/logger';
import { humanizeFsError } from '@/lib/fs/fileOperations';
import { basenameOfPath } from '@/lib/persistence/sources';
import { ToastAction, type ToastType } from '@/components/common/Toast';

export interface UseLibraryImportParams {
  // ---- 低层导入管线（useIngestPipeline）----
  ingestFiles: (infos: FileInfo[], onProgress?: (done: number, total: number) => void) => Promise<number>;
  activeScanIdRef: RefObject<string | null>;
  cancelRequestedRef: RefObject<boolean>;
  showLoadingSoon: () => void;
  cancelShowLoading: () => void;
  clearLoading: () => void;
  setLoadingTotal: Dispatch<SetStateAction<number>>;
  setLoadingProgress: Dispatch<SetStateAction<number>>;
  setLoadingCurrentFile: Dispatch<SetStateAction<string>>;
  setLoadingKind: Dispatch<SetStateAction<'import' | 'restore'>>;
  beginDropWork: () => void;
  endDropWork: () => void;
  // ---- 来源（useLibrarySources）----
  sourcesRef: RefObject<LibrarySource[]>;
  unavailableSourcePaths: Set<string>;
  rememberSources: (incoming: Array<Pick<LibrarySource, 'path' | 'kind'>>) => void;
  removeSources: (removed: LibrarySource[]) => void;
  refreshSourceAvailability: (list: LibrarySource[]) => Promise<void>;
  // ---- 目录监听（useWatcherSync）----
  watchCurrentDir: (dirPath: string) => Promise<void>;
  showToast: (message: string, type?: ToastType, action?: ToastAction) => void;
}

export interface LibraryImportResult {
  /** 打开目录：主进程递归扫描（可取消）→ 统一导入管线（同样可取消） */
  loadDirectory: (dirPath: string) => Promise<void>;
  /** 恢复上次的图库（N8）：按来源逐项重扫 / 补 stat，走统一导入管线 */
  restoreLibrary: (targets: LibrarySource[]) => Promise<void>;
  /** 按文件路径导入：stat 补齐元数据后走统一入库管线 */
  importFilePaths: (files: string[], ignored: number) => Promise<void>;
  /** 统一导入：一个对话框可同时多选图片 / 视频文件与文件夹（可混合） */
  importPickedPaths: (picked: PickedPaths) => Promise<void>;
  /** 工具栏 / 空状态 / 右键菜单统一入口 */
  handleImport: () => Promise<void>;
  // ---- 来源交互 ----
  /** 点单个来源：不可用时给出说明与「移除来源」入口，可用时走原导入管线 */
  handleSelectSource: (source: LibrarySource) => void;
  handleSelectDirectorySource: (path: string) => void;
  handleRemoveDirectorySource: (path: string) => void;
  handleSelectFileSources: () => void;
  handleRemoveFileSources: () => void;
}

export function useLibraryImport({
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
}: UseLibraryImportParams): LibraryImportResult {
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
      const scanRes = await window.electronAPI.scanDirectory(dirPath, scanId);

      // 被取消：丢弃扫描结果，不写入列表
      if (activeScanIdRef.current !== scanId || cancelRequestedRef.current) return;

      // 根目录级错误（不存在 / 无权限 / 不是文件夹）：与「空目录」明确区分
      if (!scanRes.ok) {
        logger.error('Scan directory failed:', scanRes.error);
        showToast(`无法读取目录「${dirName}」：${humanizeFsError(scanRes.error)}`, 'error', {
          label: '重试',
          onClick: () => { void loadDirectory(dirPath); },
        });
        return;
      }

      const scan = scanRes.data;
      if (scan.cancelled) return;

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
  }, [activeScanIdRef, cancelRequestedRef, cancelShowLoading, clearLoading, ingestFiles, rememberSources, setLoadingCurrentFile, setLoadingProgress, setLoadingTotal, showLoadingSoon, showToast, watchCurrentDir]);

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
          const scanRes = await api.scanDirectory(source.path, scanId);
          if (activeScanIdRef.current !== scanId || cancelRequestedRef.current) break;
          if (!scanRes.ok) {
            // 目录不存在 / 卷未挂载：标注不可用，但来源本身保留
            logger.warn(`恢复来源失败「${source.path}」:`, scanRes.error);
            failedPaths.add(source.path);
            continue;
          }
          const scan = scanRes.data;
          if (scan.cancelled) break;
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
          const statRes = await api.statFiles(paths);
          if (!statRes.ok) {
            logger.warn('恢复单独添加的文件失败:', statRes.error);
            paths.forEach(path => failedPaths.add(path));
          } else {
            const stat = statRes.data;
            stat.failedPaths.forEach(path => failedPaths.add(path));
            if (!cancelRequestedRef.current && stat.infos.length > 0) {
              setLoadingTotal(stat.infos.length);
              addedTotal += await ingestFiles(stat.infos, (done, total) => {
                if (total > 0) setLoadingProgress(Math.min(done, total));
              });
            }
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
  }, [activeScanIdRef, cancelRequestedRef, cancelShowLoading, clearLoading, ingestFiles, refreshSourceAvailability, setLoadingCurrentFile, setLoadingKind, setLoadingProgress, setLoadingTotal, showLoadingSoon, showToast, sourcesRef, watchCurrentDir]);

  /**
   * 按文件路径导入：stat 补齐元数据后走统一入库管线。
   * K1：stat 失败的路径显式回传（failedPaths），不再静默过滤成空结果；
   * 部分失败时单独给一条可重试提示 —— 重试只对 failedPaths 再 stat + 入库，天然只补漏。
   */
  const importFilePaths = useCallback(async (files: string[], ignored: number) => {
    if (!window.electronAPI || files.length === 0) return;
    beginDropWork();
    try {
      const statRes = await window.electronAPI.statFiles(files);
      // 整体性失败（IPC 层就没成功）：带原因与重试，与「部分失败」区分开
      if (!statRes.ok) {
        showToast(`无法读取所选文件：${humanizeFsError(statRes.error)}`, 'error', {
          label: '重试',
          onClick: () => { void importFilePaths(files, ignored); },
        });
        return;
      }
      const stat = statRes.data;
      const infos = stat.infos;
      setLoadingTotal(infos.length);
      const added = await ingestFiles(infos, (done, total) => {
        if (total > 0) setLoadingProgress(Math.min(done, total));
      });

      // 一个都没读到：整体性错误（K1 不再冒充「空」），带原因与重试
      if (infos.length === 0) {
        showToast('无法读取所选文件，可能已被移动或删除', 'error', {
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
  }, [beginDropWork, endDropWork, ingestFiles, rememberSources, setLoadingProgress, setLoadingTotal, showToast]);

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
  }, [cancelRequestedRef, importFilePaths, loadDirectory, showToast]);

  /** 工具栏 / 空状态 / 右键菜单统一入口 */
  const handleImport = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      const pickedRes = await window.electronAPI.selectPaths();
      // 用户在对话框里点了取消：ok(true) + data=null，不是错误，静默返回
      if (!pickedRes.ok) {
        showToast(`导入失败：${pickedRes.error}`, 'error');
        return;
      }
      const picked = pickedRes.data;
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
  }, [cancelRequestedRef, importFilePaths, loadDirectory, removeSources, showToast, unavailableSourcePaths]);

  const handleSelectDirectorySource = useCallback((path: string) => {
    const source = sourcesRef.current.find(item => item.path === path);
    if (source) handleSelectSource(source);
  }, [handleSelectSource, sourcesRef]);

  const handleRemoveDirectorySource = useCallback((path: string) => {
    removeSources(sourcesRef.current.filter(item => item.path === path));
  }, [removeSources, sourcesRef]);

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
  }, [cancelRequestedRef, importFilePaths, removeSources, showToast, sourcesRef, unavailableSourcePaths]);

  const handleRemoveFileSources = useCallback(() => {
    removeSources(sourcesRef.current.filter(item => item.kind === 'file'));
  }, [removeSources, sourcesRef]);

  return {
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
  };
}
