/**
 * 重复照片检测：全局哈希 + 精确分组 + 受控的相似度聚类。
 *
 * ## 为什么要单独成模块
 * 这一块原先占 `utils/index.ts` 的一半（约 500 行），却与「格式化字节数」
 * 「乱码修复」挤在同一个文件里。它自己有完整的一套概念（候选预筛、体积聚类、
 * 并查集归组、进度上报、取消语义），值得独立成一个可读、可测的单元。
 *
 * ## 流程
 * 0. **体积预筛**：只有「与其它照片体积接近」的图片才有可能成组，其余直接跳过解码；
 * 1. **计算哈希**：三级降级（渲染层并行解码 → 主进程 nativeImage → canvas 兜底）；
 * 2. **精确分组**：一次 Map 分组，O(n)；
 * 3. **近似聚类**：仅在体积相近的簇内两两比较，用并查集归组。
 *
 * 全程可取消，并在比对分片之间让出主线程 —— 否则大库检测期间列表滚动会明显卡顿。
 */

import { Photo } from '@/types';
import { BASE_THUMB_SIZE, cachedThumbUrl } from '@/lib/cache/thumbCache';
import { mapWithConcurrency, yieldToMain } from '@/lib/concurrency';
import { compareByOriginalTime } from '@/lib/media/photoTime';
import { isVideoPhoto } from '@/lib/media/mediaTypes';
import {
  imageHashCache,
  hashKeyOf,
  hammingDistance,
  getImageHashFast,
  getHashWithCache,
} from '@/lib/media/photoHash';

export type HashedEntry = { photo: Photo; hash: string };

export type DuplicateScanPhase = 'hashing' | 'comparing' | 'done';

/** 重复检测进度：张数、阶段、已用时与预计剩余时间 */
export interface DuplicateScanProgress {
  /** 已处理张数（含缓存命中与预筛跳过） */
  processed: number;
  /** 参与检测的图片总数 */
  total: number;
  /** 需要计算指纹的张数（已排除体积唯一被跳过的图片） */
  candidates: number;
  /** 命中缓存、无需重算的张数 */
  cached: number;
  /** 因体积唯一而跳过比对的张数 */
  skipped: number;
  /** 已耗时（毫秒） */
  elapsedMs: number;
  /** 预计剩余毫秒；无法估算时为 undefined */
  etaMs?: number;
  phase: DuplicateScanPhase;
}

export type DuplicateProgressHandler = (progress: DuplicateScanProgress) => void;

/** 渲染进程并行解码的并发度：Chromium 的解码在工作线程上执行，适度并行即可跑满 CPU */
const HASH_CONCURRENCY = 6;
/** 主进程同一批处理的张数：分批既能让进度条实时走动，也避免单次 IPC 长时间不返回 */
const HASH_IPC_BATCH = 64;
/** 快速路径熔断阈值：前若干张全部失败即认为该环境不支持，不再重试 */
const FAST_PATH_PROBE_LIMIT = 6;

/** 快速解码路径是否可用：null 表示尚未探测 */
let fastHashAvailable: boolean | null = null;

/** 并查集：O(n·α(n)) 归并相似图片 */
class UnionFind {
  private parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[x] !== root) {
      const next = this.parent[x];
      this.parent[x] = root;
      x = next;
    }
    return root;
  }

  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

// 单个体积簇内参与「近似匹配」的上限，超过则只保留精确匹配（防止 O(n²) 退化）
const SIMILAR_CLUSTER_LIMIT = 150;

/**
 * 按文件大小聚类，把近似比较限制在体积相近的候选集内。
 *
 * ⚠️ 实现语义与「±10%」这个常见说法有出入：它是**以簇内最小体积为锚点**做
 * `|size - anchor| / anchor <= 0.1`。因为先排了序，实际可容纳区间是
 * `[anchor, anchor × 1.1]` —— 上界只有 +10%，下界是 0，**不对称**。
 *
 * 导出仅为可测试：簇边界怎么切直接决定重复检测的召回与误报
 * （见 tests/unit/repairAndCluster.test.ts）。
 */
export const clusterBySize = (entries: HashedEntry[]): HashedEntry[][] => {
  const sorted = [...entries].sort((a, b) => (a.photo.size || 0) - (b.photo.size || 0));
  const clusters: HashedEntry[][] = [];
  let current: HashedEntry[] = [];
  let anchor = 0;

  for (const entry of sorted) {
    const size = entry.photo.size || 0;
    if (current.length === 0) {
      current.push(entry);
      anchor = size;
      continue;
    }
    if (anchor > 0 && Math.abs(size - anchor) / anchor <= 0.1) {
      current.push(entry);
    } else {
      clusters.push(current);
      current = [entry];
      anchor = size;
    }
  }

  if (current.length > 0) clusters.push(current);
  return clusters;
};

/**
 * 标注「建议保留」的原始照片，并把组内按时间升序排列，
 * 让最早的原图固定出现在第一位，方便用户直接对比拷贝。
 */
export const markRecommended = (group: Photo[]): Photo[] => {
  const sorted = [...group].sort(compareByOriginalTime);
  const recommended = sorted[0];
  return sorted.map(photo => ({ ...photo, isRecommended: photo.id === recommended.id }));
};

/**
 * 补全 dHash（按快慢依次降级）：
 * 1. 渲染进程 createImageBitmap —— 解码期直接缩放到 9x8，并行执行，最快；
 * 2. 主进程 nativeImage —— 可复用已落盘缩略图，覆盖浏览器解不了的格式；
 * 3. 渲染进程 <img> + canvas —— SVG 等最后的兜底。
 * 每完成一批就回调一次，保证进度与剩余时间实时更新。
 *
 * 全程支持取消：大库跑一半用户点「取消」时，不应继续占用 CPU / 内存。
 */
async function precomputeHashes(
  photos: Photo[],
  onProgressDelta: (count: number) => void,
  shouldCancel: () => boolean
): Promise<void> {
  const pending: Photo[] = [];

  for (const photo of photos) {
    if (imageHashCache.has(hashKeyOf(photo))) onProgressDelta(1);
    else pending.push(photo);
  }
  if (pending.length === 0) return;

  // 1) 浏览器并行解码（主要提速路径）
  const unresolved: Photo[] = [];
  let fastAttempts = 0;
  let fastFailures = 0;

  await mapWithConcurrency(
    pending,
    HASH_CONCURRENCY,
    async photo => {
      // 已有磁盘缩略图时优先用它做源：解码 320px 小图远比把整张原图拉进内存划算，
      // 也顺带复用了网格已经解析过的那份缓存（不产生额外 IPC）
      const source =
        photo.thumbnail || (photo.path ? cachedThumbUrl(photo.path, BASE_THUMB_SIZE) : '') || photo.url;
      if (fastHashAvailable === false || !source) {
        unresolved.push(photo);
        return;
      }
      fastAttempts += 1;
      try {
        const hash = await getImageHashFast(source);
        if (!hash) throw new Error('empty hash');
        fastHashAvailable = true;
        imageHashCache.set(hashKeyOf(photo), hash);
        onProgressDelta(1);
      } catch {
        fastFailures += 1;
        // 前若干张全部失败 → 判定当前环境不支持，余下直接走兜底，避免整轮无效重试
        if (fastAttempts >= FAST_PATH_PROBE_LIMIT && fastFailures === fastAttempts) {
          fastHashAvailable = false;
        }
        unresolved.push(photo);
      }
    },
    shouldCancel
  );

  if (unresolved.length === 0 || shouldCancel()) return;

  // 2) 主进程兜底（分批，可复用磁盘缩略图）
  const withPath = unresolved.filter(photo => photo.path);
  const attempted = new Set<string>();

  if (window.electronAPI && withPath.length > 0) {
    for (let start = 0; start < withPath.length; start += HASH_IPC_BATCH) {
      if (shouldCancel()) return;
      const slice = withPath.slice(start, start + HASH_IPC_BATCH);
      let hashes: Array<string | null> | null = null;
      try {
        const response = await window.electronAPI.getImageHashes(slice.map(photo => photo.path as string));
        hashes = response.ok ? response.data : null;
      } catch {
        hashes = null;
      }
      // 主进程不可用：本批不做标记，交给下面的逐张兜底
      if (!hashes || hashes.length !== slice.length) break;

      hashes.forEach((hash, index) => {
        const photo = slice[index];
        attempted.add(photo.id);
        if (hash) imageHashCache.set(hashKeyOf(photo), hash);
      });
      onProgressDelta(slice.length);
    }
  }

  // 3) 渲染进程 <img> + canvas 兜底（SVG 等）
  const lastResort = unresolved.filter(photo => !attempted.has(photo.id));
  if (lastResort.length === 0) return;

  await mapWithConcurrency(
    lastResort,
    HASH_CONCURRENCY,
    async photo => {
      await getHashWithCache(photo);
      onProgressDelta(1);
    },
    shouldCancel
  );
}

/**
 * 体积预筛：只有「与其它照片体积接近」的图片才有可能成组。
 *
 * clusterBySize 的簇跨度不会超过簇内最小体积的 +10%，
 * 因此某张图若能成组，必然存在另一张与它相差 ≤10%（以较小者为基准）的图片。
 * 排序后只需比较相邻两张即可判定：与前后邻座都不接近的图片
 * 永远不可能出现在重复组里，可以直接跳过哈希计算
 * —— 几千张库中往往能省掉一大半解码。
 * 体积未知（0）的图片不做判断，始终参与检测。
 */
const selectHashCandidates = (photos: Photo[]): { candidates: Photo[]; skipped: number } => {
  const sized: Photo[] = [];
  const unknownSize: Photo[] = [];

  for (const photo of photos) {
    if ((photo.size || 0) > 0) sized.push(photo);
    else unknownSize.push(photo);
  }

  if (sized.length < 2) return { candidates: photos, skipped: 0 };

  const sorted = [...sized].sort((a, b) => (a.size || 0) - (b.size || 0));
  const within10Percent = (smaller: number, larger: number) =>
    smaller > 0 && (larger - smaller) / smaller <= 0.1;

  const candidates: Photo[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const size = sorted[i].size || 0;
    const prevSize = i > 0 ? sorted[i - 1].size || 0 : 0;
    const nextSize = i < sorted.length - 1 ? sorted[i + 1].size || 0 : 0;

    if (
      (i > 0 && within10Percent(prevSize, size)) ||
      (i < sorted.length - 1 && within10Percent(size, nextSize))
    ) {
      candidates.push(sorted[i]);
    }
  }

  return {
    candidates: [...candidates, ...unknownSize],
    skipped: sized.length - candidates.length,
  };
};

/** 重复检测被中止（用户取消 / 关闭页面）时抛出 */
export class DuplicateScanAbortError extends Error {
  constructor() {
    super('duplicate scan aborted');
    this.name = 'DuplicateScanAbortError';
  }
}

/** 判断异常是否为「检测被取消」——取消是预期行为，不应弹错误提示 */
export const isDuplicateScanAbort = (error: unknown): boolean =>
  error instanceof DuplicateScanAbortError ||
  (typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError');

/** 重复检测可调参数 */
export interface DuplicateDetectOptions {
  /** 汉明距离阈值，按 bit 计（dHash 为 64 bit，10 以内视为相似）；值越大匹配越宽松 */
  threshold?: number;
  /** 仅把「同一目录内」的照片视为重复（默认 false：全库跨目录比对） */
  sameFolderOnly?: boolean;
  /**
   * 取消信号。abort 后检测会在下一个分片边界停下并抛出 DuplicateScanAbortError。
   * 大库检测耗时较长，没有它时用户点取消后任务仍会在后台跑完，持续占用 CPU 与内存。
   */
  signal?: AbortSignal;
}

/** 每处理多少个体积簇让出一次主线程：两两比对是同步长任务，不让出会让滚动 / 点击明显卡顿 */
const CLUSTER_YIELD_EVERY = 8;

/** 取照片所在目录（无磁盘路径时归入同一空桶） */
export const photoFolder = (photo: Photo): string => {
  const p = photo.path;
  if (!p) return '';
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx > 0 ? p.slice(0, idx) : p;
};

/** 按目录把一组重复拆开，仅保留同目录内仍 ≥2 张的子组 */
const splitGroupByFolder = (group: Photo[]): Photo[][] => {
  const buckets = new Map<string, Photo[]>();
  for (const photo of group) {
    const dir = photoFolder(photo);
    const bucket = buckets.get(dir);
    if (bucket) bucket.push(photo);
    else buckets.set(dir, [photo]);
  }
  return [...buckets.values()].filter(bucket => bucket.length > 1).map(markRecommended);
};

/**
 * 查找重复照片。
 * - 先做体积预筛，只对可能有重复的图片计算 dHash（并行解码 + 跨调用缓存）
 * - 精确相同：一次 Map 分组，O(n)
 * - 近似相似：仅在「体积相近」的候选簇内两两比较，并用并查集归组
 * - 全程可取消（signal），并在比对分片之间让出主线程
 *
 * @param options 阈值与目录范围（兼容旧签名：直接传 number 视为 threshold）
 */
export const findDuplicatePhotos = async (
  photos: Photo[],
  options: DuplicateDetectOptions | number = {},
  onProgress?: DuplicateProgressHandler
): Promise<Photo[][]> => {
  // 视频不参与重复检测：逐帧比对既慢又无意义
  photos = photos.filter(photo => !isVideoPhoto(photo));
  if (photos.length < 2) return [];

  const { threshold = 10, sameFolderOnly = false, signal } =
    typeof options === 'number' ? { threshold: options, sameFolderOnly: false, signal: undefined } : options;

  const shouldCancel = () => signal?.aborted === true;
  const assertLive = () => {
    if (shouldCancel()) throw new DuplicateScanAbortError();
  };

  const startedAt = Date.now();
  const total = photos.length;

  // 0) 体积预筛：不可能有重复的图片直接跳过
  const { candidates, skipped } = selectHashCandidates(photos);

  let cached = 0;
  for (const photo of candidates) {
    if (imageHashCache.has(hashKeyOf(photo))) cached += 1;
  }

  const needCompute = candidates.length;
  let computed = 0;
  let lastEmitAt = 0;

  const report = (phase: DuplicateScanPhase, force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastEmitAt < 100) return;
    lastEmitAt = now;

    const elapsedMs = now - startedAt;
    const etaMs =
      phase === 'hashing' && computed > 0 && computed < needCompute && elapsedMs > 300
        ? Math.round((elapsedMs / computed) * (needCompute - computed))
        : undefined;

    onProgress({
      processed: skipped + computed,
      total,
      candidates: needCompute,
      cached,
      skipped,
      elapsedMs,
      etaMs,
      phase,
    });
  };

  report('hashing', true);

  // 1) 并行计算哈希（每完成一批上报一次进度）
  await precomputeHashes(
    candidates,
    delta => {
      computed += delta;
      report('hashing');
    },
    shouldCancel
  );
  assertLive();

  computed = needCompute;
  report('hashing', true);

  // 2) 精确相同分组
  report('comparing', true);

  const entries: HashedEntry[] = [];
  for (const photo of photos) {
    const hash = imageHashCache.get(hashKeyOf(photo));
    if (hash) entries.push({ photo, hash });
  }

  const exactBuckets = new Map<string, HashedEntry[]>();
  for (const entry of entries) {
    const bucket = exactBuckets.get(entry.hash);
    if (bucket) {
      bucket.push(entry);
    } else {
      exactBuckets.set(entry.hash, [entry]);
    }
  }

  const duplicates: Photo[][] = [];
  const consumed = new Set<string>();

  for (const bucket of exactBuckets.values()) {
    if (bucket.length < 2) continue;
    const group = bucket.map(entry => ({ ...entry.photo, hash: entry.hash }));
    group.forEach(photo => consumed.add(photo.id));
    duplicates.push(markRecommended(group));
  }

  // 3) 近似相似聚类（仅在体积相近的簇内）
  const remaining = entries.filter(entry => !consumed.has(entry.photo.id));

  let handledClusters = 0;
  for (const cluster of clusterBySize(remaining)) {
    assertLive();
    if (cluster.length < 2 || cluster.length > SIMILAR_CLUSTER_LIMIT) continue;

    const uf = new UnionFind(cluster.length);
    for (let i = 0; i < cluster.length; i++) {
      for (let j = i + 1; j < cluster.length; j++) {
        if (hammingDistance(cluster[i].hash, cluster[j].hash) <= threshold) {
          uf.union(i, j);
        }
      }
    }

    const groups = new Map<number, HashedEntry[]>();
    for (let i = 0; i < cluster.length; i++) {
      const root = uf.find(i);
      const bucket = groups.get(root) || [];
      bucket.push(cluster[i]);
      groups.set(root, bucket);
    }

    for (const bucket of groups.values()) {
      if (bucket.length < 2) continue;
      duplicates.push(markRecommended(bucket.map(entry => ({ ...entry.photo, hash: entry.hash }))));
    }

    // 大库下「逐簇两两比对」是一长串同步任务，定期让出主线程，避免列表滚动被卡住
    handledClusters += 1;
    if (handledClusters % CLUSTER_YIELD_EVERY === 0) await yieldToMain();
  }

  report('done', true);

  // 仅同目录模式：把跨目录聚合出的重复组按目录重新拆开
  return sameFolderOnly ? duplicates.flatMap(splitGroupByFolder) : duplicates;
};
