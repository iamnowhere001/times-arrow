/**
 * 全局键盘交互 Hook（从 App 抽出）。
 *
 * 主视图键盘闭环：
 *   空格 / Enter → QuickLook；⌘A → 全选当前视图；⌘⇧F → 批量收藏；⌘F → 聚焦搜索；
 *   方向键 / Home / End → 单选移动（网格上下键按真实行几何取落点）；
 *   ⌘⌫ / Delete → 删除确认；Esc → 关闭右键菜单，其次清除选择；? → 快捷键总览。
 * 弹层打开或焦点在输入框内时全部让行。
 *
 * 另含两个配套行为：
 *   - 方向键导航（handleArrowNavigation）：移动单个选中项并让视口跟随；
 *   - 指针落在非交互区域时移开焦点，避免「上次点过工具栏按钮 → 按空格误触发它」。
 */

import { useCallback, useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { Photo } from '@/types';
import type { ImageGridHandle } from '@/components/grid/ImageGrid';

export interface UseKeyboardShortcutsParams {
  /** 当前视图真正展示的照片（方向键与全选的作用域） */
  visiblePhotos: Photo[];
  selectedIds: Set<string>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  /** 区间选择的锚点（方向键以此为起点） */
  selectionAnchorRef: RefObject<string | null>;
  gridRef: RefObject<ImageGridHandle | null>;
  viewMode: 'grid' | 'list';
  /** 右键菜单是否打开：打开时方向键 / 空格 / Home / End 让行 */
  contextMenu: unknown;
  setContextMenu: Dispatch<SetStateAction<{ x: number; y: number; photo?: Photo } | null>>;

  quickLookPhoto: Photo | null;
  setQuickLookPhoto: (photo: Photo | null) => void;

  isRenameModalOpen: boolean;
  isDeleteModalOpen: boolean;
  isExportModalOpen: boolean;
  isAiSettingsOpen: boolean;
  isAdjustDateModalOpen: boolean;
  isSaveAlbumModalOpen: boolean;
  isFilterPanelOpen: boolean;
  isClearListConfirmOpen: boolean;
  isShortcutsOpen: boolean;
  setIsShortcutsOpen: Dispatch<SetStateAction<boolean>>;
  isDuplicateDetectorOpen: boolean;
  isTimelineOpen: boolean;
  isMapOpen: boolean;
  /** 返回图库（整页视图的 Esc） */
  onExitToLibrary: () => void;
  handleExitDuplicates: () => void;

  searchInputRef: RefObject<HTMLInputElement | null>;
  handleSelectAllVisible: () => void;
  handleFavoriteSelected: () => void;
  setIsDeleteModalOpen: Dispatch<SetStateAction<boolean>>;
}

export function useKeyboardShortcuts({
  visiblePhotos,
  selectedIds,
  setSelectedIds,
  selectionAnchorRef,
  gridRef,
  viewMode,
  contextMenu,
  setContextMenu,
  quickLookPhoto,
  setQuickLookPhoto,
  isRenameModalOpen,
  isDeleteModalOpen,
  isExportModalOpen,
  isAiSettingsOpen,
  isAdjustDateModalOpen,
  isSaveAlbumModalOpen,
  isFilterPanelOpen,
  isClearListConfirmOpen,
  isShortcutsOpen,
  setIsShortcutsOpen,
  isDuplicateDetectorOpen,
  isTimelineOpen,
  isMapOpen,
  onExitToLibrary,
  handleExitDuplicates,
  searchInputRef,
  handleSelectAllVisible,
  handleFavoriteSelected,
  setIsDeleteModalOpen,
}: UseKeyboardShortcutsParams): void {
  // 指针落在非交互区域时，把焦点从按钮上移开：
  // 避免「上次点过工具栏按钮 → 按空格/回车误触发那个按钮」的经典问题
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || typeof t.closest !== 'function') return;
      if (t.closest('button, a, input, textarea, select, label, [contenteditable="true"]')) return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && ae !== document.body && typeof ae.blur === 'function') ae.blur();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, []);

  // 方向键导航：移动单个选中项并让视口跟随（网格上下键按真实行几何找落点）
  const handleArrowNavigation = useCallback((key: string) => {
    if (visiblePhotos.length === 0) return;
    const ids = visiblePhotos.map(p => p.id);
    const currentIndex = selectionAnchorRef.current ? ids.indexOf(selectionAnchorRef.current) : -1;

    // 还没有任何选中项时，任意方向键都先选中第一项并停住。
    // 若照常叠加步长，会变成「按 → 从第 2 张开始、按 ↓ 跳掉一整行」，左右上下不对称。
    if (currentIndex < 0) {
      const firstId = ids[0];
      setSelectedIds(new Set([firstId]));
      selectionAnchorRef.current = firstId;
      gridRef.current?.scrollToPhoto(firstId);
      return;
    }

    // 左右键在任意视图里都是顺序步进。
    // 上下键：列表视图一次一行；网格视图交给布局按真实行几何找目标 ——
    // justified 布局每行张数随照片宽高比变化，固定列数硬跳会跳错列。
    let nextIndex = currentIndex;
    if (key === 'ArrowLeft') {
      nextIndex = Math.max(0, currentIndex - 1);
    } else if (key === 'ArrowRight') {
      nextIndex = Math.min(ids.length - 1, currentIndex + 1);
    } else if (viewMode === 'list') {
      nextIndex = key === 'ArrowUp'
        ? Math.max(0, currentIndex - 1)
        : Math.min(ids.length - 1, currentIndex + 1);
    } else {
      const neighbor = gridRef.current?.getVerticalNeighbor(ids[currentIndex], key === 'ArrowUp' ? 'up' : 'down');
      const neighborIndex = neighbor ? ids.indexOf(neighbor) : -1;
      // 已在首 / 末行（没有相邻行）时保持原位，不再用固定列数硬跳
      if (neighborIndex >= 0) nextIndex = neighborIndex;
    }

    if (nextIndex === currentIndex && selectedIds.size === 1) return;
    const nextId = ids[nextIndex];
    setSelectedIds(new Set([nextId]));
    selectionAnchorRef.current = nextId;
    gridRef.current?.scrollToPhoto(nextId);
  }, [gridRef, selectedIds.size, selectionAnchorRef, setSelectedIds, viewMode, visiblePhotos]);

  // 主视图键盘闭环：
  // 空格 / Enter → QuickLook；⌘A → 全选当前视图；⌘⇧F → 批量收藏；⌘F → 聚焦搜索；
  // 方向键 → 单选移动；⌘⌫ / Delete → 删除确认；Esc → 关闭右键菜单，其次清除选择。
  // 弹层打开或焦点在输入框内时全部让行。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // 快捷键总览已打开：Esc 或再按 ? 关闭，并吞掉其余按键，避免背后交互被误触
      if (isShortcutsOpen) {
        if (e.key === 'Escape' || e.key === '?') {
          e.preventDefault();
          setIsShortcutsOpen(false);
        }
        return;
      }
      // 重复检测页：Esc 返回图库（预览层打开时让行给它）
      if (isDuplicateDetectorOpen) {
        if (e.key === 'Escape' && !quickLookPhoto) {
          e.preventDefault();
          handleExitDuplicates();
        }
        return;
      }
      // 时光画廊：Esc 返回图库（预览层打开时让行给它）
      if (isTimelineOpen) {
        if (e.key === 'Escape' && !quickLookPhoto) {
          e.preventDefault();
          onExitToLibrary();
        }
        return;
      }
      // 按地点浏览：同上（地图自身的方向键平移 / 缩放由地图容器处理）
      if (isMapOpen) {
        if (e.key === 'Escape' && !quickLookPhoto) {
          e.preventDefault();
          onExitToLibrary();
        }
        return;
      }
      // 弹层打开时全局快捷键一律让行：尤其是 Delete / Backspace，
      // 否则会在当前弹层之上再叠一个「移至回收站」确认框
      if (
        quickLookPhoto ||
        isRenameModalOpen ||
        isDeleteModalOpen ||
        isExportModalOpen ||
        isAiSettingsOpen ||
        isAdjustDateModalOpen ||
        isSaveAlbumModalOpen ||
        isFilterPanelOpen ||
        isClearListConfirmOpen
      ) return;

      const target = e.target as HTMLElement | null;
      const isTextInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      const cmd = e.metaKey || e.ctrlKey;

      // ?（⇧/）：唤出快捷键总览。放在输入框守卫之后，确保在搜索框内打「？」不会被误触发
      if (!isTextInput && e.key === '?') {
        e.preventDefault();
        setIsShortcutsOpen(true);
        return;
      }

      // ⌘F：聚焦搜索框（输入框内也允许接管）
      if (cmd && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if (isTextInput) return;

      if (cmd && !e.shiftKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        handleSelectAllVisible();
        return;
      }
      if (cmd && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        if (selectedIds.size > 0) handleFavoriteSelected();
        return;
      }
      if (e.key === 'Escape') {
        if (contextMenu) {
          setContextMenu(null);
        } else if (selectedIds.size > 0) {
          setSelectedIds(new Set());
        }
        return;
      }
      if (e.key === ' ' || e.key === 'Enter') {
        if (contextMenu) return;
        if (visiblePhotos.length === 0) return;
        e.preventDefault();
        const targetPhoto = visiblePhotos.find(p => selectedIds.has(p.id)) ?? visiblePhotos[0];
        setQuickLookPhoto(targetPhoto);
        return;
      }
      // Home / End：大库里逐行按方向键太慢，直接跳首尾
      if (e.key === 'Home' || e.key === 'End') {
        if (contextMenu) return;
        if (visiblePhotos.length === 0) return;
        e.preventDefault();
        const target = e.key === 'Home' ? visiblePhotos[0] : visiblePhotos[visiblePhotos.length - 1];
        setSelectedIds(new Set([target.id]));
        selectionAnchorRef.current = target.id;
        gridRef.current?.scrollToPhoto(target.id);
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (contextMenu) return;
        e.preventDefault();
        handleArrowNavigation(e.key);
        return;
      }
      // 破坏性操作对齐 macOS 习惯：⌘⌫ 删除（Finder 语义），Delete 键保留兼容。
      // 单按 ⌫ 不再触发删除，避免与「重命名」等肌肉记忆冲突导致误删。
      if (e.key === 'Delete' || (cmd && e.key === 'Backspace')) {
        if (selectedIds.size > 0) {
          e.preventDefault();
          setIsDeleteModalOpen(true);
        }
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    quickLookPhoto, isRenameModalOpen, isDeleteModalOpen, isDuplicateDetectorOpen, isTimelineOpen, isMapOpen,
    isExportModalOpen,
    isShortcutsOpen, isAiSettingsOpen, isAdjustDateModalOpen, isSaveAlbumModalOpen, isFilterPanelOpen,
    isClearListConfirmOpen,
    contextMenu, visiblePhotos, selectedIds,
    gridRef, handleArrowNavigation, handleExitDuplicates, handleFavoriteSelected, handleSelectAllVisible,
    onExitToLibrary, searchInputRef, selectionAnchorRef, setContextMenu, setIsDeleteModalOpen,
    setIsShortcutsOpen, setQuickLookPhoto, setSelectedIds,
  ]);
}
