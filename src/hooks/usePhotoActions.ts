/**
 * 单张照片的外部动作（从 App 抽出）。
 *
 * 复制图片 / 在访达中定位 / 复制路径 / 用默认应用打开 —— 这四个动作的共同点：
 * 只依赖「这张照片的磁盘路径」与一个 Toast 出口，不碰图库状态。
 * 之前它们散在 App 顶部、夹在 40 个 state 之间，读起来像编排逻辑的一部分；
 * 收进一个 hook 后，App 只保留解构，动作本身也能被其它视图直接复用。
 */

import { useCallback } from 'react';
import { Photo } from '@/types';
import { isVideoPhoto } from '@/utils';
import { logger } from '@/lib/logger';
import type { ToastType } from '@/types/toast';

type ShowToast = (message: string, type?: ToastType) => void;

export interface PhotoActions {
  copyImage: (photo: Photo) => Promise<void>;
  showInFolder: (photo: Photo) => Promise<void>;
  copyPath: (photo: Photo) => Promise<void>;
  openInEditor: (photo: Photo) => Promise<void>;
}

export function usePhotoActions(showToast: ShowToast): PhotoActions {
  // 复制图片到系统剪贴板
  const copyImage = useCallback(
    async (photo: Photo) => {
      if (!window.electronAPI) return;
      if (isVideoPhoto(photo)) {
        showToast('视频无法复制到剪贴板，可改用「复制路径」', 'warning');
        return;
      }
      if (!photo.path) {
        showToast('该文件没有磁盘路径，无法复制', 'warning');
        return;
      }
      const result = await window.electronAPI.copyImage(photo.path);
      if (!result.ok) {
        showToast(`复制失败：${result.error}`, 'error');
      } else {
        showToast(`已复制 "${photo.name}" 到剪贴板`, 'success');
      }
    },
    [showToast]
  );

  // 在访达中定位文件
  const showInFolder = useCallback(
    async (photo: Photo) => {
      if (!window.electronAPI || !photo.path) {
        showToast('该照片没有磁盘路径，无法在访达中显示', 'warning');
        return;
      }
      const result = await window.electronAPI.showInFolder(photo.path);
      if (!result.ok) {
        showToast(`无法打开所在文件夹：${result.error}`, 'error');
      }
    },
    [showToast]
  );

  // 复制文件路径到剪贴板（Electron 下走主进程 clipboard，Web 降级到 navigator.clipboard）
  const copyPath = useCallback(
    async (photo: Photo) => {
      const target = photo.path;
      if (!target) {
        showToast('该照片没有磁盘路径，无法复制路径', 'warning');
        return;
      }
      try {
        if (window.electronAPI?.copyText) {
          const result = await window.electronAPI.copyText(target);
          if (!result.ok) throw new Error(result.error);
        } else {
          await navigator.clipboard.writeText(target);
        }
        showToast('路径已复制到剪贴板', 'success');
      } catch (error) {
        logger.error('复制路径失败:', error);
        showToast('复制路径失败', 'error');
      }
    },
    [showToast]
  );

  // 用系统默认应用 / 外部编辑器打开文件
  const openInEditor = useCallback(
    async (photo: Photo) => {
      if (!window.electronAPI || !photo.path) {
        showToast('该照片没有磁盘路径，无法打开', 'warning');
        return;
      }
      const result = await window.electronAPI.openPath(photo.path);
      if (!result.ok) {
        showToast(`打开失败：${result.error}`, 'error');
      }
    },
    [showToast]
  );

  return { copyImage, showInFolder, copyPath, openInEditor };
}
