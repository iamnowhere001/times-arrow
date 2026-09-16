import React from 'react';

/**
 * 统计数字的排版规范（K29）。
 *
 * 「库里有 12,480 张照片」「可清理 3.2 GB」这类数字是全应用最有说服力的内容，
 * 此前它们散落在各处、各自写着 `text-xs text-[var(--text-tertiary)]`，
 * 结果是：最有分量的信息长着最没有分量的样子。
 *
 * 规范只有三条：
 *   1. 数字一律 `font-numeric` + `tabular-nums`（见 styles.css），纵向对齐、位数不跳；
 *   2. 数字与单位分级：数字高一档字重、单位低一档颜色，读起来是「12,480 张」而不是「12480张」；
 *   3. 三档存在感 —— `hero` 独占一行作结论、`inline` 嵌在句子里、`micro` 只做旁注。
 *      同一屏里只允许一个 `hero`，多了就等于没有重点。
 */

/** 数量级：决定字号与颜色档位 */
export type StatEmphasis = 'hero' | 'inline' | 'micro';

const NUMBER_CLASS: Record<StatEmphasis, string> = {
  hero: 'text-[22px] font-semibold leading-none tracking-[-0.01em] text-[var(--text-primary)]',
  inline: 'text-[13px] font-semibold text-[var(--text-primary)]',
  micro: 'text-[11.5px] font-medium text-[var(--text-secondary)]',
};

/** 单位比数字低一档：数字是主角，单位只是它的量纲 */
const UNIT_CLASS: Record<StatEmphasis, string> = {
  hero: 'text-[12px] font-medium text-[var(--text-tertiary)]',
  inline: 'text-[11.5px] font-medium text-[var(--text-tertiary)]',
  micro: 'text-[11px] font-medium text-[var(--text-tertiary)]',
};

const GAP_CLASS: Record<StatEmphasis, string> = {
  hero: 'gap-1.5',
  inline: 'gap-1',
  micro: 'gap-0.5',
};

interface StatProps {
  /** 已经格式化好的数值（如 `12,480` / `3.2`） */
  value: React.ReactNode;
  /** 单位（如 `张` / `GB` / `个地点`）。与数值之间留一个细缝，不紧贴 */
  unit?: string;
  /** 数字前的说明（如 `共`）。保持极短，长了就说明这个数字不该放在这里 */
  label?: string;
  emphasis?: StatEmphasis;
  className?: string;
  /** 无障碍：默认整块作为一个可读单元播报 */
  ariaLabel?: string;
}

/**
 * 统计数字。数字与单位共用一条基线（`items-baseline`），
 * 不同字号混排时才不会一个飘高一个沉底。
 */
export const Stat: React.FC<StatProps> = ({
  value,
  unit,
  label,
  emphasis = 'inline',
  className,
  ariaLabel,
}) => (
  <span
    className={`inline-flex items-baseline whitespace-nowrap font-numeric tabular-nums ${GAP_CLASS[emphasis]} ${className ?? ''}`}
    aria-label={ariaLabel}
  >
    {label && <span className={UNIT_CLASS[emphasis]}>{label}</span>}
    <span className={NUMBER_CLASS[emphasis]}>{value}</span>
    {unit && <span className={UNIT_CLASS[emphasis]}>{unit}</span>}
  </span>
);

interface StatPillProps {
  /** 已格式化的数值 */
  value: React.ReactNode;
  unit?: string;
  /** 胶囊前缀图标（如地点销钉） */
  icon?: React.ReactNode;
  /**
   * 语气色。默认 `neutral`（旁注）；`accent` 给「可清理 X GB」这类
   * 要被看见的结论；一屏内最多一个 accent。
   */
  tone?: 'neutral' | 'accent';
  title?: string;
  className?: string;
}

const PILL_TONE = {
  neutral:
    'bg-[var(--bg-glass)] border-[var(--border-subtle)] text-[var(--text-secondary)]',
  accent:
    'bg-[rgba(var(--accent-pink-rgb),0.16)] border-[rgba(var(--accent-pink-rgb),0.35)] text-[var(--accent-pink)]',
} as const;

/** 胶囊形态的统计：用于顶栏 / 情境条这类需要成组排布的位置 */
export const StatPill: React.FC<StatPillProps> = ({
  value,
  unit,
  icon,
  tone = 'neutral',
  title,
  className,
}) => (
  <span
    title={title}
    className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${PILL_TONE[tone]} ${className ?? ''}`}
  >
    {icon}
    <span className="inline-flex items-baseline gap-1 font-numeric tabular-nums">
      <span className="font-semibold">{value}</span>
      {unit && <span className="opacity-70">{unit}</span>}
    </span>
  </span>
);

export default Stat;
