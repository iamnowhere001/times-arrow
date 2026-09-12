/**
 * 重复检测 Hook（从 App 抽出）。
 *
 * 负责重复检测整页的全部领域状态与流程：参数（相似度 / 范围）及其持久化、
 * 检测管线调用与进度、取消 / 退出、检测结果中手动删除后的收敛。
 *
 * 与图库的交叉点（塌陷移除、选中集收敛、卡片动画计时器、主视图切换）
 * 全部通过参数注入，Hook 本身不直接持有这些状态。
 */

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { DuplicateScope, Photo } from '@/types';
import {
  findDuplicatePhotos,
  isDuplicateScanAbort,
  isVideoPhoto,
  markRecommended,
  type DuplicateScanProgress,
} from '@/utils';
import {
  DUPLICATE_SIMILARITY_DEFAULT,
  similarityToDistance,
} from '@/components/duplicate/DuplicateDetector';
import { releaseMemory } from '@/lib/cache/cacheManager';
import { savePersistedConfig } from '@/lib/persistence/persistence';
import { logger } from '@/lib/logger';
import { movePhotosToTrash } from '@/lib/fs/fileOperations';
import { ToastAction, type ToastType } from '@/components/common/Toast';

export interface UseDuplicateDetectionParams {
  photos: Photo[];
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
}

export function useDuplicateDetection(params: UseDuplicateDetectionParams): DuplicateDetectionResult {
  const {
    photos,
    showToast,
    isConfigLoaded,
    isDuplicateDetectorOpen,
    onEnterDuplicates,
    onExitDuplicates,
    removeWithCollapse,
    removeIdsFromSelection,
    scheduleAfterExit,
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
  const lastDuplicateOptionsRef = useRef<{ similarity: number; scope: DuplicateScope } | null>(null);
  const duplicateRecheckTimerRef = useRef<number | null>(null);
  /** 进行中的重复检测：取消时 abort，检测管线会在下一个分片边界停下并释放 */
  const duplicateAbortRef = useRef<AbortController | null>(null);

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

  // 检测：支持传入阈值 / 范围覆盖（参数变化时自动重跑）
  const handleCheckDuplicates = useCallback(async (
    override?: { similarity?: number; scope?: DuplicateScope },
    mode: 'full' | 'repartition' = 'full'
  ) => {
    // 重复检测只针对图片：视频逐帧比对既慢又无意义。
    // 已隐藏项同样排除：隐藏是跨视图的语义，不该因为进到检测页就重新可见（还能被删掉）
    const imagePhotos = photos.filter(p => !isVideoPhoto(p) && !p.isHidden);
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
        { threshold: similarityToDistance(runSimilarity), sameFolderOnly: runScope === 'sameFolder', signal: controller.signal },
        setDuplicateProgress
      );
      setDuplicateGroups(detectedDuplicates);

      if (detectedDuplicates.length > 0) {
        showToast(`找到 ${detectedDuplicates.length} 组相似照片`, 'info');
      } else {
        showToast('未找到相似照片', 'success');
      }
    } catch (error) {
      // 取消是用户主动行为而非故障：静默收尾，不弹错误
      if (isDuplicateScanAbort(error)) {
        // 重新分组被新一轮取代时不能清空：旧结果还要继续撑着界面
        if (!isRepartition) setDuplicateGroups([]);
        return;
      }
      logger.error('Error detecting duplicates:', error);
      showToast('检测相似照片失败', 'error');
    } finally {
      // 无论成功 / 取消 / 失败，本轮使用的参数都要记下来。
      // 否则取消后「参数与上次不同」的条件一直成立，自动重跑 effect 会把用户的取消吞掉，
      // 表现为：点了取消，进度条消失几百毫秒后又自己跑起来。
      lastDuplicateOptionsRef.current = { similarity: runSimilarity, scope: runScope };
      if (duplicateAbortRef.current === controller) duplicateAbortRef.current = null;
      setIsProcessingDuplicates(false);
      setIsRepartitioningDuplicates(false);
      setDuplicateProgress(prev =>
        prev ? { ...prev, processed: prev.total, etaMs: undefined, phase: 'done' } : prev
      );
      // 检测结束（或取消）后回收易失缓存，把峰值内存还回去
      releaseMemory('soft', 'duplicate-scan-done');
    }
  }, [photos, duplicateSimilarity, duplicateScope, showToast, onEnterDuplicates]);

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
      handleCheckDuplicates({ similarity: duplicateSimilarity, scope: duplicateScope }, 'repartition');
    }, 300);

    return () => {
      if (duplicateRecheckTimerRef.current !== null) {
        window.clearTimeout(duplicateRecheckTimerRef.current);
        duplicateRecheckTimerRef.current = null;
      }
    };
  }, [duplicateSimilarity, duplicateScope, isDuplicateDetectorOpen, isProcessingDuplicates, isRepartitioningDuplicates, handleCheckDuplicates]);

  /** 按删除结果收敛检测分组：去掉已删条目、丢弃不足 2 张的组、重算推荐保留项 */
  const pruneDuplicateGroups = useCallback((ids: Set<string>) => {
    setDuplicateGroups(prev =>
      prev
        .map(group => group.filter(p => !ids.has(p.id)))
        .filter(group => group.length > 1)
        .map(markRecommended)
    );
  }, []);

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
      removeIdsFromSelection(deletedIds);
      // 分组与图库同步延后收敛，避免「列表先空一格、分组后跳一下」的错位
      scheduleAfterExit(() => {
        setDuplicateGroups(prev =>
          prev
            .map(group => group.filter(p => !deletedIds.has(p.id)))
            .filter(group => group.length > 1)
            .map(group => markRecommended(group))
        );
      });
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
  };
}
