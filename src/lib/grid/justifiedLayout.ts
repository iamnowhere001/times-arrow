import type { Photo } from '@/types';

/**
 * 网格的「唯一几何入口」：justified 行布局 + 行定位。
 *
 * 从 ImageGrid.tsx 抽出来的原因不止是文件太大 —— 行宽一旦超过内容区就会撑出
 * 横向滚动条，而这类几何错误只能靠纯函数用例钉住（渲染层测不到 clientWidth
 * 与 padding 的差值）。布局常量与 ImageCard 的 className 必须成对修改，见
 * tests/unit/gridLayout.test.ts 的静态断言。
 */

/** 卡片内边距（单边）：对应 ImageCard 的 `p-px` = 1px */
export const CARD_PADDING = 1;
/** 卡片中图片区之外占用的固定高度：只剩上下内边距 */
export const CARD_CHROME_HEIGHT = CARD_PADDING * 2;
/** 卡片间距：加上两侧内边距后，相邻图片净留白 4px */
export const GRID_GAP = 2;

/** 尺寸未知时的兜底比例（宽 / 高） */
const FALLBACK_IMAGE_ASPECT = 4 / 3;
/** 极端长图 / 全景的比例钳制，避免单张卡片把整行撑得不可用 */
const MIN_IMAGE_ASPECT = 0.2;
const MAX_IMAGE_ASPECT = 5;
/** 行高下限：太矮的缩略图没有辨识度 */
const MIN_ROW_HEIGHT = 48;

export interface GridCell {
  photo: Photo;
  left: number;
  width: number;
}

export interface GridRow {
  top: number;
  /** 图片区高度（不含内边距 / 名称行） */
  height: number;
  cells: GridCell[];
}

export interface GridLayout {
  rows: GridRow[];
  /** 下标与 items 对齐：每一项所在的行号 */
  rowOfItem: number[];
  totalHeight: number;
}

/**
 * 取照片的展示宽高比。
 * 手机截屏（约 9:19.5）、竖幅人像、全景都会被如实保留 —— 长图因此得到更高的卡片，
 * 配合图片区的 object-contain，画面内容（含截屏里的文字）不会被裁掉。
 */
export function photoAspect(photo: Photo): number {
  const dim = photo.dimensions;
  if (!dim || !dim.width || !dim.height) return FALLBACK_IMAGE_ASPECT;
  const aspect = dim.width / dim.height;
  if (!Number.isFinite(aspect) || aspect <= 0) return FALLBACK_IMAGE_ASPECT;
  return Math.min(MAX_IMAGE_ASPECT, Math.max(MIN_IMAGE_ASPECT, aspect));
}

/**
 * 居中行布局（justified rows，类似 Google Photos / Flickr）：
 * 按原始顺序把照片逐行铺满容器宽度，同一行共用行高、宽度按各自比例分配。
 * 好处：排序顺序不变、行内不留空隙、每张卡片的比例与照片一致（不裁切内容）。
 *
 * `containerWidth` 必须是**内容区可用宽度**（已扣掉滚动容器的横向 padding），
 * 不是 `clientWidth`。后者含 padding，直接拿来铺行会让最右一张越出内容区。
 *
 * 不变式：任意输入下，每行右边界 <= containerWidth（浮点误差除外）。
 * 行高的一切钳制都不得越过 `fitHeight`，否则行宽必然反超容器宽度。
 */
export function buildGridLayout(
  items: Photo[],
  containerWidth: number,
  targetRowHeight: number,
  gap: number = GRID_GAP
): GridLayout {
  const rows: GridRow[] = [];
  const rowOfItem: number[] = new Array(items.length);
  if (containerWidth <= 0 || items.length === 0) {
    return { rows, rowOfItem, totalHeight: 0 };
  }

  let buffer: Array<{ photo: Photo; aspect: number; index: number }> = [];
  let ratioSum = 0;
  let top = 0;

  const flush = (stretch: boolean) => {
    if (buffer.length === 0) return;
    // 解 sum(aspect) * h + 内边距 + 间距 = 容器宽度，得到「恰好铺满」的图片区高度
    const chrome = CARD_PADDING * 2 * buffer.length + gap * (buffer.length - 1);
    const fitHeight = Math.max(1, (containerWidth - chrome) / ratioSum);
    // 末行不满时不做拉伸，避免寥寥几张被放大得离谱
    let height = stretch ? fitHeight : Math.min(fitHeight, targetRowHeight);
    // 单张极端竖图不该把行撑得比容器还高
    height = Math.min(height, containerWidth);
    // 下限不能反过来突破 fitHeight：窄窗口 + 超宽全景图时会让整行超宽
    height = Math.max(height, Math.min(MIN_ROW_HEIGHT, fitHeight));

    let left = 0;
    const cells: GridCell[] = buffer.map((entry) => {
      const width = entry.aspect * height + CARD_PADDING * 2;
      const cell: GridCell = { photo: entry.photo, left, width };
      left += width + gap;
      rowOfItem[entry.index] = rows.length;
      return cell;
    });

    rows.push({ top, height, cells });
    top += height + CARD_CHROME_HEIGHT + gap;
    buffer = [];
    ratioSum = 0;
  };

  for (let i = 0; i < items.length; i += 1) {
    const aspect = photoAspect(items[i]);
    buffer.push({ photo: items[i], aspect, index: i });
    ratioSum += aspect;
    const chrome = CARD_PADDING * 2 * buffer.length + gap * (buffer.length - 1);
    // 本行已「矮」到目标行高以下 → 收行
    if ((containerWidth - chrome) / ratioSum <= targetRowHeight) flush(true);
  }
  flush(false);

  return { rows, rowOfItem, totalHeight: rows.length > 0 ? top - gap : 0 };
}

/** 二分查找：返回 top <= y 的最后一行下标 */
export function findRowAt(rows: GridRow[], y: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].top <= y) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
