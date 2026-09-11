import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { Photo } from '../types';
import { ThumbImage } from './ThumbnailImage';
import { isVideoPhoto } from '../utils';

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

/** 月份中文名 */
const MONTH_LABELS = [
  '一月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '十一月', '十二月',
];

/** 卡片密度：紧凑 / 适中 / 沉浸（与图库的网格缩放同一心智） */
const DENSITY_OPTIONS = [
  { key: 'compact', label: '紧凑', height: 116 },
  { key: 'comfortable', label: '适中', height: 164 },
  { key: 'immersive', label: '沉浸', height: 224 },
] as const;
type DensityKey = (typeof DENSITY_OPTIONS)[number]['key'];
const DENSITY_STORAGE_KEY = 'pm:timeline-density';

/** 记住上次离开时的滚动位置：图库 ↔ 时光画廊来回切换不丢进度 */
let savedScrollTop = 0;

/** 取照片的有效时间戳：拍摄时间优先，其次文件修改时间 */
function photoTimestamp(photo: Photo): number {
  return photo.dateTaken || photo.lastModified || 0;
}

interface MonthGroup {
  key: string; // YYYY-MM
  year: number;
  month: number; // 0-11
  photos: Photo[];
}

interface YearGroup {
  year: number;
  months: MonthGroup[];
  total: number;
}

/**
 * 把按时间升序排列的照片分组成「年 → 月」两级结构。
 * 同一年份的月份按时间升序（一月在前）；缺失时间戳的条目归到「未知时间」。
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
    for (const [month, list] of monthMap) {
      months.push({ key: `${year}-${month}`, year, month, photos: list });
      total += list.length;
    }
    months.sort((a, b) => a.month - b.month);
    years.push({ year, months, total });
  }
  years.sort((a, b) => b.year - a.year); // 倒序：最近的年份在顶部

  return { years, unknown };
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
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2"></rect>
    <line x1="16" y1="2" x2="16" y2="6"></line>
    <line x1="8" y1="2" x2="8" y2="6"></line>
    <line x1="3" y1="10" x2="21" y2="10"></line>
  </svg>
);

const ImagesIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
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

const ClockIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9"></circle>
    <polyline points="12 7 12 12 15.5 14"></polyline>
  </svg>
);

const PlayBadge = () => (
  <span className="absolute bottom-1.5 right-1.5 flex items-center justify-center w-5 h-5 rounded-full bg-black/55 backdrop-blur-sm text-white">
    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
  </span>
);

const FavoriteBadge = () => (
  <span
    className="absolute bottom-1.5 left-1.5 flex items-center justify-center w-5 h-5 rounded-full bg-black/55 backdrop-blur-sm"
    title="收藏"
  >
    <svg width="10" height="10" viewBox="0 0 24 24" fill="var(--accent-blue)">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
    </svg>
  </span>
);

// ---------------------------------------------------------------------------
// 胶片横条：单个月份的水平滚动条
// 边缘渐隐提示「还有更多」，悬停出现滚动箭头；proximity 吸附不抢手感。
// ---------------------------------------------------------------------------

const FilmStrip: React.FC<{
  photos: Photo[];
  height: number;
  onQuickLook: (photo: Photo) => void;
}> = ({ photos, height, onQuickLook }) => {
  const stripRef = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, right: false });

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
        className="flex gap-3 overflow-x-auto pb-3 custom-scrollbar snap-x snap-proximity"
      >
        {photos.map((photo) => (
          <TimelineCard
            key={photo.id}
            photo={photo}
            height={height}
            onClick={() => onQuickLook(photo)}
          />
        ))}
      </div>

      {/* 边缘渐隐：只在对应方向还有内容时显示 */}
      <div
        aria-hidden
        className={`absolute left-0 top-0 bottom-3 w-8 pointer-events-none bg-gradient-to-r from-[var(--bg-primary)] to-transparent transition-opacity duration-200 ${
          edge.left ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <div
        aria-hidden
        className={`absolute right-0 top-0 bottom-3 w-8 pointer-events-none bg-gradient-to-l from-[var(--bg-primary)] to-transparent transition-opacity duration-200 ${
          edge.right ? 'opacity-100' : 'opacity-0'
        }`}
      />

      {/* 悬停滚动箭头 */}
      {edge.left && (
        <button
          type="button"
          aria-label="向左滚动"
          onClick={() => scrollByPage(-1)}
          className="absolute left-1 top-1/2 -translate-y-1/2 flex items-center justify-center w-8 h-8 rounded-full bg-[var(--bg-overlay)] backdrop-blur-md text-white/80 hover:text-white border border-[var(--border-default)] shadow-md opacity-0 group-hover/strip:opacity-100 transition-opacity duration-200"
        >
          <ChevronLeftSmallIcon />
        </button>
      )}
      {edge.right && (
        <button
          type="button"
          aria-label="向右滚动"
          onClick={() => scrollByPage(1)}
          className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center w-8 h-8 rounded-full bg-[var(--bg-overlay)] backdrop-blur-md text-white/80 hover:text-white border border-[var(--border-default)] shadow-md opacity-0 group-hover/strip:opacity-100 transition-opacity duration-200"
        >
          <ChevronRightSmallIcon />
        </button>
      )}
    </div>
  );
};

/** 时间线上的单张照片卡片：高度随密度，宽度按原始比例自适应 */
const TimelineCard: React.FC<{
  photo: Photo;
  height: number;
  onClick: () => void;
}> = ({ photo, height, onClick }) => {
  const isVideo = isVideoPhoto(photo);
  const aspect = photo.dimensions?.width && photo.dimensions.height
    ? Math.min(2.2, Math.max(0.62, photo.dimensions.width / photo.dimensions.height))
    : 1;

  const width = Math.round(height * aspect);

  return (
    <button
      type="button"
      onClick={onClick}
      title={photo.name}
      className="group relative shrink-0 snap-start rounded-lg overflow-hidden bg-[var(--bg-card)] border border-[var(--border-subtle)] hover:border-[var(--accent-blue)] hover:shadow-lg hover:shadow-[rgba(var(--accent-blue-rgb),0.16)] hover:z-10 transition-all duration-200 active:scale-[0.98]"
      style={{ width, height }}
    >
      <ThumbImage
        photo={photo}
        size={height}
        className="w-full h-full object-cover"
        alt={photo.name}
      />
      {isVideo && <PlayBadge />}
      {photo.isFavorite && <FavoriteBadge />}
      {/* 悬停浮层：文件名 + 拍摄日期 */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex flex-col justify-end p-2.5 text-left pointer-events-none">
        <p className="text-[11px] text-white/90 font-medium truncate">{photo.name}</p>
        {photo.dateTaken && (
          <p className="text-[10px] text-white/60">
            {new Date(photo.dateTaken).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
          </p>
        )}
      </div>
    </button>
  );
};

/**
 * 月份区块：滚动临近视口时才真正挂载卡片（IntersectionObserver 预载），
 * 未挂载时渲染等高的占位骨架，保证滚动条长度与真实布局一致，
 * 恢复滚动位置也不会漂移。挂载后常驻，避免来回滚动反复重建。
 */
const MonthBlock: React.FC<{
  month: MonthGroup;
  height: number;
  onQuickLook: (photo: Photo) => void;
}> = ({ month, height, onQuickLook }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (mounted) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setMounted(true);
          io.disconnect();
        }
      },
      { rootMargin: '900px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [mounted]);

  return (
    <div ref={ref}>
      {/* 月份标签：滚动时吸附在顶部，充当行进中的「里程碑」 */}
      <div className="sticky top-0 z-10 flex items-center gap-2.5 py-2 mb-3 bg-[var(--bg-elevated)] backdrop-blur-xl rounded-md">
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-blue)] shadow-[0_0_8px_rgba(var(--accent-blue-rgb),0.55)] shrink-0"></span>
        <h3 className="text-[15px] font-semibold text-[var(--text-secondary)] shrink-0">
          {MONTH_LABELS[month.month]}
        </h3>
        <span className="text-xs text-[var(--text-quaternary)] shrink-0">{month.photos.length}</span>
        <div className="flex-1 h-px bg-[var(--border-subtle)]"></div>
      </div>

      {mounted ? (
        <FilmStrip photos={month.photos} height={height} onQuickLook={onQuickLook} />
      ) : (
        <>
          <div
            aria-hidden
            className="rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)]"
            style={{ height }}
          />
          {/* 与 FilmStrip 的 pb-3 对齐，保证占位高度一致 */}
          <div className="h-3" />
        </>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 主视图
// ---------------------------------------------------------------------------

/**
 * 时光画廊：沿时间线沉浸式回顾全部记忆。
 *
 * 结构：左侧年份轨道（体量条长度编码该年照片数量）+ 右侧「年 → 月 → 胶片横条」
 * 的纵向流。照片按拍摄时间升序排列；点击进入 QuickLook 逐张翻阅。
 * 纯本地视图，不包含任何分享 / 上传能力。
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

  const handleDensityChange = (key: DensityKey) => {
    setDensity(key);
    try { localStorage.setItem(DENSITY_STORAGE_KEY, key); } catch { /* 忽略 */ }
  };

  // 时间范围文案
  const rangeLabel = useMemo(() => {
    if (totalPhotos === 0) return '';
    const dated = photos.filter((p) => photoTimestamp(p) > 0);
    if (dated.length === 0) return '';
    const start = new Date(photoTimestamp(dated[0]));
    const end = new Date(photoTimestamp(dated[dated.length - 1]));
    const fmt = (d: Date) => `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
    return fmt(start) === fmt(end) ? fmt(start) : `${fmt(start)} — ${fmt(end)}`;
  }, [photos, totalPhotos]);

  // 滚动时当前可见的年份：用于左侧轨道高亮
  const [activeYear, setActiveYear] = useState<number | null>(null);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const yearSectionRefs = useRef<Map<number, HTMLElement>>(new Map());

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

  useEffect(() => {
    if (years.length === 0) {
      setActiveYear(null);
      return;
    }
    // 默认高亮最顶部（最近）的年份
    setActiveYear(years[0].year);
  }, [years]);

  // 滚动监听：取视口上沿附近的年份区块作为当前年份
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setShowBackToTop(el.scrollTop > 900);

        const boundaryTop = el.getBoundingClientRect().top + 140;
        let current: number | null = null;
        // Map 保持插入序（年份倒序），取最后一个越过边界的区块
        yearSectionRefs.current.forEach((section, year) => {
          if (section.getBoundingClientRect().top <= boundaryTop) current = year;
        });
        if (current === null && years.length > 0) current = years[years.length - 1].year;
        setActiveYear(current);
      });
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [years]);

  // 轨道高亮跟随：年份很多时让当前年份始终可见
  const railRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  useEffect(() => {
    if (activeYear === null) return;
    railRefs.current.get(activeYear)?.scrollIntoView({ block: 'nearest' });
  }, [activeYear]);

  /** 点击左侧年份轨道：平滑滚动到对应年份区块 */
  const scrollToYear = useCallback((year: number) => {
    const section = yearSectionRefs.current.get(year);
    const el = scrollRef.current;
    if (section && el) {
      const top = section.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      el.scrollTo({ top: Math.max(0, top - 8), behavior: 'smooth' });
    }
  }, []);

  const maxYearTotal = years.reduce((m, y) => Math.max(m, y.total), 0);

  // 空状态
  if (totalPhotos === 0) {
    return (
      <div className="flex-1 flex flex-col bg-transparent">
        <TimelineHeader
          onBack={onBack}
          isLeftPaneOpen={isLeftPaneOpen}
          total={0}
          rangeLabel=""
          yearsCount={0}
          density={density}
          onDensityChange={handleDensityChange}
        />
        <div className="flex-1 flex items-center justify-center px-8">
          <div className="text-center max-w-sm">
            <div className="w-20 h-20 mx-auto mb-6 rounded-3xl bg-[rgba(var(--accent-blue-rgb),0.1)] flex items-center justify-center text-[var(--accent-blue)]">
              <CalendarIcon />
            </div>
            <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-2">还没有可回顾的时光</h2>
            <p className="text-sm text-[var(--text-tertiary)] leading-relaxed">
              导入一些照片或视频后，时光画廊会按拍摄时间自动整理成一条可漫步的记忆长卷。
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-transparent overflow-hidden">
      <TimelineHeader
        onBack={onBack}
        isLeftPaneOpen={isLeftPaneOpen}
        total={totalPhotos}
        rangeLabel={rangeLabel}
        yearsCount={years.length}
        density={density}
        onDensityChange={handleDensityChange}
      />

      <div className="flex-1 flex overflow-hidden">
        {/* 左侧年份轨道：体量条长度编码该年照片数量，一眼看出记忆的浓淡 */}
        <nav
          aria-label="年份导航"
          className="shrink-0 w-[76px] md:w-[88px] py-6 px-2 border-r border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-y-auto custom-scrollbar"
        >
          <div className="flex flex-col items-center gap-5">
            {years.map(({ year, total }) => {
              const active = activeYear === year;
              const barWidth = 10 + Math.round(30 * (total / maxYearTotal));
              return (
                <button
                  key={year}
                  type="button"
                  ref={(el) => {
                    if (el) railRefs.current.set(year, el);
                    else railRefs.current.delete(year);
                  }}
                  onClick={() => scrollToYear(year)}
                  title={`${year} 年 · ${total} 项`}
                  aria-label={`跳转到 ${year} 年，共 ${total} 项`}
                  aria-current={active ? 'true' : undefined}
                  className={`group flex flex-col items-center gap-1.5 py-1 transition-opacity duration-200 focus-visible:rounded-lg ${
                    active ? 'opacity-100' : 'opacity-60 hover:opacity-100'
                  }`}
                >
                  <span className={`text-[13px] font-semibold tracking-wide transition-colors ${
                    active ? 'text-[var(--accent-blue)]' : 'text-[var(--text-tertiary)] group-hover:text-[var(--text-secondary)]'
                  }`}>
                    {year}
                  </span>
                  {/* 体量条：这一年的记忆密度 */}
                  <span
                    aria-hidden
                    className={`h-[3px] rounded-full transition-all duration-300 ${
                      active
                        ? 'bg-[var(--accent-blue)] shadow-[0_0_8px_rgba(var(--accent-blue-rgb),0.5)]'
                        : 'bg-[var(--border-default)]'
                    }`}
                    style={{ width: barWidth }}
                  />
                  <span className="text-[10px] text-[var(--text-quaternary)]">{total}</span>
                </button>
              );
            })}
          </div>
        </nav>

        {/* 右侧主时间线流 */}
        <div ref={scrollRef} className="relative flex-1 overflow-y-auto custom-scrollbar">
          <div className="px-6 md:px-10 py-8 max-w-[1400px] mx-auto fade-in">
            {years.map((yearGroup) => (
              <section
                key={yearGroup.year}
                ref={(el) => {
                  if (el) yearSectionRefs.current.set(yearGroup.year, el);
                  else yearSectionRefs.current.delete(yearGroup.year);
                }}
                className="mb-14"
                aria-label={`${yearGroup.year} 年`}
              >
                {/* 年份大标题 */}
                <div className="flex items-baseline gap-4 mb-8">
                  <h2 className="text-5xl md:text-6xl font-bold leading-none tracking-tight bg-gradient-to-br from-[var(--text-primary)] to-[var(--text-tertiary)] bg-clip-text text-transparent">
                    {yearGroup.year}
                  </h2>
                  <span className="text-sm text-[var(--text-quaternary)]">{yearGroup.total} 个片段</span>
                </div>

                <div className="space-y-9">
                  {yearGroup.months.map((monthGroup) => (
                    <MonthBlock
                      key={monthGroup.key}
                      month={monthGroup}
                      height={cardHeight}
                      onQuickLook={onQuickLook}
                    />
                  ))}
                </div>
              </section>
            ))}

            {/* 未知时间的照片：归到末尾，避免丢失 */}
            {unknown.length > 0 && (
              <section className="mb-10 opacity-80" aria-label="未知时间">
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-[var(--text-quaternary)]"><ClockIcon /></span>
                  <h2 className="text-lg font-semibold text-[var(--text-tertiary)]">未知时间</h2>
                  <span className="text-xs text-[var(--text-quaternary)]">{unknown.length} 项 · 缺少拍摄时间</span>
                </div>
                <FilmStrip photos={unknown} height={cardHeight} onQuickLook={onQuickLook} />
              </section>
            )}

            <div className="h-10" />
          </div>

          {/* 回到顶部：滚动超过一屏后出现 */}
          <button
            type="button"
            onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
            aria-hidden={!showBackToTop}
            tabIndex={showBackToTop ? 0 : -1}
            className={`absolute bottom-6 left-1/2 -translate-x-1/2 app-no-drag flex items-center gap-1.5 h-8 px-3.5 rounded-full bg-[var(--bg-elevated)] backdrop-blur-xl border border-[var(--border-default)] shadow-lg text-[12px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-hover)] transition-all duration-300 ${
              showBackToTop ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'
            }`}
          >
            <ArrowUpIcon />
            回到顶部
          </button>
        </div>
      </div>
    </div>
  );
};

/** 顶部标题栏：返回按钮 + 标题 + 统计 + 密度切换 */
const TimelineHeader: React.FC<{
  onBack: () => void;
  isLeftPaneOpen: boolean;
  total: number;
  rangeLabel: string;
  yearsCount: number;
  density: DensityKey;
  onDensityChange: (key: DensityKey) => void;
}> = ({ onBack, isLeftPaneOpen, total, rangeLabel, yearsCount, density, onDensityChange }) => (
  <header className={`app-drag shrink-0 bg-[var(--bg-elevated)] backdrop-blur-xl border-b border-[var(--border-subtle)] z-20 sticky top-0 ${isLeftPaneOpen ? 'px-4' : 'pl-[78px] pr-4'}`}>
    <div className="app-no-drag flex items-center gap-3 h-[52px]">
      <button
        type="button"
        onClick={onBack}
        title="返回图库（Esc）"
        aria-label="返回图库"
        className="flex items-center justify-center w-9 h-9 rounded-xl text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] active:scale-[0.98] transition-all duration-200 shrink-0"
      >
        <ChevronLeftIcon />
      </button>

      <div className="flex items-center gap-2.5 min-w-0">
        <h1 className="text-[17px] font-semibold text-[var(--text-primary)] truncate">时光画廊</h1>
        {total > 0 && (
          <div className="hidden sm:flex items-center gap-1.5 text-[12px] text-[var(--text-tertiary)] shrink-0">
            <ImagesIcon />
            <span>{total} 项</span>
            {yearsCount > 1 && (
              <>
                <span className="text-[var(--text-quaternary)]">·</span>
                <span>{yearsCount} 个年份</span>
              </>
            )}
            {rangeLabel && (
              <>
                <span className="text-[var(--text-quaternary)]">·</span>
                <CalendarIcon />
                <span className="truncate max-w-[260px]">{rangeLabel}</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* 密度切换：与图库网格缩放同一心智 */}
      <div
        role="radiogroup"
        aria-label="卡片大小"
        className="ml-auto flex items-center gap-0.5 p-0.5 rounded-lg bg-[var(--bg-input)] border border-[var(--border-subtle)] shrink-0"
      >
        {DENSITY_OPTIONS.map((opt) => {
          const active = density === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              role="radio"
              aria-checked={active}
              title={`${opt.label}显示`}
              onClick={() => onDensityChange(opt.key)}
              className={`px-2.5 h-[22px] rounded-md text-[11px] font-medium transition-colors duration-150 ${
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

export default TimelineGallery;
