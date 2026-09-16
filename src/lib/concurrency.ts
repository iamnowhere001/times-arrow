/**
 * 并发受控的异步工具。
 *
 * 抽成独立模块是因为它被多个领域共用（缩略图哈希、元数据补齐、批量文件操作），
 * 原先挂在 `utils/index.ts` 里，导致任何想用它的人都得依赖那个 1000 行的文件。
 */

/**
 * 并发受控的 map：限制同时进行的任务数，避免一次性解码 / IPC 造成内存或句柄尖峰。
 *
 * 与 `Promise.all(items.map(...))` 的区别就是那个上限 —— 几千张图同时解码会直接把内存打满。
 * 与「分批 await」的区别是不会在批与批之间空等：某批先跑完就立刻领下一项，
 * 因此总耗时更接近 `总工作量 / 并发度` 而不是 `批数 × 最慢一批`。
 *
 * @param shouldStop 返回 true 时停止领取新任务（用于取消）。**已在跑的任务不被打断** ——
 *   强行中断解码这类操作反而容易留下半初始化状态，让它们自然跑完更安全。
 *   注意返回数组里被跳过的位置是 `undefined`，调用方需要自行判空。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  shouldStop?: () => boolean
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(Math.max(concurrency, 1), items.length) }, async () => {
    while (cursor < items.length) {
      if (shouldStop?.()) return;
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

/** 让出主线程一个宏任务：让滚动 / 点击这类交互有机会插进来 */
export const yieldToMain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
