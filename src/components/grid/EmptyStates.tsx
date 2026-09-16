import React from 'react';
import { LandDotField } from '@/components/common/DotField';
import { Stat } from '@/components/common/Stat';
// 种类定义与判定都在 lib 里（见 libraryViewState.ts），组件只负责按种类挑图形与语气
import type { EmptyKind } from '@/lib/filter/libraryViewState';

export type { EmptyKind };

/**
 * 图库的六种空状态（K27）。
 *
 * 此前六种共用一个模板，只是换了文案：第一印象（完全为空的首屏）与
 * 「搜不到」「筛不到」这类过程态长着同一张脸。而首屏是这块界面里唯一
 * 一整屏、且尚未被任何内容占据的画布 —— 它值得被单独设计一次。
 *
 * 于是这里分成两种：
 *   - `WelcomeEmptyState`：首屏。用点阵世界地图作主视觉（K30 的视觉资产），
 *     标题 + 说明 + 能力要点 + 一个主行动，把它当成封面而不是提示框；
 *   - `QuietEmptyState`：其余五种。保持克制（一个小图形 + 一行结论 + 一个出口），
 *     但按 `kind` 区分语气 —— 搜索与筛选是「没找到」，隐藏与收藏是「这里还空着」，
 *     两者不该用同一种颜色说话。
 */

/** 语气色：图形的底色与描边。冷 = 没找到；暖 = 还没开始；粉 = 与收藏有关 */
type Tone = 'cold' | 'neutral' | 'warm' | 'heart';

const TONE_CLASS: Record<Tone, string> = {
  cold: 'bg-[rgba(var(--accent-blue-rgb),0.07)] text-[var(--text-tertiary)] border-[rgba(var(--accent-blue-rgb),0.14)]',
  neutral: 'bg-[var(--bg-glass)] text-[var(--text-tertiary)] border-[var(--border-subtle)]',
  warm: 'bg-[rgba(var(--accent-blue-rgb),0.12)] text-[var(--accent-blue)] border-[rgba(var(--accent-blue-rgb),0.28)]',
  heart: 'bg-[rgba(var(--accent-pink-rgb),0.12)] text-[var(--accent-pink)] border-[rgba(var(--accent-pink-rgb),0.28)]',
};

/** 每种空状态一个图形：不用同一张「空照片」，否则六种状态又变回一张脸 */
const Glyph: React.FC<{ kind: Exclude<EmptyKind, 'library'> }> = ({ kind }) => {
  const common = {
    width: 26,
    height: 26,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (kind) {
    case 'search':
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="7" />
          <line x1="16.5" y1="16.5" x2="21" y2="21" />
        </svg>
      );
    case 'filter':
      return (
        <svg {...common}>
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="6" y1="12" x2="18" y2="12" />
          <line x1="10" y1="18" x2="14" y2="18" />
        </svg>
      );
    case 'media':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2.5" />
          <circle cx="9" cy="10" r="1.6" />
          <polyline points="21 15.5 16 10.5 5 19" />
        </svg>
      );
    case 'allHidden':
    case 'hiddenEmpty':
      return (
        <svg {...common}>
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
          <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
          <line x1="2" y1="2" x2="22" y2="22" />
        </svg>
      );
    case 'favorites':
      return (
        <svg {...common}>
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
        </svg>
      );
  }
};

const KIND_TONE: Record<Exclude<EmptyKind, 'library'>, Tone> = {
  search: 'cold',
  filter: 'cold',
  media: 'neutral',
  allHidden: 'warm',
  hiddenEmpty: 'neutral',
  favorites: 'heart',
};

/* ------------------------------------------------------------------ */
/* 首屏：唯一一整屏的空白，按封面设计                                    */
/* ------------------------------------------------------------------ */

/** 首屏的能力要点：回答「这个应用是什么」，不是罗列功能 */
const WELCOME_POINTS = [
  {
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    ),
    label: '纯本地处理',
  },
  {
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    ),
    label: '拖入文件夹',
  },
  {
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="18" rx="2" />
        <path d="M9 17L4 12l5-5m6 10l5-5-5-5" />
      </svg>
    ),
    label: '图片 & 视频',
  },
];

interface WelcomeEmptyStateProps {
  title: string;
  description: string;
  onImport?: () => void;
}

/**
 * 首屏空状态。
 *
 * 主视觉是点阵世界地图 —— 它同时是「按地点浏览」底图的语言（K30），
 * 因此首屏不只是一次性插画：它预告了这个应用会把照片落到地图上去。
 * 点阵用极淡的琥珀，不抢标题，也不做动画（首屏已经有一次交错入场）。
 */
export const WelcomeEmptyState: React.FC<WelcomeEmptyStateProps> = ({
  title,
  description,
  onImport,
}) => (
  <div className="flex flex-col items-center text-center">
    {/* 点阵地图：裁掉南极那块实心白，构图更接近常见世界地图 */}
    <div className="relative mb-8 w-full max-w-[440px] animate-fadeInUp">
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-32 bg-[radial-gradient(ellipse_at_center,rgba(var(--accent-blue-rgb),0.10)_0%,transparent_70%)] blur-2xl"
      />
      <LandDotField
        cols={104}
        latRange={{ north: 83, south: -56 }}
        className="relative w-full text-[var(--accent-blue)]"
        opacity={0.34}
      />
    </div>

    <h1 className="mb-2.5 text-[26px] font-semibold tracking-[-0.01em] text-[var(--text-primary)] animate-fadeInUp" style={{ animationDelay: '60ms' }}>
      {title}
    </h1>
    <p
      className="mb-7 max-w-[420px] text-[13.5px] leading-relaxed text-[var(--text-tertiary)] animate-fadeInUp"
      style={{ animationDelay: '120ms' }}
    >
      {description}
    </p>

    <div className="mb-8 flex flex-wrap items-center justify-center gap-2.5 animate-fadeInUp" style={{ animationDelay: '180ms' }}>
      {WELCOME_POINTS.map((p) => (
        <div
          key={p.label}
          className="flex items-center gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--bg-glass)] px-3.5 py-2 text-[var(--text-secondary)] backdrop-blur-sm"
        >
          <span className="text-[var(--accent-cyan)]">{p.icon}</span>
          <span className="text-xs font-medium">{p.label}</span>
        </div>
      ))}
    </div>

    {onImport && (
      <div className="animate-fadeInUp" style={{ animationDelay: '240ms' }}>
        <button
          type="button"
          onClick={onImport}
          className="rounded-xl bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-hover))] px-6 py-2.5 text-sm font-semibold text-[var(--accent-contrast)] shadow-lg shadow-[rgba(var(--accent-blue-rgb),0.25)] transition-all duration-200 hover:brightness-110 active:scale-[0.98]"
        >
          导入图片 / 视频 / 文件夹
        </button>
      </div>
    )}
  </div>
);

/* ------------------------------------------------------------------ */
/* 其余五种：克制，但区分语气                                            */
/* ------------------------------------------------------------------ */

interface QuietEmptyStateProps {
  kind: Exclude<EmptyKind, 'library'>;
  title: string;
  description: string;
  /** 主出口（如「前往所有照片」） */
  onShowAll?: () => void;
  showAllLabel?: string;
  /** 次出口（如「清除搜索」） */
  onClearSearch?: () => void;
  /** 右上角的可选读数（如「库中 1,204 张」），帮用户判断是不是条件太窄 */
  hint?: React.ReactNode;
}

/**
 * 过程态空状态：一个图形 + 一句结论 + 一个出口。
 * `kind` 决定图形与语气色，六种状态因此不再共用一张脸。
 */
export const QuietEmptyState: React.FC<QuietEmptyStateProps> = ({
  kind,
  title,
  description,
  onShowAll,
  showAllLabel,
  onClearSearch,
  hint,
}) => {
  const tone = KIND_TONE[kind];
  return (
    <div className="flex flex-col items-center text-center">
      <div
        className={`mb-6 flex h-16 w-16 items-center justify-center rounded-2xl border animate-fadeInUp ${TONE_CLASS[tone]}`}
      >
        <Glyph kind={kind} />
      </div>

      <p
        className="mb-2.5 text-[17px] font-semibold text-[var(--text-primary)] animate-fadeInUp"
        style={{ animationDelay: '60ms' }}
      >
        {title}
      </p>
      <p
        className="mb-6 max-w-[400px] text-[13px] leading-relaxed text-[var(--text-tertiary)] animate-fadeInUp"
        style={{ animationDelay: '120ms' }}
      >
        {description}
      </p>

      {hint && (
        <div className="mb-5 animate-fadeInUp" style={{ animationDelay: '150ms' }}>
          {hint}
        </div>
      )}

      {(onShowAll || onClearSearch) && (
        <div className="flex items-center gap-3 animate-fadeInUp" style={{ animationDelay: '180ms' }}>
          {onShowAll && (
            <button
              type="button"
              onClick={onShowAll}
              className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-glass)] px-5 py-2.5 text-sm font-medium text-[var(--text-primary)] transition-all duration-200 hover:bg-[var(--bg-glass-hover)] active:scale-[0.98]"
            >
              {showAllLabel}
            </button>
          )}
          {onClearSearch && (
            <button
              type="button"
              onClick={onClearSearch}
              className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-glass)] px-5 py-2.5 text-sm font-medium text-[var(--text-primary)] transition-all duration-200 hover:bg-[var(--bg-glass-hover)] active:scale-[0.98]"
            >
              清除搜索
            </button>
          )}
        </div>
      )}
    </div>
  );
};

/** 空状态里最常见的旁注数字：让「是不是条件太窄」有个参照 */
export const EmptyStateHint: React.FC<{ value: React.ReactNode; unit: string }> = ({ value, unit }) => (
  <Stat value={value} unit={unit} label="库中" emphasis="micro" />
);

export default WelcomeEmptyState;
