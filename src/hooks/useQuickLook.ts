/**
 * 全屏预览（QuickLook）Hook（从 App 抽出）。
 *
 * 负责预览的打开 / 关闭、翻页范围与前后预加载：
 * 翻页范围跟随当前视图 —— 图库里按可见列表翻页，重复检测页只在检测结果内翻页，
 * 时光画廊按时间排序的全部照片翻页；地图里通过 quickLookScope 临时收窄到
 * 同一点位内，预览关闭后自动释放，不影响其它视图。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Photo } from '@/types';
import { isVideoPhoto } from '@/utils';

export interface UseQuickLookParams {
  /** 图库当前可见列表（筛选 + 搜索后） */
  visiblePhotos: Photo[];
  /** 时光画廊的时间序列表（非隐藏的全部照片） */
  timelinePhotos: Photo[];
  /** 重复检测页是否在前台 */
  isDuplicateDetectorOpen: boolean;
  /** 时光画廊是否在前台 */
  isTimelineOpen: boolean;
  /** 重复检测分组（翻页范围限定在检测结果内） */
  duplicateGroups: Photo[][];
}

export interface QuickLookResult {
  quickLookPhoto: Photo | null;
  setQuickLookPhoto: (photo: Photo | null) => void;
  /** 地图照片条临时收窄的翻页范围；预览关闭后自动释放 */
  setQuickLookScope: (scope: Photo[] | null) => void;
  /** 当前翻页范围（决定翻页边界与总数展示） */
  quickLookList: Photo[];
  /** 当前索引；不在范围内时为 -1 */
  quickLookIndex: number;
  /** 前后各一张的预加载源（视频由播放器自行管理，不预热） */
  quickLookPreloadSources: string[];
  handleQuickLookNext: () => void;
  handleQuickLookPrev: () => void;
}

export function useQuickLook({
  visiblePhotos,
  timelinePhotos,
  isDuplicateDetectorOpen,
  isTimelineOpen,
  duplicateGroups,
}: UseQuickLookParams): QuickLookResult {
  const [quickLookPhoto, setQuickLookPhoto] = useState<Photo | null>(null);
  /**
   * 「按地点浏览」里点开某张照片时的临时翻页范围：收窄到该地点的照片。
   * QuickLook 关闭后自动释放，不会影响其它视图的翻页。
   */
  const [quickLookScope, setQuickLookScope] = useState<Photo[] | null>(null);

  /**
   * QuickLook 的翻页范围跟随当前视图：
   * 图库里按可见列表翻页，重复检测页只在检测结果内翻页，
   * 时光画廊按时间排序的全部照片翻页，地图里则限定在同一点位内。
   */
  const quickLookList = useMemo(
    () => {
      if (quickLookScope) return quickLookScope;
      if (isDuplicateDetectorOpen) return duplicateGroups.flatMap(group => group);
      if (isTimelineOpen) return timelinePhotos;
      return visiblePhotos;
    },
    [quickLookScope, isDuplicateDetectorOpen, isTimelineOpen, duplicateGroups, visiblePhotos, timelinePhotos]
  );

  // 预览关闭即释放地点范围：否则回到图库再打开预览，翻页仍被困在上一个地点
  useEffect(() => {
    if (!quickLookPhoto) setQuickLookScope(null);
  }, [quickLookPhoto]);

  // 当前索引：缓存结果，避免每次渲染对大列表做线性查找
  const quickLookIndex = useMemo(
    () => (quickLookPhoto ? quickLookList.findIndex(p => p.id === quickLookPhoto.id) : -1),
    [quickLookPhoto, quickLookList]
  );

  /**
   * 预览层的前后预加载源：只预热紧邻的图片（视频由播放器自行管理），
   * 翻页时直接命中已解码的位图，避免每张都出现「黑屏 → 亮起」。
   */
  const quickLookPreloadSources = useMemo(() => {
    if (quickLookIndex < 0) return [];
    const neighbors = [quickLookList[quickLookIndex - 1], quickLookList[quickLookIndex + 1]];
    return neighbors
      .filter((item): item is Photo => Boolean(item) && !isVideoPhoto(item))
      .map(item => item.url);
  }, [quickLookIndex, quickLookList]);

  // 翻页范围跟随「当前可见列表」（收藏夹内只翻收藏），不会跳到分类之外；
  // 在重复检测页则只在本次检测结果内翻页
  const handleQuickLookNext = useCallback(() => {
    if (quickLookIndex < 0 || quickLookIndex >= quickLookList.length - 1) return;
    setQuickLookPhoto(quickLookList[quickLookIndex + 1]);
  }, [quickLookIndex, quickLookList]);

  const handleQuickLookPrev = useCallback(() => {
    if (quickLookIndex <= 0) return;
    setQuickLookPhoto(quickLookList[quickLookIndex - 1]);
  }, [quickLookIndex, quickLookList]);

  return {
    quickLookPhoto,
    setQuickLookPhoto,
    setQuickLookScope,
    quickLookList,
    quickLookIndex,
    quickLookPreloadSources,
    handleQuickLookNext,
    handleQuickLookPrev,
  };
}
