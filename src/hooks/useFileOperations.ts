/**
 * 批量文件操作 Hook（从 App 抽出）。
 *
 * 重命名（单个 / 批量）/ 删除（回收站）/ 移动（跨目录）三条链路的唯一入口：
 *   - 提交锁 fileOpLockRef 防连点（异步执行期间确认按钮仍可点击）；
 *   - 操作前后登记 touchedPaths 过滤 watcher 回环，锁释放后合并应用暂存事件；
 *   - 磁盘成功后同步条目状态（路径 / 名称 / pm:// 地址）与「按路径存储」的用户数据；
 *   - 失败项按「文件已消失」与「可重试失败」分流：前者剔除条目，后者给 Toast 重试入口；
 *   - K19：beginFileOp / reportFileOp / endFileOp 统一进度反馈。
 */

import { type Dispatch, type RefObject, type SetStateAction } from 'react';
import { Photo, RenameOptions } from '@/types';
import { formatDateForNaming, folderOfPath, pmFileUrl, repairFileName } from '@/utils';
import { logger } from '@/lib/logger';
import { humanizeFsError, isFileGoneError, movePhotosToTrash, type TrashResult } from '@/lib/fs/fileOperations';
import { joinPath, sanitizeFilename } from '@/lib/fs/pathUtils';
import { photoTakenTime } from '@/lib/media/photoTime';
import type { FsErrorReporter } from '@/lib/fs/ipcGuard';
import { ToastAction, type ToastType } from '@/components/common/Toast';

export interface UseFileOperationsParams {
  photos: Photo[];
  photosRef: RefObject<Photo[]>;
  selectedIds: Set<string>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  setPhotos: Dispatch<SetStateAction<Photo[]>>;
  setIsRenameModalOpen: Dispatch<SetStateAction<boolean>>;
  setIsDeleteModalOpen: Dispatch<SetStateAction<boolean>>;
  showToast: (message: string, type?: ToastType, action?: ToastAction) => void;
  /** 文件操作提交锁：防止确认按钮被连点导致同一批文件提交两次 */
  fileOpLockRef: RefObject<boolean>;
  /** 操作发起前登记涉及的路径（回环防护），由 watcher 域提供 */
  markPathsTouched: (paths: Array<string | undefined>) => void;
  /** 操作锁释放后应用暂存的 watcher 事件 */
  flushPendingWatcherEvents: () => void;
  fsGuard: FsErrorReporter;
  // K19 批量操作反馈
  beginFileOp: (title: string, hint: string, total: number) => void;
  reportFileOp: (done: number, file: string) => void;
  endFileOp: () => void;
  // 列表与选中集的收敛
  removeWithCollapse: (ids: Set<string>) => void;
  pruneDuplicateGroups: (ids: Set<string>) => void;
  // 按路径存储的数据迁移 / 清理
  rekeyPathData: (from: string, to: string) => { video: boolean; ai: boolean };
  dropPathData: (paths: Iterable<string>) => { video: boolean; ai: boolean };
  persistPathData: (changed: { video: boolean; ai: boolean }) => Promise<void>;
}

export interface FileOperationsResult {
  /** 单个重命名（详情面板 / 右键菜单） */
  handleRenamePhoto: (id: string, newName: string) => Promise<void>;
  /** 批量重命名（RenameModal 的提交） */
  handleBatchRename: (options: RenameOptions) => Promise<void>;
  /** 删除确认框的提交（移至回收站） */
  handleConfirmDelete: () => Promise<void>;
  /** 批量移动入口：先选目标文件夹（macOS 面板里可直接新建文件夹），再执行移动 */
  handleMoveSelected: (targets?: Photo[]) => void;
}

export function useFileOperations({
  photos,
  photosRef,
  selectedIds,
  setSelectedIds,
  setPhotos,
  setIsRenameModalOpen,
  setIsDeleteModalOpen,
  showToast,
  fileOpLockRef,
  markPathsTouched,
  flushPendingWatcherEvents,
  fsGuard,
  beginFileOp,
  reportFileOp,
  endFileOp,
  removeWithCollapse,
  pruneDuplicateGroups,
  rekeyPathData,
  dropPathData,
  persistPathData,
}: UseFileOperationsParams): FileOperationsResult {
  // Handle single photo rename
  const handleRenamePhoto = async (id: string, newName: string) => {
    // 提交锁：确认按钮在异步执行期间仍可点击，连点会把同一批文件提交两次
    //（第二轮拿到的还是闭包里的旧路径，必然整批 ENOENT）
    if (fileOpLockRef.current) return;
    fileOpLockRef.current = true;
    try {
      // Check if we're in Electron environment
      if (!window.electronAPI) {
        logger.error('Electron API not available');
        showToast('电子API不可用，无法执行重命名操作', 'error');
        return;
      }

      const photo = photos.find(p => p.id === id);
      if (!photo) {
        showToast('找不到要重命名的照片', 'error');
        return;
      }

      if (!photo.path) {
        showToast('照片没有有效的文件路径，无法重命名', 'error');
        return;
      }

      // Sanitize filename to remove invalid characters
      const sanitizedName = sanitizeFilename(newName);

      // Get original file extension to preserve it
      const originalExt = photo.name.includes('.') ? photo.name.substring(photo.name.lastIndexOf('.')) : '';
      const finalName = sanitizedName.includes('.') ? sanitizedName : (sanitizedName + originalExt);

      // Rename the file using Electron API
      const oldPath = photo.path;
      logger.debug(`Attempting to rename single photo: ${oldPath} to ${finalName}`);

      const dirPath = folderOfPath(oldPath);
      const newPath = joinPath(dirPath, finalName);
      logger.debug(`Generated new path for single rename: ${newPath}`);

      // Skip if new name is the same as old name
      if (newPath === oldPath) {
        logger.debug(`Skipping single rename for ${oldPath} - same name`);
        showToast('新名称与原名称相同，无需重命名', 'info');
        setIsRenameModalOpen(false);
        return;
      }

      // 回环防护：改名涉及的新旧路径登记进 touchedPathsRef（主进程 watcher 会立刻看到这次改名）
      markPathsTouched([oldPath, newPath]);

      let finalPath = newPath;
      let conflicted = false;
      try {
        const result = await window.electronAPI.renameFile(oldPath, newPath);
        logger.debug(`Single rename result:`, result);

        if (!result.ok) {
          logger.error('Failed to rename file:', result.error);
          // 文件已被外部删除 / 移动：自动从列表剔除，不再弹常规失败提示
          if (!fsGuard.handleGone([photo], result.error)) {
            showToast(`重命名「${photo.name}」失败：${humanizeFsError(result.error)}`, 'error');
          }
          return;
        }
        // 主进程在重名时可能自动追加了序号，一律以返回的最终路径为准
        finalPath = result.data.path || newPath;
        markPathsTouched([finalPath]);
        conflicted = Boolean(result.data.conflicted);
      } catch (electronError) {
        logger.error('Electron rename error:', electronError);
        const message = (electronError as Error).message;
        if (!fsGuard.handleGone([photo], message)) {
          showToast(`重命名「${photo.name}」失败：${humanizeFsError(message)}`, 'error');
        }
        return;
      }

      const actualName = finalPath.split(/[\\/]/).pop() || finalName;

      // 更新条目：pm:// 原图地址要跟着新路径走，缩略图按新路径重新生成
      setPhotos(prev => prev.map(p => {
        if (p.id === id) {
          return {
            ...p,
            name: actualName,
            path: finalPath,
            url: pmFileUrl(finalPath),
            thumbnail: undefined,
          };
        }
        return p;
      }));

      // 按路径存储的用户数据一起迁移：不迁移的话，重启后收藏 / 标签会全部丢失
      await persistPathData(rekeyPathData(oldPath, finalPath));

      if (conflicted) {
        showToast(`「${finalName}」已存在，已自动重命名为「${actualName}」`, 'warning');
      } else {
        showToast(`照片已重命名为 ${actualName}`, 'success');
      }
      setIsRenameModalOpen(false);
    } catch (err) {
      logger.error('Error renaming photo:', err);
      showToast(`重命名照片失败：${(err as Error).message}`, 'error');
    } finally {
      fileOpLockRef.current = false;
      // 操作期间抵达的外部变动事件此刻才应用（重命名的新路径已被去重，天然幂等）
      flushPendingWatcherEvents();
    }
  };

  // 日期格式化统一由 utils.formatDateForNaming 提供（与 RenameModal 预览共用同一实现）

  // Handle batch rename
  const handleBatchRename = async (options: RenameOptions) => {
    if (fileOpLockRef.current) return;
    fileOpLockRef.current = true;
    try {
      // Check if we're in Electron environment
      if (!window.electronAPI) {
        logger.error('Electron API not available');
        showToast('电子API不可用，无法执行重命名操作', 'error');
        return;
      }

      const selectedPhotos = Array.from(selectedIds).map(id => photos.find(p => p.id === id)).filter(Boolean);
      if (selectedPhotos.length === 0) {
        showToast('没有选择要重命名的照片', 'info');
        return;
      }

      // Sort photos by date to maintain consistent numbering
      const sortedPhotos = [...selectedPhotos].sort((a, b) => {
        // 与 RenameModal 的预览排序共用同一个时间语义，保证「预览即所得」
        return photoTakenTime(a!) - photoTakenTime(b!);
      });

      const updates: Array<{ id: string; oldPath: string; newName: string; newPath: string }> = [];
      // 只有同一个目录内才需要担心重名，不同文件夹下的同名文件互不影响
      const usedNames = new Set<string>();
      let renamedCount = 0;
      let unchangedCount = 0; // 名称本来就符合规则、无需改动
      let failedCount = 0;
      let conflictCount = 0; // 因重名被主进程自动追加序号的数量
      // 文件已被外部删除 / 移动的条目：剔除出列表，不算普通失败、不进失败汇总
      const gonePhotos: Photo[] = [];
      // 循环内不逐条弹 Toast（队列上限 4 条，会把汇总顶掉、还看不到是哪些失败），
      // 只留首个失败原因，结束后给一条统一汇总
      let firstError: string | null = null;

      // K19：批量重命名较慢时给出进度，避免看起来像卡死
      beginFileOp('正在重命名', '个项目', sortedPhotos.length);

      for (let i = 0; i < sortedPhotos.length; i++) {
        const photo = sortedPhotos[i];
        if (!photo) continue;
        reportFileOp(i, photo.name);

        // Check if photo has a valid path
        if (!photo.path || photo.path === '') {
          logger.error('Cannot rename photo without path:', photo.name);
          continue; // Skip photos without path (e.g., dragged files)
        }

        const fileExt = photo.name.split('.').pop();
        if (!fileExt) {
          logger.error('Cannot rename photo without file extension:', photo.name);
          failedCount++;
          firstError ??= `「${photo.name}」缺少文件扩展名`;
          continue;
        }

        let newName = '';

        if (options.mode === 'sequence') {
          // Generate sequential name with prefix and number
          const padding = options.numberPadding && options.numberPadding > 0 ? options.numberPadding : 3;
          newName = `${options.prefix}${(options.startNumber + i).toString().padStart(padding, '0')}.${fileExt}`;
        } else if (options.mode === 'replace') {
          // Replace text in filename
          let baseName = photo.name.replace(new RegExp(`\.${fileExt}$`), '');

          if (options.useRegex) {
            try {
              const regex = new RegExp(options.findText, 'g');
              baseName = baseName.replace(regex, options.replaceText);
            } catch (e) {
              logger.error('Invalid regex:', e);
              showToast('无效的正则表达式', 'error');
              return;
            }
          } else {
            baseName = baseName.split(options.findText).join(options.replaceText);
          }

          newName = `${baseName}.${fileExt}`;
        } else if (options.mode === 'date') {
          // Get the photo's creation date
          const photoDate = new Date(photoTakenTime(photo) || Date.now());

          // Format the date according to the specified format
          const dateStr = formatDateForNaming(photoDate, options.dateFormat || 'yyyy-MM-dd_HHmmss');

          // Generate base name with date（前缀可由用户自定义，默认 photo_）
          newName = `${options.datePrefix ?? 'photo_'}${dateStr}.${fileExt}`;
        } else if (options.mode === 'repair') {
          // 清理乱码 / 无意义名称：与弹窗预览共用同一实现，保证「预览即所得」
          const repairOptions = options.repair ?? {
            fixMojibake: true,
            stripJunkPrefix: true,
            stripCopyMarks: true,
            fallbackToDate: true,
            dateFormat: options.dateFormat,
            datePrefix: options.datePrefix,
          };
          newName = repairFileName(
            photo.name,
            repairOptions,
            photoTakenTime(photo)
          ).name;
        }

        // 批内重名统一处理：在扩展名前追加 _1、_2…（磁盘上同名由主进程兜底）
        const dirKey = folderOfPath(photo.path);
        {
          const dotIndex = newName.lastIndexOf('.');
          const stem = dotIndex > 0 ? newName.slice(0, dotIndex) : newName;
          const ext = dotIndex > 0 ? newName.slice(dotIndex) : '';
          let counter = 1;
          while (usedNames.has(`${dirKey}\u0000${newName}`)) {
            newName = `${stem}_${counter}${ext}`;
            counter++;
          }
        }

        // Sanitize filename to remove invalid characters
        newName = sanitizeFilename(newName);

        // Add to used names set
        usedNames.add(`${dirKey}\u0000${newName}`);

        // Rename the file using Electron API
        const oldPath = photo.path;
        logger.debug(`Attempting to rename: ${oldPath} to ${newName}`);

        const dirPath = folderOfPath(oldPath);
        const newPath = joinPath(dirPath, newName);
        logger.debug(`Generated new path: ${newPath}`);

        // Skip if new name is the same as old name
        if (newPath === oldPath) {
          logger.debug(`Skipping rename for ${oldPath} - same name`);
          unchangedCount++;
          continue;
        }

        // 回环防护：登记本次改名的新旧路径
        markPathsTouched([oldPath, newPath]);

        try {
          const result = await window.electronAPI.renameFile(oldPath, newPath);
          logger.debug(`Rename result:`, result);

          if (!result.ok) {
            logger.error('Failed to rename file:', result.error);
            if (isFileGoneError(result.error)) {
              gonePhotos.push(photo);
            } else {
              failedCount++;
              firstError ??= `「${photo.name}」${humanizeFsError(result.error)}`;
            }
            // Continue with other photos instead of failing all
            continue;
          }

          // 重名时主进程会自动追加序号，以返回的最终路径为准
          const finalPath = result.data.path || newPath;
          markPathsTouched([finalPath]);
          const actualName = finalPath.split(/[\\/]/).pop() || newName;
          if (result.data.conflicted) conflictCount++;

          updates.push({ id: photo.id, oldPath, newName: actualName, newPath: finalPath });
          renamedCount++;
        } catch (electronError) {
          logger.error('Electron rename error:', electronError);
          if (isFileGoneError((electronError as Error).message)) {
            gonePhotos.push(photo);
          } else {
            failedCount++;
            firstError ??= `「${photo.name}」${humanizeFsError((electronError as Error).message)}`;
          }
          continue;
        }
      }

      // Update all renamed photos in state
      if (updates.length > 0) {
        setPhotos(prev => prev.map(p => {
          const update = updates.find(u => u.id === p.id);
          if (update) {
            return {
              ...p,
              name: update.newName,
              path: update.newPath,
              url: pmFileUrl(update.newPath),
              thumbnail: undefined,
            };
          }
          return p;
        }));

        // 批量改名同样要做路径迁移：收藏 / 隐藏 / 标签 / 时间修正 / AI 缓存都按路径存储
        let changed = { video: false, ai: false };
        for (const update of updates) {
          const one = rekeyPathData(update.oldPath, update.newPath);
          changed = {
            video: changed.video || one.video,
            ai: changed.ai || one.ai,
          };
        }
        await persistPathData(changed);
      }

      // 文件已不在原位的条目：统一剔除（塌陷动画 + 收敛选中 + 收藏标签保留）
      if (gonePhotos.length > 0) fsGuard.reportGone(gonePhotos);

      const summaryParts: string[] = [];
      if (renamedCount > 0) summaryParts.push(`已重命名 ${renamedCount} 项`);
      if (unchangedCount > 0) summaryParts.push(`${unchangedCount} 项无需修改`);
      if (conflictCount > 0) summaryParts.push(`${conflictCount} 项因重名追加了序号`);
      // 失败项带上首个原因，让用户知道是「文件不见了」还是「没权限」
      if (failedCount > 0) {
        summaryParts.push(`${failedCount} 项失败${firstError ? `（如 ${firstError}）` : ''}`);
      }

      if (failedCount > 0) {
        showToast(summaryParts.join('，'), 'warning');
      } else if (summaryParts.length === 0) {
        // 全部条目因文件消失被剔除：reportGone 的提示已经说明，不再补一条误导性的「无需修改」
        if (gonePhotos.length === 0) showToast('没有需要修改的名称', 'info');
      } else {
        showToast(summaryParts.join('，'), 'success');
      }
      setIsRenameModalOpen(false);
    } catch (err) {
      logger.error('Error batch renaming photos:', err);
      showToast(`批量重命名照片失败：${(err as Error).message}`, 'error');
    } finally {
      endFileOp();
      fileOpLockRef.current = false;
      flushPendingWatcherEvents();
    }
  };

  /** 执行删除并反馈结果；失败项可在 Toast 上点「重试」再删一次 */
  const runDelete = async (targets: Photo[]) => {
    if (targets.length === 0) return;
    if (!window.electronAPI) {
      showToast('电子 API 不可用，无法执行删除操作', 'error');
      return;
    }

    // 回环防护：删除会让 watcher 看到一波 removed，登记后由双保险过滤掉
    markPathsTouched(targets.map(p => p.path));

    // K19：逐项回收站操作有真实进度可报，大库批量删除不再像卡死
    beginFileOp('正在移至回收站', '个项目', targets.length);
    let trash: TrashResult;
    try {
      trash = await movePhotosToTrash(targets, (done) => reportFileOp(done, ''));
    } finally {
      endFileOp();
    }
    const { deletedIds, failedPhotos, errors, pathlessRemoved } = trash;

    // 同步收敛状态：列表、选中项、重复检测结果
    if (deletedIds.size > 0) {
      // 磁盘上已经没有这个文件了，它残留的收藏 / 隐藏 / 标签 / 时间修正等按路径数据
      // 也要一并摘掉：否则日后同名的文件回到同一目录，会直接继承上一份标记
      //（最坏情况是「新导入的照片一进来就是隐藏状态，在库里根本找不到」）
      const removedPaths = targets
        .filter(p => deletedIds.has(p.id) && p.path)
        .map(p => p.path as string);
      await persistPathData(dropPathData(removedPaths));

      // 卡片先淡出再摘除：磁盘上的文件已经没了，但界面上要让人看见它离开
      removeWithCollapse(deletedIds);
      setSelectedIds(new Set());
      // 重复检测分组同步收敛（实现见 hooks/useDuplicateDetection）
      pruneDuplicateGroups(deletedIds);
    }

    // 无磁盘路径的条目（拖放降级预览）不会进回收站，必须说明，否则会给人「还能找回」的错觉
    const pathlessNote = pathlessRemoved > 0
      ? `，另有 ${pathlessRemoved} 项无磁盘文件，仅从列表移除`
      : '';

    // ENOENT 的失败项说明文件早已不在磁盘（外部删除 / 移动）：剔除条目，
    // 不进「重试」（重试只会再失败一次）；其余失败项维持原有重试入口
    const gonePhotos: Photo[] = [];
    const retryPhotos: Photo[] = [];
    const retryErrors: string[] = [];
    failedPhotos.forEach((photo, i) => {
      if (isFileGoneError(errors[i])) {
        gonePhotos.push(photo);
      } else {
        retryPhotos.push(photo);
        retryErrors.push(errors[i]);
      }
    });
    if (gonePhotos.length > 0) fsGuard.reportGone(gonePhotos);

    if (retryPhotos.length === 0) {
      showToast(`已将 ${deletedIds.size - pathlessRemoved} 张照片移至回收站${pathlessNote}`, 'success');
      return;
    }

    retryErrors.forEach(error => logger.error('删除失败：', error));
    const detail = retryErrors[0] + (retryErrors.length > 1 ? ` 等 ${retryErrors.length} 项` : '');
    const retryAction = { label: '重试', onClick: () => { void runDelete(retryPhotos); } };

    if (deletedIds.size > 0) {
      showToast(
        `已删除 ${deletedIds.size - pathlessRemoved} 张，${retryPhotos.length} 张失败${pathlessNote}：${detail}`,
        'warning',
        retryAction
      );
    } else {
      showToast(`删除失败：${detail}`, 'error', retryAction);
    }
  };

  // Handle delete photo
  const handleConfirmDelete = async () => {
    if (!window.electronAPI) {
      logger.error('Electron API not available');
      showToast('电子API不可用，无法执行删除操作', 'error');
      return;
    }

    const targets = Array.from(selectedIds)
      .map(id => photos.find(p => p.id === id))
      .filter((p): p is Photo => Boolean(p));
    if (targets.length === 0) {
      showToast('没有选择要删除的照片', 'info');
      return;
    }

    // 连点「移至回收站」会让第二轮拿着已删除的路径重试，整批失败并刷屏
    if (fileOpLockRef.current) return;
    fileOpLockRef.current = true;
    try {
      await runDelete(targets);
      setIsDeleteModalOpen(false);
    } finally {
      fileOpLockRef.current = false;
      flushPendingWatcherEvents();
    }
  };

  /**
   * 批量移动到指定文件夹。
   * 磁盘移动成功后，条目状态（路径 / 文件名 / pm:// 地址）与所有「按路径存储」
   * 的用户数据（收藏 / 隐藏 / 标签 / 日期修正 / 视频元数据 / AI 缓存）
   * 都要一起迁移，否则移动后这些标记会凭空消失。
   */
  const doRunMove = async (
    targets: Photo[],
    targetDir: string,
    /** K2 幂等重试：源路径 → 上次跨卷移动已落盘的副本路径（只补删源，不重复复制） */
    priorTargets?: Record<string, string>
  ) => {
    if (!window.electronAPI) {
      showToast('电子 API 不可用，无法执行移动操作', 'error');
      return;
    }

    // 拖放导入、尚未落盘的条目没有磁盘路径，无法参与文件移动
    const movable = targets.filter((p): p is Photo => Boolean(p.path));
    const pathlessCount = targets.length - movable.length;
    if (movable.length === 0) {
      showToast('所选项目没有磁盘路径，无法移动', 'warning');
      return;
    }

    // 回环防护：源路径的移出会被 watcher 看到，先登记（目标路径在拿到结果后登记）
    markPathsTouched(movable.map(p => p.path));

    const response = await window.electronAPI.moveFiles(
      movable.map(p => p.path as string),
      targetDir,
      priorTargets
    );
    if (!response.ok) {
      showToast(`移动失败：${response.error}`, 'error');
      return;
    }

    const result = response.data;
    const moved = result.results.filter(r => r.success && r.to);
    const skipped = result.results.filter(r => r.skipped);
    // K2 中间态：副本已落盘但源文件删除失败 —— 源仍在原位，列表条目保持不动，
    // 单独汇总并允许「重试」只补删源（回传 priorTargets，绝不重复复制）
    const partialPhotos: Photo[] = [];
    const partialRetryTargets: Record<string, string> = {};
    for (const r of result.results) {
      if (!r.partial) continue;
      const photo = movable.find(p => p.path === r.from);
      if (photo && r.to) {
        partialPhotos.push(photo);
        partialRetryTargets[r.from] = r.to;
      }
    }
    // 文件已被外部删除 / 移动：剔除条目，不进重试
    const gonePhotos: Photo[] = [];
    const failedResults: MoveFileResult[] = [];
    for (const r of result.results) {
      if (r.success || r.skipped || r.partial) continue;
      const photo = movable.find(p => p.path === r.from);
      if (isFileGoneError(r.error) && photo) {
        gonePhotos.push(photo);
      } else {
        failedResults.push(r);
      }
    }
    if (gonePhotos.length > 0) fsGuard.reportGone(gonePhotos);
    // 目标路径也登记：跨卷复制落盘同样会被 watcher 看到
    markPathsTouched([...moved.map(r => r.to), ...Object.values(partialRetryTargets)]);
    let conflictCount = 0;

    if (moved.length > 0) {
      // 旧路径 → 新路径；条目 id → 新路径与新文件名
      const pathMap = new Map<string, string>();
      const updates = new Map<string, { path: string; name: string }>();
      for (const r of moved) {
        if (!r.to) continue;
        pathMap.set(r.from, r.to);
        if (r.conflicted) conflictCount += 1;
        const photo = movable.find(p => p.path === r.from);
        if (photo) {
          updates.set(photo.id, {
            path: r.to,
            name: r.to.split(/[\\/]/).pop() || photo.name,
          });
        }
      }

      // 1) 列表条目跟随到新路径：pm:// 原图地址同步替换，缩略图按新路径重新生成
      setPhotos(prev => prev.map(p => {
        const next = updates.get(p.id);
        return next
          ? { ...p, path: next.path, name: next.name, url: pmFileUrl(next.path), thumbnail: undefined }
          : p;
      }));

      // 2) 迁移按路径存储的用户数据（收藏 / 隐藏 / 标签 / 时间修正 / 视频元数据 / AI 缓存）
      let changed = { video: false, ai: false };
      for (const [from, to] of pathMap) {
        const one = rekeyPathData(from, to);
        changed = {
          video: changed.video || one.video,
          ai: changed.ai || one.ai,
        };
      }
      await persistPathData(changed);
    }

    // 失败项映射回条目，供 Toast「重试」继续移动到同一目标
    const failedPhotos: Photo[] = failedResults
      .map(r => movable.find(p => p.path === r.from))
      .filter((p): p is Photo => Boolean(p));
    failedResults.forEach(r => logger.error('移动失败：', r.from, r.error));

    const dirName = targetDir.split(/[\\/]/).filter(Boolean).pop() || targetDir;
    const notes: string[] = [];
    if (conflictCount > 0) notes.push(`${conflictCount} 项重名已自动加序号`);
    if (skipped.length > 0) notes.push(`${skipped.length} 项已在该文件夹中`);
    if (pathlessCount > 0) notes.push(`${pathlessCount} 项无磁盘路径已跳过`);
    const noteText = notes.length > 0 ? `（${notes.join('，')}）` : '';

    // 重试集合 = 普通失败（正常重走移动）+ partial（回传 priorTargets 只补删源）；
    // 同一批里两类并存时，priorTargets 只作用于 partial 项，互不干扰
    const retryPhotos = [...failedPhotos, ...partialPhotos];
    const retryPriors = partialPhotos.length > 0 ? partialRetryTargets : undefined;
    const retryAction = retryPhotos.length > 0
      ? { label: '重试', onClick: () => { void runMove(retryPhotos, targetDir, retryPriors); } }
      : undefined;

    if (moved.length > 0 && retryPhotos.length === 0) {
      showToast(`已移动 ${moved.length} 项到「${dirName}」${noteText}`, 'success');
    } else if (moved.length > 0 || partialPhotos.length > 0) {
      const head = moved.length > 0
        ? `已移动 ${moved.length} 项到「${dirName}」`
        : `已复制 ${partialPhotos.length} 项到「${dirName}」`;
      const partialText = moved.length > 0 && partialPhotos.length > 0
        ? `，另有 ${partialPhotos.length} 项已复制到目标位置，但原文件删除失败`
        : '';
      const failText = failedPhotos.length > 0
        ? `，${failedPhotos.length} 项失败：${humanizeFsError(failedResults[0]?.error)}`
        : '';
      showToast(`${head}${failText}${partialText}${noteText}`, 'warning', retryAction);
    } else if (skipped.length > 0 && retryPhotos.length === 0) {
      showToast(`所选项目都已在「${dirName}」中，无需移动`, 'info');
    } else if (retryPhotos.length > 0) {
      const detail = humanizeFsError(failedResults[0]?.error);
      showToast(`移动失败：${detail}`, 'error', retryAction);
    }
    // else：全部条目已按「文件不在原位」剔除 —— reportGone 的提示已覆盖，不再补报错
  };

  /** 移动的提交锁包装：连点防护 + 操作期间抵达的 watcher 事件在锁释放后统一应用 */
  const runMove = async (
    targets: Photo[],
    targetDir: string,
    priorTargets?: Record<string, string>
  ) => {
    if (fileOpLockRef.current) return;
    fileOpLockRef.current = true;
    // K19：移动由主进程一次性完成，无法回报逐项进度，用不确定态说明「在处理 N 项」
    beginFileOp('正在移动文件', `${targets.length} 个项目`, 0);
    try {
      await doRunMove(targets, targetDir, priorTargets);
    } finally {
      endFileOp();
      fileOpLockRef.current = false;
      flushPendingWatcherEvents();
    }
  };

  /** 批量移动入口：先选目标文件夹（macOS 面板里可直接新建文件夹），再执行移动 */
  const handleMoveSelected = (targets?: Photo[]) => {
    if (!window.electronAPI) {
      showToast('电子 API 不可用，无法执行移动操作', 'error');
      return;
    }
    const chosen = targets
      ?? Array.from(selectedIds)
        .map(id => photos.find(p => p.id === id))
        .filter((p): p is Photo => Boolean(p));
    if (chosen.length === 0) {
      showToast('没有选择要移动的照片', 'info');
      return;
    }
    void (async () => {
      const dirRes = await window.electronAPI.chooseDirectory({ allowCreate: true });
      // 用户在文件夹面板里点了取消：ok(true) + data=null，属正常结果
      if (!dirRes.ok) {
        showToast(`无法打开文件夹面板：${dirRes.error}`, 'error');
        return;
      }
      if (!dirRes.data) return;
      await runMove(chosen, dirRes.data);
    })();
  };

  return { handleRenamePhoto, handleBatchRename, handleConfirmDelete, handleMoveSelected };
}
