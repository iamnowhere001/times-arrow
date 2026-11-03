import React from 'react';

/**
 * 跨文件复用的通用图标 —— 唯一入口（CODE_REVIEW 的 N13 / D4）。
 *
 * 这些图形此前在多个组件里各复制了一份：同一段 path 抄成两三处之后，
 * 改动只会落到其中一处，视觉语言就开始悄悄漂移（最典型的是同款
 * 「视频时长角标」在两个视图里一个 `10px`、一个 `9.5px`）。
 *
 * 收录标准只有一条：**图形本身相同、且已被两处以上使用**。
 * 因此这里刻意保持很小 ——
 *   - 与业务语义强绑定的图形（地图销钉、点阵语言、品牌光圈）留在各自模块，
 *     它们的差异是有意为之，强行共用反而会互相牵制；
 *   - 只在单处出现的图标也不往这里搬，避免把这里变成第二个「什么都往里放」
 *     的角落（这正是当初 `utils/index.ts` 的教训）。
 *
 * 尺寸差异通过 `size` / `strokeWidth` 参数表达，不在这里写死。
 */
interface IconProps {
  /** 边长（px）。默认值取各图标最常用的一档 */
  size?: number;
  /** 线宽。只影响描边类图标 */
  strokeWidth?: number;
  className?: string;
}

/** 返回 / 上一级：左向箭头。用于整页视图的返回按钮 */
export const ChevronLeftIcon: React.FC<IconProps> = ({ size = 18, strokeWidth = 2, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

/**
 * 刷新 / 重置：环形箭头。
 * 「重新检测」与「清空列表」共用同一图形 —— 两者对用户都是「从头再来一次」。
 */
export const RefreshIcon: React.FC<IconProps> = ({ size = 16, strokeWidth = 1.8, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
);

/** 筛选：漏斗。顶栏入口与条件条共用 */
export const FunnelIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 1.9, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
  </svg>
);

/** 新增 / 放大：加号。侧栏「添加入口」与地图缩放共用 */
export const PlusIcon: React.FC<IconProps> = ({ size = 14, strokeWidth = 2.2, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    className={className}
  >
    <path d="M12 5v14M5 12h14" />
  </svg>
);
