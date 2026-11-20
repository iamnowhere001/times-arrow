import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import { Photo } from '@/types';
import { useVirtualViewport } from '@/hooks/useVirtualViewport';
// 网格几何的唯一入口：常量、行布局、行定位都从这里取（几何错误有纯函数单测守着）
import { buildGridLayout, findRowAt, CARD_CHROME_HEIGHT } from '@/lib/grid/justifiedLayout';

/**
 * 把时间戳格式化为「今天 / 昨天 / 具体日期」，用于滚动日期胶囊。
 * 与 App 的日期分组语义保持一致，只是轻量展示用途。
 *
 * 导出是因为调用方在构造 `stickyDay` 回调时也要用同一套文案，
 * 两处各写一份会让「今天 / 昨天」的判定漂移。
 */
export function formatDayCapsule(timestamp?: number): string | null {
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
  /** 上下键导航：返回相邻行中水平位置最接近的项 id；已在首 / 末行时返回 null */
  getVerticalNeighbor: (id: string, direction: 'up' | 'down') => string | null;
}

/**
 * 记住上次离开时的滚动位置：图库 ↔ 时光画廊 / 重复检测来回切换不丢进度。
 * 沿用时光画廊已验证的模块级变量模式（两个视图形态各记一份，互不干扰）。
 *
 * 状态留在本模块而不是提给调用方：它只服务于这个组件自己的挂载 / 卸载，
 * 提上去反而要求调用方每次挂载都记得传值。
 */
let savedGridScrollTop = 0;

/** 图库被清空时丢弃记忆位置，否则下次挂载会把新内容直接滚到旧偏移处 */
export function resetGridScrollMemory(): void {
  savedGridScrollTop = 0;
}

/**
 * 虚拟化网格：只渲染视口内（含 overscan）的卡片。
 * 行高按照片真实比例计算，长图（手机截屏等）会占据更高的行。
 * 额外支持：
 *  - onBlankClick：点击卡片间隙的空白 → 取消选择（Photos 式行为）
 *  - stickyDay：滚动时在顶部贴住当前首行照片对应的日期标签（可点击 → 只看这一天）
 *  - onColumnsChange：每行张数上报（仅供外部参考）
 */
const VirtualGrid = forwardRef<
  VirtualGridHandle,
  {
    items: Photo[];
    /** 目标行高（图片区高度），由缩放滑块控制 */
    targetRowHeight: number;
    gap: number;
    overscan?: number;
    onBlankClick?: () => void;
    onContainerContextMenu?: (e: React.MouseEvent) => void;
    onColumnsChange?: (columns: number) => void;
    /**
     * 顶部日期胶囊的文案与时间戳；返回 null 表示这张照片没有可用日期。
     * 时间戳要一并给出：胶囊可点击时会用它把筛选收敛到「这一天」，
     * 只回传文案的话调用方还得反解析字符串。
     */
    stickyDay?: (photo: Photo) => { label: string; timestamp: number } | null;
    /** 点击日期胶囊 → 只看这一天 */
    onFilterByDate?: (timestamp: number) => void;
    children: (photo: Photo, style: React.CSSProperties, itemWidth: number) => React.ReactNode;
  }
>(
  (
    {
      items,
      targetRowHeight,
      gap,
      overscan = 2,
      onBlankClick,
      onContainerContextMenu,
      onColumnsChange,
      stickyDay,
      onFilterByDate,
      children,
    },
    ref
  ) => {
    const scrollRef = useRef<HTMLDivElement>(null);
    // 卡片之间的空白落在「布局容器」上，不是滚动容器本身；两者都算空白点击
    const contentRef = useRef<HTMLDivElement>(null);
    const { viewport, scrollTop, handleScroll } = useVirtualViewport(scrollRef, {
      contentWidth: true,
      // 顺手记录最后位置：卸载时可能已读不到 DOM，这里持续写最稳
      onScroll: (top) => {
        savedGridScrollTop = top;
      },
    });

    const layout = useMemo(
      () => buildGridLayout(items, viewport.width, targetRowHeight, gap),
      [items, viewport.width, targetRowHeight, gap]
    );
    const { rows, rowOfItem, totalHeight } = layout;

    // 恢复上次离开图库时的滚动位置。
    // 必须等布局算出内容高度（totalHeight > 0）再落一次：首帧容器宽度还没量到，
    // 内容高度为 0，此时写 scrollTop 会被浏览器夹回 0。
    const scrollRestoredRef = useRef(false);
    useEffect(() => {
      if (scrollRestoredRef.current || totalHeight <= 0) return;
      scrollRestoredRef.current = true;
      const el = scrollRef.current;
      if (el && savedGridScrollTop > 0) el.scrollTop = savedGridScrollTop;
    }, [totalHeight]);

    /* -------------------------------------------------------------------------
     * K18 · 元数据回填时保持滚动锚点
     * 入库时还不知道 dimensions，首屏按 4:3 兜底铺排；随后每批回填真实尺寸，
     * 行高与行数都会变。若放任不管，正在看的照片会被上方高度的变化顶走。
     * 做法：持续记录「视口顶部那一行」及其相对偏移，等同一批照片（id 顺序不变）
     * 因尺寸变化重排后，把这一行重新对回原来的位置。
     * 只在「同一批照片的几何变化」时出手，排序 / 筛选导致的换序不去干预。
     * ----------------------------------------------------------------------- */
    const prevItemsRef = useRef<Photo[] | null>(null);
    const geometryChanged = useMemo(() => {
      const prev = prevItemsRef.current;
      const same =
        !!prev && prev.length === items.length && prev.every((p, i) => p.id === items[i].id);
      prevItemsRef.current = items;
      return same;
    }, [items]);
    const pendingAnchorFixRef = useRef(false);
    if (geometryChanged) pendingAnchorFixRef.current = true;

    const anchorRef = useRef<{ id: string; offset: number } | null>(null);

    // 回正要在「记录新锚点」之前跑（effect 按声明顺序执行），
    // 否则会先被新布局覆盖掉旧锚点，失去参照。
    useLayoutEffect(() => {
      if (!pendingAnchorFixRef.current) return;
      pendingAnchorFixRef.current = false;
      const el = scrollRef.current;
      const anchor = anchorRef.current;
      if (!el || !anchor) return;
      const index = items.findIndex((p) => p.id === anchor.id);
      if (index < 0) return;
      const row = rows[rowOfItem[index]];
      if (!row) return;
      const desired = Math.max(0, row.top - anchor.offset);
      if (Math.abs(el.scrollTop - desired) > 1) el.scrollTop = desired;
    }, [rows, rowOfItem, items]);

    // 读 DOM 真实 scrollTop：程序化滚动不会立刻反映到 state 上
    useLayoutEffect(() => {
      const el = scrollRef.current;
      if (!el || rows.length === 0) return;
      const top = el.scrollTop;
      const row = rows[findRowAt(rows, top)];
      const first = row?.cells[0];
      if (first) anchorRef.current = { id: first.photo.id, offset: row.top - top };
    }, [scrollTop, rows]);

    const startRow = rows.length > 0 ? Math.max(0, findRowAt(rows, scrollTop) - overscan) : 0;
    const endRow =
      rows.length > 0
        ? Math.min(
            rows.length,
            findRowAt(rows, scrollTop + (viewport.height || 600)) + overscan + 1
          )
        : 0;

    // 每行张数上报（仅参考用；方向键导航已按真实行几何计算）
    const itemsPerRow = rows[0]?.cells.length ?? 1;
    useEffect(() => {
      onColumnsChange?.(itemsPerRow);
    }, [itemsPerRow, onColumnsChange]);

    // 命令式滚动：键盘导航时让选中项滚入视口
    useImperativeHandle(
      ref,
      () => ({
        scrollToItem: (id: string) => {
          const el = scrollRef.current;
          if (!el) return;
          const index = items.findIndex((p) => p.id === id);
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
        /**
         * 上下键的落点：justified 布局每行张数随照片宽高比变化，固定列数步进会跳错列。
         * 因此按真实行几何找「下一行里水平中心最接近当前项」的那张。
         */
        getVerticalNeighbor: (id: string, direction: 'up' | 'down') => {
          const index = items.findIndex((p) => p.id === id);
          if (index < 0) return null;
          const rowIndex = rowOfItem[index];
          const currentRow = rows[rowIndex];
          const targetRow = rows[direction === 'up' ? rowIndex - 1 : rowIndex + 1];
          if (!currentRow || !targetRow || targetRow.cells.length === 0) return null;

          const currentCell = currentRow.cells.find((c) => c.photo.id === id);
          const centerX = currentCell ? currentCell.left + currentCell.width / 2 : 0;
          let bestId: string | null = null;
          let bestDistance = Number.POSITIVE_INFINITY;
          for (const cell of targetRow.cells) {
            const distance = Math.abs(cell.left + cell.width / 2 - centerX);
            if (distance < bestDistance) {
              bestDistance = distance;
              bestId = cell.photo.id;
            }
          }
          return bestId;
        },
      }),
      [items, rows, rowOfItem]
    );

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
    let topCapsule: { label: string; timestamp: number } | null = null;
    if (stickyDay && rows.length > 0) {
      const row = rows[findRowAt(rows, scrollTop)];
      if (row && scrollTop >= (row.height + CARD_CHROME_HEIGHT) * 0.6 && row.cells.length > 0) {
        topCapsule = stickyDay(row.cells[0].photo);
      }
    }

    // 显式关掉横向滚动：行宽已按内容区算准，但卡片 hover 的 scale(1.005) 与
    // 亚像素取整仍可能让最右一张多出 1~2px，裁掉即可，不该给用户一条横向滚动条。
    return (
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        onClick={(e) => {
          // 空白有两种：滚动容器的 padding 区，和卡片之间的间隙（内层布局容器）。
          // 只认 currentTarget 会让后者失效 —— 而间隙才是最常点到的空白。
          if (e.target === e.currentTarget || e.target === contentRef.current) {
            onBlankClick?.();
          }
        }}
        onContextMenu={(e) => {
          // 空白区域右键（卡片自身会 stopPropagation）
          onContainerContextMenu?.(e);
        }}
        className="flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar min-h-0 p-4"
        style={{ overflowAnchor: 'none' }}
      >
        {topCapsule !== null && (
          <div
            className="pointer-events-none flex justify-start"
            style={{ position: 'sticky', top: 4, zIndex: 30 }}
          >
            {/* 不加 key：文案变化时原地更新即可，加 key 会让胶囊每换一天就重播一次入场动画 */}
            <button
              type="button"
              onClick={() => onFilterByDate?.(topCapsule.timestamp)}
              disabled={!onFilterByDate}
              title={onFilterByDate ? '只看这一天' : undefined}
              className={`date-capsule animate-scaleIn inline-flex items-center gap-2 rounded-full bg-[var(--bg-elevated)] px-4 py-1.5 text-xs font-semibold text-[var(--text-primary)] border border-[var(--border-default)] shadow-lg shadow-[rgba(0,0,0,0.3)] ${
                onFilterByDate
                  ? 'pointer-events-auto cursor-pointer hover:border-[var(--accent-cyan)] hover:text-[var(--accent-cyan)] transition-colors'
                  : ''
              }`}
            >
              <svg
                className="w-3.5 h-3.5 text-[var(--accent-cyan)]"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <rect x="3" y="4" width="18" height="18" rx="2"></rect>
                <line x1="16" y1="2" x2="16" y2="6"></line>
                <line x1="8" y1="2" x2="8" y2="6"></line>
                <line x1="3" y1="10" x2="21" y2="10"></line>
              </svg>
              {topCapsule.label}
            </button>
          </div>
        )}
        <div ref={contentRef} style={{ position: 'relative', height: totalHeight }}>
          {visible}
        </div>
      </div>
    );
  }
);

VirtualGrid.displayName = 'VirtualGrid';

export default VirtualGrid;
