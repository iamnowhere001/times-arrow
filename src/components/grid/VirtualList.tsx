import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Photo } from '@/types';
import { formatBytes, formatDate, isVideoPhoto } from '@/utils';
import { useVirtualViewport } from '@/hooks/useVirtualViewport';
import { ThumbImage } from '@/components/grid/ThumbnailImage';

/**
 * 列表虚拟化。
 *
 * 网格用「绝对定位 + 实测布局」，列表保留原生 table 语义 + 上下占位行。
 * 三个必须做对的细节：
 *
 * 1. **行高精确**：占位行高度 = 实测行高 × 行数。任何 1px 误差在几千行下都会
 *    让滚动条比例失真；窗口换入换出时内容总高持续变化，惯性滚动就会出现
 *    「停不下来、直接冲到底」。分隔线统一放在行底（border-b），保证首行 /
 *    后续行高度一致，不依赖 tr 在前在后。
 * 2. **overflow-anchor 关闭**：窗口化本来就在手动管理可见行，浏览器的滚动锚定
 *    会反向修正 scrollTop，与窗口切换互相打架，造成跳动与猛冲。
 * 3. **滚动状态封闭在本组件内**：惯性滚动每帧只重渲染窗口内的少量行，不波及
 *    外层选择条 / 表头 / 空状态。
 */

/** 列表列数（选择框 / 收藏 / 名称 / 内容创建 / 修改 / 创建 / 大小），占位单元格需要 colSpan */
const LIST_COLUMN_COUNT = 7;
/** 行高初始估算：py-3(24px) + 40px 缩略图 + 1px 底线 = 65px；挂载后实测校正 */
const LIST_ROW_ESTIMATED_HEIGHT = 65;
/** 上下缓冲行数：列表行很轻，给足缓冲避免惯性滚动白屏，同时不挂载过多缩略图 */
const LIST_OVERSCAN_TOP = 8;
const LIST_OVERSCAN_BOTTOM = 16;

/** 记住上次离开时的列表滚动位置（与网格各记一份，互不干扰） */
let savedListScrollTop = 0;

/** 图库被清空时丢弃记忆位置，否则下次挂载会滚到旧偏移处 */
export function resetListScrollMemory(): void {
  savedListScrollTop = 0;
}

/** VirtualList 对外暴露的命令式句柄 */
export interface VirtualListHandle {
  scrollToIndex: (index: number) => void;
}

/** 注意：回调必须是稳定引用，否则 React.memo 失效 */
interface ListRowProps {
  photo: Photo;
  rowHeight: number;
  isSelected: boolean;
  isExiting: boolean;
  /** 只挂在窗口首行：实测真实行高，校正估算常量 */
  innerRef?: (el: HTMLTableRowElement | null) => void;
  onSelect: (id: string, multiSelect: boolean) => void;
  onRange: (id: string) => void;
  onOpen: (photo: Photo) => void;
  onMenu: (e: React.MouseEvent, photo: Photo) => void;
  onToggleFavorite: (id: string) => void;
}

const ListRow = React.memo(
  ({
    photo,
    rowHeight,
    isSelected,
    isExiting,
    innerRef,
    onSelect,
    onRange,
    onOpen,
    onMenu,
    onToggleFavorite,
  }: ListRowProps) => {
    const handleClick = useCallback(
      (e: React.MouseEvent) => {
        if (e.shiftKey) {
          onRange(photo.id);
          return;
        }
        onSelect(photo.id, e.metaKey || e.ctrlKey);
      },
      [photo.id, onSelect, onRange]
    );

    return (
      <tr
        ref={innerRef}
        onClick={handleClick}
        onDoubleClick={() => onOpen(photo)}
        onContextMenu={(e) => onMenu(e, photo)}
        style={{ height: rowHeight }}
        className={`cursor-pointer border-b border-[var(--border-subtle)] transition-[opacity,background-color,color] duration-200 ease-entrance ${
          isExiting
            ? 'opacity-0 pointer-events-none'
            : isSelected
              ? 'bg-[rgba(var(--accent-blue-rgb),0.15)] text-[var(--text-primary)]'
              : 'hover:bg-[var(--bg-glass)] text-[var(--text-secondary)]'
        }`}
      >
        <td className="px-4 py-3">
          {/* 用 40×40 的 label 包住原生复选框：视觉尺寸不变（保留原生外观），
            但整个格子都是可点热区；阻止冒泡避免连同行点击一起触发双重切换 */}
          <label
            className="flex items-center justify-center w-10 h-10 cursor-pointer rounded-lg hover:bg-[var(--bg-glass)] transition-colors"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => onSelect(photo.id, true)}
              className="w-4 h-4 rounded-lg border-2 border-[rgba(255,255,255,0.2)] bg-[rgba(0,0,0,0.2)] text-[var(--accent-blue)] focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.4)] cursor-pointer accent-[var(--accent-blue)]"
              aria-label="选择"
            />
          </label>
        </td>
        <td className="px-4 py-3">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(photo.id);
            }}
            className={`p-1.5 rounded-full transition-all duration-200 ${
              photo.isFavorite
                ? 'text-[var(--accent-pink)] bg-[rgba(var(--accent-pink-rgb),0.15)]'
                : 'text-[var(--text-quaternary)] hover:text-[var(--accent-pink)] hover:bg-[rgba(var(--accent-pink-rgb),0.15)]'
            }`}
            title="收藏"
            aria-label="收藏"
          >
            <svg
              className="w-4 h-4"
              fill={photo.isFavorite ? 'currentColor' : 'none'}
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
              ></path>
            </svg>
          </button>
        </td>

        <td className="px-4 py-3">
          <div className="flex items-center gap-3">
            <ThumbImage
              photo={photo}
              size={40}
              className="w-10 h-10 object-cover border border-[var(--border-subtle)] shrink-0 bg-[var(--bg-card)]"
            />
            {isVideoPhoto(photo) && (
              <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs font-medium text-[var(--accent-cyan)] bg-[rgba(var(--accent-blue-rgb),0.12)] border border-[rgba(var(--accent-blue-rgb),0.25)]">
                <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
                视频
              </span>
            )}
            <span className="font-medium truncate max-w-[200px]" title={photo.name}>
              {photo.name}
            </span>
          </div>
        </td>
        <td className="px-4 py-3 text-[var(--text-tertiary)]">
          {formatDate(photo.dateTaken || 0)}
        </td>
        <td className="px-4 py-3 text-[var(--text-tertiary)]">{formatDate(photo.lastModified)}</td>
        <td className="px-4 py-3 text-[var(--text-tertiary)] tabular-nums">
          {photo.dateCreated ? formatDate(photo.dateCreated) : '—'}
        </td>
        <td className="px-4 py-3 text-[var(--text-tertiary)] font-mono text-xs">
          {formatBytes(photo.size)}
        </td>
      </tr>
    );
  }
);

ListRow.displayName = 'ListRow';

interface VirtualListProps {
  items: Photo[];
  selectedIds: Set<string>;
  exitingIds: Set<string>;
  /** 表头节点：父组件渲染一次后传入；滚动重渲染时引用不变，整块表头直接跳过 reconcile */
  header: React.ReactNode;
  onSelect: (id: string, multiSelect: boolean) => void;
  onRange: (id: string) => void;
  onOpen: (photo: Photo) => void;
  onMenu: (e: React.MouseEvent, photo: Photo) => void;
  onToggleFavorite: (id: string) => void;
  onBlankClick?: () => void;
  onContainerContextMenu?: (e: React.MouseEvent) => void;
}

const VirtualList = forwardRef<VirtualListHandle, VirtualListProps>(
  (
    {
      items,
      selectedIds,
      exitingIds,
      header,
      onSelect,
      onRange,
      onOpen,
      onMenu,
      onToggleFavorite,
      onBlankClick,
      onContainerContextMenu,
    },
    ref
  ) => {
    const scrollRef = useRef<HTMLDivElement>(null);
    const { viewport, scrollTop, handleScroll } = useVirtualViewport(scrollRef, {
      onScroll: (top) => {
        savedListScrollTop = top;
      },
    });
    const viewportHeight = viewport.height;
    const [rowHeight, setRowHeight] = useState(LIST_ROW_ESTIMATED_HEIGHT);
    const rowHeightRef = useRef(rowHeight);
    rowHeightRef.current = rowHeight;

    // 恢复上次离开图库时的列表滚动位置（占位行已给出内容高度，可直接落）
    const scrollRestoredRef = useRef(false);
    useEffect(() => {
      if (scrollRestoredRef.current || items.length === 0) return;
      scrollRestoredRef.current = true;
      const el = scrollRef.current;
      if (el && savedListScrollTop > 0) el.scrollTop = savedListScrollTop;
    }, [items.length]);

    /**
     * 窗口起点必须夹取到有效范围（K24）。
     * 深度滚动后筛选 / 搜索把列表缩短时，scrollTop 还停在旧的大值上，
     * 若不夹取：`items.slice(大起点, 小终点)` 为空 → 整屏空白，
     * 而占位行仍按旧起点撑高，浏览器也就不会把 scrollTop 夹回去。
     * 夹到最后一行的起点，至少渲染末尾一行，内容高度随之收缩，滚动条会自然回落。
     */
    const startIndex = Math.min(
      Math.max(0, items.length - 1),
      Math.max(0, Math.floor(scrollTop / rowHeight) - LIST_OVERSCAN_TOP)
    );
    const endIndex = Math.min(
      items.length,
      startIndex +
        Math.ceil((viewportHeight || 600) / rowHeight) +
        LIST_OVERSCAN_TOP +
        LIST_OVERSCAN_BOTTOM
    );

    // 实测行高：首个真实行挂载时量一次 offsetHeight，修正常量估算误差。
    // 行高统一（分隔线在行底），测量结果不会随窗口位置反复跳变，故只测一次，
    // 避免滚动跨页时 ref 切换反复读取布局（强制同步 layout）。
    const measuredRef = useRef(false);
    const measureRow = useCallback((el: HTMLTableRowElement | null) => {
      if (!el || measuredRef.current) return;
      const h = el.offsetHeight;
      if (h <= 0) return;
      measuredRef.current = true;
      if (h !== rowHeightRef.current) {
        rowHeightRef.current = h;
        setRowHeight(h);
      }
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        scrollToIndex: (index: number) => {
          const el = scrollRef.current;
          if (!el || index < 0) return;
          const h = rowHeightRef.current;
          const top = Math.max(0, index * h - 8);
          if (top < el.scrollTop || top + h > el.scrollTop + el.clientHeight) {
            el.scrollTo({ top, behavior: 'auto' });
          }
        },
      }),
      []
    );

    const topSpacer = startIndex * rowHeight;
    const bottomSpacer = (items.length - endIndex) * rowHeight;

    /** 占位行：必须带 <td>（空 tr 的高度在 table 布局下不可靠），并清零 padding / 边框 */
    const spacerRow = (height: number, key: string) => (
      <tr key={key} aria-hidden style={{ height, border: 0 }}>
        <td colSpan={LIST_COLUMN_COUNT} style={{ padding: 0, border: 0 }} />
      </tr>
    );

    return (
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        onClick={(e) => {
          if (e.target === e.currentTarget) onBlankClick?.();
        }}
        onContextMenu={(e) => onContainerContextMenu?.(e)}
        className="flex-1 overflow-y-auto custom-scrollbar bg-transparent min-h-0"
        style={{ overflowAnchor: 'none' }}
      >
        <table className="w-full text-left text-sm text-[var(--text-secondary)] border-collapse">
          {header}
          <tbody>
            {topSpacer > 0 && spacerRow(topSpacer, 'top-spacer')}
            {items.slice(startIndex, endIndex).map((photo, i) => (
              <ListRow
                key={photo.id}
                photo={photo}
                rowHeight={rowHeight}
                isSelected={selectedIds.has(photo.id)}
                isExiting={exitingIds.has(photo.id)}
                innerRef={i === 0 ? measureRow : undefined}
                onSelect={onSelect}
                onRange={onRange}
                onOpen={onOpen}
                onMenu={onMenu}
                onToggleFavorite={onToggleFavorite}
              />
            ))}
            {bottomSpacer > 0 && spacerRow(bottomSpacer, 'bottom-spacer')}
          </tbody>
        </table>
      </div>
    );
  }
);

VirtualList.displayName = 'VirtualList';

export default VirtualList;
