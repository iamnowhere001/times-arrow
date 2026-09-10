
import React, { useRef, useState, useCallback, useMemo, useEffect, useLayoutEffect, forwardRef, useImperativeHandle } from 'react';
import { Photo, ViewMode, SortConfig, SortKey } from '../types';
import { formatBytes, formatDate, formatVideoDuration, isVideoPhoto } from '../utils';
import { useThumbnailSrc, useVideoPoster, ThumbImage } from './ThumbnailImage';

/**
 * 把时间戳格式化为「今天 / 昨天 / 具体日期」，用于滚动日期胶囊。
 * 与 App 的日期分组语义保持一致，只是轻量展示用途。
 */
function formatDayCapsule(timestamp?: number): string | null {
  if (!timestamp || Number.isNaN(timestamp)) return null;
  const d = new Date(timestamp);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return '今天';
  if (d.toDateString() === y.toDateString()) return '昨天';
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** VirtualGrid 对外暴露的命令式句柄 */
export interface VirtualGridHandle {
  /** 滚动到指定照片（键盘导航跟随视口） */
  scrollToItem: (id: string) => void;
}

/* ---------------------------------------------------------------------------
 * 网格卡片尺寸常量
 * 卡片结构 = 内边距 + 图片区（高度等于行高）。
 * 文件名不再独占一行，而是悬停时浮在图片底部，图片区因此吃满整张卡片的高度。
 * VirtualGrid 的布局计算与 ImageCard 的 className 必须保持一致，改样式时同步这里。
 * ------------------------------------------------------------------------- */
/** 尺寸未知时的兜底比例（宽 / 高） */
const FALLBACK_IMAGE_ASPECT = 4 / 3;
/** 极端长图 / 全景的比例钳制，避免单张卡片把整行撑得不可用 */
const MIN_IMAGE_ASPECT = 0.2;
const MAX_IMAGE_ASPECT = 5;
const CARD_PADDING = 2;       // p-0.5
/** 卡片中图片区之外占用的固定高度：只剩上下内边距 */
const CARD_CHROME_HEIGHT = CARD_PADDING * 2;

/**
 * 取照片的展示宽高比。
 * 手机截屏（约 9:19.5）、竖幅人像、全景都会被如实保留 —— 长图因此得到更高的卡片，
 * 配合图片区的 object-contain，画面内容（含截屏里的文字）不会被裁掉。
 */
function photoAspect(photo: Photo): number {
  const dim = photo.dimensions;
  if (!dim || !dim.width || !dim.height) return FALLBACK_IMAGE_ASPECT;
  const aspect = dim.width / dim.height;
  if (!Number.isFinite(aspect) || aspect <= 0) return FALLBACK_IMAGE_ASPECT;
  return Math.min(MAX_IMAGE_ASPECT, Math.max(MIN_IMAGE_ASPECT, aspect));
}

interface GridCell {
  photo: Photo;
  left: number;
  width: number;
}

interface GridRow {
  top: number;
  /** 图片区高度（不含内边距 / 名称行） */
  height: number;
  cells: GridCell[];
}

interface GridLayout {
  rows: GridRow[];
  /** 下标与 items 对齐：每一项所在的行号 */
  rowOfItem: number[];
  totalHeight: number;
}

/**
 * 居中行布局（justified rows，类似 Google Photos / Flickr）：
 * 按原始顺序把照片逐行铺满容器宽度，同一行共用行高、宽度按各自比例分配。
 * 好处：排序顺序不变、行内不留空隙、每张卡片的比例与照片一致（不裁切内容）。
 */
function buildGridLayout(
  items: Photo[],
  containerWidth: number,
  targetRowHeight: number,
  gap: number
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
    // 解 sum(aspect) * h + 内边距 + 间距 = 容器宽度，得到「图片区高度」
    const chrome = CARD_PADDING * 2 * buffer.length + gap * (buffer.length - 1);
    let height = (containerWidth - chrome) / ratioSum;
    // 末行不满时不做拉伸，避免寥寥几张被放大得离谱
    if (!stretch) height = Math.min(height, targetRowHeight);
    height = Math.max(48, Math.min(height, containerWidth));

    let left = 0;
    const cells: GridCell[] = buffer.map(entry => {
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
function findRowAt(rows: GridRow[], y: number): number {
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

/**
 * 虚拟化网格：只渲染视口内（含 overscan）的卡片。
 * 行高按照片真实比例计算，长图（手机截屏等）会占据更高的行。
 * 额外支持：
 *  - onBlankClick：点击卡片间隙的空白 → 取消选择（Photos 式行为）
 *  - stickyLabel：滚动时在顶部贴住当前首行照片对应的日期标签
 *  - onColumnsChange：每行张数上报（App 用于方向键导航步长）
 */
const VirtualGrid = forwardRef<VirtualGridHandle, {
  items: Photo[];
  /** 目标行高（图片区高度），由缩放滑块控制 */
  targetRowHeight: number;
  gap: number;
  overscan?: number;
  onBlankClick?: () => void;
  onContainerContextMenu?: (e: React.MouseEvent) => void;
  onColumnsChange?: (columns: number) => void;
  stickyLabel?: (photo: Photo) => string | null;
  children: (photo: Photo, style: React.CSSProperties, itemWidth: number) => React.ReactNode;
}>(({ items, targetRowHeight, gap, overscan = 2, onBlankClick, onContainerContextMenu, onColumnsChange, stickyLabel, children }, ref) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);

  // 监听容器尺寸变化，计算列数
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const update = () => setViewport({ width: el.clientWidth, height: el.clientHeight });
    update();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // rAF 节流：滚动事件触发频率远高于刷新率，直接 setState 会造成大量无效重渲染
  const rafRef = useRef(0);
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const top = e.currentTarget.scrollTop;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      setScrollTop(top);
    });
  }, []);

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  const layout = useMemo(
    () => buildGridLayout(items, viewport.width, targetRowHeight, gap),
    [items, viewport.width, targetRowHeight, gap]
  );
  const { rows, rowOfItem, totalHeight } = layout;

  const startRow = rows.length > 0 ? Math.max(0, findRowAt(rows, scrollTop) - overscan) : 0;
  const endRow =
    rows.length > 0
      ? Math.min(rows.length, findRowAt(rows, scrollTop + (viewport.height || 600)) + overscan + 1)
      : 0;

  // 每行张数上报：App 的方向键导航需要「↓ = 下一行」的步长
  const itemsPerRow = rows[0]?.cells.length ?? 1;
  useEffect(() => {
    onColumnsChange?.(itemsPerRow);
  }, [itemsPerRow, onColumnsChange]);

  // 命令式滚动：键盘导航时让选中项滚入视口
  useImperativeHandle(ref, () => ({
    scrollToItem: (id: string) => {
      const el = scrollRef.current;
      if (!el) return;
      const index = items.findIndex(p => p.id === id);
      if (index < 0) return;
      const row = rows[rowOfItem[index]];
      if (!row) return;
      const cardHeight = row.height + CARD_CHROME_HEIGHT;
      const targetTop = Math.max(0, row.top - 8);
      // 目标行在视口上方或下方时才滚动，避免每次按键都跳动
      if (targetTop < el.scrollTop || targetTop + cardHeight > el.scrollTop + el.clientHeight) {
        el.scrollTo({ top: targetTop, behavior: 'auto' });
      }
    },
  }), [items, rows, rowOfItem]);

  const visible: React.ReactNode[] = [];
  for (let r = startRow; r < endRow; r += 1) {
    const row = rows[r];
    if (!row) break;
    for (const cell of row.cells) {
      visible.push(
        <div
          key={cell.photo.id}
          // 悬停卡片会轻微上浮，抬高一层保证阴影不被相邻卡片压住
          className="hover:z-10"
          style={{
            position: 'absolute',
            left: cell.left,
            top: row.top,
            width: cell.width,
            height: row.height + CARD_CHROME_HEIGHT,
          }}
        >
          {children(cell.photo, { width: '100%', height: '100%' }, cell.width)}
        </div>
      );
    }
  }

  // 顶部日期胶囊：仅当用户向下滚动超过首行、且提供了格式化函数时出现。
  // 取“最上方已滚动到的首行”对应的照片，随滚动实时换文案。
  let topCapsule: string | null = null;
  if (stickyLabel && rows.length > 0) {
    const row = rows[findRowAt(rows, scrollTop)];
    if (row && scrollTop >= (row.height + CARD_CHROME_HEIGHT) * 0.6 && row.cells.length > 0) {
      topCapsule = stickyLabel(row.cells[0].photo);
    }
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      onClick={(e) => {
        if (e.target === e.currentTarget) onBlankClick?.();
      }}
      onContextMenu={(e) => {
        // 空白区域右键（卡片自身会 stopPropagation）
        onContainerContextMenu?.(e);
      }}
      className="flex-1 overflow-y-auto custom-scrollbar min-h-0 p-4"
    >
      {topCapsule !== null && (
        <div
          className="pointer-events-none flex justify-start"
          style={{ position: 'sticky', top: 4, zIndex: 30 }}
        >
          <span
            key={topCapsule}
            className="date-capsule animate-scaleIn inline-flex items-center gap-2 rounded-full bg-[var(--bg-elevated)] px-4 py-1.5 text-xs font-semibold text-[var(--text-primary)] border border-[var(--border-default)] shadow-lg shadow-[rgba(0,0,0,0.3)]"
          >
            <svg className="w-3.5 h-3.5 text-[var(--accent-cyan)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round">
              <rect x="3" y="4" width="18" height="18" rx="2"></rect>
              <line x1="16" y1="2" x2="16" y2="6"></line>
              <line x1="8" y1="2" x2="8" y2="6"></line>
              <line x1="3" y1="10" x2="21" y2="10"></line>
            </svg>
            {topCapsule}
          </span>
        </div>
      )}
      <div style={{ position: 'relative', height: totalHeight }}>
        {visible}
      </div>
    </div>
  );
});

VirtualGrid.displayName = 'VirtualGrid';

/** ImageGrid 对外暴露的命令式句柄：滚动定位到某张照片（网格 / 列表通用） */
export interface ImageGridHandle {
  scrollToPhoto: (id: string) => void;
}

interface ImageGridProps {
  photos: Photo[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string, multiSelect: boolean) => void;
  onRangeSelect: (id: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onFavoriteSelected: () => void;
  viewMode: ViewMode;
  scale: number;
  sortConfig: SortConfig;
  onSort: (key: SortKey) => void;
  onToggleFavorite: (id: string) => void;
  onQuickLook: (photo: Photo) => void;
  onContextMenu?: (e: React.MouseEvent, photo?: Photo) => void;
  onShowDeleteConfirm: () => void;
  onBatchRename?: () => void;
  /** 导出选中项（批量转换格式） */
  onExportSelected?: () => void;
  /** 列数变化上报：App 用于方向键导航步长 */
  onColumnsChange?: (columns: number) => void;
  /** 情境条左侧展示的分类名（所有照片 / 收藏夹） */
  viewTitle?: string;
  /** 空状态引导 */
  emptyTitle?: string;
  emptyDescription?: string;
  onOpenDirectory?: () => void;
  onAddImages?: () => void;
  /** 收藏夹为空时，引导跳回所有照片 */
  onShowAll?: () => void;
  /** 搜索无结果时，清除搜索 */
  onClearSearch?: () => void;
  /** onShowAll 按钮文案（默认「前往「所有照片」」，筛选无结果时改为「清除筛选」） */
  showAllLabel?: string;
  /** 已删除、正在播塌陷动画的条目：卡片仍渲染，但淡出且不可交互 */
  exitingIds?: Set<string>;
}

/** 注意：所有回调都必须是稳定引用，否则 React.memo 会失效 */
interface ImageCardProps {
  photo: Photo;
  isSelected: boolean;
  onSelect: (id: string, multiSelect: boolean) => void;
  onRange: (id: string) => void;
  onOpen: (photo: Photo) => void;
  onMenu: (e: React.MouseEvent, photo: Photo) => void;
  onToggleFavorite: (id: string) => void;
  onShowDeleteConfirm: () => void;
  /** 卡片渲染宽度（CSS px），用于按屏幕像素比按需提升缩略图分辨率 */
  cardWidth: number;
  /** 已从磁盘删除、正在播塌陷动画：此时卡片还在，但已不可交互 */
  isExiting: boolean;
  /** 首屏入场的交错延迟（ms）；undefined 表示不参与入场动画 */
  enterDelay?: number;
}

const ImageCard = React.memo(({
  photo,
  isSelected,
  onSelect,
  onRange,
  onOpen,
  onMenu,
  onToggleFavorite,
  onShowDeleteConfirm,
  cardWidth,
  isExiting,
  enterDelay
}: ImageCardProps) => {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  const isVideo = isVideoPhoto(photo);

  // 磁盘缩略图按需解析：进入视口才请求，并按「渲染宽度 × 屏幕像素比」自动提升清晰度
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const targetSize = cardWidth * dpr;
  const src = useThumbnailSrc(photo, targetSize);
  // 视频首帧：命中缩略图直接当图片用；否则退化为 <video> 静帧
  const poster = useVideoPoster(photo, targetSize);

  const handleImageLoad = useCallback(() => {
    setLoaded(true);
  }, []);

  const handleImageError = useCallback(() => {
    setLoadError(true);
  }, []);

  const retryLoading = useCallback(() => {
    setLoadError(false);
    setLoaded(false);
    if (imgRef.current && src) {
      imgRef.current.src = src;
    }
  }, [src]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (e.shiftKey) {
      onRange(photo.id);
      return;
    }
    onSelect(photo.id, e.metaKey || e.ctrlKey);
  }, [photo.id, onSelect, onRange]);

  // 视频且主进程/抓帧均不可用：直接用 <video> 渲染首帧兜底
  const useVideoElement = isVideo && !poster.src && poster.failed;
  const mediaSrc = isVideo ? poster.src : src;
  const mediaPending = isVideo ? !poster.src && !poster.failed : !src;

  // 视频时长角标：元数据只能由播放器加载后上报，未就绪时不显示（而不是显示 0:00）
  const durationLabel = isVideo ? formatVideoDuration(photo.duration) : '';

  return (
    <div
      onClick={handleClick}
      onDoubleClick={() => onOpen(photo)}
      onContextMenu={(e) => onMenu(e, photo)}
      style={enterDelay !== undefined ? { animationDelay: `${enterDelay}ms` } : undefined}
      className={`group relative flex flex-col items-center p-0.5 rounded-lg cursor-pointer w-full h-full transition-[transform,opacity,background-color,box-shadow] duration-200 ease-entrance ${enterDelay !== undefined ? 'animate-fadeInUp ' : ''}${
        isExiting
          ? 'opacity-0 scale-[0.92] pointer-events-none'
          : isSelected
            ? 'shadow-lg shadow-[rgba(var(--accent-blue-rgb),0.2)]'
            : 'hover:bg-[var(--bg-glass)] hover:-translate-y-0.5 hover:scale-[1.005]'
      }`}
    >
      <div
        className={`relative flex-1 min-h-0 w-full rounded-md overflow-hidden bg-[var(--bg-card)] border transition-[border-color,box-shadow] duration-200 ease-entrance ${
          isSelected
            ? 'border-transparent ring-2 ring-inset ring-[var(--accent-blue)]'
            : 'border-[var(--border-subtle)] group-hover:border-[var(--border-hover)]'
        }`}
      >
        {/* 圆形选择圈：入场做淡入 + 轻微放大，悬停/按下与收藏按钮同一套缩放反馈 */}
        <div className={`absolute top-1.5 left-1.5 z-10 transition-[opacity,transform] duration-200 ease-entrance ${
          isSelected ? 'opacity-100 scale-100' : 'opacity-0 scale-90 group-hover:opacity-100 group-hover:scale-100'
        }`}>
          <button
            type="button"
            role="checkbox"
            aria-checked={isSelected}
            aria-label={isSelected ? '取消选择' : '选择'}
            title={isSelected ? '取消选择' : '选择'}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(photo.id, true);
            }}
            className={`flex items-center justify-center w-6 h-6 rounded-full border-2 backdrop-blur-md cursor-pointer transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--accent-blue-rgb),0.6)] hover:scale-110 active:scale-90 ${
              isSelected
                ? 'border-[var(--accent-blue)] bg-[var(--accent-blue)] text-[var(--accent-contrast)] shadow-lg shadow-[rgba(var(--accent-blue-rgb),0.45)]'
                : 'border-[rgba(255,255,255,0.85)] bg-[rgba(0,0,0,0.35)] text-transparent hover:bg-[rgba(0,0,0,0.55)] hover:border-white'
            }`}
          >
            {/* 勾选出现在圆心：从小放大 + 回弹，让「选中」这个动作看得见 */}
            <svg
              className={`w-3.5 h-3.5 transition-transform duration-200 ease-entrance ${isSelected ? 'scale-100' : 'scale-50'}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 13l4 4L19 7" />
            </svg>
          </button>
        </div>

        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite(photo.id);
          }}
          className={`absolute top-1.5 right-1.5 z-10 p-2 rounded-full backdrop-blur-md transition-all duration-200 hover:scale-110 active:scale-90 ${
            photo.isFavorite
              ? 'text-[var(--accent-pink)] opacity-100 bg-[rgba(var(--accent-pink-rgb),0.2)] hover:bg-[rgba(var(--accent-pink-rgb),0.3)] shadow-lg shadow-[rgba(var(--accent-pink-rgb),0.25)]'
              : isSelected
                ? 'text-white opacity-100 bg-[rgba(0,0,0,0.4)] hover:bg-[rgba(0,0,0,0.6)] backdrop-blur-md'
                : 'text-white opacity-0 group-hover:opacity-100 bg-[rgba(0,0,0,0.4)] hover:bg-[rgba(0,0,0,0.6)] backdrop-blur-md'
          }`}
          title="收藏"
          aria-label="收藏"
        >
          <svg className="w-5 h-5" fill={photo.isFavorite ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"></path>
          </svg>
        </button>

        {photo.isCover && (
          <div className="absolute bottom-1.5 right-1.5 z-10 flex items-center gap-1 px-2 py-1 rounded-full bg-[rgba(0,0,0,0.55)] text-white text-[10px] font-medium backdrop-blur-md shadow-lg">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2l2.9 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14 5 9.27l7.1-1.01z" />
            </svg>
            封面
          </div>
        )}

        {isSelected && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onShowDeleteConfirm();
            }}
            className="absolute top-1.5 right-12 z-10 p-2 rounded-full transition-all duration-200 text-white bg-[rgba(0,0,0,0.45)] border border-[rgba(255,255,255,0.3)] hover:text-[var(--accent-pink)] hover:border-[rgba(232,94,102,0.7)] hover:bg-[rgba(var(--accent-pink-rgb),0.28)] backdrop-blur-md hover:scale-110 active:scale-90"
            title="删除"
            aria-label="删除选中"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        )}

        {(!loaded || mediaPending) && !loadError && (
          <div className="absolute inset-0 bg-[rgba(255,255,255,0.03)] animate-pulse flex items-center justify-center">
            <div className="w-10 h-10 rounded-full border-2 border-[rgba(255,255,255,0.1)] border-t-[var(--accent-blue)] animate-spin"></div>
          </div>
        )}

        {loadError && (
          <div className="absolute inset-0 bg-[rgba(var(--accent-pink-rgb),0.05)] backdrop-blur-sm flex flex-col items-center justify-center p-4">
            <svg className="w-12 h-12 text-[rgba(var(--accent-pink-rgb),0.4)] mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <p className="text-sm text-[rgba(var(--accent-pink-rgb),0.7)] text-center">
              {isVideo ? '无法预览此视频' : '图片加载失败'}
            </p>
            {isVideo && (
              <p className="mt-1.5 text-[10px] leading-snug text-[rgba(var(--accent-pink-rgb),0.55)] text-center">
                编码格式可能不受支持，可右键「在访达中显示」用系统播放器打开
              </p>
            )}
            {!isVideo && (
              <button
                onClick={retryLoading}
                className="mt-3 px-3 py-1.5 text-xs bg-[rgba(var(--accent-pink-rgb),0.2)] text-[var(--accent-pink-hover)] rounded-lg hover:bg-[rgba(var(--accent-pink-rgb),0.3)] transition-colors border border-[rgba(var(--accent-pink-rgb),0.3)]"
              >
                重试
              </button>
            )}
          </div>
        )}

        {useVideoElement ? (
          <video
            src={`${photo.url}#t=0.1`}
            preload="metadata"
            muted
            playsInline
            className={`w-full h-full object-contain transition-[opacity,transform] duration-500 ease-out ${
              loaded ? 'opacity-100 scale-100' : 'opacity-0 scale-105'
            }`}
            onLoadedData={handleImageLoad}
            onError={handleImageError}
          />
        ) : (
          <img
            ref={imgRef}
            src={mediaSrc ?? undefined}
            alt={photo.name}
            className={`w-full h-full object-contain transition-[opacity,transform] duration-500 ease-out ${
              loaded ? 'opacity-100 scale-100' : 'opacity-0 scale-105'
            }`}
            loading="lazy"
            decoding="async"
            onLoad={handleImageLoad}
            onError={handleImageError}
          />
        )}

        {/* 视频播放标识：让静态首帧一眼可辨 */ }
        {isVideo && !loadError && (
          <div className="absolute inset-0 z-[5] flex items-center justify-center pointer-events-none">
            <span className="w-11 h-11 rounded-full bg-[rgba(0,0,0,0.45)] backdrop-blur-md border border-[rgba(255,255,255,0.25)] flex items-center justify-center text-white shadow-lg transition-transform duration-300 group-hover:scale-110">
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </span>
          </div>
        )}

        {/* 时长角标：贴在左下角，位于文件名浮层之上 */}
        {isVideo && durationLabel && !loadError && (
          <div className="absolute bottom-1.5 left-1.5 z-[7] px-1.5 py-0.5 rounded-md bg-[rgba(0,0,0,0.6)] text-white text-[10px] font-medium tabular-nums backdrop-blur-md shadow-sm">
            {durationLabel}
          </div>
        )}

        {/* 文件名浮层：不再占卡片高度，悬停（或选中）时贴在图底渐显。
            「封面」角标在右下，因此有角标时给文字留出右侧空位。
            加载失败时不盖住重试按钮。 */}
        {!loadError && (
          <div
            className={`pointer-events-none absolute inset-x-0 bottom-0 z-[6] ${durationLabel ? 'pl-14 pr-2' : 'px-2'} pt-5 pb-1.5 bg-[linear-gradient(to_top,rgba(0,0,0,0.78),rgba(0,0,0,0.45)_55%,transparent)] transition-opacity duration-200 ease-entrance ${
              isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            }`}
          >
            <p
              title={photo.name}
              className={`text-[11px] leading-tight font-medium truncate text-white ${photo.isCover ? 'pr-14' : ''}`}
            >
              {photo.name}
            </p>
          </div>
        )}
      </div>
    </div>
  );
});

ImageCard.displayName = 'ImageCard';

/** 列表模式行高（px），用于窗口化计算 */
const LIST_ROW_HEIGHT = 57;
/** 无条目在塌陷时的空集合：保持引用稳定，避免每次渲染都让 memo 失效 */
const NO_EXITING_IDS: Set<string> = new Set();

/** 首屏入场的交错参数：只给第一批卡片排延迟，避免大库里几百张集体淡入 */
const INTRO_COUNT = 12;
const INTRO_STAGGER_MS = 8;
/** 入场播完后立刻撤销标记：否则虚拟化重挂载卡片时会反复重播 */
const INTRO_CLEAR_MS = 1200;
const NO_INTRO_DELAYS: Map<string, number> = new Map();
/** 网格模式列间距（对应 gap-1 = 4px）：加上卡片自身内边距，相邻图片净留白 8px */
const GRID_GAP = 4;

const SORT_OPTIONS: Array<{ key: SortKey; label: string }> = [
  { key: 'dateTaken', label: '日期' },
  { key: 'name', label: '名称' },
  { key: 'size', label: '大小' },
];

const ImageGrid = forwardRef<ImageGridHandle, ImageGridProps>(({
  photos,
  selectedIds,
  onToggleSelect,
  onRangeSelect,
  onSelectAll,
  onClearSelection,
  onFavoriteSelected,
  viewMode,
  scale,
  sortConfig,
  onSort,
  onToggleFavorite,
  onQuickLook,
  onContextMenu,
  onShowDeleteConfirm,
  onBatchRename,
  onExportSelected,
  onColumnsChange,
  viewTitle,
  emptyTitle = '没有照片',
  emptyDescription = '拖放图片到此处，或点击上方按钮打开文件夹',
  onOpenDirectory,
  onAddImages,
  onShowAll,
  onClearSearch,
  showAllLabel = '前往「所有照片」',
  exitingIds = NO_EXITING_IDS,
}, ref) => {
  const selectAllRef = useRef<HTMLInputElement>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const virtualGridRef = useRef<VirtualGridHandle>(null);

  // 列表 / 网格统一的滚动定位：方向键导航时让选中项进入视口
  useImperativeHandle(ref, () => ({
    scrollToPhoto: (id: string) => {
      if (viewMode === 'list') {
        const el = listScrollRef.current;
        if (!el) return;
        const index = photos.findIndex(p => p.id === id);
        if (index < 0) return;
        const targetTop = Math.max(0, index * LIST_ROW_HEIGHT - 60);
        if (targetTop < el.scrollTop || targetTop + LIST_ROW_HEIGHT > el.scrollTop + el.clientHeight) {
          el.scrollTo({ top: targetTop, behavior: 'auto' });
        }
      } else {
        virtualGridRef.current?.scrollToItem(id);
      }
    },
  }), [viewMode, photos]);

  // 列表模式的滚动位置与视口高度，用于窗口化渲染
  const [listScroll, setListScroll] = useState({ top: 0, height: 0 });

  // rAF 节流：避免滚动事件高频触发 setState
  const listRafRef = useRef(0);
  const handleListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const top = el.scrollTop;
    const height = el.clientHeight;
    if (listRafRef.current) return;
    listRafRef.current = requestAnimationFrame(() => {
      listRafRef.current = 0;
      setListScroll(prev =>
        prev.top === top && prev.height === height ? prev : { top, height }
      );
    });
  }, []);

  useEffect(() => () => {
    if (listRafRef.current) cancelAnimationFrame(listRafRef.current);
  }, []);

  useEffect(() => {
    if (viewMode !== 'list') return;
    const el = listScrollRef.current;
    if (el) setListScroll(prev => ({ ...prev, height: el.clientHeight }));
  }, [viewMode, photos.length]);

  const listStartIndex = Math.max(0, Math.floor(listScroll.top / LIST_ROW_HEIGHT) - 6);
  const listEndIndex = Math.min(
    photos.length,
    listStartIndex + Math.ceil((listScroll.height || 600) / LIST_ROW_HEIGHT) + 12
  );

  // 「全选」语义：只针对当前视图中出现的照片计算
  const allVisibleSelected = useMemo(
    () => photos.length > 0 && photos.every(p => selectedIds.has(p.id)),
    [photos, selectedIds]
  );
  const visibleSelectedCount = useMemo(
    () => photos.reduce((acc, p) => acc + (selectedIds.has(p.id) ? 1 : 0), 0),
    [photos, selectedIds]
  );

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = visibleSelectedCount > 0 && !allVisibleSelected;
    }
  }, [visibleSelectedCount, allVisibleSelected]);

  // 缩放滑块映射为「目标行高」（图片区高度）：0.5x ~ 2x
  const BASE_ROW_HEIGHT = 200;
  const targetRowHeight = Math.round(BASE_ROW_HEIGHT * scale);

  // 把最新的回调存进 ref，向下传递恒定引用，保证 React.memo 真正生效
  const handlersRef = useRef({ onToggleSelect, onRangeSelect, onQuickLook, onContextMenu, onToggleFavorite, onShowDeleteConfirm, onClearSelection });
  handlersRef.current = { onToggleSelect, onRangeSelect, onQuickLook, onContextMenu, onToggleFavorite, onShowDeleteConfirm, onClearSelection };

  const handleSelect = useCallback((id: string, multiSelect: boolean) => {
    handlersRef.current.onToggleSelect(id, multiSelect);
  }, []);

  const handleRange = useCallback((id: string) => {
    handlersRef.current.onRangeSelect(id);
  }, []);

  const handleOpen = useCallback((photo: Photo) => {
    handlersRef.current.onQuickLook(photo);
  }, []);

  const handleMenu = useCallback((e: React.MouseEvent, photo: Photo) => {
    // 阻止冒泡到滚动容器的「空白区域右键」
    e.stopPropagation();
    handlersRef.current.onContextMenu?.(e, photo);
  }, []);

  const handleFavorite = useCallback((id: string) => {
    handlersRef.current.onToggleFavorite(id);
  }, []);

  const handleDeleteConfirm = useCallback(() => {
    handlersRef.current.onShowDeleteConfirm();
  }, []);

  const handleBlankClick = useCallback(() => {
    handlersRef.current.onClearSelection();
  }, []);

  /**
   * 首屏导入后的交错入场。只做一次：播完就把标记撤掉，
   * 否则卡片滚出视口再滚回来时（虚拟化重挂载）会反复重播淡入。
   */
  const [introDelays, setIntroDelays] = useState<Map<string, number>>(NO_INTRO_DELAYS);
  const introDoneRef = useRef(false);
  useEffect(() => {
    if (introDoneRef.current || photos.length === 0) return;
    introDoneRef.current = true;

    const delays = new Map<string, number>();
    photos.slice(0, INTRO_COUNT).forEach((p, i) => delays.set(p.id, i * INTRO_STAGGER_MS));
    setIntroDelays(delays);

    const timer = window.setTimeout(() => setIntroDelays(NO_INTRO_DELAYS), INTRO_CLEAR_MS);
    return () => window.clearTimeout(timer);
  }, [photos]);

  const renderCard = useCallback((photo: Photo, _style: React.CSSProperties, itemWidth: number) => (
    <ImageCard
      photo={photo}
      isSelected={selectedIds.has(photo.id)}
      onSelect={handleSelect}
      onRange={handleRange}
      onOpen={handleOpen}
      onMenu={handleMenu}
      onToggleFavorite={handleFavorite}
      onShowDeleteConfirm={handleDeleteConfirm}
      cardWidth={itemWidth}
      isExiting={exitingIds.has(photo.id)}
      enterDelay={introDelays.get(photo.id)}
    />
  ), [selectedIds, exitingIds, introDelays, handleSelect, handleRange, handleOpen, handleMenu, handleFavorite, handleDeleteConfirm]);

  const renderRow = useCallback((photo: Photo) => {
    const isSelected = selectedIds.has(photo.id);
    const isExiting = exitingIds.has(photo.id);
    const rowClick = (e: React.MouseEvent) => {
      if (e.shiftKey) {
        onRangeSelect(photo.id);
        return;
      }
      handleSelect(photo.id, e.metaKey || e.ctrlKey);
    };
    return (
      <tr
        onClick={rowClick}
        onDoubleClick={() => handleOpen(photo)}
        onContextMenu={(e) => handleMenu(e, photo)}
        className={`cursor-pointer transition-[opacity,background-color,color] duration-200 ease-entrance ${
          isExiting
            ? 'opacity-0 pointer-events-none'
            : isSelected
              ? 'bg-[rgba(var(--accent-blue-rgb),0.15)] text-[var(--text-primary)]'
              : 'hover:bg-[var(--bg-glass)] text-[var(--text-secondary)]'
        }`}
      >
        <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => handleSelect(photo.id, true)}
            className="rounded-lg border-2 border-[rgba(255,255,255,0.2)] bg-[rgba(0,0,0,0.2)] text-[var(--accent-blue)] focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.4)] cursor-pointer accent-[var(--accent-blue)]"
            aria-label="选择"
          />
        </td>
        <td className="px-4 py-3">
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleFavorite(photo.id);
            }}
            className={`p-1.5 rounded-full transition-all duration-200 ${
              photo.isFavorite
                ? 'text-[var(--accent-pink)] bg-[rgba(var(--accent-pink-rgb),0.15)]'
                : 'text-[var(--text-quaternary)] hover:text-[var(--accent-pink)] hover:bg-[rgba(var(--accent-pink-rgb),0.15)]'
            }`}
            title="收藏"
            aria-label="收藏"
          >
            <svg className="w-4 h-4" fill={photo.isFavorite ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"></path>
            </svg>
          </button>
        </td>

        <td className="px-4 py-3">
          <div className="flex items-center gap-3">
            <ThumbImage
              photo={photo}
              size={40}
              className="w-10 h-10 rounded-lg object-cover border border-[var(--border-subtle)] shrink-0 bg-[var(--bg-card)]"
            />
            {isVideoPhoto(photo) && (
              <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium text-[var(--accent-cyan)] bg-[rgba(var(--accent-blue-rgb),0.12)] border border-[rgba(var(--accent-blue-rgb),0.25)]">
                <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                视频
              </span>
            )}
            <span className="font-medium truncate max-w-[200px]" title={photo.name}>{photo.name}</span>
          </div>
        </td>
        <td className="px-4 py-3 text-[var(--text-tertiary)]">{formatDate(photo.dateTaken || 0)}</td>
        <td className="px-4 py-3 text-[var(--text-tertiary)]">{formatDate(photo.lastModified)}</td>
        <td className="px-4 py-3 text-[var(--text-tertiary)]">{formatDate(photo.dateCreated || photo.lastModified)}</td>
        <td className="px-4 py-3 text-[var(--text-tertiary)] font-mono text-xs">{formatBytes(photo.size)}</td>
      </tr>
    );
  }, [selectedIds, exitingIds, handleSelect, handleRange, handleOpen, handleMenu, handleFavorite, onRangeSelect]);

  const SortIndicator = ({ columnKey }: { columnKey: SortKey }) => {
    const isActive = sortConfig.key === columnKey;
    return (
      <span className={`ml-1 inline-flex items-center justify-center w-4 h-4 transition-all duration-200 ${
        isActive ? 'opacity-100 text-[var(--accent-cyan)]' : 'opacity-0 text-[var(--text-quaternary)] group-hover:opacity-50'
      }`}>
        {isActive && sortConfig.direction === 'desc' ? '↓' : '↑'}
      </span>
    );
  };

  /**
   * 排序 / 分类切换后的整组淡入。
   * 先无过渡地落到初始态（透明 + 下移 4px），等浏览器真正绘制出这一帧，
   * 再切回终态由 transition 完成淡入。只动 opacity / transform，
   * 因此不影响虚拟化布局计算与已滚动位置。
   */
  const reflowKey = `${sortConfig.key}|${sortConfig.direction}|${viewTitle ?? ''}`;
  const [isReflowing, setIsReflowing] = useState(false);
  const prevReflowKeyRef = useRef(reflowKey);
  useEffect(() => {
    if (prevReflowKeyRef.current === reflowKey) return;
    prevReflowKeyRef.current = reflowKey;
    setIsReflowing(true);
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setIsReflowing(false));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [reflowKey]);

  const reflowClass = isReflowing
    ? 'opacity-0 translate-y-1'
    : 'opacity-100 translate-y-0 transition-[opacity,transform] duration-200 ease-entrance';

  const selectedCount = selectedIds.size;
  const inSelectMode = selectedCount > 0;

  /**
   * 选择条：网格与列表视图共用。
   * 批量重命名 / 导出 / 删除等「条目级操作」都集中在这里（出现即意味着有选中项可用），
   * 顶栏因此只需要承载导入与视图控制。
   */
  const selectionBar = inSelectMode ? (
    <div className="mb-3 mx-4 shrink-0 rounded-xl border backdrop-blur-xl px-3.5 py-2 flex items-center gap-2.5 min-h-[46px] transition-all duration-300 bg-[rgba(var(--accent-blue-rgb),0.08)] border-[rgba(var(--accent-blue-rgb),0.25)] shadow-lg shadow-[rgba(var(--accent-blue-rgb),0.1)]">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="relative flex w-2.5 h-2.5 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--accent-blue)] opacity-50"></span>
          <span className="relative inline-flex rounded-full w-2.5 h-2.5 bg-[var(--accent-blue)]"></span>
        </span>
        <span className="text-sm font-semibold text-[var(--text-primary)] whitespace-nowrap">已选 {selectedCount} 项</span>
        <button
          type="button"
          onClick={onClearSelection}
          title="清除选择（Esc）"
          className="ml-1 text-xs font-medium text-[var(--text-tertiary)] hover:text-[var(--text-primary)] px-2 py-1 rounded-lg hover:bg-[var(--bg-glass-hover)] transition-all duration-200"
        >
          ✕ 清除
        </button>
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-1.5">
        {!allVisibleSelected && (
          <button
            type="button"
            onClick={onSelectAll}
            className="hidden md:flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded-lg border border-[var(--border-default)] bg-[var(--bg-glass)] hover:bg-[var(--bg-glass-hover)] transition-all duration-200"
            title="全选当前视图（⌘A）"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"></path></svg>
            全选
          </button>
        )}
        <button
          type="button"
          onClick={onFavoriteSelected}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--accent-pink)] hover:bg-[rgba(var(--accent-pink-rgb),0.12)] rounded-lg border border-[var(--border-default)] bg-[var(--bg-glass)] transition-all duration-200"
          title="收藏 / 取消收藏选中项（⌘⇧F）"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"></path></svg>
          <span className="hidden sm:inline">收藏</span>
        </button>
        {onBatchRename && (
          <button
            type="button"
            onClick={onBatchRename}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--accent-cyan)] hover:bg-[rgba(var(--accent-blue-rgb),0.12)] rounded-lg border border-[var(--border-default)] bg-[var(--bg-glass)] transition-all duration-200"
            title="批量重命名"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            <span className="hidden sm:inline">重命名</span>
          </button>
        )}
        {onExportSelected && (
          <button
            type="button"
            onClick={onExportSelected}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--accent-green)] hover:bg-[rgba(var(--accent-green-rgb),0.12)] rounded-lg border border-[var(--border-default)] bg-[var(--bg-glass)] transition-all duration-200"
            title="批量导出（转换格式 / 压缩）"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
            <span className="hidden sm:inline">导出</span>
          </button>
        )}
        <button
          type="button"
          onClick={onShowDeleteConfirm}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] bg-[linear-gradient(135deg,var(--accent-pink),var(--accent-pink-deep))] hover:brightness-110 rounded-lg shadow-lg shadow-[rgba(var(--accent-pink-rgb),0.25)] transition-all duration-200 active:scale-[0.98]"
          title="移至回收站（Delete）"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path></svg>
          <span className="hidden sm:inline">删除</span>
        </button>
      </div>
    </div>
  ) : null;

  /* ============ 空状态：把“下一步能做什么”直接放在眼前 ============ */
  if (photos.length === 0) {
    const isWelcome = Boolean(onOpenDirectory || onAddImages);
    // 空库欢迎页的能力要点：纯本地 / 拖放导入 / 图片视频，帮助新用户建立预期。
    const welcomePoints = [
      {
        icon: (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="11" width="18" height="11" rx="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
        ),
        label: '纯本地处理',
      },
      {
        icon: (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
        ),
        label: '拖入文件夹',
      },
      {
        icon: (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="3" width="20" height="18" rx="2"></rect>
            <path d="M9 17L4 12l5-5m6 10l5-5-5-5"></path>
          </svg>
        ),
        label: '图片 & 视频',
      },
    ];

    return (
      <div
        className="flex-1 flex flex-col items-center justify-center text-[var(--text-tertiary)] p-12 min-h-0 overflow-y-auto text-center"
        onContextMenu={(e) => onContextMenu && onContextMenu(e)}
      >
        {isWelcome ? (
          /* 空库欢迎页：光晕 + 图标 + 能力要点 + 交错入场，第一印象更专业 */
          <>
            <div className="relative mb-8 animate-fadeInUp">
              <div className="absolute inset-0 -m-10 rounded-full bg-[radial-gradient(circle,rgba(var(--accent-blue-rgb),0.16)_0%,rgba(var(--accent-blue-rgb),0.05)_45%,transparent_72%)] blur-2xl" aria-hidden="true"></div>
              <div className="relative w-24 h-24 rounded-3xl bg-[linear-gradient(135deg,rgba(var(--accent-blue-rgb),0.2),rgba(var(--accent-blue-rgb),0.05))] border border-[rgba(var(--accent-blue-rgb),0.3)] flex items-center justify-center shadow-xl shadow-[rgba(var(--accent-blue-rgb),0.18)] backdrop-blur">
                <svg className="w-12 h-12 text-[var(--accent-blue)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
                </svg>
              </div>
            </div>
            <p className="text-xl font-semibold text-[var(--text-primary)] mb-2 animate-fadeInUp" style={{ animationDelay: '60ms' }}>{emptyTitle}</p>
            <p className="text-sm text-[var(--text-tertiary)] max-w-sm leading-relaxed mb-8 animate-fadeInUp" style={{ animationDelay: '120ms' }}>{emptyDescription}</p>
            <div className="flex flex-wrap items-center justify-center gap-3 mb-10 animate-fadeInUp" style={{ animationDelay: '180ms' }}>
              {welcomePoints.map((p) => (
                <div key={p.label} className="flex items-center gap-2 px-3.5 py-2 rounded-xl border border-[var(--border-default)] bg-[var(--bg-glass)] text-[var(--text-secondary)] backdrop-blur">
                  <span className="text-[var(--accent-cyan)]">{p.icon}</span>
                  <span className="text-xs font-medium">{p.label}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3 animate-fadeInUp" style={{ animationDelay: '240ms' }}>
              {onAddImages && (
                <button
                  onClick={onAddImages}
                  className="px-5 py-2.5 rounded-xl text-sm font-medium bg-[var(--bg-glass)] hover:bg-[var(--bg-glass-hover)] border border-[var(--border-default)] text-[var(--text-primary)] transition-all duration-200 active:scale-[0.98]"
                >
                  添加图片
                </button>
              )}
              {onOpenDirectory && (
                <button
                  onClick={onOpenDirectory}
                  className="px-5 py-2.5 rounded-xl text-sm font-semibold text-[var(--accent-contrast)] bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-hover))] shadow-lg shadow-[rgba(var(--accent-blue-rgb),0.25)] transition-all duration-200 hover:brightness-110 active:scale-[0.98]"
                >
                  打开文件夹
                </button>
              )}
            </div>
          </>
        ) : (
          /* 其它空态（搜索 / 筛选 / 隐藏）：保持轻量，仅图标 + 文案 + 单入口 */
          <>
            <div className="w-32 h-32 mb-8 rounded-3xl bg-[rgba(var(--accent-blue-rgb),0.08)] border border-[rgba(var(--accent-blue-rgb),0.15)] flex items-center justify-center shadow-xl shadow-[rgba(var(--accent-blue-rgb),0.08)] animate-fadeInUp">
              <svg className="w-14 h-14 text-[var(--accent-blue)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
              </svg>
            </div>
            <p className="text-xl font-semibold text-[var(--text-secondary)] mb-3 animate-fadeInUp" style={{ animationDelay: '60ms' }}>{emptyTitle}</p>
            <p className="text-sm text-[var(--text-tertiary)] text-center max-w-sm leading-relaxed animate-fadeInUp" style={{ animationDelay: '120ms' }}>{emptyDescription}</p>
            {(onShowAll || onClearSearch) && (
              <div className="mt-8 flex items-center gap-3 animate-fadeInUp" style={{ animationDelay: '180ms' }}>
                {onShowAll && (
                  <button
                    onClick={onShowAll}
                    className="px-5 py-2.5 rounded-xl text-sm font-medium bg-[var(--bg-glass)] hover:bg-[var(--bg-glass-hover)] border border-[var(--border-default)] text-[var(--text-primary)] transition-all duration-200 active:scale-[0.98]"
                  >
                    {showAllLabel}
                  </button>
                )}
                {onClearSearch && (
                  <button
                    onClick={onClearSearch}
                    className="px-5 py-2.5 rounded-xl text-sm font-medium bg-[var(--bg-glass)] hover:bg-[var(--bg-glass-hover)] border border-[var(--border-default)] text-[var(--text-primary)] transition-all duration-200 active:scale-[0.98]"
                  >
                    清除搜索
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  /* ============ 列表视图 ============ */
  if (viewMode === 'list') {
    return (
      <div className="flex-1 flex flex-col w-full min-h-0">
        {selectionBar}
        <div
          ref={listScrollRef}
          className={`flex-1 overflow-y-auto custom-scrollbar bg-transparent min-h-0 ${reflowClass}`}
          onScroll={handleListScroll}
          onClick={(e) => { if (e.target === e.currentTarget) onClearSelection(); }}
          onContextMenu={(e) => onContextMenu && onContextMenu(e)}
        >
        <table className="w-full text-left text-sm text-[var(--text-secondary)] border-collapse">
          <thead className="bg-[var(--bg-table-header)] backdrop-blur-xl text-[var(--text-secondary)] font-semibold border-b border-[var(--border-subtle)] sticky top-0 z-10">
            <tr>
              <th className="px-4 py-3 w-10 rounded-tl-lg">
                <input
                  type="checkbox"
                  ref={selectAllRef}
                  checked={allVisibleSelected}
                  onChange={onSelectAll}
                  className="rounded-lg border-2 border-[rgba(255,255,255,0.2)] bg-[rgba(0,0,0,0.2)] text-[var(--accent-blue)] focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.4)] cursor-pointer accent-[var(--accent-blue)]"
                  aria-label="全选"
                />
              </th>
              <th className="px-4 py-3 w-10"></th>

              <th
                className="px-4 py-3 cursor-pointer group hover:bg-[var(--bg-glass)] transition-colors select-none"
                onClick={() => onSort('name')}
              >
                <div className="flex items-center">
                  名称 <SortIndicator columnKey="name" />
                </div>
              </th>

              <th
                className="px-4 py-3 cursor-pointer group hover:bg-[var(--bg-glass)] transition-colors select-none"
                onClick={() => onSort('dateTaken')}
              >
                <div className="flex items-center">
                  内容创建时间 <SortIndicator columnKey="dateTaken" />
                </div>
              </th>

              <th
                className="px-4 py-3 cursor-pointer group hover:bg-[var(--bg-glass)] transition-colors select-none"
                onClick={() => onSort('dateModified')}
              >
                <div className="flex items-center">
                  修改时间 <SortIndicator columnKey="dateModified" />
                </div>
              </th>

              <th
                className="px-4 py-3 cursor-pointer group hover:bg-[var(--bg-glass)] transition-colors select-none"
                onClick={() => onSort('dateCreated')}
              >
                <div className="flex items-center">
                  创建时间 <SortIndicator columnKey="dateCreated" />
                </div>
              </th>

              <th
                className="px-4 py-3 cursor-pointer group hover:bg-[var(--bg-glass)] transition-colors select-none rounded-tr-lg"
                onClick={() => onSort('size')}
              >
                <div className="flex items-center">
                  大小 <SortIndicator columnKey="size" />
                </div>
              </th>
            </tr>
          </thead>

          <tbody className="divide-y divide-[var(--border-subtle)]">
            {/* 窗口化：用上下占位行撑起高度，只渲染可见区间 */}
            {listStartIndex > 0 && (
              <tr aria-hidden style={{ height: listStartIndex * LIST_ROW_HEIGHT }} />
            )}
            {photos.slice(listStartIndex, listEndIndex).map(renderRow)}
            {listEndIndex < photos.length && (
              <tr aria-hidden style={{ height: (photos.length - listEndIndex) * LIST_ROW_HEIGHT }} />
            )}
          </tbody>
        </table>
        </div>
      </div>
    );
  }

  /* ============ 网格视图 ============ */
  const sortByDate =
    sortConfig.key === 'dateTaken' || sortConfig.key === 'dateModified' || sortConfig.key === 'dateCreated';
  const directionLabel = sortConfig.direction === 'asc' ? '↑' : '↓';

  return (
    <div className="flex-1 flex flex-col w-full min-h-0">
      {/* 情境条：无选中 = 浏览条（统计 + 排序）；有选中 = 选择条（批量操作 + 清除） */}
      {inSelectMode ? selectionBar : (
        <div className="mb-3 mx-4 shrink-0 rounded-xl border backdrop-blur-xl px-3.5 py-2 flex items-center gap-2.5 min-h-[46px] bg-[var(--bg-elevated)] border-[var(--border-subtle)]">
            <div className="flex items-center gap-2 min-w-0">
              {viewTitle && (
                <span className="text-sm font-semibold text-[var(--text-primary)] whitespace-nowrap">{viewTitle}</span>
              )}
              <span className="text-sm text-[var(--text-tertiary)] whitespace-nowrap">{photos.length} 项</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--bg-glass)] border border-[var(--border-subtle)] text-[var(--text-tertiary)] whitespace-nowrap hidden sm:inline-flex">
                按{sortByDate ? '时间' : sortConfig.key === 'name' ? '名称' : '大小'}{sortConfig.direction === 'asc' ? '升序' : '降序'}
              </span>
            </div>

            <div className="flex-1" />

            <div className="flex items-center gap-1 p-0.5 rounded-lg bg-[var(--bg-input)] border border-[var(--border-subtle)]">
              {SORT_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => onSort(opt.key)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all duration-200 ${
                    sortConfig.key === opt.key
                      ? 'bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-hover))] text-[var(--accent-contrast)] shadow-sm'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
              <button
                onClick={() => onSort(sortConfig.key)}
                className="px-2 py-1 rounded-md text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] transition-all duration-200"
                title="切换排序方向"
              >
                {directionLabel}
              </button>
            </div>

            <div className="hidden xl:flex items-center gap-1.5 text-[var(--text-tertiary)]">
              <span className="flex items-center gap-1"><span className="kbd">空格</span>预览</span>
              <span className="w-px h-3 bg-[var(--border-subtle)] mx-1"></span>
              <span className="flex items-center gap-1"><span className="kbd">⇧</span>连选</span>
              <span className="w-px h-3 bg-[var(--border-subtle)] mx-1"></span>
              <span className="flex items-center gap-1"><span className="kbd">⌘A</span>全选</span>
              <span className="w-px h-3 bg-[var(--border-subtle)] mx-1"></span>
              <span className="flex items-center gap-1"><span className="kbd">⌫</span>删除</span>
            </div>
        </div>
      )}

      <div className={`flex-1 flex flex-col min-h-0 ${reflowClass}`}>
        <VirtualGrid
          ref={virtualGridRef}
          items={photos}
          targetRowHeight={targetRowHeight}
          gap={GRID_GAP}
          onBlankClick={handleBlankClick}
          onContainerContextMenu={(e) => onContextMenu?.(e)}
          onColumnsChange={onColumnsChange}
          stickyLabel={sortByDate ? (photo) => formatDayCapsule(photo.dateTaken || photo.lastModified) : undefined}
        >
          {renderCard}
        </VirtualGrid>
      </div>
    </div>
  );
});

ImageGrid.displayName = 'ImageGrid';

export default ImageGrid;
