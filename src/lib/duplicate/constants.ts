/**
 * 相似照片检测的阈值常量。
 *
 * 放在 lib/ 而不是 DuplicateDetector.tsx：阈值既是 UI 滑块的取值范围，
 * 也是 hook（`useAppConfig` / `useDuplicateDetection`）的默认值与校验依据。
 * 让 hook 反向依赖展示组件是层次倒置，因此把领域常量下沉到 lib。
 */

/**
 * 阈值对外以「相似度百分比」暴露，内部再换算成汉明距离（bit）。
 * dHash 只有 64 bit，相似度低于 80%（距离 > 12 bit）时两组照片通常只是构图相近，
 * 已经不能叫「相似照片」—— 再松下去就是碰运气，所以下限收在 80%；
 * 想「只找完全相同的」把滑块拖到 100% 即可。
 */
export const DUPLICATE_SIMILARITY_MIN = 80;
export const DUPLICATE_SIMILARITY_MAX = 100;
export const DUPLICATE_SIMILARITY_DEFAULT = 90;

/** 相似度下限 → 汉明距离上限。向下取整，保证界面「≥ N%」这句话是真的 */
export const similarityToDistance = (similarity: number): number =>
  Math.max(0, Math.floor((100 - similarity) * (64 / 100)));
