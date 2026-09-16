/**
 * 渲染层通用工具 —— **统一出口**。
 *
 * ## 这个文件现在的角色
 * 它曾经是一个 1024 行的「什么都往里放」的文件：媒体类型判定、格式化、
 * 乱码修复、dHash、重复检测、并发控制全挤在一起。想看 `formatBytes` 得先翻过
 * 500 行哈希聚类代码，改动风险与阅读成本都很高。
 *
 * 现在每个领域各自成模块，这里只做**再导出**，从而：
 *   - 既有 `from '@/utils'` 的引用**一行都不用改**（迁移零破坏）；
 *   - 新代码应当直接 import 具体模块（`@/lib/media/photoHash` 等），
 *     这样依赖关系才是显式的，也不会因为碰了 barrel 而牵连整个依赖图。
 *
 * 具体模块划分：
 * | 领域 | 模块 |
 * |---|---|
 * | 路径与文件名 | `@/lib/fs/pathUtils` |
 * | 媒体类型判定与智能分类 | `@/lib/media/mediaTypes` |
 * | 展示格式化 | `@/lib/format/format` |
 * | 照片时间语义 | `@/lib/media/photoTime` |
 * | 感知哈希（dHash / 汉明距离） | `@/lib/media/photoHash` |
 * | 文件名清理与乱码修复 | `@/lib/media/filenameRepair` |
 * | 并发控制 | `@/lib/concurrency` |
 * | 重复检测 | `@/lib/duplicate/duplicateDetection` |
 * | File → base64 | `@/lib/fs/fileToBase64` |
 */

// 路径与文件名
export { folderOfPath, extOfName, pmFileUrl } from '@/lib/fs/pathUtils';

// 媒体类型判定与智能分类
export {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  isVideoName,
  isImageName,
  mediaKindOf,
  mediaMimeType,
  isVideoPhoto,
  isVideoPlaybackUncertain,
} from '@/lib/media/mediaTypes';

// 展示格式化
export { formatBytes, formatDate, formatVideoDuration, formatDateForNaming } from '@/lib/format/format';

// 照片时间语义
export { photoOriginalTime, photoTakenTime, compareByOriginalTime } from '@/lib/media/photoTime';

// 感知哈希
export {
  getImageHash,
  getImageHashFast,
  hammingDistance,
  clearImageHashCache,
  hashKeyOf,
  getHashWithCache,
} from '@/lib/media/photoHash';

// 文件名清理与乱码修复
export {
  looksLikeMojibake,
  fixMojibakeOnce,
  fixMojibake,
  repairFileName,
  type RepairedName,
} from '@/lib/media/filenameRepair';

// 并发控制
export { mapWithConcurrency } from '@/lib/concurrency';

// 重复检测
export {
  clusterBySize,
  markRecommended,
  findDuplicatePhotos,
  isDuplicateScanAbort,
  DuplicateScanAbortError,
  type HashedEntry,
  type DuplicateScanPhase,
  type DuplicateScanProgress,
  type DuplicateProgressHandler,
  type DuplicateDetectOptions,
} from '@/lib/duplicate/duplicateDetection';

// File → base64
export { fileToBase64 } from '@/lib/fs/fileToBase64';
