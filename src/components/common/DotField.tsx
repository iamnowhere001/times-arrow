import React, { useMemo } from 'react';
import { buildDotPath, buildLandGrid, buildUniformGrid } from '@/lib/geo/dotField';

/**
 * 点阵语言的渲染层（K30）。
 *
 * `landMask` 原本只服务地图底图的 canvas，是本项目唯一「别人没有」的视觉资产。
 * 这里把它做成可复用的 React 组件，让首屏空状态、加载占位、地图相关图标都能
 * 取用同一套语言 —— 点阵因此从「地图的一个实现细节」变成「产品的身份标记」。
 *
 * 渲染统一走单条 `<path>`：上千个点逐个 `<rect>` 是上千个 DOM 节点，
 * 合成一条 path 只有一个，且与 `LocationMap` 里 Path2D 的画法同源。
 */

interface LandDotFieldProps {
  /** 目标列数（真实列数由 720 宽的掩码按步长反推，略有出入） */
  cols?: number;
  /** 纬度裁剪：首屏构图裁掉南极那块实心白，观感更像一张世界地图 */
  latRange?: { north: number; south: number };
  className?: string;
  /** 点的不透明度：底纹要退后，主角要立住 */
  opacity?: number;
  /** 点边长占网格单位的比例，默认与 buildDotPath 一致 */
  dotSize?: number;
}

/**
 * 世界陆地点阵。
 *
 * 用法上是「一张图」而不是「一个图标」：给它宽度，高度按网格宽高比自适应。
 * `aria-hidden` —— 它对屏幕阅读器没有信息量，文案负责语义。
 */
export const LandDotField: React.FC<LandDotFieldProps> = ({
  cols = 96,
  latRange,
  className,
  opacity = 1,
  dotSize = 0.78,
}) => {
  const { d, viewBox, aspect } = useMemo(() => {
    const grid = buildLandGrid(cols, latRange);
    return {
      d: buildDotPath(grid, dotSize),
      viewBox: `0 0 ${grid.cols} ${grid.rows}`,
      aspect: grid.cols / grid.rows,
    };
  }, [cols, latRange?.north, latRange?.south, dotSize]);

  return (
    <svg
      aria-hidden="true"
      viewBox={viewBox}
      className={className}
      style={{ aspectRatio: String(aspect), opacity }}
      preserveAspectRatio="xMidYMid meet"
      fill="currentColor"
    >
      <path d={d} />
    </svg>
  );
};

interface DotGridProps {
  /** 列数 */
  cols?: number;
  /** 行数 */
  rows?: number;
  className?: string;
  opacity?: number;
}

/**
 * 均匀点阵底纹：无语义，只作「点阵语言」的底噪。
 * 用于加载占位这类需要一点质感、但不应传达信息的场合。
 */
export const DotGrid: React.FC<DotGridProps> = ({ cols = 24, rows = 6, className, opacity = 1 }) => {
  const { d, viewBox, aspect } = useMemo(() => {
    const grid = buildUniformGrid(cols, rows);
    return {
      d: buildDotPath(grid, 0.62),
      viewBox: `0 0 ${grid.cols} ${grid.rows}`,
      aspect: grid.cols / grid.rows,
    };
  }, [cols, rows]);

  return (
    <svg
      aria-hidden="true"
      viewBox={viewBox}
      className={className}
      style={{ aspectRatio: String(aspect), opacity }}
      preserveAspectRatio="xMidYMid meet"
      fill="currentColor"
    >
      <path d={d} />
    </svg>
  );
};

/**
 * 点阵构成的定位销（7 × 9 位图）。
 *
 * 侧栏的「按地点浏览」此前是线稿三折地图 —— 与地图底图的点阵语言各说各话。
 * 换成点阵销钉后，入口与它打开的那张地图用的是同一种颗粒。
 */
const PIN_BITMAP = [
  '..###..',
  '.#####.',
  '#######',
  '##...##',
  '##...##',
  '#######',
  '.#####.',
  '..###..',
  '...#...',
];

const PIN_PATH = (() => {
  const size = 0.78;
  const inset = (1 - size) / 2;
  let out = '';
  PIN_BITMAP.forEach((line, row) => {
    line.split('').forEach((ch, col) => {
      if (ch !== '#') return;
      out += `M${col + inset} ${row + inset}h${size}v${size}h${-size}z`;
    });
  });
  return out;
})();

/** 点阵定位销图标：与侧栏其它图标同尺寸（18px），viewBox 7 × 9 */
export const DotPinIcon = ({ size = 18 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 7 9"
    fill="none"
    aria-hidden="true"
  >
    <path d={PIN_PATH} fill="currentColor" />
  </svg>
);

export default LandDotField;
