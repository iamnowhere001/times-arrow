/**
 * 智能相簿 Hook（从 App 抽出）。
 *
 * 智能相簿只存「一组筛选条件」，不存照片：内容随图库实时求值，
 * 因此保存 / 选择 / 删除都只是筛选状态的读写与落盘。
 * 删掉的正是当前在看的相簿时，界面会停在它留下的筛选条件上（侧栏再无高亮、
 * 用户不知道自己在看什么），所以顺手把视图复位。
 *
 * v0.6.2 批次 1（K26）：保存与重命名都做重名校验。弹窗负责行内提示，
 * hook 这里再做一次防御 —— 配置里的相簿可能来自旧版本或导入文件，
 * 只靠 UI 拦不住。两者共用 `lib/album/albumNames` 的同一套比较规则。
 */

import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { PhotoFilters, SmartAlbum } from '@/types';
import { savePersistedConfig } from '@/lib/persistence/persistence';
import {
  createEmptyFilters,
  filtersEqual,
  isFilterActive,
  normalizeFilters,
} from '@/lib/filter/filters';
import { isAlbumNameTaken } from '@/lib/album/albumNames';
import { ToastAction, type ToastType } from '@/types/toast';

export interface UseSmartAlbumsParams {
  filters: PhotoFilters;
  setFilters: Dispatch<SetStateAction<PhotoFilters>>;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  showToast: (message: string, type?: ToastType, action?: ToastAction) => void;
}

export interface SmartAlbumsResult {
  albums: SmartAlbum[];
  /** 供配置加载完成时回填（配置里的相簿列表） */
  setAlbums: Dispatch<SetStateAction<SmartAlbum[]>>;
  /** 把当前筛选条件存成智能相簿；返回是否真的保存（重名 / 无效时为 false） */
  handleSaveAlbum: (name: string) => boolean;
  handleSelectAlbum: (album: SmartAlbum) => void;
  handleDeleteAlbum: (id: string) => void;
  /** 重命名；返回是否真的改名（空名 / 重名 / 找不到时为 false） */
  handleRenameAlbum: (id: string, name: string) => boolean;
}

export function useSmartAlbums({
  filters,
  setFilters,
  setSearchQuery,
  showToast,
}: UseSmartAlbumsParams): SmartAlbumsResult {
  /** 智能相簿（只存筛选条件，内容随图库自动更新） */
  const [albums, setAlbums] = useState<SmartAlbum[]>([]);

  /** 把当前筛选条件存成智能相簿 */
  const handleSaveAlbum = useCallback(
    (name: string): boolean => {
      const trimmed = name.trim();
      if (!trimmed || !isFilterActive(filters)) return false;
      if (isAlbumNameTaken(albums, trimmed)) {
        showToast(`已有同名相簿「${trimmed}」，换一个名字吧`, 'warning');
        return false;
      }
      const album: SmartAlbum = {
        id: `album-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: trimmed,
        filters: normalizeFilters(filters),
        createdAt: Date.now(),
      };
      const next = [...albums, album];
      setAlbums(next);
      void savePersistedConfig({ albums: next });
      showToast(`已保存相簿「${trimmed}」`, 'success');
      return true;
    },
    [albums, filters, showToast]
  );

  const handleSelectAlbum = useCallback(
    (album: SmartAlbum) => {
      setFilters(normalizeFilters(album.filters));
      setSearchQuery('');
    },
    [setFilters, setSearchQuery]
  );

  const handleDeleteAlbum = useCallback(
    (id: string) => {
      const removed = albums.find((album) => album.id === id);
      const next = albums.filter((album) => album.id !== id);
      setAlbums(next);
      void savePersistedConfig({ albums: next });
      // 删掉的正是当前在看的相簿时，界面会停在它留下的筛选条件上，
      // 侧栏再无任何高亮、用户不知道自己在看什么，所以顺手把视图复位
      if (removed && filtersEqual(normalizeFilters(removed.filters), filters)) {
        setFilters(createEmptyFilters());
        setSearchQuery('');
      }
      showToast(removed ? `已删除相簿「${removed.name}」` : '已删除相簿', 'info');
    },
    [albums, filters, setFilters, setSearchQuery, showToast]
  );

  const handleRenameAlbum = useCallback(
    (id: string, name: string): boolean => {
      const trimmed = name.trim();
      const current = albums.find((album) => album.id === id);
      if (!trimmed || !current) return false;
      if (current.name === trimmed) return true; // 没改动，不必写盘
      if (isAlbumNameTaken(albums, trimmed, id)) {
        showToast(`已有同名相簿「${trimmed}」，换一个名字吧`, 'warning');
        return false;
      }
      const next = albums.map((album) => (album.id === id ? { ...album, name: trimmed } : album));
      setAlbums(next);
      void savePersistedConfig({ albums: next });
      showToast(`已重命名为「${trimmed}」`, 'success');
      return true;
    },
    [albums, showToast]
  );

  return {
    albums,
    setAlbums,
    handleSaveAlbum,
    handleSelectAlbum,
    handleDeleteAlbum,
    handleRenameAlbum,
  };
}
