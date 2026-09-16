/**
 * 点阵语言的纯几何层。
 *
 * `landMask.ts` 的位图是本项目的视觉资产（0.5° 陆地掩码），此前只有
 * `LocationMap` 的 canvas 底图用到它。这里把它采样成可直接渲染的点阵，
 * 供首屏空状态 / 加载占位 / 地图相关图标复用 —— 三处与地图底图读同一份
 * 数据，轮廓必然一致，这正是「点阵语言贯穿」的前提。
 *
 * 只做几何，不碰 DOM：返回的是格子坐标（列 / 行），渲染层再决定用什么
 * 单位画（SVG 的 viewBox 与 canvas 的像素都可以直接吃）。
 */
import { LAND_MASK_HEIGHT, LAND_MASK_WIDTH, isLandCell } from './landMask';

/** 单个点：格子坐标（整数），渲染时按所在网格的单位换算 */
export interface Dot {
  col: number;
  row: number;
}

/** 一个点阵网格：尺寸 + 点列表 */
export interface DotGrid {
  cols: number;
  rows: number;
  dots: readonly Dot[];
}

/** 纬度裁剪区间（度）。默认不裁剪；首屏构图会裁掉南极那块实心白 */
export interface LatRange {
  /** 北界（度，含） */
  north: number;
  /** 南界（度，含） */
  south: number;
}

/** 纬度 → 行号。掩码 y=0 对应北纬 90°，共 360 行覆盖 180°，即每度 2 行 */
const rowFromLat = (lat: number): number =>
  Math.round(((90 - lat) / 180) * LAND_MASK_HEIGHT);

/** 采样步长：按目标列数反推，至少 1 格 */
const stepFromCols = (targetCols: number): number =>
  Math.max(1, Math.round(LAND_MASK_WIDTH / Math.max(1, targetCols)));

const gridCache = new Map<string, DotGrid>();

/**
 * 均匀点阵：cols × rows 全填满。用于加载占位这类「无语义的底纹」。
 */
export const buildUniformGrid = (cols: number, rows: number): DotGrid => {
  const dots: Dot[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) dots.push({ col, row });
  }
  return { cols, rows, dots };
};

/**
 * 陆地点阵：按目标列数把 `landMask` 采样成点。
 *
 * 结果按 `targetCols` + 纬度区间缓存 —— 同一份参数在首屏 / 空状态 /
 * 图标里会被多处取用，没必要每次重新遍历 720 × 360。
 */
export const buildLandGrid = (targetCols: number, range?: LatRange): DotGrid => {
  const north = range?.north ?? 90;
  const south = range?.south ?? -90;
  const key = `${targetCols}|${north}|${south}`;
  const cached = gridCache.get(key);
  if (cached) return cached;

  const step = stepFromCols(targetCols);
  const rowStart = Math.max(0, rowFromLat(north));
  const rowEnd = Math.min(LAND_MASK_HEIGHT - 1, rowFromLat(south));
  const rows = Math.floor((rowEnd - rowStart) / step) + 1;

  const dots: Dot[] = [];
  for (let y = rowStart; y <= rowEnd; y += step) {
    const row = (y - rowStart) / step;
    for (let x = 0; x < LAND_MASK_WIDTH; x += step) {
      if (!isLandCell(x, y)) continue;
      dots.push({ col: x / step, row });
    }
  }

  // 列数由步长反推，不用 LAND_MASK_WIDTH / step：后者在不能整除时会超出一格
  const cols = Math.floor((LAND_MASK_WIDTH - 1) / step) + 1;
  const grid: DotGrid = { cols, rows, dots };
  gridCache.set(key, grid);
  return grid;
};

/**
 * 把点阵编译成一条 SVG path。
 *
 * 上千个点若逐个渲染成 <rect> 就是上千个 DOM 节点；合成单条 path 只有
 * 一个节点，且与 `LocationMap` 里 Path2D 的画法同一心智。
 *
 * @param grid 点阵
 * @param size 点的边长（网格单位）。默认 0.78：留 0.22 的缝隙，
 *   密排时读起来才是一片点而不是一块实底。
 */
export const buildDotPath = (grid: DotGrid, size = 0.78): string => {
  const inset = (1 - size) / 2;
  let out = '';
  for (const dot of grid.dots) {
    const x = dot.col + inset;
    const y = dot.row + inset;
    // 方点，与地图底图一致（不用圆点：圆点在 0.5px 级会糊成灰雾）
    out += `M${x} ${y}h${size}v${size}h${-size}z`;
  }
  return out;
};
