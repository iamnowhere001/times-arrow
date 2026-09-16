/**
 * 智能相簿 Hook（从 App 抽出）。
 *
 * 智能相簿只存「一组筛选条件」，不存照片：内容随图库实时求值，
 * 因此保存 / 选择 / 删除都只是筛选状态的读写与落盘。
 * 删掉的正是当前在看的相簿时，界面会停在它留下的筛选条件上（侧栏再无高亮、
 * 用户不知道自己在看什么），所以顺手把视图复位。
 */

import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { PhotoFilters, SmartAlbum } from '@/types';
import { savePersistedConfig } from '@/lib/persistence/persistence';
import { createEmptyFilters, filtersEqual, normalizeFilters } from '@/lib/filter/filters';
import { ToastAction, type ToastType } from '@/components/common/Toast';

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
  /** 把当前筛选条件存成智能相簿 */
  handleSaveAlbum: (name: string) => void;
  handleSelectAlbum: (album: SmartAlbum) => void;
  handleDeleteAlbum: (id: string) => void;
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
  const handleSaveAlbum = useCallback((name: string) => {
    const album: SmartAlbum = {
      id: `album-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      filters: normalizeFilters(filters),
      createdAt: Date.now(),
    };
    const next = [...albums, album];
    setAlbums(next);
    void savePersistedConfig({ albums: next });
    showToast(`已保存相簿「${name}」`, 'success');
  }, [albums, filters, showToast]);

  const handleSelectAlbum = useCallback((album: SmartAlbum) => {
    setFilters(normalizeFilters(album.filters));
    setSearchQuery('');
  }, [setFilters, setSearchQuery]);

  const handleDeleteAlbum = useCallback((id: string) => {
    const removed = albums.find(album => album.id === id);
    const next = albums.filter(album => album.id !== id);
    setAlbums(next);
    void savePersistedConfig({ albums: next });
    // 删掉的正是当前在看的相簿时，界面会停在它留下的筛选条件上，
    // 侧栏再无任何高亮、用户不知道自己在看什么，所以顺手把视图复位
    if (removed && filtersEqual(normalizeFilters(removed.filters), filters)) {
      setFilters(createEmptyFilters());
      setSearchQuery('');
    }
    showToast(removed ? `已删除相簿「${removed.name}」` : '已删除相簿', 'info');
  }, [albums, filters, setFilters, setSearchQuery, showToast]);

  return { albums, setAlbums, handleSaveAlbum, handleSelectAlbum, handleDeleteAlbum };
}
