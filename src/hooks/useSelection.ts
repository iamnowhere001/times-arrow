/**
 * 选择集 Hook（从 App 抽出）。
 *
 * 管理「当前选中项」及其全部交互：单击 / ⌘ 追加 / Shift 区间连选、全选与反选、
 * 清空，以及筛选条件变化后的自动收敛（防止「选中 A → 筛选把 A 隐藏 → 删除却仍把 A 删掉」）。
 *
 * 区间选择以「最近一次单击」为锚点：锚点被筛掉或被删除时会自动挪到当前选中项，
 * 否则下一次方向键导航会因为找不到锚点而从列表第一项重新开始。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import { Photo } from '@/types';

export interface UseSelectionParams {
  /** 完整照片列表（详情面板的选中项据此取全量数据） */
  photos: Photo[];
  /** 当前视图真正展示的照片（筛选 + 搜索后）：区间选择与全选的作用域 */
  visiblePhotos: Photo[];
}

export interface SelectionResult {
  selectedIds: Set<string>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  /** 当前选中项（详情面板 / 弹层数据源） */
  selectedPhotos: Photo[];
  /** 区间选择的锚点：最近一次「单击」的照片 id（Shift 连选以它为起点） */
  selectionAnchorRef: RefObject<string | null>;
  handleToggleSelect: (id: string, multiSelect: boolean) => void;
  handleRangeSelect: (targetId: string) => void;
  handleSelectAllVisible: () => void;
  handleClearSelection: () => void;
  /** 从当前选中集中移除指定 id（保留其它选中项） */
  removeIdsFromSelection: (ids: Set<string>) => void;
}

export function useSelection({ photos, visiblePhotos }: UseSelectionParams): SelectionResult {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  /** 区间选择的锚点：最近一次「单击」的照片 id（Shift 连选以它为起点） */
  const selectionAnchorRef = useRef<string | null>(null);

  const removeIdsFromSelection = useCallback((ids: Set<string>) => {
    setSelectedIds(prev => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      ids.forEach(id => next.delete(id));
      return next;
    });
  }, []);

  // Selected photo for details pane
  const selectedPhotos = useMemo(
    () => photos.filter(p => selectedIds.has(p.id)),
    [photos, selectedIds]
  );

  const handleToggleSelect = useCallback((id: string, multiSelect: boolean) => {
    setSelectedIds(prev => {
      const newSet = new Set(multiSelect ? prev : []);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
    // 普通单击更新锚点；⌘/Ctrl 追加选择与 Shift 区间不会动锚点
    if (!multiSelect) selectionAnchorRef.current = id;
  }, []);

  // 筛选条件变化后收敛选择：防止「选中 A → 筛选把 A 隐藏 → 删除却仍把 A 删掉」
  useEffect(() => {
    setSelectedIds(prev => {
      if (prev.size === 0) return prev;
      const visible = new Set(visiblePhotos.map(p => p.id));
      let changed = false;
      const next = new Set<string>();
      prev.forEach(id => {
        if (visible.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [visiblePhotos]);

  // 选区收敛后，锚点若已不在可见列表里（被筛掉 / 被删除）要跟着挪走。
  // 否则下一次方向键导航会因为找不到锚点而从列表第一项重新开始。
  useEffect(() => {
    const anchor = selectionAnchorRef.current;
    if (anchor && visiblePhotos.some(p => p.id === anchor)) return;
    selectionAnchorRef.current = selectedIds.values().next().value ?? null;
  }, [visiblePhotos, selectedIds]);

  // Shift 区间选择：从锚点一路选到目标照片（在当前可见列表的顺序中取区间）
  const handleRangeSelect = useCallback((targetId: string) => {
    const anchor = selectionAnchorRef.current ?? targetId;
    const ids = visiblePhotos.map(p => p.id);
    const a = ids.indexOf(anchor);
    const b = ids.indexOf(targetId);
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (a < 0 || b < 0) {
        next.add(targetId);
        return next;
      }
      const [start, end] = a < b ? [a, b] : [b, a];
      for (let i = start; i <= end; i++) next.add(ids[i]);
      return next;
    });
    // 锚点保持不变：连续 Shift 点击会以最初的照片向两端延伸
  }, [visiblePhotos]);

  // 全选 / 反选：作用域是「当前视图」
  const handleSelectAllVisible = useCallback(() => {
    if (visiblePhotos.length === 0) return;
    setSelectedIds(prev => {
      const allPicked = visiblePhotos.every(p => prev.has(p.id));
      return allPicked ? new Set() : new Set(visiblePhotos.map(p => p.id));
    });
  }, [visiblePhotos]);

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  return {
    selectedIds,
    setSelectedIds,
    selectedPhotos,
    selectionAnchorRef,
    handleToggleSelect,
    handleRangeSelect,
    handleSelectAllVisible,
    handleClearSelection,
    removeIdsFromSelection,
  };
}
