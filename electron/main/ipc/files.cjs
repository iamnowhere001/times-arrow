/**
 * 文件类 IPC：重命名 / 删除 / 移动 / 导出 / 系统开放。
 *
 * 这个模块只做三件事：参数校验、路径授权、把结果翻译成 `IpcResult`。
 * 真正的写盘语义（不覆盖、原子占位、跨卷移动、partial 中间态）在 `../fs-ops.cjs`，
 * 预览与落盘共用同一套候选名序列 —— 拆开写必然漂移。
 *
 * 所有接收路径的 handler 入口都必须 `isPathAuthorized()`：
 * 渲染层能构造任意路径字符串，授权才是边界，参数校验不是。
 */
const { shell, clipboard, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const {
  uniqueNameCandidates,
  reserveUniquePath,
  discardReservedPath,
  isSameFile,
  isSameDirectory,
  moveAcrossDevices,
  resumePartialMove,
} = require('../fs-ops.cjs');

const rename = promisify(fs.rename);
const stat = promisify(fs.stat);
const writeFile = promisify(fs.writeFile);

/** 单次批量预演的条目上限：超过说明不是正常场景，避免一次 IPC 拖死主进程 */
const RENAME_PROBE_MAX = 500;

/**
 * 注册文件类通道。
 *
 * @param {object} deps
 * @param {(channel: string, handler: Function) => void} deps.handle 统一注册器（含异常兜底）
 * @param {(data?: unknown) => object} deps.ok
 * @param {(message: unknown, code?: string) => object} deps.fail
 * @param {object} deps.logger
 * @param {(p: string) => boolean} deps.isPathAuthorized
 * @param {string} deps.UNAUTHORIZED_ERROR
 * @param {(entry: object) => Promise<void>} deps.recordOperation 操作日志（撤销的依据）
 * @param {(p: string) => boolean} deps.isHeicFile
 * @param {(p: string) => Promise<Buffer>} deps.readHeicAsJpeg 带磁盘缓存的 HEIC 转换
 */
function createFileIpc({
  handle,
  ok,
  fail,
  logger,
  isPathAuthorized,
  UNAUTHORIZED_ERROR,
  recordOperation,
  isHeicFile,
  readHeicAsJpeg,
}) {
  // 重命名：目标不存在直接改；目标已存在（且不是自身）时自动追加序号，绝不覆盖
  handle('rename-file', async (event, oldPath, newPath) => {
    if (!oldPath || !newPath || typeof oldPath !== 'string' || typeof newPath !== 'string') {
      return fail('无效的文件路径');
    }
    // 源与目标都必须在已授权范围内：目标由 dirname(源) + 新文件名推出，
    // 正常路径必然通过；若渲染层传入越界的 newPath，则在此拦下。
    if (!isPathAuthorized(oldPath) || !isPathAuthorized(newPath)) {
      return fail(UNAUTHORIZED_ERROR);
    }

    // 目标就是源自身（仅大小写变化等）：无需任何落盘操作
    if (isSameFile(oldPath, newPath)) {
      return ok({ path: newPath, conflicted: false });
    }

    // 原子占位目标名：并发的两次重命名不会拿到同一个路径，也就不会互相覆盖。
    // 这里刻意不再用 existsSync 预判 —— 预判与 rename 之间的窗口正是竞态所在。
    const reservedPath = await reserveUniquePath(path.dirname(newPath), path.basename(newPath));
    const conflicted = reservedPath !== newPath;

    try {
      // POSIX 的 rename 会原子地替换已存在的目标 —— 而那个目标正是我们刚占下的占位文件，
      // 替换它是预期行为，不是覆盖用户数据。
      await rename(oldPath, reservedPath);
    } catch (error) {
      // 落盘失败：清掉占位文件，别在用户目录里留下空文件
      await discardReservedPath(reservedPath);
      throw error;
    }

    if (conflicted) {
      logger.debug(`Rename conflict: ${newPath} exists, using ${reservedPath}`);
    }
    logger.debug(`Renamed file: ${oldPath} -> ${reservedPath}`);
    await recordOperation({ type: 'rename', from: oldPath, to: reservedPath });
    return ok({ path: reservedPath, conflicted });
  });

  /**
   * K11：只读预演一组重命名的最终文件名。
   *
   * 预览阶段不能调 reserveUniquePath —— 那会真的创建占位文件（用户每改一次前缀就留一堆空文件）。
   * 这里按**完全相同**的候选名序列（原名 → base-1.ext → base-2.ext…）做只读 stat 探测，
   * 并把「批内已分配的名字」当作虚拟占用，得到与落盘一致的结论。
   *
   * 顺序语义：批量重命名是按 rows 顺序逐条落盘的，前一条改名后它的旧路径即腾空。
   * 用 freed 模拟这一点，否则「A 改成 B 的旧名」这类链式改名会预演出多余的 -1。
   *
   * 安全：源与目标路径都必须已授权，任一越界整体拒绝；不写盘、不返回目录列表，
   * 只回最终文件名，不能把这个接口当成「探测任意目录」的入口。
   */
  handle('probe-rename-targets', async (event, entries) => {
    if (!Array.isArray(entries)) return fail('无效的重命名预演参数');
    if (entries.length === 0) return ok([]);
    if (entries.length > RENAME_PROBE_MAX) return fail('待重命名的项目过多，无法预演');

    const plans = [];
    for (const entry of entries) {
      if (
        !entry ||
        typeof entry.oldPath !== 'string' ||
        typeof entry.desiredPath !== 'string' ||
        !entry.oldPath ||
        !entry.desiredPath
      ) {
        return fail('无效的重命名预演参数');
      }
      if (!isPathAuthorized(entry.oldPath) || !isPathAuthorized(entry.desiredPath)) {
        return fail(UNAUTHORIZED_ERROR);
      }
      plans.push(entry);
    }

    // macOS 默认大小写不敏感，占用集合统一按小写比较
    const reserved = new Set();
    const freed = new Set();
    const results = [];

    for (const { oldPath, desiredPath } of plans) {
      const dir = path.dirname(desiredPath);
      const fileName = path.basename(desiredPath);
      let finalName = fileName;
      let conflicted = false;

      // 目标就是源自身（含仅大小写变化）：rename-file 会直接返回，不算冲突
      if (desiredPath.toLowerCase() === oldPath.toLowerCase()) {
        results.push({ finalName, conflicted: false });
        reserved.add(desiredPath.toLowerCase());
        freed.add(oldPath.toLowerCase());
        continue;
      }

      for (const candidateName of uniqueNameCandidates(fileName)) {
        const candidate = path.join(dir, candidateName);
        const key = candidate.toLowerCase();
        // 与源自身同名的仅大小写变体，视为可用
        if (key === oldPath.toLowerCase()) {
          finalName = candidateName;
          break;
        }
        if (reserved.has(key)) {
          conflicted = true;
          continue;
        }
        let occupied = false;
        if (!freed.has(key)) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await stat(candidate);
            occupied = true;
          } catch {
            occupied = false;
          }
        }
        if (occupied) {
          conflicted = true;
          continue;
        }
        finalName = candidateName;
        break;
      }

      reserved.add(path.join(dir, finalName).toLowerCase());
      freed.add(oldPath.toLowerCase());
      results.push({ finalName, conflicted: conflicted || finalName !== fileName });
    }

    return ok(results);
  });

  handle('delete-file', async (event, filePath) => {
    if (!filePath || typeof filePath !== 'string') {
      return fail('无效的文件路径');
    }
    if (!isPathAuthorized(filePath)) {
      return fail(UNAUTHORIZED_ERROR);
    }

    // 先记下体积与修改时间：撤销时要靠它们从 ~/.Trash 里认出同一份文件
    const stat = await fs.promises.stat(filePath).catch(() => null);
    // Electron 官方回收站 API：跨平台、无 shell 注入风险
    await shell.trashItem(filePath);
    await recordOperation({
      type: 'delete',
      from: filePath,
      size: stat?.size,
      mtime: stat?.mtimeMs,
    });
    return ok(true);
  });

  /**
   * 批量移动文件到指定文件夹（整理图库用）。
   * - 源文件已在目标目录 → 跳过（skipped + reason='same-directory'）
   * - 目标已存在同名文件 → 自动追加序号（conflicted=true），绝不覆盖
   * - 跨磁盘 / 跨卷 → 复制后删除源文件；删源失败返回 partial 中间态（K2），
   *   渲染层重试时回传 priorTargets（源路径 → 已落盘副本路径），只补删源、绝不重复复制
   * 逐个串行执行：前一个落盘后后一个才能探测同名，避免批内互相覆盖。
   * 返回整体错误 + 每个文件独立结果，失败项由渲染进程组织重试。
   */
  handle('move-files', async (event, filePaths, targetDir, priorTargets) => {
    if (!Array.isArray(filePaths) || typeof targetDir !== 'string' || !targetDir) {
      return fail('无效的参数');
    }

    let targetStat;
    try {
      targetStat = await fs.promises.stat(targetDir);
    } catch {
      return fail('目标文件夹不存在');
    }
    if (!targetStat.isDirectory()) {
      return fail('目标位置不是文件夹');
    }
    // 目标目录必须已授权（来自「选择文件夹」对话框）；
    // 越界时整批拒绝，避免半批移动后才发现问题。
    if (!isPathAuthorized(targetDir)) {
      return fail(UNAUTHORIZED_ERROR);
    }

    const results = [];
    // 这个循环**必须**串行：每一项都要先原子占位、落盘之后，下一项才能正确探测同名。
    // 改成并发会让批内同名文件互相抢名字（也正是旧实现静默覆盖的成因之一）。
    /* eslint-disable no-await-in-loop */
    for (const srcPath of filePaths) {
      if (typeof srcPath !== 'string' || !srcPath) {
        results.push({ from: String(srcPath ?? ''), error: '无效的文件路径' });
        continue;
      }
      if (!isPathAuthorized(srcPath)) {
        results.push({ from: srcPath, error: UNAUTHORIZED_ERROR });
        continue;
      }

      // K2 重试幂等：上次「复制成功但删源失败」的残留副本优先补删源
      const priorTo =
        priorTargets && typeof priorTargets === 'object' ? priorTargets[srcPath] : null;
      if (typeof priorTo === 'string' && priorTo) {
        const resumed = await resumePartialMove(srcPath, priorTo);
        if (resumed) {
          if (resumed.ok) {
            logger.debug(`Resumed partial move: removed source ${srcPath}`);
            results.push({ from: srcPath, to: priorTo, success: true, resumed: true });
          } else {
            results.push({ from: srcPath, to: priorTo, partial: true, error: resumed.error });
          }
          continue;
        }
        // 副本缺失 / 体积不一致：残留副本不可信，回退正常移动流程
      }

      try {
        if (isSameDirectory(path.dirname(srcPath), targetDir)) {
          results.push({ from: srcPath, skipped: true, reason: 'same-directory' });
          continue;
        }

        const fileName = path.basename(srcPath);
        // 原子占位目标名：批内多个同名文件、或并发的另一次移动，都不会拿到同一路径。
        const destPath = await reserveUniquePath(targetDir, fileName);
        const conflicted = destPath !== path.join(targetDir, fileName);
        let finalDest = destPath;
        let partialMove = null;
        try {
          // 目标是我们刚占下的占位文件，POSIX rename 会原子替换它
          await rename(srcPath, destPath);
        } catch (err) {
          if (err.code === 'EXDEV') {
            // 跨卷：占位文件仍在，moveAcrossDevices 用普通 copyFile 覆写它
            partialMove = await moveAcrossDevices(srcPath, destPath);
            finalDest = partialMove.to;
          } else {
            // 其他失败：清掉占位文件，避免留下空文件
            await discardReservedPath(destPath);
            throw err;
          }
        }
        logger.debug(`Moved file: ${srcPath} -> ${finalDest}`);
        if (partialMove?.partial) {
          // 副本已落盘但源未删除：条目留在原位（源仍在），渲染层提示可重试
          results.push({ from: srcPath, to: finalDest, partial: true, error: partialMove.error });
          continue;
        }
        results.push({
          from: srcPath,
          to: finalDest,
          success: true,
          conflicted,
        });
      } catch (error) {
        logger.error('Error moving file:', error);
        results.push({ from: srcPath, error: error.message });
      }
    }
    /* eslint-enable no-await-in-loop */

    await Promise.all(
      results
        .filter((r) => r.success && r.to)
        .map((r) => recordOperation({ type: 'move', from: r.from, to: r.to }))
    );
    return ok({ results });
  });

  // 在访达 / 资源管理器中定位文件
  handle('show-in-folder', async (event, filePath) => {
    if (!filePath || typeof filePath !== 'string') {
      return fail('无效的文件路径');
    }
    if (!isPathAuthorized(filePath)) {
      return fail(UNAUTHORIZED_ERROR);
    }
    shell.showItemInFolder(filePath);
    return ok(true);
  });

  // 复制图片到系统剪贴板（HEIC 先转 JPEG）
  handle('copy-image', async (event, filePath) => {
    if (!filePath || typeof filePath !== 'string') {
      return fail('无效的文件路径');
    }
    if (!isPathAuthorized(filePath)) {
      return fail(UNAUTHORIZED_ERROR);
    }
    let image = nativeImage.createFromPath(filePath);
    if (image.isEmpty() && isHeicFile(filePath)) {
      image = nativeImage.createFromBuffer(await readHeicAsJpeg(filePath));
    }
    if (image.isEmpty()) {
      return fail('无法读取图片');
    }
    clipboard.writeImage(image);
    return ok(true);
  });

  // 复制纯文本（如文件路径）到系统剪贴板
  handle('copy-text', async (event, text) => {
    if (!text || typeof text !== 'string') {
      return fail('无效的文本');
    }
    clipboard.writeText(text);
    return ok(true);
  });

  // 用系统默认应用 / 外部编辑器打开文件
  handle('open-path', async (event, filePath) => {
    if (!filePath || typeof filePath !== 'string') {
      return fail('无效的文件路径');
    }
    if (!isPathAuthorized(filePath)) {
      return fail(UNAUTHORIZED_ERROR);
    }
    const openError = await shell.openPath(filePath);
    if (openError) {
      return fail(openError);
    }
    return ok(true);
  });

  // 写入二进制文件（base64）。同名冲突时自动追加序号，返回最终写入路径。
  // 用于批量导出：渲染进程 canvas 完成格式转换后落盘。
  handle('write-file-unique', async (event, targetDir, fileName, base64) => {
    if (!targetDir || !fileName || typeof base64 !== 'string') {
      return fail('无效的参数');
    }
    if (!isPathAuthorized(targetDir)) {
      return fail(UNAUTHORIZED_ERROR);
    }
    await fs.promises.access(targetDir);

    // 只取文件名部分：否则 ../ 前缀能让 path.join 把文件写到授权目录之外
    const safeName = path.basename(fileName);
    if (!safeName || safeName === '.' || safeName === '..') {
      return fail('无效的文件名');
    }

    // 原子占位：并发导出同名文件时不会互相覆盖（名字一旦占下就是本次调用独有的）
    const finalPath = await reserveUniquePath(targetDir, safeName);
    try {
      await writeFile(finalPath, Buffer.from(base64, 'base64'));
    } catch (error) {
      // 写入失败：清掉占位文件，否则用户会看到一个 0 字节的「导出成功」
      await discardReservedPath(finalPath);
      throw error;
    }
    await recordOperation({ type: 'export', to: finalPath });
    return ok({ path: finalPath });
  });
}

module.exports = { createFileIpc };
