/**
 * 文件级操作（从 App 抽出的半纯逻辑）。
 *
 * 目前只包含「批量移入回收站」：逐张调用主进程删除，收集成功 id、失败照片与错误说明，
 * 失败项由调用方用于重试。不读取任何组件状态，仅依赖主进程 IPC。
 */

import { Photo } from '@/types';

/**
 * 把主进程回传的 fs 错误翻译成用户能看懂的一句话。
 *
 * Node 的原始信息形如
 *   `ENOENT: no such file or directory, rename '/Users/x/Pictures/IMG_001.jpg' -> '...'`
 * 直接展示既暴露内部绝对路径，也没告诉用户「现在该怎么办」。
 */
export const humanizeFsError = (message?: string): string => {
  if (!message) return '未知错误';

  const code = message.match(
    /\b(ENOENT|EACCES|EPERM|ENOSPC|EROFS|EEXIST|EBUSY|EMFILE|ENOTDIR|EISDIR|ENAMETOOLONG)\b/
  )?.[1];

  switch (code) {
    case 'ENOENT':
      return '文件已不在原位置（可能被移动或删除）';
    case 'EACCES':
    case 'EPERM':
      return '没有访问权限';
    case 'ENOSPC':
      return '磁盘空间不足';
    case 'EROFS':
      return '目标磁盘为只读';
    case 'EEXIST':
      return '同名文件已存在';
    case 'EBUSY':
      return '文件正被其它程序占用';
    case 'EMFILE':
      return '同时打开的文件过多，请稍后重试';
    case 'ENOTDIR':
    case 'EISDIR':
      return '路径类型不正确';
    case 'ENAMETOOLONG':
      return '文件名过长';
    default:
      return code ? `操作失败（${code}）` : '操作失败';
  }
};

/**
 * 错误信息是否表示「文件已不在磁盘上」。
 *
 * 主进程只回传 `error.message` 字符串，这里用原始错误码判定即可；
 * 命中后调用方应把对应条目从列表剔除（见 ipcGuard.reportGone），而不是留给用户反复重试。
 */
export const isFileGoneError = (message?: string): boolean => /\bENOENT\b/.test(message ?? '');

export interface TrashResult {
  /** 成功移入回收站的条目 id */
  deletedIds: Set<string>;
  /** 失败的照片 */
  failedPhotos: Photo[];
  /** 与 failedPhotos 对应的错误说明 */
  errors: string[];
  /**
   * 其中「没有磁盘文件、只是从列表移除」的条目数。
   * 这类条目不会进回收站，提示时必须区分开，否则用户会以为还能去回收站找回。
   */
  pathlessRemoved: number;
}

/**
 * 批量移入回收站：返回成功删除的 id、失败照片与错误说明（失败项可用于重试）。
 * onProgress 逐项回调（含跳过 / 失败项），供调用方展示批量删除进度。
 */
export const movePhotosToTrash = async (
  targets: Photo[],
  onProgress?: (done: number, total: number) => void
): Promise<TrashResult> => {
  const deletedIds = new Set<string>();
  const failedPhotos: Photo[] = [];
  const errors: string[] = [];
  let pathlessRemoved = 0;

  for (let i = 0; i < targets.length; i++) {
    const photo = targets[i];
    if (!window.electronAPI) {
      failedPhotos.push(photo);
      errors.push(`「${photo.name}」：电子 API 不可用`);
    } else if (!photo.path) {
      // 拖放降级条目（只有 blob: 预览、磁盘上没有文件）：
      // 「移入回收站」无处可移，从列表中移除即为唯一有意义的操作。
      // 视为删除成功，交由调用方 removeWithCollapse 顺带回收 blob URL。
      deletedIds.add(photo.id);
      pathlessRemoved += 1;
    } else {
      try {
        const result = await window.electronAPI.deleteFile(photo.path);
        if (!result.ok) {
          failedPhotos.push(photo);
          errors.push(`「${photo.name}」：${humanizeFsError(result.error)}`);
        } else {
          deletedIds.add(photo.id);
        }
      } catch (err) {
        failedPhotos.push(photo);
        errors.push(`「${photo.name}」：${humanizeFsError((err as Error).message)}`);
      }
    }
    onProgress?.(i + 1, targets.length);
  }

  return { deletedIds, failedPhotos, errors, pathlessRemoved };
};
