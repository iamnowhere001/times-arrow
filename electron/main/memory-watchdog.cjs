/**
 * 内存看门狗。
 *
 * ## 为什么主进程要自己盯内存
 *
 * 主进程持有磁盘缩略图索引与感知哈希缓存，通常比渲染进程更早感知到整机内存吃紧；
 * 而渲染进程一旦被 OOM kill，用户看到的是「窗口白了一下」，没有任何可操作的线索。
 *
 * ## 两级回收
 *
 * - 软（1.2GB 起）：裁掉一部分感知哈希缓存（最容易只增不减的常驻缓存）；
 * - 硬（2GB 起）：大幅裁剪 + 触发缩略图磁盘缓存清理；
 * 两种情况都会广播 `memory-pressure` 给渲染进程做统一释放，但**带 2 分钟冷却** ——
 * 高压期间每 60s 打断一次渲染进程，反而会让它更卡。
 */
const MEMORY_WATCH_INTERVAL = 60_000;
/** 1.2GB 起软性回收（裁缓存），2GB 起硬性回收（清空易失缓存） */
const MEMORY_SOFT_RSS = 1.2 * 1024 * 1024 * 1024;
const MEMORY_HARD_RSS = 2 * 1024 * 1024 * 1024;
/** 广播冷却：避免高压期间每 60s 都打断渲染进程 */
const MEMORY_NOTIFY_COOLDOWN = 120_000;

/**
 * @param {object} deps
 * @param {object} deps.logger
 * @param {{ send: Function }} deps.win
 * @param {(ratio: number) => void} deps.trimHashCache 主进程感知哈希缓存裁剪
 * @param {() => void} deps.scheduleThumbPrune 缩略图磁盘缓存清理
 * @returns {NodeJS.Timeout} 未 ref 的定时器（不阻止进程退出）
 */
function startMemoryWatchdog({ logger, win, trimHashCache, scheduleThumbPrune }) {
  let lastMemoryNotifyAt = 0;

  const timer = setInterval(() => {
    let usage;
    try {
      usage = process.memoryUsage();
    } catch {
      return;
    }

    const rss = usage.rss || 0;
    if (rss < MEMORY_SOFT_RSS) return;

    const level = rss >= MEMORY_HARD_RSS ? 'hard' : 'soft';
    // 先自己瘦身：感知哈希是主进程里最容易只增不减的常驻缓存
    trimHashCache(level === 'hard' ? 0.25 : 0.6);
    if (level === 'hard') scheduleThumbPrune();

    const now = Date.now();
    if (now - lastMemoryNotifyAt < MEMORY_NOTIFY_COOLDOWN) return;
    lastMemoryNotifyAt = now;

    logger.warn(`[memory] pressure(${level}) rss=${Math.round(rss / 1048576)}MB`);
    try {
      win.send('memory-pressure', level);
    } catch {
      /* 窗口已关闭 */
    }
  }, MEMORY_WATCH_INTERVAL);
  timer.unref?.();
  return timer;
}

module.exports = { startMemoryWatchdog };
