/**
 * 文件操作 IPC 失败的统一上报与「文件已消失」自动剔除（N5）。
 *
 * 之前各操作 handler 的失败提示文案口径不一，且磁盘文件已被外部删除的条目会
 * 永远留在列表里，之后每次重命名 / 移动 / 导出都注定再次失败。这里收敛两条路径：
 *
 *  - reportFailure：所有 IPC 失败统一 logger + humanizeFsError 转译 + error Toast；
 *  - reportGone：判定为「文件已不在原位」的条目自动从列表剔除，并给出汇总 Toast。
 *
 * reportGone 有意【不】清收藏 / 标签 / 时间修正：这些按路径记录，等文件从其它
 * 目录重新导入时仍能命中（README 已知限制）；只摘 importedPaths 登记，否则
 * 同路径文件重建后 ingestFiles 的去重会拒绝其重新入库。
 */

import { Photo } from '@/types';
import { logger } from '@/lib/logger';
import { humanizeFsError, isFileGoneError } from './fileOperations';

/** 与 useToasts 的 showToast 签名对齐（guard 只用到前两个参数） */
type ShowToast = (message: string, type?: 'success' | 'info' | 'error' | 'warning') => void;

export interface FsErrorReporter {
  /** IPC 失败统一上报：logger.error + 人话转译 + error Toast。error 可传 Error、字符串（result.error）或 undefined */
  reportFailure: (scope: string, error: unknown) => void;
  /**
   * 把「文件已不在原位」的条目从列表剔除：塌陷动画、收敛选中、摘 importedPaths、
   * 同步清理重复检测分组，并给出一条汇总 Toast。返回被剔除的照片。
   * silent 时不弹提示（如目录监听场景，由「外部变动」汇总 Toast 统一说明）。
   */
  reportGone: (photos: Photo[], options?: { silent?: boolean }) => Photo[];
  /**
   * 便捷判定：message 命中 ENOENT 时走 reportGone 并返回 true，
   * 调用方据此不再把这批照片放进失败重试集合。
   */
  handleGone: (photos: Photo[], message?: string) => boolean;
}

export interface FsGuardDeps {
  showToast: ShowToast;
  /** App.removeWithCollapse：塌陷动画 + blob URL 回收 */
  removeWithCollapse: (ids: Set<string>) => void;
  /** App.removeIdsFromSelection：从当前选中集移除 */
  removeIdsFromSelection: (ids: Set<string>) => void;
  /** 摘除已导入路径登记（importedPathsRef），不清收藏 / 标签 */
  forgetImportedPaths: (paths: Iterable<string>) => void;
  /** useDuplicateDetection.pruneDuplicateGroups：重复分组同步摘除 */
  pruneDuplicateGroups: (ids: Set<string>) => void;
}

export const createFsErrorReporter = (deps: FsGuardDeps): FsErrorReporter => {
  const { showToast, removeWithCollapse, removeIdsFromSelection, forgetImportedPaths, pruneDuplicateGroups } = deps;

  const reportFailure = (scope: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error ?? '');
    logger.error(`${scope}:`, message);
    showToast(`${scope}：${humanizeFsError(message)}`, 'error');
  };

  const reportGone = (photos: Photo[], options?: { silent?: boolean }): Photo[] => {
    if (photos.length === 0) return [];
    const ids = new Set(photos.map(p => p.id));
    forgetImportedPaths(
      photos.map(p => p.path).filter((p): p is string => Boolean(p))
    );
    removeWithCollapse(ids);
    removeIdsFromSelection(ids);
    pruneDuplicateGroups(ids);
    if (!options?.silent) {
      showToast(`已从列表移除 ${photos.length} 个失效条目（收藏与标签保留）`, 'warning');
    }
    return photos;
  };

  const handleGone = (photos: Photo[], message?: string): boolean => {
    if (!isFileGoneError(message)) return false;
    reportGone(photos);
    return true;
  };

  return { reportFailure, reportGone, handleGone };
};
