/**
 * 文件级操作（从 App 抽出的半纯逻辑）。
 *
 * 目前只包含「批量移入回收站」：逐张调用主进程删除，收集成功 id、失败照片与错误说明，
 * 失败项由调用方用于重试。不读取任何组件状态，仅依赖主进程 IPC。
 */

import { Photo } from './types';

export interface TrashResult {
  /** 成功移入回收站的条目 id */
  deletedIds: Set<string>;
  /** 失败的照片 */
  failedPhotos: Photo[];
  /** 与 failedPhotos 对应的错误说明 */
  errors: string[];
}

/** 批量移入回收站：返回成功删除的 id、失败照片与错误说明（失败项可用于重试） */
export const movePhotosToTrash = async (targets: Photo[]): Promise<TrashResult> => {
  const deletedIds = new Set<string>();
  const failedPhotos: Photo[] = [];
  const errors: string[] = [];

  for (const photo of targets) {
    if (!window.electronAPI) {
      failedPhotos.push(photo);
      errors.push(`「${photo.name}」：电子 API 不可用`);
      continue;
    }
    if (!photo.path) {
      failedPhotos.push(photo);
      errors.push(`「${photo.name}」缺少文件路径`);
      continue;
    }
    try {
      const result = await window.electronAPI.deleteFile(photo.path);
      if (result?.error) {
        failedPhotos.push(photo);
        errors.push(`「${photo.name}」：${result.error}`);
      } else {
        deletedIds.add(photo.id);
      }
    } catch (err) {
      failedPhotos.push(photo);
      errors.push(`「${photo.name}」：${(err as Error).message}`);
    }
  }

  return { deletedIds, failedPhotos, errors };
};
