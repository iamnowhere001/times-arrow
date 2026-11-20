/**
 * 目录监听（N5）：轻量感知图库目录的外部增删。
 *
 * ## 为什么主进程只做「过滤 + 防抖」
 *
 * macOS 下 `fs.watch` 的 recursive 基于 FSEvents：一次「重命名」会同时产生 add + remove
 * 一对事件，整目录拷入会形成事件风暴。如果把语义判定（新增 / 移除 / 回环防护）也放在
 * 主进程，就要在这里维护一份与渲染层并行的图库状态 —— 两套状态必然漂移。
 *
 * 所以边界是：主进程只做「按扩展名过滤 → 聚合去重 → 防抖后一次性投递」，
 * 语义判定全部交给渲染层，它才持有唯一可信的图库。
 *
 * ## 两个时序细节
 *
 * - 尾沿 500ms 防抖，避免连续事件刷爆 IPC；
 * - 3s maxWait 强制截断，避免「持续有事件」时永远不 flush。
 */
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const stat = promisify(fs.stat);

const WATCH_DEBOUNCE_MS = 500;
const WATCH_MAX_WAIT_MS = 3000;

/**
 * @param {object} deps
 * @param {(channel: string, handler: Function) => void} deps.handle
 * @param {(data?: unknown) => object} deps.ok
 * @param {(message: unknown, code?: string) => object} deps.fail
 * @param {object} deps.logger
 * @param {(dir: string) => void} deps.authorizeRoot 监听目录属于当前图库，一并授权
 * @param {(p: string) => boolean} deps.isMediaFile
 * @param {{ send: Function }} deps.win
 */
function createDirWatcher({ handle, ok, fail, logger, authorizeRoot, isMediaFile, win }) {
  let dirWatcher = null;
  let watchedDir = null;
  /** absolutePath → 最近一次事件类型（Map 天然去重，同路径只保留一条） */
  const pendingWatchEvents = new Map();
  let watchFlushTimer = null;
  let watchFlushMaxTimer = null;

  /** 关闭当前 watcher 并清空全部聚合状态 */
  function stop() {
    if (dirWatcher) {
      try {
        dirWatcher.close();
      } catch {
        // 已关闭 / 已失效时 close 可能抛错，忽略
      }
      dirWatcher = null;
    }
    watchedDir = null;
    pendingWatchEvents.clear();
    if (watchFlushTimer) {
      clearTimeout(watchFlushTimer);
      watchFlushTimer = null;
    }
    if (watchFlushMaxTimer) {
      clearTimeout(watchFlushMaxTimer);
      watchFlushMaxTimer = null;
    }
  }

  /** 防抖 flush：500ms 尾沿；事件持续到达时由 3s maxWait 强制截断 */
  function scheduleFlush() {
    if (watchFlushTimer) clearTimeout(watchFlushTimer);
    watchFlushTimer = setTimeout(() => {
      watchFlushTimer = null;
      flush();
    }, WATCH_DEBOUNCE_MS);
    if (!watchFlushMaxTimer) {
      watchFlushMaxTimer = setTimeout(() => {
        watchFlushMaxTimer = null;
        if (watchFlushTimer) {
          clearTimeout(watchFlushTimer);
          watchFlushTimer = null;
        }
        flush();
      }, WATCH_MAX_WAIT_MS);
    }
  }

  /** 聚合分类后一次性发给渲染层：stat 成功的文件 → added；目录 → addedDirs；ENOENT → removed */
  function flush() {
    if (!watchedDir || pendingWatchEvents.size === 0) return;

    const added = [];
    const addedDirs = [];
    const removed = [];
    const paths = [...pendingWatchEvents.keys()];
    pendingWatchEvents.clear();

    for (const filePath of paths) {
      try {
        const s = fs.statSync(filePath);
        if (s.isFile()) added.push(filePath);
        else if (s.isDirectory()) addedDirs.push(filePath); // 目录被拖入监听范围，交渲染层走扫描管线
      } catch (error) {
        if (error.code === 'ENOENT') removed.push(filePath);
        // EACCES 等无法判定的忽略，避免误删列表
      }
    }

    if (added.length === 0 && addedDirs.length === 0 && removed.length === 0) return;
    logger.debug(
      `[watch] ${watchedDir}: +${added.length} files, +${addedDirs.length} dirs, -${removed.length}`
    );
    win.send('directory-changed', {
      dir: watchedDir,
      added,
      addedDirs,
      removed,
    });
  }

  handle('watch-directory', async (event, dirPath) => {
    if (typeof dirPath !== 'string' || !dirPath) {
      return fail('无效的目录路径');
    }
    const resolved = path.resolve(dirPath);
    if (watchedDir === resolved && dirWatcher) {
      return ok({ already: true });
    }
    stop();
    try {
      const dirStat = await stat(dirPath);
      if (!dirStat.isDirectory()) {
        return fail('路径不是文件夹');
      }
      // 监听目录意味着它属于当前图库，一并授权
      authorizeRoot(dirPath);
      watchedDir = resolved;
      dirWatcher = fs.watch(resolved, { recursive: true }, (type, relPath) => {
        if (!watchedDir || !relPath) return;
        const base = path.basename(relPath);
        if (base.startsWith('.')) return; // .DS_Store / ._* / 临时文件
        const full = path.join(resolved, relPath);
        if (!isMediaFile(full)) return;
        pendingWatchEvents.set(full, type);
        scheduleFlush();
      });
      // 目录被外部删除 / 卷被卸载时 macOS 多报 EPERM / ENOENT：停止监听并告知渲染层
      dirWatcher.on('error', (watchError) => {
        logger.warn(`[watch] watcher error on ${watchedDir}:`, watchError);
        const erroredDir = watchedDir;
        stop();
        win.send('directory-watch-error', {
          dir: erroredDir,
          code: watchError?.code,
        });
      });
      logger.debug(`[watch] watching ${resolved}`);
      return ok({ already: false });
    } catch (error) {
      logger.error('Error watching directory:', error);
      // 监听失败后必须清掉半初始化状态，否则下一次 watch 会因为 watchedDir 残留而误判为「已在监听」
      stop();
      throw error;
    }
  });

  handle('unwatch-directory', async () => {
    stop();
    return ok(true);
  });

  return { stop };
}

module.exports = { createDirWatcher };
