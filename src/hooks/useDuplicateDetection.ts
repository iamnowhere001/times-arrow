/**
 * 重复检测 Hook（从 App 抽出）。
 *
 * 负责重复检测整页的全部领域状态与流程：参数（相似度 / 范围）及其持久化、
 * 检测管线调用与进度、取消 / 退出、检测结果中手动删除后的收敛。
 *
 * 与图库的交叉点（塌陷移除、选中集收敛、卡片动画计时器、主视图切换）
 * 全部通过参数注入，Hook 本身不直接持有这些状态。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { DuplicateScope, Photo, type IgnoredDuplicateGroup } from '@/types';
import {
  findDuplicatePhotos,
  isDuplicateScanAbort,
  isVideoPhoto,
  markRecommended,
  type DuplicateScanProgress,
} from '@/utils';
import { DUPLICATE_SIMILARITY_DEFAULT, similarityToDistance } from '@/lib/duplicate/constants';
import { releaseMemory } from '@/lib/cache/cacheManager';
import { loadPersistedConfig, savePersistedConfig } from '@/lib/persistence/persistence';
import {
  buildScanReport,
  filterIgnoredGroups,
  groupIdentityKey,
  normalizeIgnoredGroups,
  recordIgnoredGroup,
  removeIgnoredGroup,
  type DuplicateScanReport,
} from '@/lib/duplicate/ignoredGroups';
import { logger } from '@/lib/logger';
import { movePhotosToTrash } from '@/lib/fs/fileOperations';
import { ToastAction, type ToastType } from '@/types/toast';

export interface UseDuplicateDetectionParams {
  photos: Photo[];
  /** 主图库当前选中项：scope='selected' 时只检测这些照片 */
  selectedIds: Set<string>;
  showToast: (message: string, type?: ToastType, action?: ToastAction) => void;
  /** 配置是否已读取完成：完成前不写检测参数偏好 */
  isConfigLoaded: boolean;
  /** 重复检测页是否在前台（来自 mainView） */
  isDuplicateDetectorOpen: boolean;
  /** 切到重复检测整页 */
  onEnterDuplicates: () => void;
  /** 切回图库 */
  onExitDuplicates: () => void;
  /** 删除后的塌陷移除（与图库共用同一套计时器） */
  removeWithCollapse: (ids: Set<string>) => void;
  /** 从当前选中集中移除指定 id（保留其它选中项） */
  removeIdsFromSelection: (ids: Set<string>) => void;
  /** 延时到卡片塌陷动画结束后执行（复用 App 的 exitTimersRef，卸载时统一清理） */
  scheduleAfterExit: (callback: () => void) => void;
  /** 成功 Toast 的「撤销」按钮；批量场景由调用方传 label 说明只撤 1 项 */
  makeUndoAction: (label?: string) => ToastAction;
}

export interface DuplicateDetectionResult {
  duplicateGroups: Photo[][];
  isProcessingDuplicates: boolean;
  /** 仅按新参数重新分组中（指纹已缓存）：保留结果列表，只显示细进度 */
  isRepartitioningDuplicates: boolean;
  duplicateProgress: DuplicateScanProgress | null;
  duplicateSimilarity: number;
  setDuplicateSimilarity: Dispatch<SetStateAction<number>>;
  duplicateScope: DuplicateScope;
  setDuplicateScope: Dispatch<SetStateAction<DuplicateScope>>;
  /**
   * 启动检测；支持传入阈值 / 范围覆盖（参数变化时自动重跑）。
   * mode='repartition' 表示已有结果、指纹可复用，保留结果列表做轻量重分组。
   */
  handleCheckDuplicates: (
    override?: { similarity?: number; scope?: DuplicateScope },
    mode?: 'full' | 'repartition'
  ) => Promise<void>;
  handleCancelDuplicates: () => void;
  handleExitDuplicates: () => void;
  handleDeleteDuplicates: (photosToDelete: Photo[]) => Promise<void>;
  /** 图库侧删除后，同步收敛检测结果（供通用删除流程复用） */
  pruneDuplicateGroups: (ids: Set<string>) => void;
  /** 用户标记为「不是重复」的组（按内容指纹持久化） */
  ignoredGroups: IgnoredDuplicateGroup[];
  /** 忽略当前组；缺少稳定身份时给出明确说明而不是静默当成功 */
  handleIgnoreGroup: (group: Photo[]) => void;
  /** 取消忽略并自动重新分组，让这一组回到列表 */
  handleRestoreIgnoredGroup: (key: string) => void;
  /** 本次检测报告：扫描 / 成组 / 可释放 / 已删除，数字全部由同一份结果算出 */
  scanReport: DuplicateScanReport;
  /** 当前图库选中数量，供「只检测选中项」控件展示 */
  selectedCount: number;
}

export function useDuplicateDetection(
  params: UseDuplicateDetectionParams
): DuplicateDetectionResult {
  const {
    photos,
    selectedIds,
    showToast,
    isConfigLoaded,
    isDuplicateDetectorOpen,
    onEnterDuplicates,
    onExitDuplicates,
    removeWithCollapse,
    removeIdsFromSelection,
    scheduleAfterExit,
    makeUndoAction,
  } = params;

  const [duplicateGroups, setDuplicateGroups] = useState<Photo[][]>([]);
  const [isProcessingDuplicates, setIsProcessingDuplicates] = useState(false);
  /**
   * K22：仅「按新参数重新分组」的轻量重算（指纹已缓存）。
   * 与首次全量扫描分开：此时不摘掉已有结果，只叠一条细进度，
   * 用户才能连续拖动阈值微调，而不是每动一下就整页闪回进度视图。
   */
  const [isRepartitioningDuplicates, setIsRepartitioningDuplicates] = useState(false);
  const [duplicateProgress, setDuplicateProgress] = useState<DuplicateScanProgress | null>(null);
  /** 供回调读取最新的分组结果（判断是否值得走「保留结果的重新分组」），避免把分组塞进依赖 */
  const duplicateGroupsRef = useRef<Photo[][]>([]);
  duplicateGroupsRef.current = duplicateGroups;
  // 可调检测参数：相似度阈值（百分比 80–100）与比对范围
  const [duplicateSimilarity, setDuplicateSimilarity] = useState(DUPLICATE_SIMILARITY_DEFAULT);
  const [duplicateScope, setDuplicateScope] = useState<DuplicateScope>('all');
  /** 最近一次实际生效的检测参数：用于判断参数变化后是否需要自动重跑 */
  const lastDuplicateOptionsRef = useRef<{ similarity: number; scope: DuplicateScope } | null>(
    null
  );
  const duplicateRecheckTimerRef = useRef<number | null>(null);
  /** 进行中的重复检测：取消时 abort，检测管线会在下一个分片边界停下并释放 */
  const duplicateAbortRef = useRef<AbortController | null>(null);

  // 选中集用 ref 镜像：App 每次渲染可能给出新的 Set，直接放进检测回调的依赖
  // 会让回调频繁重建，进而抖动「参数变化自动重分组」的防抖 effect。
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;

  // 忽略集存 config 顶层字段、由本 hook 自己读写：duplicate 偏好每次调阈值都被整体替换，
  // 挤进去会被无声抹掉（TODO「现实约束」第 6 条）。
  const [ignoredGroups, setIgnoredGroups] = useState<IgnoredDuplicateGroup[]>([]);
  const ignoredGroupsRef = useRef<IgnoredDuplicateGroup[]>([]);
  ignoredGroupsRef.current = ignoredGroups;

  /** 本轮检测的固定数字；组数含被忽略的组，可见组数由当前列表实时决定 */
  const scanSummaryRef = useRef({ scanned: 0, groupsFound: 0 });
  const [deletedStats, setDeletedStats] = useState({ count: 0, bytes: 0 });

  // 重复检测参数变更 → 延迟写盘（拖动阈值滑块时同样会连续触发）
  const duplicatePrefsTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!isConfigLoaded) return;

    if (duplicatePrefsTimerRef.current !== null)
      window.clearTimeout(duplicatePrefsTimerRef.current);
    duplicatePrefsTimerRef.current = window.setTimeout(() => {
      duplicatePrefsTimerRef.current = null;
      void savePersistedConfig({
        duplicate: { similarity: duplicateSimilarity, scope: duplicateScope },
      });
    }, 600);

    return () => {
      if (duplicatePrefsTimerRef.current !== null) {
        window.clearTimeout(duplicatePrefsTimerRef.current);
        duplicatePrefsTimerRef.current = null;
      }
    };
  }, [isConfigLoaded, duplicateSimilarity, duplicateScope]);

  // 启动时读一次忽略集。等 isConfigLoaded 是因为配置读取完成前可能拿到空对象，
  // 此时若发生写回，会用空集覆盖掉已存记录。
  useEffect(() => {
    if (!isConfigLoaded) return;
    let cancelled = false;
    void loadPersistedConfig().then((config) => {
      if (cancelled) return;
      const restored = normalizeIgnoredGroups(config.ignoredDuplicateGroups);
      ignoredGroupsRef.current = restored;
      setIgnoredGroups(restored);
    });
    return () => {
      cancelled = true;
    };
  }, [isConfigLoaded]);

  /** 同步更新 state 与 ref：紧接着的重分组必须读到新忽略集，不能等下一次渲染 */
  const applyIgnoredGroups = useCallback((next: IgnoredDuplicateGroup[]) => {
    ignoredGroupsRef.current = next;
    setIgnoredGroups(next);
    // saveConfig 是顶层字段合并写，不会覆盖其它模块写入的偏好
    void savePersistedConfig({ ignoredDuplicateGroups: next });
  }, []);

  /** 报告只在这里算一次：组件不再各自统计，避免顶栏与报告数字对不上 */
  const scanReport = useMemo(
    () =>
      buildScanReport({
        scanned: scanSummaryRef.current.scanned,
        groupsFound: scanSummaryRef.current.groupsFound,
        ignoredGroups: ignoredGroups.length,
        groups: duplicateGroups,
        deletedCount: deletedStats.count,
        deletedBytes: deletedStats.bytes,
      }),
    [duplicateGroups, deletedStats, ignoredGroups]
  );

  // 检测：支持传入阈值 / 范围覆盖（参数变化时自动重跑）
  const handleCheckDuplicates = useCallback(
    async (
      override?: { similarity?: number; scope?: DuplicateScope },
      mode: 'full' | 'repartition' = 'full'
    ) => {
      const runSimilarity = override?.similarity ?? duplicateSimilarity;
      const runScope = override?.scope ?? duplicateScope;

      // 「只检测选中项」与另外两种范围共用同一个控件：先收敛到选中集，再排除视频 / 隐藏项。
      // 不足 2 张时明确说明，不切页、也不把空结果说成「没有相似项」。
      const scopePhotos =
        runScope === 'selected' ? photos.filter((p) => selectedIdsRef.current.has(p.id)) : photos;
      // 视频逐帧比对既慢又无意义；隐藏是跨视图语义，不该因为进了检测页就重新可见（还能被删掉）
      const imagePhotos = scopePhotos.filter((p) => !isVideoPhoto(p) && !p.isHidden);
      if (imagePhotos.length < 2) {
        showToast(
          runScope === 'selected'
            ? '只检测选中项时，请先在图库中至少选中 2 张图片'
            : photos.length > 0
              ? '相似检测至少需要 2 张图片'
              : '没有照片可检查相似项',
          'info'
        );
        return;
      }

      // 上一轮还在跑就先取消：两轮重叠会同时占用 CPU 与内存，是列表卡顿的主要来源
      duplicateAbortRef.current?.abort();
      const controller = new AbortController();
      duplicateAbortRef.current = controller;

      // 检测是整页流程：先把主内容区切到重复检测页，再开始扫描
      onEnterDuplicates();

      // 已有结果 + 明确要求重分组 → 走轻量路径：保留列表，只叠一条细进度。
      // 没有结果可保留时（首次扫描 / 上次无结果）仍按全量处理。
      const isRepartition = mode === 'repartition' && duplicateGroupsRef.current.length > 0;
      setIsProcessingDuplicates(!isRepartition);
      setIsRepartitioningDuplicates(isRepartition);
      if (!isRepartition) setDuplicateGroups([]);
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
          {
            threshold: similarityToDistance(runSimilarity),
            sameFolderOnly: runScope === 'sameFolder',
            signal: controller.signal,
          },
          setDuplicateProgress
        );
        const { visible, ignoredCount } = filterIgnoredGroups(
          detectedDuplicates,
          ignoredGroupsRef.current
        );
        scanSummaryRef.current = {
          scanned: imagePhotos.length,
          groupsFound: detectedDuplicates.length,
        };
        setDuplicateGroups(visible);

        if (visible.length > 0) {
          const hiddenNote = ignoredCount > 0 ? `（另 ${ignoredCount} 组已标记不是重复）` : '';
          showToast(`找到 ${visible.length} 组相似照片${hiddenNote}`, 'info');
        } else if (ignoredCount > 0) {
          showToast(`找到 ${ignoredCount} 组，均已标记为不是重复`, 'info');
        } else {
          showToast('未找到相似照片', 'success');
        }
      } catch (error) {
        // 取消是用户主动行为而非故障：静默收尾，不弹错误
        if (isDuplicateScanAbort(error)) {
          // 重新分组被新一轮取代时不能清空：旧结果还要继续撑着界面
          if (!isRepartition) {
            setDuplicateGroups([]);
            scanSummaryRef.current = { scanned: 0, groupsFound: 0 };
          }
          return;
        }
        logger.error('Error detecting duplicates:', error);
        showToast('检测相似照片失败', 'error');
      } finally {
        // 无论成功 / 取消 / 失败，本轮使用的参数都要记下来。
        // 否则取消后「参数与上次不同」的条件一直成立，自动重跑 effect 会把用户的取消吞掉，
        // 表现为：点了取消，进度条消失几百毫秒后又自己跑起来。
        lastDuplicateOptionsRef.current = { similarity: runSimilarity, scope: runScope };
        // 被新一轮接管时不要收尾：那一轮的进度条刚立起来，标成 done 会让它看起来瞬间完成
        const supersededByNewRun =
          duplicateAbortRef.current !== null && duplicateAbortRef.current !== controller;
        if (!supersededByNewRun) {
          setDuplicateProgress((prev) =>
            prev ? { ...prev, processed: prev.total, etaMs: undefined, phase: 'done' } : prev
          );
        }
        if (duplicateAbortRef.current === controller) duplicateAbortRef.current = null;
        setIsProcessingDuplicates(false);
        setIsRepartitioningDuplicates(false);
        // 检测结束（或取消）后回收易失缓存，把峰值内存还回去
        releaseMemory('soft', 'duplicate-scan-done');
      }
    },
    [photos, duplicateSimilarity, duplicateScope, showToast, onEnterDuplicates]
  );

  /** 取消进行中的重复检测 */
  const handleCancelDuplicates = useCallback(() => {
    if (!duplicateAbortRef.current) return;
    duplicateAbortRef.current.abort();
    duplicateAbortRef.current = null;
    // 把进度收回「尚未检测」：组件用 progress !== null 判断「跑过一轮」，
    // 留着它会把用户主动取消显示成「未检测到相似图片」—— 那是另一回事。
    setDuplicateProgress(null);
    showToast('已取消重复检测', 'info');
  }, [showToast]);

  /** 离开重复检测页：先取消，避免任务在后台继续跑导致图库卡顿 */
  const handleExitDuplicates = useCallback(() => {
    handleCancelDuplicates();
    onExitDuplicates();
  }, [handleCancelDuplicates, onExitDuplicates]);

  // 卸载时中断仍在跑的检测，防止任务残留在后台
  useEffect(() => () => duplicateAbortRef.current?.abort(), []);

  // 阈值 / 范围调整后自动重新分组（防抖 300ms，避免拖动滑块时反复触发）。
  // 走 repartition 模式：指纹已有缓存，只按新参数重新分组，结果列表不闪走。
  // 已有一次重分组在跑时不叠加，等它结束后依赖变化会再排一次。
  useEffect(() => {
    if (!isDuplicateDetectorOpen || isProcessingDuplicates || isRepartitioningDuplicates) return;
    const last = lastDuplicateOptionsRef.current;
    if (!last) return; // 尚未检测过：等用户主动触发
    if (last.similarity === duplicateSimilarity && last.scope === duplicateScope) return;

    if (duplicateRecheckTimerRef.current !== null) {
      window.clearTimeout(duplicateRecheckTimerRef.current);
    }
    duplicateRecheckTimerRef.current = window.setTimeout(() => {
      duplicateRecheckTimerRef.current = null;
      handleCheckDuplicates(
        { similarity: duplicateSimilarity, scope: duplicateScope },
        'repartition'
      );
    }, 300);

    return () => {
      if (duplicateRecheckTimerRef.current !== null) {
        window.clearTimeout(duplicateRecheckTimerRef.current);
        duplicateRecheckTimerRef.current = null;
      }
    };
  }, [
    duplicateSimilarity,
    duplicateScope,
    isDuplicateDetectorOpen,
    isProcessingDuplicates,
    isRepartitioningDuplicates,
    handleCheckDuplicates,
  ]);

  /** 按删除结果收敛检测分组：去掉已删条目、丢弃不足 2 张的组、重算推荐保留项 */
  const pruneDuplicateGroups = useCallback((ids: Set<string>) => {
    setDuplicateGroups((prev) =>
      prev
        .map((group) => group.filter((p) => !ids.has(p.id)))
        .filter((group) => group.length > 1)
        .map(markRecommended)
    );
  }, []);

  /** 标记「这组不是重复」：按内容指纹持久化、从当前列表移除，Toast 给现场撤销出口 */
  const handleIgnoreGroup = useCallback(
    (group: Photo[]) => {
      const key = groupIdentityKey(group);
      const next = recordIgnoredGroup(ignoredGroupsRef.current, group);
      if (!key) {
        // 拖放降级且未算出指纹的照片无法跨重启识别：宁可明说，也不假装已经记住
        showToast('这组缺少内容指纹，无法跨重启记住；请改用「只留最早」处理', 'warning');
        return;
      }
      if (!next) {
        showToast('这组已经标记为不是重复', 'info');
        return;
      }
      applyIgnoredGroups(next);
      setDuplicateGroups((prev) => prev.filter((item) => groupIdentityKey(item) !== key));
      showToast('已标记为不是重复，下次检测不再显示', 'info', {
        label: '撤销',
        onClick: () => {
          applyIgnoredGroups(removeIgnoredGroup(ignoredGroupsRef.current, key));
          void handleCheckDuplicates(undefined, 'repartition');
        },
      });
    },
    [applyIgnoredGroups, handleCheckDuplicates, showToast]
  );

  /** 取消忽略后自动重新分组：用户点「恢复」就是想再看这组，不该再点一次检测 */
  const handleRestoreIgnoredGroup = useCallback(
    (key: string) => {
      const current = ignoredGroupsRef.current;
      const restored = removeIgnoredGroup(current, key);
      if (restored.length === current.length) return;
      applyIgnoredGroups(restored);
      void handleCheckDuplicates(undefined, 'repartition');
      showToast('已恢复 1 组，正在重新检测', 'info');
    },
    [applyIgnoredGroups, handleCheckDuplicates, showToast]
  );

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
      const freedBytes = photosToDelete
        .filter((photo) => deletedIds.has(photo.id))
        .reduce((sum, photo) => sum + (photo.size || 0), 0);
      setDeletedStats((prev) => ({
        count: prev.count + deletedIds.size,
        bytes: prev.bytes + freedBytes,
      }));
      removeWithCollapse(deletedIds);
      removeIdsFromSelection(deletedIds);
      // 分组与图库同步延后收敛，避免「列表先空一格、分组后跳一下」的错位
      scheduleAfterExit(() => {
        setDuplicateGroups((prev) =>
          prev
            .map((group) => group.filter((p) => !deletedIds.has(p.id)))
            .filter((group) => group.length > 1)
            .map((group) => markRecommended(group))
        );
      });
    }

    if (failedPhotos.length === 0) {
      showToast(
        `已将 ${deletedIds.size} 张相似照片移至回收站`,
        'success',
        makeUndoAction(deletedIds.size > 1 ? '撤销 1 项' : '撤销')
      );
      return;
    }

    errors.forEach((error) => logger.error('删除重复照片失败：', error));
    const detail = errors[0] + (errors.length > 1 ? ` 等 ${errors.length} 项` : '');
    const retryAction = {
      label: '重试',
      onClick: () => {
        void handleDeleteDuplicates(failedPhotos);
      },
    };

    if (deletedIds.size > 0) {
      showToast(
        `已删除 ${deletedIds.size} 张，${failedPhotos.length} 张失败：${detail}`,
        'warning',
        retryAction
      );
    } else {
      showToast(`删除失败：${detail}`, 'error', retryAction);
    }
  };

  return {
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
    ignoredGroups,
    handleIgnoreGroup,
    handleRestoreIgnoredGroup,
    scanReport,
    selectedCount: selectedIds.size,
  };
}
