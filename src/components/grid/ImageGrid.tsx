import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Photo, ViewMode, SortConfig, SortKey, SortDirection } from '@/types';
import type { ImageGridHandle } from '@/types/grid';
// 时间语义统一入口：不要在这里内联 `dateTaken || lastModified`
import { photoTakenTime } from '@/lib/media/photoTime';
import { GRID_GAP } from '@/lib/grid/justifiedLayout';
// 空状态：首屏单独设计，其余五种共用模板但区分语气（K27）
import { EmptyKind, QuietEmptyState, WelcomeEmptyState } from '@/components/grid/EmptyStates';
// 虚拟化与卡片各自独立成文件，本文件只做工具栏与两者的组合。
// 网格与列表各记一份滚动位置，清空图库时通过 reset* 统一丢弃。
import VirtualGrid, {
  formatDayCapsule,
  resetGridScrollMemory,
  type VirtualGridHandle,
} from '@/components/grid/VirtualGrid';
import VirtualList, {
  resetListScrollMemory,
  type VirtualListHandle,
} from '@/components/grid/VirtualList';
import ImageCard from '@/components/grid/ImageCard';

/* 网格虚拟化见 ./VirtualGrid.tsx（布局、滚动位置记忆、键盘落点几何都在那里）。 */

/* 列表虚拟化见 ./VirtualList.tsx（table 语义 + 占位行 + 实测行高都在那里）。 */

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
  /** 调整网格缩略图大小（0.5x ~ 2x），仅网格视图有效 */
  onScaleChange: (scale: number) => void;
  sortConfig: SortConfig;
  onSort: (key: SortKey) => void;
  onToggleFavorite: (id: string) => void;
  onQuickLook: (photo: Photo) => void;
  onContextMenu?: (e: React.MouseEvent, photo?: Photo) => void;
  onShowDeleteConfirm: () => void;
  onBatchRename?: () => void;
  /** 移动选中项到指定文件夹（面板中可新建文件夹） */
  onMoveSelected?: () => void;
  /** 导出选中项（批量转换格式） */
  onExportSelected?: () => void;
  /** 每行张数变化上报（仅供外部参考；方向键导航已改为按真实行几何计算，不再依赖它） */
  onColumnsChange?: (columns: number) => void;
  /** 点击顶部日期胶囊 → 只看这一天（由 App 落到日期筛选条件上） */
  onFilterByDate?: (timestamp: number) => void;
  /** 情境条左侧展示的分类名（所有照片 / 收藏夹） */
  viewTitle?: string;
  /** 空状态引导 */
  emptyTitle?: string;
  emptyDescription?: string;
  /**
   * 空状态种类：决定图形与语气（见 EmptyStates）。
   * `library`（图库完全为空）走单独设计的首屏，其余五种共用克制的模板但区分语气。
   */
  emptyKind?: EmptyKind;
  /** 空库欢迎页的统一导入入口（图片 / 视频 / 文件夹均可批量选择） */
  onImport?: () => void;
  /** 收藏夹为空时，引导跳回所有照片 */
  onShowAll?: () => void;
  /** 搜索无结果时，清除搜索 */
  onClearSearch?: () => void;
  /** onShowAll 按钮文案（默认「前往「所有照片」」，筛选无结果时改为「清除筛选」） */
  showAllLabel?: string;
  /**
   * 非首屏空态的旁注读数（如「库中 1,204 张」）。
   * 给「是没找到还是本来就没有」一个参照，避免用户怀疑应用坏了。
   */
  emptyHint?: React.ReactNode;
  /** 已删除、正在播塌陷动画的条目：卡片仍渲染，但淡出且不可交互 */
  exitingIds?: Set<string>;
}

/* 卡片见 ./ImageCard.tsx（浮层几何、缩略图按需解析、加载失败重试都在那里）。 */

/** 无条目在塌陷时的空集合：保持引用稳定，避免每次渲染都让 memo 失效 */
const NO_EXITING_IDS: Set<string> = new Set();

/** 首屏入场的交错参数：只给第一批卡片排延迟，避免大库里几百张集体淡入 */
const INTRO_COUNT = 12;
const INTRO_STAGGER_MS = 8;
/** 入场播完后立刻撤销标记：否则虚拟化重挂载卡片时会反复重播 */
const INTRO_CLEAR_MS = 1200;
const NO_INTRO_DELAYS: Map<string, number> = new Map();
// 与列表视图表头的排序键保持一致：此前网格缺了「修改时间 / 创建时间」，
// 想按它们排序必须切到列表视图，同一个功能两套入口
const SORT_OPTIONS: Array<{ key: SortKey; label: string }> = [
  { key: 'dateTaken', label: '拍摄时间' },
  { key: 'dateModified', label: '修改时间' },
  { key: 'dateCreated', label: '创建时间' },
  { key: 'name', label: '名称' },
  { key: 'size', label: '大小' },
];

/**
 * 表头排序箭头。定义在组件外：若定义在渲染函数内，每次渲染都是一个新的
 * 组件类型，React 会卸载并重挂载这些节点（连带失焦 / 动画重播）。
 */
const SortIndicator: React.FC<{ active: boolean; direction: SortDirection }> = ({
  active,
  direction,
}) => (
  <span
    className={`ml-1 inline-flex items-center justify-center w-4 h-4 transition-all duration-200 ${
      active
        ? 'opacity-100 text-[var(--accent-cyan)]'
        : 'opacity-0 text-[var(--text-quaternary)] group-hover:opacity-50'
    }`}
  >
    {active ? (direction === 'desc' ? '↓' : '↑') : null}
  </span>
);

/** 网格缩放：对角双向箭头 */
const ResizeIcon = ({ className = 'w-4 h-4' }: { className?: string }) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="4 9 4 4 9 4"></polyline>
    <polyline points="20 15 20 20 15 20"></polyline>
    <line x1="4" y1="4" x2="10" y2="10"></line>
    <line x1="20" y1="20" x2="14" y2="14"></line>
  </svg>
);

const ImageGrid = forwardRef<ImageGridHandle, ImageGridProps>(
  (
    {
      photos,
      selectedIds,
      onToggleSelect,
      onRangeSelect,
      onSelectAll,
      onClearSelection,
      onFavoriteSelected,
      viewMode,
      scale,
      onScaleChange,
      sortConfig,
      onSort,
      onToggleFavorite,
      onQuickLook,
      onContextMenu,
      onShowDeleteConfirm,
      onBatchRename,
      onMoveSelected,
      onExportSelected,
      onColumnsChange,
      onFilterByDate,
      viewTitle,
      emptyTitle = '没有照片',
      emptyDescription = '拖放图片、视频或文件夹到此处，或点击上方「导入」按钮批量添加',
      emptyKind = 'library',
      onImport,
      onShowAll,
      onClearSearch,
      showAllLabel = '前往「所有照片」',
      emptyHint,
      exitingIds = NO_EXITING_IDS,
    },
    ref
  ) => {
    const selectAllRef = useRef<HTMLInputElement>(null);
    const virtualListRef = useRef<VirtualListHandle>(null);
    const virtualGridRef = useRef<VirtualGridHandle>(null);

    // 列表 / 网格统一的滚动定位：方向键导航时让选中项进入视口
    useImperativeHandle(
      ref,
      () => ({
        scrollToPhoto: (id: string) => {
          if (viewMode === 'list') {
            const index = photos.findIndex((p) => p.id === id);
            if (index >= 0) virtualListRef.current?.scrollToIndex(index);
          } else {
            virtualGridRef.current?.scrollToItem(id);
          }
        },
        getVerticalNeighbor: (id, direction) =>
          viewMode === 'list'
            ? null
            : (virtualGridRef.current?.getVerticalNeighbor(id, direction) ?? null),
      }),
      [viewMode, photos]
    );

    // 「全选」语义：只针对当前视图中出现的照片计算
    const allVisibleSelected = useMemo(
      () => photos.length > 0 && photos.every((p) => selectedIds.has(p.id)),
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
    const handlersRef = useRef({
      onToggleSelect,
      onRangeSelect,
      onQuickLook,
      onContextMenu,
      onToggleFavorite,
      onShowDeleteConfirm,
      onClearSelection,
    });
    handlersRef.current = {
      onToggleSelect,
      onRangeSelect,
      onQuickLook,
      onContextMenu,
      onToggleFavorite,
      onShowDeleteConfirm,
      onClearSelection,
    };

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

    // 列表被清空（清空列表 / 重新打开目录）时丢弃记忆的滚动位置，
    // 否则下次挂载会把新内容直接滚到旧偏移处。
    // 两段记忆各自归 VirtualGrid / VirtualList 所有，这里只发「清空」信号。
    useEffect(() => {
      if (photos.length === 0) {
        resetGridScrollMemory();
        resetListScrollMemory();
      }
    }, [photos.length]);

    /**
     * 首屏导入后的交错入场。只做一次：播完就把标记撤掉，
     * 否则卡片滚出视口再滚回来时（虚拟化重挂载）会反复重播淡入。
     */
    const [introDelays, setIntroDelays] = useState<Map<string, number>>(NO_INTRO_DELAYS);
    const introDoneRef = useRef(false);
    const introTimerRef = useRef<number | null>(null);
    useEffect(() => {
      if (introDoneRef.current || photos.length === 0) return;
      introDoneRef.current = true;

      const delays = new Map<string, number>();
      photos.slice(0, INTRO_COUNT).forEach((p, i) => delays.set(p.id, i * INTRO_STAGGER_MS));
      setIntroDelays(delays);

      // 定时器只在这里创建、只在卸载时清理。
      // 之前把 clearTimeout 放在本 effect 的清理函数里：photos 一变（元数据回填 / 收藏切换等）
      // 定时器就被清掉，而 introDoneRef 已置位又不会再建新的 —— 入场标记永远撤不掉，
      // 卡片滚出视口再滚回来（虚拟化重挂载）就会反复重播淡入动画。
      introTimerRef.current = window.setTimeout(() => {
        introTimerRef.current = null;
        setIntroDelays(NO_INTRO_DELAYS);
      }, INTRO_CLEAR_MS);
    }, [photos]);
    useEffect(
      () => () => {
        if (introTimerRef.current !== null) window.clearTimeout(introTimerRef.current);
      },
      []
    );

    const renderCard = useCallback(
      (photo: Photo, _style: React.CSSProperties, itemWidth: number) => (
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
      ),
      [
        selectedIds,
        exitingIds,
        introDelays,
        handleSelect,
        handleRange,
        handleOpen,
        handleMenu,
        handleFavorite,
        handleDeleteConfirm,
      ]
    );

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
     * 排序 / 缩放属于「浏览视图」控制，选中项出现时也必须留着（K16）。
     * 现在只渲染在一个地方：列表右上角的浮动胶囊（见网格视图 return），
     * 与选中态无关 —— 不再出现「选中后才多出一条浏览设置行」。
     */
    const directionLabel = sortConfig.direction === 'asc' ? '↑' : '↓';
    const browseControls = (
      <>
        {/* 断点只留 sm：此前 hidden lg 让窄窗口（< 1024px）完全没有网格大小入口 */}
        <div
          className="hidden sm:flex items-center gap-2 h-8 pl-2.5 pr-2 rounded-lg bg-[var(--bg-input)] border border-[var(--border-subtle)]"
          title="调整网格大小"
        >
          <ResizeIcon className="w-3.5 h-3.5 text-[var(--text-tertiary)] shrink-0" />
          <input
            type="range"
            min="0.5"
            max="2"
            step="0.1"
            value={scale}
            onChange={(e) => onScaleChange(parseFloat(e.target.value))}
            className="w-16 2xl:w-20 appearance-none cursor-pointer accent-[var(--accent-blue)] focus:outline-hidden"
            aria-label="网格大小"
          />
          <span className="text-xs font-mono text-[var(--text-tertiary)] w-8 text-right">
            {Math.round(scale * 100)}%
          </span>
        </div>

        <div className="flex items-center gap-1 p-0.5 rounded-lg bg-[var(--bg-input)] border border-[var(--border-subtle)]">
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => onSort(opt.key)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all duration-200 ${
                sortConfig.key === opt.key
                  ? 'bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-hover))] text-[var(--accent-contrast)] shadow-xs'
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
      </>
    );

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
          <span className="text-sm font-semibold text-[var(--text-primary)] whitespace-nowrap">
            已选 {selectedCount} 项
          </span>
          <button
            type="button"
            onClick={onClearSelection}
            title="清除选择（Esc）"
            className="ml-1 flex items-center gap-1 text-xs font-medium text-[var(--text-tertiary)] hover:text-[var(--text-primary)] px-2 py-1 rounded-lg hover:bg-[var(--bg-glass-hover)] transition-all duration-200"
          >
            <svg
              className="w-3 h-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth="2.5"
              strokeLinecap="round"
            >
              <path d="M6 18L18 6M6 6l12 12"></path>
            </svg>
            清除
          </button>
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-1.5">
          {/* 常驻的「全选 / 取消全选」开关：⌘A 本来就是切换语义，
            按钮此前在全部选中后消失，等于收走了唯一的批量撤回入口 */}
          <button
            type="button"
            onClick={onSelectAll}
            className="hidden md:flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded-lg border border-[var(--border-default)] bg-[var(--bg-glass)] hover:bg-[var(--bg-glass-hover)] transition-all duration-200"
            title={allVisibleSelected ? '取消全选（⌘A）' : '全选当前视图（⌘A）'}
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d={allVisibleSelected ? 'M5 12h14' : 'M5 13l4 4L19 7'}></path>
            </svg>
            {allVisibleSelected ? '取消全选' : '全选'}
          </button>
          <button
            type="button"
            onClick={onFavoriteSelected}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--accent-pink)] hover:bg-[rgba(var(--accent-pink-rgb),0.12)] rounded-lg border border-[var(--border-default)] bg-[var(--bg-glass)] transition-all duration-200"
            title="收藏 / 取消收藏选中项（⌘⇧F）"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
              ></path>
            </svg>
            <span className="hidden sm:inline">收藏</span>
          </button>
          {onBatchRename && (
            <button
              type="button"
              onClick={onBatchRename}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--accent-cyan)] hover:bg-[rgba(var(--accent-blue-rgb),0.12)] rounded-lg border border-[var(--border-default)] bg-[var(--bg-glass)] transition-all duration-200"
              title="批量重命名"
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth="2"
              >
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"></path>
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"></path>
              </svg>
              <span className="hidden sm:inline">重命名</span>
            </button>
          )}
          {onMoveSelected && (
            <button
              type="button"
              onClick={onMoveSelected}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--accent-blue)] hover:bg-[rgba(var(--accent-blue-rgb),0.12)] rounded-lg border border-[var(--border-default)] bg-[var(--bg-glass)] transition-all duration-200"
              title="移动选中项到其他文件夹（可在面板中新建文件夹）"
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth="2"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3 7a2 2 0 012-2h3.5l2 2H19a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
                ></path>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9.5 13.5h7m0 0l-2.5-2.5m2.5 2.5l-2.5 2.5"
                ></path>
              </svg>
              <span className="hidden sm:inline">移动到</span>
            </button>
          )}
          {onExportSelected && (
            <button
              type="button"
              onClick={onExportSelected}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--accent-green)] hover:bg-[rgba(var(--accent-green-rgb),0.12)] rounded-lg border border-[var(--border-default)] bg-[var(--bg-glass)] transition-all duration-200"
              title="批量导出（转换格式 / 压缩）"
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth="2"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                ></path>
              </svg>
              <span className="hidden sm:inline">导出</span>
            </button>
          )}
          <button
            type="button"
            onClick={onShowDeleteConfirm}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] bg-[linear-gradient(135deg,var(--accent-pink),var(--accent-pink-deep))] hover:brightness-110 rounded-lg shadow-lg shadow-[rgba(var(--accent-pink-rgb),0.25)] transition-all duration-200 active:scale-[0.98]"
            title="移至回收站（⌘⌫）"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth="2"
            >
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path>
            </svg>
            <span className="hidden sm:inline">删除</span>
          </button>
        </div>
      </div>
    ) : null;

    /* ============ 空状态：把“下一步能做什么”直接放在眼前 ============ */
    if (photos.length === 0) {
      // 首屏（图库完全为空）单独设计；其余五种共用克制模板，按 emptyKind 区分语气。
      // 判定用 emptyKind 而不是 `Boolean(onImport)`：导入入口只在该出现时出现，
      // 与「这是哪一种空」是两件事，混在一起会让首屏判定被入口的有无牵着走。
      const isWelcome = emptyKind === 'library';
      return (
        <div
          className="flex-1 flex flex-col items-center justify-center text-[var(--text-tertiary)] p-12 min-h-0 overflow-y-auto text-center"
          onContextMenu={(e) => onContextMenu && onContextMenu(e)}
        >
          {isWelcome ? (
            <WelcomeEmptyState
              title={emptyTitle}
              description={emptyDescription}
              onImport={onImport}
            />
          ) : (
            <QuietEmptyState
              kind={emptyKind}
              title={emptyTitle}
              description={emptyDescription}
              onShowAll={onShowAll}
              showAllLabel={showAllLabel}
              onClearSearch={onClearSearch}
              hint={emptyHint}
            />
          )}
        </div>
      );
    }

    /* ============ 列表视图 ============ */
    if (viewMode === 'list') {
      // 表头只依赖排序状态，作为 element 传给 VirtualList：滚动帧不会重渲染它。
      // 背景用不透明色（非毛玻璃）：backdrop-filter 在惯性滚动时要每帧全宽重新
      // 采样模糊，是长列表掉帧的常见来源。
      const tableHeader = (
        <thead className="bg-[var(--bg-table-header)] text-[var(--text-secondary)] font-semibold border-b border-[var(--border-subtle)] sticky top-0 z-10">
          <tr>
            <th className="px-4 py-3 w-10 rounded-tl-lg">
              <label
                className="flex items-center justify-center w-10 h-10 cursor-pointer rounded-lg hover:bg-[var(--bg-glass)] transition-colors"
                title="全选 / 取消全选"
              >
                <input
                  type="checkbox"
                  ref={selectAllRef}
                  checked={allVisibleSelected}
                  onChange={onSelectAll}
                  className="w-4 h-4 rounded-lg border-2 border-[rgba(255,255,255,0.2)] bg-[rgba(0,0,0,0.2)] text-[var(--accent-blue)] focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.4)] cursor-pointer accent-[var(--accent-blue)]"
                  aria-label="全选"
                />
              </label>
            </th>
            <th className="px-4 py-3 w-10"></th>

            <th
              className="px-4 py-3 cursor-pointer group hover:bg-[var(--bg-glass)] transition-colors select-none"
              onClick={() => onSort('name')}
            >
              <div className="flex items-center">
                名称{' '}
                <SortIndicator
                  active={sortConfig.key === 'name'}
                  direction={sortConfig.direction}
                />
              </div>
            </th>

            <th
              className="px-4 py-3 cursor-pointer group hover:bg-[var(--bg-glass)] transition-colors select-none"
              onClick={() => onSort('dateTaken')}
            >
              <div className="flex items-center">
                内容创建时间{' '}
                <SortIndicator
                  active={sortConfig.key === 'dateTaken'}
                  direction={sortConfig.direction}
                />
              </div>
            </th>

            <th
              className="px-4 py-3 cursor-pointer group hover:bg-[var(--bg-glass)] transition-colors select-none"
              onClick={() => onSort('dateModified')}
            >
              <div className="flex items-center">
                修改时间{' '}
                <SortIndicator
                  active={sortConfig.key === 'dateModified'}
                  direction={sortConfig.direction}
                />
              </div>
            </th>

            <th
              className="px-4 py-3 cursor-pointer group hover:bg-[var(--bg-glass)] transition-colors select-none"
              onClick={() => onSort('dateCreated')}
            >
              <div className="flex items-center">
                创建时间{' '}
                <SortIndicator
                  active={sortConfig.key === 'dateCreated'}
                  direction={sortConfig.direction}
                />
              </div>
            </th>

            <th
              className="px-4 py-3 cursor-pointer group hover:bg-[var(--bg-glass)] transition-colors select-none rounded-tr-lg"
              onClick={() => onSort('size')}
            >
              <div className="flex items-center">
                大小{' '}
                <SortIndicator
                  active={sortConfig.key === 'size'}
                  direction={sortConfig.direction}
                />
              </div>
            </th>
          </tr>
        </thead>
      );

      return (
        <div className="flex-1 flex flex-col w-full min-h-0">
          {selectionBar}
          {/* reflow 动画挂在包裹层：不要让滚动容器常驻 transform，否则整个滚动
            内容（几十万 px 高）会被提升成一个超大合成层 */}
          <div className={`flex-1 min-h-0 flex flex-col ${reflowClass}`}>
            <VirtualList
              ref={virtualListRef}
              items={photos}
              selectedIds={selectedIds}
              exitingIds={exitingIds}
              header={tableHeader}
              onSelect={handleSelect}
              onRange={handleRange}
              onOpen={handleOpen}
              onMenu={handleMenu}
              onToggleFavorite={handleFavorite}
              onBlankClick={onClearSelection}
              onContainerContextMenu={(e) => onContextMenu?.(e)}
            />
          </div>
        </div>
      );
    }

    /* ============ 网格视图 ============ */
    const sortByDate =
      sortConfig.key === 'dateTaken' ||
      sortConfig.key === 'dateModified' ||
      sortConfig.key === 'dateCreated';
    return (
      <div className="flex-1 flex flex-col w-full min-h-0">
        {/* 顶部只有一条「占位」行：无选中 = 分类名 + 数量，有选中 = 选择条。
            浏览控件不再占位（见下方浮动胶囊），因此选中与否都不会多插一行、列表不会整体下移。 */}
        {inSelectMode ? (
          selectionBar
        ) : (
          <div className="mb-2 mx-4 shrink-0 flex items-baseline gap-2 min-w-0">
            {viewTitle && (
              <span className="text-sm font-semibold text-[var(--text-primary)] truncate">
                {viewTitle}
              </span>
            )}
            <span className="text-xs text-[var(--text-tertiary)] whitespace-nowrap tabular-nums">
              {photos.length} 项
            </span>
          </div>
        )}

        <div className={`relative flex-1 flex flex-col min-h-0 ${reflowClass}`}>
          {/*
            浏览设置浮层：半透明毛玻璃、右对齐、压在第一行图片上。
            - 不参与布局（绝对定位）：选中 / 取消选中不会推动列表，滚到哪都在同一位置；
            - 外层 pointer-events-none：胶囊之外的区域仍能点卡片、拖滚动条；
            - 背景用 color-mix 把 --bg-elevated 压到 72% 透明度，图片能透出来但文字仍可读。
          */}
          <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-end pr-4">
            <div
              className="pointer-events-auto flex max-w-full flex-wrap items-center justify-end gap-2 rounded-xl border border-[var(--border-subtle)] px-2 py-1 shadow-lg shadow-[rgba(0,0,0,0.18)] backdrop-blur-xl transition-[border-color,box-shadow] duration-200 hover:border-[rgba(var(--accent-blue-rgb),0.35)] hover:shadow-xl"
              style={{
                backgroundColor: 'color-mix(in srgb, var(--bg-elevated) 72%, transparent)',
              }}
            >
              {browseControls}
            </div>
          </div>

          <VirtualGrid
            ref={virtualGridRef}
            items={photos}
            targetRowHeight={targetRowHeight}
            gap={GRID_GAP}
            onBlankClick={handleBlankClick}
            onContainerContextMenu={(e) => onContextMenu?.(e)}
            onColumnsChange={onColumnsChange}
            onFilterByDate={onFilterByDate}
            stickyDay={
              sortByDate
                ? (photo) => {
                    // 与 photoGrouping 的分组口径保持一致：按修改时间排序时用 lastModified 切天，
                    // 否则用统一的「拍摄时间」语义（见 @/lib/media/photoTime）
                    const ts =
                      sortConfig.key === 'dateModified'
                        ? photo.lastModified
                        : photoTakenTime(photo);
                    const label = formatDayCapsule(ts);
                    return label ? { label, timestamp: ts } : null;
                  }
                : undefined
            }
          >
            {renderCard}
          </VirtualGrid>
        </div>
      </div>
    );
  }
);

ImageGrid.displayName = 'ImageGrid';

export default ImageGrid;
