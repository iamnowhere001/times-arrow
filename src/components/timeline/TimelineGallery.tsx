import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Photo } from '@/types';
import { ThumbImage } from '@/components/grid/ThumbnailImage';
import { formatVideoDuration, isVideoPhoto } from '@/utils';

interface TimelineGalleryProps {
  /** 已按拍摄时间升序排列的照片 */
  photos: Photo[];
  /** 点击照片打开 QuickLook */
  onQuickLook: (photo: Photo) => void;
  /** 返回图库 */
  onBack: () => void;
  /** 侧栏是否展开：标题栏据此为红绿灯让位 */
  isLeftPaneOpen: boolean;
}

// ---------------------------------------------------------------------------
// 常量与纯逻辑
// ---------------------------------------------------------------------------

/** 月份中文名 */
const MONTH_LABELS = [
  '一月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '十一月', '十二月',
];

/** 卡片密度：紧凑 / 适中 / 沉浸（与图库的网格缩放同一心智） */
const DENSITY_OPTIONS = [
  { key: 'compact', label: '紧凑', hint: '小图，一屏看更多', height: 116 },
  { key: 'comfortable', label: '适中', hint: '默认密度', height: 164 },
  { key: 'immersive', label: '沉浸', hint: '大图，近看细节', height: 224 },
] as const;
type DensityKey = (typeof DENSITY_OPTIONS)[number]['key'];
const DENSITY_STORAGE_KEY = 'pm:timeline-density';

/**
 * 时间脊的几何常量。
 * 内容列左侧留出一条固定宽度的装订线（gutter），时间脊与年 / 月节点都落在它的中轴上。
 * 所有偏移都由这几个常量推导，避免各处手写魔数后对不齐。
 */
const SPINE_LEFT = 18;
const SPINE_WIDTH = 2;
const CONTENT_PAD = 38;
const MONTH_DOT = 9;
const YEAR_DOT = 13;
const SPINE_CENTER = SPINE_LEFT + SPINE_WIDTH / 2;
/** 节点相对「内容列起点」的左偏移（负值，向左探进装订线） */
const MONTH_DOT_LEFT = SPINE_CENTER - CONTENT_PAD - MONTH_DOT / 2;
const YEAR_DOT_LEFT = SPINE_CENTER - CONTENT_PAD - YEAR_DOT / 2;

/** 记住上次离开时的滚动位置：图库 ↔ 时光画廊来回切换不丢进度 */
let savedScrollTop = 0;

/** 取照片的有效时间戳：拍摄时间优先，其次文件修改时间 */
function photoTimestamp(photo: Photo): number {
  return photo.dateTaken || photo.lastModified || 0;
}

interface MonthGroup {
  key: string; // YYYY-MM（月份 0 基）
  year: number;
  month: number; // 0-11
  photos: Photo[];
  videos: number;
}

interface YearGroup {
  year: number;
  months: MonthGroup[];
  total: number;
  videos: number;
}

/**
 * 把按时间升序排列的照片分组成「年 → 月」两级结构。
 *
 * 排序遵循「由近及远」：年份倒序、年内月份也倒序，因此整页自上而下是
 * 严格的时间倒序——时间脊与键盘导航（上下 / j k）才读得通，
 * 顶部也才是真正的「最近」。月份内部的照片仍按时间升序（一张胶片从左到右即拍摄顺序）。
 * 缺失时间戳的条目归到「未知时间」。
 */
function groupByTime(photos: Photo[]): { years: YearGroup[]; unknown: Photo[] } {
  const yearMap = new Map<number, Map<number, Photo[]>>();
  const unknown: Photo[] = [];

  for (const photo of photos) {
    const ts = photoTimestamp(photo);
    if (!ts) {
      unknown.push(photo);
      continue;
    }
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = d.getMonth();
    if (!yearMap.has(y)) yearMap.set(y, new Map());
    const monthMap = yearMap.get(y)!;
    if (!monthMap.has(m)) monthMap.set(m, []);
    monthMap.get(m)!.push(photo);
  }

  const years: YearGroup[] = [];
  for (const [year, monthMap] of yearMap) {
    const months: MonthGroup[] = [];
    let total = 0;
    let videos = 0;
    for (const [month, list] of monthMap) {
      const monthVideos = list.reduce((n, p) => n + (isVideoPhoto(p) ? 1 : 0), 0);
      months.push({ key: `${year}-${month}`, year, month, photos: list, videos: monthVideos });
      total += list.length;
      videos += monthVideos;
    }
    months.sort((a, b) => b.month - a.month); // 倒序：同一年内最近的月份在前
    years.push({ year, months, total, videos });
  }
  years.sort((a, b) => b.year - a.year); // 倒序：最近的年份在顶部

  return { years, unknown };
}

/** 卡片宽度：由原始比例推得，并夹在可读区间内（避免极端长条 / 细条） */
function cardWidth(photo: Photo, height: number): number {
  const dim = photo.dimensions;
  const aspect = dim?.width && dim?.height
    ? Math.min(2.1, Math.max(0.66, dim.width / dim.height))
    : 1;
  return Math.round(height * aspect);
}

/** 「4月2日」 */
function formatMonthDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 「2007年11月」 */
function formatYearMonth(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

/** 单个月份的跨度文案：同一天只显示一天，否则「4月2日 – 28日」 */
function monthRangeLabel(photos: Photo[]): string {
  if (photos.length === 0) return '';
  const first = new Date(photoTimestamp(photos[0]));
  const last = new Date(photoTimestamp(photos[photos.length - 1]));
  if (first.toDateString() === last.toDateString()) return formatMonthDay(first.getTime());
  return `${first.getMonth() + 1}月${first.getDate()}日 – ${last.getDate()}日`;
}

// ---------------------------------------------------------------------------
// 图标
// ---------------------------------------------------------------------------

const ChevronLeftIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6"></polyline>
  </svg>
);

const ChevronRightSmallIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 6 15 12 9 18"></polyline>
  </svg>
);

const ChevronLeftSmallIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 6 9 12 15 18"></polyline>
  </svg>
);

const CalendarIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2"></rect>
    <line x1="16" y1="2" x2="16" y2="6"></line>
    <line x1="8" y1="2" x2="8" y2="6"></line>
    <line x1="3" y1="10" x2="21" y2="10"></line>
  </svg>
);

const ImagesIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2"></rect>
    <circle cx="8.5" cy="8.5" r="1.5"></circle>
    <polyline points="21 15 16 10 5 21"></polyline>
  </svg>
);

const ArrowUpIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="19" x2="12" y2="5"></line>
    <polyline points="5 12 12 5 19 12"></polyline>
  </svg>
);

const ClockIcon = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9"></circle>
    <polyline points="12 7 12 12 15.5 14"></polyline>
  </svg>
);

// ---------------------------------------------------------------------------
// 角标
// ---------------------------------------------------------------------------

/** 视频：画面中央一个克制的播放标识，保证「这是视频」一眼可辨 */
const PlayOverlay = () => (
  <span aria-hidden className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
    <span className="flex items-center justify-center w-9 h-9 rounded-full bg-black/45 text-white/95 ring-1 ring-white/20 backdrop-blur-[1px] transition-transform duration-300 ease-entrance group-hover:scale-110">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>
    </span>
  </span>
);

const DurationBadge = ({ text }: { text: string }) => (
  <span className="absolute bottom-1.5 right-1.5 z-20 rounded-md bg-black/62 px-1.5 py-0.5 font-numeric text-[10px] leading-none tabular-nums text-white/92">
    {text}
  </span>
);

const FavoriteBadge = () => (
  <span
    className="absolute left-1.5 top-1.5 z-20 flex items-center justify-center w-5 h-5 rounded-full bg-black/50 backdrop-blur-xs"
    title="收藏"
  >
    <svg width="10" height="10" viewBox="0 0 24 24" fill="var(--accent-blue)">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
    </svg>
  </span>
);

// ---------------------------------------------------------------------------
// 时间线卡片
// ---------------------------------------------------------------------------

interface TimelineCardProps {
  photo: Photo;
  height: number;
  /** 是否已进入视口邻域：只有它变 true 才开始解析缩略图 */
  active: boolean;
  onOpen: (photo: Photo) => void;
  registerRef: (id: string, el: HTMLButtonElement | null) => void;
}

/**
 * 时间线上的单张照片卡片：高度随密度，宽度按原始比例自适应。
 *
 * 缩略图按需加载——卡片初次进入视口邻域（含一屏预载）时才真正请求并解码，
 * 之后保持挂载，避免来回滚动反复解码。可视区域外的卡片只保留等高占位，
 * 因此一个包含数百张照片的月份也不会一次性压垮内存与 CPU。
 */
const TimelineCard = memo(function TimelineCard({
  photo,
  height,
  active,
  onOpen,
  registerRef,
}: TimelineCardProps) {
  const isVideo = isVideoPhoto(photo);
  const width = cardWidth(photo, height);
  const [everActive, setEverActive] = useState(active);

  useEffect(() => {
    // 一次性闩锁：离开视口后不必再卸载，省下重新解码
    if (active && !everActive) setEverActive(true);
  }, [active, everActive]);

  const setRef = useCallback(
    (el: HTMLButtonElement | null) => registerRef(photo.id, el),
    [registerRef, photo.id]
  );

  const duration = isVideo ? formatVideoDuration(photo.duration) : '';
  const dateLabel = photo.dateTaken ? formatMonthDay(photo.dateTaken) : '';

  return (
    <button
      ref={setRef}
      data-photo-id={photo.id}
      type="button"
      onClick={() => onOpen(photo)}
      title={photo.name}
      style={{ width, height }}
      className="group relative shrink-0 snap-start overflow-hidden rounded-[11px] border border-[var(--border-subtle)] bg-[var(--bg-card)] outline-hidden transition-[transform,box-shadow,border-color] duration-300 ease-entrance hover:-translate-y-0.5 hover:border-[var(--border-hover)] hover:shadow-[var(--shadow-lg)] focus-visible:z-20 focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)] focus-visible:ring-offset-0 active:translate-y-0"
    >
      {everActive ? (
        <ThumbImage
          photo={photo}
          size={height}
          className="h-full w-full object-cover transition-transform duration-500 ease-entrance group-hover:scale-[1.03]"
          alt={photo.name}
        />
      ) : (
        <span aria-hidden className="skeleton block h-full w-full" />
      )}

      {isVideo && <PlayOverlay />}
      {duration && <DurationBadge text={duration} />}
      {photo.isFavorite && <FavoriteBadge />}

      {/* 悬停 / 聚焦信息层：文件名 + 拍摄日 */}
      <span className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-end bg-gradient-to-t from-black/72 via-black/10 to-transparent p-2.5 text-left opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
        <span className="truncate text-[11px] font-medium text-white/95">{photo.name}</span>
        {dateLabel && (
          <span className="font-numeric text-[10px] tabular-nums text-white/65">{dateLabel}</span>
        )}
      </span>
    </button>
  );
});

// ---------------------------------------------------------------------------
// 胶片横条：单个月份的水平滚动条
// 边缘渐隐提示「还有更多」，悬停出现滚动箭头；proximity 吸附不抢手感。
// ---------------------------------------------------------------------------

interface FilmStripProps {
  photos: Photo[];
  height: number;
  label: string;
  onQuickLook: (photo: Photo) => void;
}

const FilmStrip: React.FC<FilmStripProps> = ({ photos, height, label, onQuickLook }) => {
  const stripRef = useRef<HTMLDivElement>(null);
  const ioRef = useRef<IntersectionObserver | null>(null);
  const cardElsRef = useRef(new Map<string, HTMLButtonElement>());
  const [edge, setEdge] = useState({ left: false, right: false });
  const [activeIds, setActiveIds] = useState<Set<string>>(() => new Set());

  // 视口邻域观察：进入即请求缩略图。
  // root 用视口（而非横条本身），这样纵横两个方向都受「是否接近屏幕」约束——
  // 既不会为一个已滚过屏的月份补拉全部缩略图，也不会一次性拉满一个月内数百张。
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        const added: string[] = [];
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const id = (entry.target as HTMLElement).dataset.photoId;
          if (id) added.push(id);
          io.unobserve(entry.target); // 一次性，命中后不再观察
        }
        if (added.length === 0) return;
        setActiveIds((prev) => {
          const next = new Set(prev);
          let changed = false;
          for (const id of added) {
            if (!next.has(id)) {
              next.add(id);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      { rootMargin: '240px 60%', threshold: 0 }
    );
    ioRef.current = io;
    cardElsRef.current.forEach((el) => io.observe(el));
    return () => {
      io.disconnect();
      ioRef.current = null;
    };
  }, []);

  const registerRef = useCallback((id: string, el: HTMLButtonElement | null) => {
    const map = cardElsRef.current;
    const prev = map.get(id);
    if (el) {
      map.set(id, el);
      ioRef.current?.observe(el);
    } else if (prev) {
      ioRef.current?.unobserve(prev);
      map.delete(id);
    }
  }, []);

  const updateEdge = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    setEdge({
      left: el.scrollLeft > 4,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    });
  }, []);

  useEffect(() => {
    updateEdge();
    const el = stripRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateEdge, { passive: true });
    const ro = new ResizeObserver(updateEdge);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', updateEdge);
      ro.disconnect();
    };
  }, [updateEdge, photos, height]);

  const scrollByPage = (dir: 1 | -1) => {
    const el = stripRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.75, behavior: 'smooth' });
  };

  return (
    <div className="group/strip relative">
      <div
        ref={stripRef}
        role="group"
        aria-label={label}
        className="custom-scrollbar flex snap-x snap-proximity gap-3 overflow-x-auto overscroll-x-contain pb-3"
      >
        {photos.map((photo) => (
          <TimelineCard
            key={photo.id}
            photo={photo}
            height={height}
            active={activeIds.has(photo.id)}
            onOpen={onQuickLook}
            registerRef={registerRef}
          />
        ))}
      </div>

      {/* 边缘渐隐：只在对应方向还有内容时显示 */}
      <div
        aria-hidden
        className={`pointer-events-none absolute left-0 top-0 bottom-3 w-7 bg-gradient-to-r from-[var(--bg-primary)] to-transparent transition-opacity duration-200 ${
          edge.left ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <div
        aria-hidden
        className={`pointer-events-none absolute right-0 top-0 bottom-3 w-7 bg-gradient-to-l from-[var(--bg-primary)] to-transparent transition-opacity duration-200 ${
          edge.right ? 'opacity-100' : 'opacity-0'
        }`}
      />

      {/* 悬停滚动箭头 */}
      {edge.left && (
        <button
          type="button"
          aria-label={`向左查看更多（${label}）`}
          onClick={() => scrollByPage(-1)}
          className="absolute left-1 top-1/2 z-20 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--bg-overlay)] text-white/80 opacity-0 shadow-md backdrop-blur-md transition-opacity duration-200 hover:text-white group-hover/strip:opacity-100 focus-visible:opacity-100"
        >
          <ChevronLeftSmallIcon />
        </button>
      )}
      {edge.right && (
        <button
          type="button"
          aria-label={`向右查看更多（${label}）`}
          onClick={() => scrollByPage(1)}
          className="absolute right-1 top-1/2 z-20 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--bg-overlay)] text-white/80 opacity-0 shadow-md backdrop-blur-md transition-opacity duration-200 hover:text-white group-hover/strip:opacity-100 focus-visible:opacity-100"
        >
          <ChevronRightSmallIcon />
        </button>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 月份区块：滚动临近视口时才真正挂载胶片条（IntersectionObserver 预载），
// 未挂载时保留等高骨架，保证滚动条长度恒等于真实布局，恢复滚动位置也不会漂移。
// ---------------------------------------------------------------------------

interface MonthBlockProps {
  month: MonthGroup;
  height: number;
  isActive: boolean;
  onQuickLook: (photo: Photo) => void;
  registerMonth: (key: string, el: HTMLElement | null) => void;
}

const MonthBlockBase: React.FC<MonthBlockProps> = ({
  month,
  height,
  isActive,
  onQuickLook,
  registerMonth,
}) => {
  const blockRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  // 双向惰性挂载：进入 900px 预载区挂载，离开后卸载。
  // 之前只挂载不卸载（一次性闩锁），浏览完整条时间线后每个月份的照片卡片、缩略图与
  // 它们的 IntersectionObserver 都会常驻，DOM 与内存随时间只增不减。
  // 卸载后用等高骨架占位，滚动条长度不变，因此不会造成滚动位置漂移。
  useEffect(() => {
    const el = blockRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        setMounted(entry.isIntersecting);
      },
      { rootMargin: '900px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // 同一个 ref 回调要同时服务两件事：惰性挂载的观察目标 + 年/月跳转的锚点。
  // 漏掉任一边都会让这个月区块一直停在骨架态。
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      blockRef.current = el;
      registerMonth(month.key, el);
    },
    [registerMonth, month.key]
  );

  const range = monthRangeLabel(month.photos);

  return (
    <div
      ref={setRef}
      data-month-key={month.key}
      className="relative pb-8 last:pb-4"
      aria-current={isActive ? 'true' : undefined}
    >
      {/* 月份节点：吸附在顶部的「里程碑」胶囊，节点圆点始终落在时间脊上 */}
      <div className="sticky top-0 z-10 mb-3 flex items-center py-1.5">
        <span
          aria-hidden
          className={`absolute rounded-full transition-all duration-300 ${
            isActive
              ? 'bg-[var(--accent-blue)] shadow-[0_0_10px_rgba(var(--accent-blue-rgb),0.6)]'
              : 'bg-[var(--border-hover)]'
          }`}
          style={{
            left: MONTH_DOT_LEFT,
            top: '50%',
            width: MONTH_DOT,
            height: MONTH_DOT,
            transform: 'translateY(-50%)',
          }}
        />
        <span className="inline-flex h-7 items-center gap-2 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-secondary)] pl-3 pr-2 shadow-[var(--shadow-sm)]">
          <span className="text-[13px] font-semibold text-[var(--text-primary)]">
            {MONTH_LABELS[month.month]}
          </span>
          <span className="h-3 w-px bg-[var(--border-default)]" aria-hidden />
          <span className="font-numeric text-[11px] tabular-nums text-[var(--text-quaternary)]">
            {range}
          </span>
          <span className="rounded-full bg-[var(--bg-glass)] px-1.5 py-0.5 font-numeric text-[10px] tabular-nums text-[var(--text-tertiary)]">
            {month.photos.length}
          </span>
        </span>
      </div>

      {mounted ? (
        <FilmStrip
          photos={month.photos}
          height={height}
          label={`${month.year}年${MONTH_LABELS[month.month]}`}
          onQuickLook={onQuickLook}
        />
      ) : (
        /* 未挂载时用一排「卡片形状」的骨架占位：高度与真实胶片条一致（滚动条长度不漂移），
           同时一眼就能看出是「内容待加载」，而不是一块空白的板子 */
        <div aria-hidden className="flex gap-3 overflow-hidden pb-3" style={{ height: height + 12 }}>
          {[1.4, 1, 1.6, 1.05, 1.35, 0.9].map((aspect, i) => (
            <div
              key={i}
              className="skeleton shrink-0 rounded-[11px] border border-[var(--border-subtle)]"
              style={{ height, width: Math.round(height * aspect) }}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/** 滚动时会频繁重渲染外层：只有「当前月份」变化的那一两个月需要真正重渲染 */
const MonthBlock = memo(MonthBlockBase);

// ---------------------------------------------------------------------------
// 年份区块
// ---------------------------------------------------------------------------

interface YearSectionProps {
  group: YearGroup;
  height: number;
  activeMonthKey: string | null;
  onQuickLook: (photo: Photo) => void;
  registerYear: (year: number, el: HTMLElement | null) => void;
  registerMonth: (key: string, el: HTMLElement | null) => void;
}

const YearSectionBase: React.FC<YearSectionProps> = ({
  group,
  height,
  activeMonthKey,
  onQuickLook,
  registerYear,
  registerMonth,
}) => {
  const setRef = useCallback(
    (el: HTMLElement | null) => registerYear(group.year, el),
    [registerYear, group.year]
  );

  // 月份按倒序排列，这里取两端并统一成「早 → 晚」读法
  const latest = group.months[0];
  const earliest = group.months[group.months.length - 1];
  const monthSpan = !latest
    ? ''
    : earliest.month === latest.month
      ? MONTH_LABELS[earliest.month]
      : `${MONTH_LABELS[earliest.month]} – ${MONTH_LABELS[latest.month]}`;

  return (
    <section ref={setRef} className="mb-12" aria-label={`${group.year} 年`}>
      {/* 年份大标题：等宽数字，读起来像胶片边缘的刻度，而不是普通的粗体标题 */}
      <div className="mb-7 mt-2 flex items-end gap-4 md:gap-6">
        <span className="relative inline-block font-numeric text-[44px] font-semibold leading-[0.85] tracking-tight text-[var(--text-primary)] sm:text-[56px] md:text-[68px]">
          <span
            aria-hidden
            className="absolute rounded-full bg-[var(--bg-primary)] ring-2 ring-[rgba(var(--accent-blue-rgb),0.7)]"
            style={{
              left: YEAR_DOT_LEFT,
              top: '50%',
              width: YEAR_DOT,
              height: YEAR_DOT,
              transform: 'translateY(-50%)',
            }}
          />
          {group.year}
        </span>
        <div className="flex min-w-0 flex-col gap-1 pb-1.5">
          <span className="truncate text-[12px] font-medium text-[var(--text-secondary)]">
            {monthSpan}
          </span>
          <span className="font-numeric text-[11px] tabular-nums text-[var(--text-quaternary)]">
            {group.months.length} 个月 · {group.total} 项
            {group.videos > 0 ? ` · 视频 ${group.videos}` : ''}
          </span>
        </div>
        <span
          aria-hidden
          className="mb-3 hidden h-px flex-1 bg-gradient-to-r from-[var(--border-default)] to-transparent sm:block"
        />
      </div>

      <div>
        {group.months.map((month) => (
          <MonthBlock
            key={month.key}
            month={month}
            height={height}
            isActive={activeMonthKey === month.key}
            onQuickLook={onQuickLook}
            registerMonth={registerMonth}
          />
        ))}
      </div>
    </section>
  );
};

const YearSection = memo(YearSectionBase);

// ---------------------------------------------------------------------------
// 年份导航轨：体量条长度编码该年照片数量；当前年份额外展开「月份密度网格」，
// 可一眼看出这一年哪些月份有内容，并直接跳到具体月份。
// ---------------------------------------------------------------------------

interface YearRailProps {
  years: YearGroup[];
  activeYear: number | null;
  activeMonth: number | null;
  maxYearTotal: number;
  monthCountsByYear: Map<number, number[]>;
  onJumpYear: (year: number) => void;
  onJumpMonth: (key: string) => void;
}

const YearRailBase: React.FC<YearRailProps> = ({
  years,
  activeYear,
  activeMonth,
  maxYearTotal,
  monthCountsByYear,
  onJumpYear,
  onJumpMonth,
}) => (
  <nav
    aria-label="年份导航"
    className="custom-scrollbar h-full w-[60px] shrink-0 overflow-y-auto border-r border-[var(--border-subtle)] bg-[var(--bg-secondary)] md:w-[104px]"
  >
    <div className="flex flex-col gap-1 px-2 py-6">
      {years.map(({ year, total }) => {
        const active = activeYear === year;
        const barPct = maxYearTotal > 0 ? Math.max(0.08, total / maxYearTotal) : 0;
        const counts = monthCountsByYear.get(year) ?? [];
        return (
          <div key={year} className="flex flex-col">
            <button
              type="button"
              onClick={() => onJumpYear(year)}
              aria-current={active ? 'true' : undefined}
              title={`${year} 年 · ${total} 项`}
              aria-label={`跳转到 ${year} 年，共 ${total} 项`}
              className={`group flex flex-col gap-1.5 rounded-xl px-2 py-1.5 transition-colors duration-200 ${
                active ? 'bg-[var(--bg-glass)]' : 'hover:bg-[var(--bg-glass-hover)]'
              }`}
            >
              <span className="flex items-baseline justify-between gap-1">
                <span
                  className={`font-numeric text-[13px] font-semibold tabular-nums transition-colors ${
                    active
                      ? 'text-[var(--accent-blue)]'
                      : 'text-[var(--text-tertiary)] group-hover:text-[var(--text-secondary)]'
                  }`}
                >
                  {year}
                </span>
                <span className="hidden font-numeric text-[10px] tabular-nums text-[var(--text-quaternary)] md:inline">
                  {total}
                </span>
              </span>
              {/* 体量条：这一年的记忆密度 */}
              <span aria-hidden className="h-[3px] w-full overflow-hidden rounded-full bg-[var(--border-subtle)]">
                <span
                  className={`block h-full rounded-full transition-all duration-300 ${
                    active ? 'bg-[var(--accent-blue)]' : 'bg-[var(--border-hover)]'
                  }`}
                  style={{ width: `${barPct * 100}%` }}
                />
              </span>
            </button>

            {/* 月份密度网格：只在当前年份展开，12 格对应 12 个月 */}
            {active && (
              <div className="hidden grid-cols-6 gap-1 px-2 pb-1 pt-1.5 md:grid">
                {Array.from({ length: 12 }, (_, m) => {
                  const count = counts[m] ?? 0;
                  const hasContent = count > 0;
                  const isCurrent = activeMonth === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      disabled={!hasContent}
                      onClick={() => onJumpMonth(`${year}-${m}`)}
                      title={hasContent ? `跳转到 ${m + 1} 月 · ${count} 项` : `${m + 1} 月暂无内容`}
                      aria-label={`跳转到 ${year} 年 ${m + 1} 月${hasContent ? `，共 ${count} 项` : '，暂无内容'}`}
                      className={`h-3 rounded-[3px] transition-all duration-200 ${
                        isCurrent
                          ? 'bg-[var(--accent-blue)] shadow-[0_0_6px_rgba(var(--accent-blue-rgb),0.55)]'
                          : hasContent
                            ? 'bg-[var(--border-hover)] hover:bg-[var(--text-quaternary)]'
                            : 'cursor-default bg-transparent ring-1 ring-inset ring-[var(--border-subtle)]'
                      }`}
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  </nav>
);

const YearRail = memo(YearRailBase);

// ---------------------------------------------------------------------------
// 顶部标题栏
// ---------------------------------------------------------------------------

interface TimelineHeaderProps {
  onBack: () => void;
  isLeftPaneOpen: boolean;
  total: number;
  yearsCount: number;
  rangeLabel: string;
  /** 视频数量，用于在统计里提示媒体构成 */
  videos: number;
  density: DensityKey;
  onDensityChange: (key: DensityKey) => void;
}

const TimelineHeaderBase: React.FC<TimelineHeaderProps> = ({
  onBack,
  isLeftPaneOpen,
  total,
  yearsCount,
  rangeLabel,
  videos,
  density,
  onDensityChange,
}) => (
  <header
    className={`app-drag z-20 shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] backdrop-blur-xl ${
      isLeftPaneOpen ? 'px-4' : 'pl-[78px] pr-4'
    }`}
  >
    <div className="app-no-drag flex h-[52px] items-center gap-3">
      <button
        type="button"
        onClick={onBack}
        title="返回图库（Esc）"
        aria-label="返回图库"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[var(--text-secondary)] transition-all duration-200 hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] active:scale-[0.98]"
      >
        <ChevronLeftIcon />
      </button>

      <div className="flex min-w-0 items-center gap-2.5">
        <h1 className="truncate text-[17px] font-semibold text-[var(--text-primary)]">时光画廊</h1>
        {total > 0 && (
          <div className="hidden items-center gap-2 text-[11px] text-[var(--text-tertiary)] lg:flex">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-glass)] px-2 py-0.5">
              <ImagesIcon />
              <span className="font-numeric tabular-nums text-[var(--text-secondary)]">{total}</span>
              <span>项</span>
            </span>
            {yearsCount > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-glass)] px-2 py-0.5">
                <span className="font-numeric tabular-nums text-[var(--text-secondary)]">{yearsCount}</span>
                <span>年</span>
              </span>
            )}
            {videos > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-glass)] px-2 py-0.5">
                <span className="font-numeric tabular-nums text-[var(--text-secondary)]">{videos}</span>
                <span>个视频</span>
              </span>
            )}
            {rangeLabel && (
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[var(--text-tertiary)]">
                <CalendarIcon />
                <span className="font-numeric tabular-nums">{rangeLabel}</span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* 密度切换：与图库网格缩放同一心智 */}
      <div
        role="radiogroup"
        aria-label="卡片大小"
        className="ml-auto flex shrink-0 items-center gap-0.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-input)] p-0.5"
      >
        {DENSITY_OPTIONS.map((opt) => {
          const active = density === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              role="radio"
              aria-checked={active}
              title={`${opt.label}显示 · ${opt.hint}`}
              onClick={() => onDensityChange(opt.key)}
              className={`h-[22px] rounded-md px-2.5 text-[11px] font-medium transition-colors duration-150 ${
                active
                  ? 'bg-[var(--bg-glass-active)] text-[var(--text-primary)]'
                  : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  </header>
);

const TimelineHeader = memo(TimelineHeaderBase);

// ---------------------------------------------------------------------------
// 空状态
// ---------------------------------------------------------------------------

const EmptyState: React.FC<{ onBack: () => void }> = ({ onBack }) => (
  <div className="flex flex-1 items-center justify-center px-8">
    <div className="max-w-sm text-center">
      <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-3xl bg-[rgba(var(--accent-blue-rgb),0.1)] text-[var(--accent-blue)]">
        <ClockIcon size={30} />
      </div>
      <h2 className="mb-2 text-xl font-semibold text-[var(--text-primary)]">还没有可回顾的时光</h2>
      <p className="mb-6 text-sm leading-relaxed text-[var(--text-tertiary)]">
        导入一些照片或视频后，时光画廊会按拍摄时间把它们整理成一条可漫步的记忆长卷。
      </p>
      <button
        type="button"
        onClick={onBack}
        className="rounded-xl border border-[var(--border-default)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)]"
      >
        返回图库去导入
      </button>
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// 主视图
// ---------------------------------------------------------------------------

/**
 * 时光画廊：沿一条真正的时间轴沉浸式回顾全部记忆。
 *
 * 结构：左侧年份轨道（体量条编码该年照片数量，当前年份展开月份密度网格）
 * + 右侧贯穿上下的「时间脊」——年份是大节点、月份是小节点，
 * 已浏览的段落会逐段点亮，滚动因此读起来像在时间上行走。
 * 整页自上而下由近及远（年倒序、年内月份倒序），月份内的一张胶片从左到右即拍摄顺序；
 * 点击任意一张进入 QuickLook 逐张翻阅。纯本地视图。
 */
const TimelineGallery: React.FC<TimelineGalleryProps> = ({
  photos,
  onQuickLook,
  onBack,
  isLeftPaneOpen,
}) => {
  const { years, unknown } = useMemo(() => groupByTime(photos), [photos]);
  const totalPhotos = photos.length;

  // 密度偏好：持久化到 localStorage，与图库的网格缩放同一心智
  const [density, setDensity] = useState<DensityKey>(() => {
    try {
      const saved = localStorage.getItem(DENSITY_STORAGE_KEY);
      if (saved && DENSITY_OPTIONS.some((o) => o.key === saved)) return saved as DensityKey;
    } catch { /* 忽略 */ }
    return 'comfortable';
  });
  const cardHeight = DENSITY_OPTIONS.find((o) => o.key === density)?.height ?? 164;

  const handleDensityChange = useCallback((key: DensityKey) => {
    setDensity(key);
    try { localStorage.setItem(DENSITY_STORAGE_KEY, key); } catch { /* 忽略 */ }
  }, []);

  // 时间范围文案（首张 — 末张，均取有效拍摄时间）
  const rangeLabel = useMemo(() => {
    const dated = photos.filter((p) => photoTimestamp(p) > 0);
    if (dated.length === 0) return '';
    const start = formatYearMonth(photoTimestamp(dated[0]));
    const end = formatYearMonth(photoTimestamp(dated[dated.length - 1]));
    return start === end ? start : `${start} – ${end}`;
  }, [photos]);

  const videoCount = useMemo(
    () => photos.reduce((n, photo) => n + (isVideoPhoto(photo) ? 1 : 0), 0),
    [photos]
  );

  /** 每个年份的 12 个月份计数（0 基），供导航轨画密度网格 */
  const monthCountsByYear = useMemo(() => {
    const map = new Map<number, number[]>();
    for (const yearGroup of years) {
      const counts = new Array(12).fill(0);
      for (const month of yearGroup.months) counts[month.month] = month.photos.length;
      map.set(yearGroup.year, counts);
    }
    return map;
  }, [years]);

  /** 按时间顺序（新 → 旧、月升序）展开的月份 key，键盘导航与「当前月份」判定据此 */ 
  const orderedMonthKeys = useMemo(
    () => years.flatMap((yearGroup) => yearGroup.months.map((month) => month.key)),
    [years]
  );
  const monthByKey = useMemo(() => {
    const map = new Map<string, MonthGroup>();
    for (const yearGroup of years) {
      for (const month of yearGroup.months) map.set(month.key, month);
    }
    return map;
  }, [years]);

  const maxYearTotal = useMemo(() => years.reduce((m, y) => Math.max(m, y.total), 0), [years]);

  // ---- 滚动状态：当前月份 / 年份、时间脊进度、回到顶部 ----
  const [activeMonthKey, setActiveMonthKey] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const yearAnchorsRef = useRef<Map<number, HTMLElement>>(new Map());
  const monthAnchorsRef = useRef<Map<string, HTMLElement>>(new Map());

  const activeYear = useMemo(() => {
    if (!activeMonthKey) return years[0]?.year ?? null;
    const parsed = Number(activeMonthKey.split('-')[0]);
    return Number.isFinite(parsed) ? parsed : (years[0]?.year ?? null);
  }, [activeMonthKey, years]);
  const activeMonth = useMemo(() => {
    if (!activeMonthKey) return null;
    const parsed = Number(activeMonthKey.split('-')[1]);
    return Number.isFinite(parsed) ? parsed : null;
  }, [activeMonthKey]);

  const registerYear = useCallback((year: number, el: HTMLElement | null) => {
    if (el) yearAnchorsRef.current.set(year, el);
    else yearAnchorsRef.current.delete(year);
  }, []);
  const registerMonth = useCallback((key: string, el: HTMLElement | null) => {
    if (el) monthAnchorsRef.current.set(key, el);
    else monthAnchorsRef.current.delete(key);
  }, []);

  // 恢复上次离开时的滚动位置；离开时保存
  useEffect(() => {
    const el = scrollRef.current;
    if (el && savedScrollTop > 0) {
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = savedScrollTop;
      });
    }
    return () => {
      if (scrollRef.current) savedScrollTop = scrollRef.current.scrollTop;
    };
  }, []);

  // 滚动监听（rAF 节流）：更新当前月份、时间脊进度与回到顶部按钮
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    let raf = 0;
    const measure = () => {
      raf = 0;
      const scrollTop = el.scrollTop;
      setShowBackToTop(scrollTop > 900);

      const boundaryTop = el.getBoundingClientRect().top + 150;
      let current: string | null = null;
      // 按渲染顺序（orderedMonthKeys）逐月判定，取最后一个越过边界的区块即为当前区块。
      // 不能依赖 Map 的插入序：新增照片会挂载新月份区块并追加到 Map 末尾，
      // 但它的 DOM 位置在上方，「取最后一个」就会把当前月份判成那个新块。
      for (const key of orderedMonthKeys) {
        const node = monthAnchorsRef.current.get(key);
        if (!node) continue;
        if (node.getBoundingClientRect().top <= boundaryTop) current = key;
        else break;
      }
      if (!current && orderedMonthKeys.length > 0) current = orderedMonthKeys[0];
      setActiveMonthKey((prev) => (prev === current ? prev : current));

      // 进度量化到 0.1%：滚动一帧就重渲染整页代价不小，这点误差肉眼不可见
      const denom = el.scrollHeight - el.clientHeight;
      const next = denom > 0 ? Math.min(1, Math.max(0, scrollTop / denom)) : 1;
      setProgress((prev) => (Math.abs(prev - next) < 0.001 ? prev : next));
    };
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(measure);
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    measure();
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [orderedMonthKeys]);

  const scrollToEl = useCallback((target: HTMLElement | undefined | null) => {
    const el = scrollRef.current;
    if (!target || !el) return;
    const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    el.scrollTo({ top: Math.max(0, top - 14), behavior: 'smooth' });
  }, []);

  const scrollToYear = useCallback(
    (year: number) => scrollToEl(yearAnchorsRef.current.get(year)),
    [scrollToEl]
  );
  const scrollToMonth = useCallback(
    (key: string) => scrollToEl(monthAnchorsRef.current.get(key)),
    [scrollToEl]
  );

  /** 键盘导航：在月份锚点间移动 / 打开当前月份首张（让整屏免鼠标浏览成为可能） */
  const jumpToMonthIndex = useCallback(
    (index: number) => {
      if (orderedMonthKeys.length === 0) return;
      const clamped = Math.min(orderedMonthKeys.length - 1, Math.max(0, index));
      scrollToMonth(orderedMonthKeys[clamped]);
    },
    [orderedMonthKeys, scrollToMonth]
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (orderedMonthKeys.length === 0) return;

      // 焦点已落在某个可交互元素（如卡片按钮）上时，Enter / 空格交还给原生的激活行为
      const onInteractive = Boolean(
        target && typeof target.closest === 'function' &&
        target.closest('button, a, [role="button"], input, textarea, select')
      );

      const currentIndex = activeMonthKey ? orderedMonthKeys.indexOf(activeMonthKey) : 0;

      if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowDown') {
        e.preventDefault();
        jumpToMonthIndex(currentIndex + 1);
      } else if (e.key === 'k' || e.key === 'K' || e.key === 'ArrowUp') {
        e.preventDefault();
        jumpToMonthIndex(currentIndex - 1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        jumpToMonthIndex(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        jumpToMonthIndex(orderedMonthKeys.length - 1);
      } else if ((e.key === 'Enter' || e.key === ' ') && !onInteractive) {
        const month = activeMonthKey ? monthByKey.get(activeMonthKey) : null;
        if (month && month.photos.length > 0) {
          e.preventDefault();
          onQuickLook(month.photos[0]);
        }
      } else if (e.key === '1') {
        handleDensityChange('compact');
      } else if (e.key === '2') {
        handleDensityChange('comfortable');
      } else if (e.key === '3') {
        handleDensityChange('immersive');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeMonthKey, orderedMonthKeys, monthByKey, jumpToMonthIndex, handleDensityChange, onQuickLook]);

  // 当前所在区间的无障碍播报（不能写成 `!activeMonth`——一月是 0，会被误判为空）
  const activeLabel = useMemo(() => {
    if (!activeMonthKey) return '';
    const month = monthByKey.get(activeMonthKey);
    if (!month) return '';
    return `${month.year} 年 ${MONTH_LABELS[month.month]}，共 ${month.photos.length} 项`;
  }, [activeMonthKey, monthByKey]);

  // 空状态
  if (totalPhotos === 0) {
    return (
      <div className="flex flex-1 flex-col bg-transparent">
        <TimelineHeader
          onBack={onBack}
          isLeftPaneOpen={isLeftPaneOpen}
          total={0}
          yearsCount={0}
          rangeLabel=""
          videos={0}
          density={density}
          onDensityChange={handleDensityChange}
        />
        <EmptyState onBack={onBack} />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-transparent">
      <TimelineHeader
        onBack={onBack}
        isLeftPaneOpen={isLeftPaneOpen}
        total={totalPhotos}
        yearsCount={years.length}
        rangeLabel={rangeLabel}
        videos={videoCount}
        density={density}
        onDensityChange={handleDensityChange}
      />

      {/* 屏幕阅读器播报：当前浏览到的年月，配合键盘导航成为可感知的状态 */}
      <p className="sr-only" aria-live="polite">{activeLabel}</p>

      <div className="flex flex-1 overflow-hidden">
        {years.length > 0 && (
          <YearRail
            years={years}
            activeYear={activeYear}
            activeMonth={activeMonth}
            maxYearTotal={maxYearTotal}
            monthCountsByYear={monthCountsByYear}
            onJumpYear={scrollToYear}
            onJumpMonth={scrollToMonth}
          />
        )}

        {/* 右侧主时间线流：滚动层与浮层分离，否则浮层会随内容一起滚走 */}
        <div className="relative flex-1 overflow-hidden">
          <div ref={scrollRef} className="custom-scrollbar h-full overflow-y-auto">
            <div className="mx-auto max-w-[1440px] px-5 py-8 sm:px-7 md:px-10">
              <div className="relative" style={{ paddingLeft: CONTENT_PAD }}>
                {/* 时间脊：一条贯穿上下的细线，已浏览段落点亮为安全灯琥珀 */}
                <div
                  aria-hidden
                  className="pointer-events-none absolute bottom-0 top-0 rounded-full bg-[var(--border-default)]"
                  style={{ left: SPINE_LEFT, width: SPINE_WIDTH }}
                />
                <div
                  aria-hidden
                  className="pointer-events-none absolute top-0 rounded-full bg-gradient-to-b from-[var(--accent-blue)] to-[rgba(var(--accent-blue-rgb),0.35)] transition-[height] duration-150 ease-out"
                  style={{ left: SPINE_LEFT, width: SPINE_WIDTH, height: `${progress * 100}%` }}
                />
                {/* 「你在这里」光标：落在已点亮段落的末端 */}
                <div
                  aria-hidden
                  className="pointer-events-none absolute h-2 w-2 -translate-y-1/2 rounded-full bg-[var(--accent-blue)] shadow-[0_0_10px_rgba(var(--accent-blue-rgb),0.9)] transition-[top] duration-150 ease-out"
                  style={{ left: SPINE_LEFT - 3, top: `${progress * 100}%` }}
                />

                {years.map((yearGroup) => (
                  <YearSection
                    key={yearGroup.year}
                    group={yearGroup}
                    height={cardHeight}
                    activeMonthKey={activeMonthKey}
                    onQuickLook={onQuickLook}
                    registerYear={registerYear}
                    registerMonth={registerMonth}
                  />
                ))}

                {/* 未知时间的照片：归到末尾，避免丢失 */}
                {unknown.length > 0 && (
                  <section aria-label="未知时间" className="relative pb-4">
                    <div className="sticky top-0 z-10 mb-3 flex items-center py-1.5">
                      <span
                        aria-hidden
                        className="absolute rounded-full bg-[var(--border-hover)]"
                        style={{
                          left: MONTH_DOT_LEFT,
                          top: '50%',
                          width: MONTH_DOT,
                          height: MONTH_DOT,
                          transform: 'translateY(-50%)',
                        }}
                      />
                      <span className="inline-flex h-7 items-center gap-2 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-secondary)] pl-3 pr-2 shadow-[var(--shadow-sm)]">
                        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--text-secondary)]">
                          <ClockIcon size={14} />
                          未知时间
                        </span>
                        <span className="h-3 w-px bg-[var(--border-default)]" aria-hidden />
                        <span className="font-numeric text-[11px] tabular-nums text-[var(--text-quaternary)]">
                          {unknown.length} 项
                        </span>
                      </span>
                    </div>
                    <p className="-mt-1 mb-3 text-[11px] leading-relaxed text-[var(--text-quaternary)]">
                      这些条目缺少拍摄时间，暂时按文件时间放在最后；可在详情面板里手动修正拍摄日期。
                    </p>
                    <FilmStrip
                      photos={unknown}
                      height={cardHeight}
                      label="未知时间"
                      onQuickLook={onQuickLook}
                    />
                  </section>
                )}

                <div className="h-16" />
              </div>
            </div>
          </div>

          {/* 回到最近：滚动超过一屏后出现，一键回到最新的记忆 */}
          <button
            type="button"
            onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
            aria-hidden={!showBackToTop}
            tabIndex={showBackToTop ? 0 : -1}
            className={`app-no-drag absolute bottom-6 left-1/2 z-20 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3.5 text-[12px] font-medium text-[var(--text-secondary)] shadow-lg backdrop-blur-xl transition-all duration-300 hover:border-[var(--border-hover)] hover:text-[var(--text-primary)] ${
              showBackToTop ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0'
            }`}
          >
            <ArrowUpIcon />
            回到最近
          </button>
        </div>
      </div>
    </div>
  );
};

export default TimelineGallery;
