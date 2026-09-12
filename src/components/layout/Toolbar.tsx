
import React, { useCallback, useState } from 'react';
import { PhotoFilters, ViewMode } from '@/types';
import { countAdvancedFilters } from '@/lib/filter/filters';
import FilterPanel from '@/components/filter/FilterPanel';

interface ToolbarProps {
  /** 统一导入：图片 / 视频文件与文件夹都能批量选择 */
  onImport: () => void;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  isDetailsPaneOpen: boolean;
  setIsDetailsPaneOpen: (isOpen: boolean) => void;
  isLeftPaneOpen: boolean;
  setIsLeftPaneOpen: (isOpen: boolean) => void;
  /** 搜索关键词（文件名 / 相机 / 格式） */
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  /** ⌘F 聚焦搜索框 */
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  /** 可组合筛选条件（N3） */
  filters: PhotoFilters;
  onFiltersChange: (patch: Partial<PhotoFilters>) => void;
  onResetFilters: () => void;
  /** 筛选面板的可选项（相机 / 格式 / 标签），来自当前库 */
  filterOptions: { cameras: string[]; formats: string[]; tags: string[] };
  /** 库中是否含视频：决定筛选面板是否展示时长条件 */
  hasVideos: boolean;
  /**
   * 筛选面板开合上报。
   * App 的全局快捷键需要据此让行：面板里的胶囊是普通按钮，
   * 不隔离的话按 Delete 会在面板之上再叠一个「移至回收站」确认框。
   */
  onFilterOpenChange?: (isOpen: boolean) => void;
}

const ImageIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
    <circle cx="8.5" cy="8.5" r="1.5"></circle>
    <polyline points="21 15 16 10 5 21"></polyline>
  </svg>
);

const GridIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="7" rx="1"></rect>
    <rect x="14" y="3" width="7" height="7" rx="1"></rect>
    <rect x="14" y="14" width="7" height="7" rx="1"></rect>
    <rect x="3" y="14" width="7" height="7" rx="1"></rect>
  </svg>
);

const ListIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="8" y1="6" x2="21" y2="6"></line>
    <line x1="8" y1="12" x2="21" y2="12"></line>
    <line x1="8" y1="18" x2="21" y2="18"></line>
    <line x1="3" y1="6" x2="3.01" y2="6"></line>
    <line x1="3" y1="12" x2="3.01" y2="12"></line>
    <line x1="3" y1="18" x2="3.01" y2="18"></line>
  </svg>
);

/** macOS 标准「侧边栏」图标：圆角矩形 + 实心左侧面板（SF Symbol sidebar.left），
    收起 / 展开共用同一图标，状态由侧栏本身表达 */
const SidebarIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4V4H5Z" fill="currentColor" stroke="none"></path>
    <rect x="3" y="4" width="18" height="16" rx="2"></rect>
  </svg>
);

const PanelIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
    <line x1="15" y1="3" x2="15" y2="21"></line>
  </svg>
);

const SearchIcon = ({ className = 'w-4 h-4' }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8"></circle>
    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
  </svg>
);

const FunnelIcon = () => (
  <svg width="17" height="17" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"></path>
  </svg>
);

interface ToolButtonProps {
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  /** 开关型按钮的选中态 */
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /**
   * 悬停时呈现的语义色。
   * 静止态统一为中性灰 —— 顶栏只保留「导入」一处彩色，
   * 其余功能靠悬停变色与 Tooltip 识别，避免一排图标五颜六色。
   */
  hoverColor?: string;
  size?: 'sm' | 'md';
}

/**
 * 顶带内的「软激活」：浅琥珀底 + 琥珀图标 + 一圈细边框。
 *
 * 实心渐变只留给「导入」一处主操作。顶带里一旦出现第二个实心色块，
 * 眼睛就不知道该先落在哪儿 —— 而「视图切成网格」和「导入照片」本就不该同等重要。
 * 软激活同时让分段控件（视图 / 外观）与独立开关（筛选 / 详情）共用一套选中语言。
 *
 * 边框放在 SOFT_ACTIVE 里、由各处的基类预置 `border-transparent`：
 * 这样选中与未选中共用同一套盒模型，切换时不会有 1px 的跳动。
 */
const SOFT_ACTIVE =
  'border-[rgba(var(--accent-blue-rgb),0.32)] bg-[rgba(var(--accent-blue-rgb),0.15)] text-[var(--accent-blue)]';

const ToolButton: React.FC<ToolButtonProps> = ({
  onClick,
  icon,
  title,
  active,
  danger,
  disabled,
  hoverColor,
  size = 'md',
}) => {
  const [hovered, setHovered] = useState(false);
  /** 顶带统一一条 40px 的高度，控件随之收成 28 / 32 两档 */
  const dim = size === 'sm' ? 'w-7 h-7' : 'w-8 h-8';
  const radius = size === 'sm' ? 'rounded-lg' : 'rounded-[10px]';
  const tint = !disabled && !active && !danger && hovered ? hoverColor : undefined;

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-label={title}
        className={`flex items-center justify-center ${dim} ${radius} border border-transparent transition-all duration-200 ${
          disabled
            ? 'opacity-30 cursor-not-allowed text-[var(--text-quaternary)]'
            : danger
              ? 'text-[var(--accent-pink)] hover:bg-[rgba(var(--accent-pink-rgb),0.12)] active:bg-[rgba(var(--accent-pink-rgb),0.2)]'
              : active
                ? SOFT_ACTIVE
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] active:bg-[var(--bg-glass-active)]'
        }`}
        style={tint ? { color: tint } : undefined}
      >
        {icon}
      </button>

      {hovered && !disabled && (
        <div className="absolute top-full mt-2 left-1/2 transform -translate-x-1/2 z-50 pointer-events-none">
          <div className="bg-[var(--bg-tooltip)] backdrop-blur-xl text-[var(--text-primary)] text-xs font-medium px-3 py-1.5 rounded-lg shadow-xl border border-[var(--border-subtle)] whitespace-nowrap">
            {title}
            <div className="absolute -top-1 left-1/2 transform -translate-x-1/2 w-2 h-2 bg-[var(--bg-tooltip)] rotate-45 border-l border-t border-[var(--border-subtle)]"></div>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * 带文字标签的动作按钮：顶栏左区用它承载「导入」这一类主操作。
 * 主操作在一屏里始终要有名字，所以分两档标签：lg 起显示短标签，2xl 起显示完整标签，
 * 避免只剩一个图标靠猜。
 */
const ActionButton: React.FC<{
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  label: string;
  /** xl ~ 2xl 之间使用的短标签 */
  compactLabel?: string;
  variant: 'outline' | 'solid';
}> = ({ onClick, icon, title, label, compactLabel, variant }) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    aria-label={title}
    className={`flex items-center h-8 pl-2 pr-2.5 gap-1.5 rounded-[10px] shrink-0 transition-all duration-200 active:scale-[0.98] ${
      variant === 'solid'
        ? 'bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-deep))] text-[var(--accent-contrast)] shadow-[0_2px_10px_-3px_rgba(var(--accent-blue-rgb),0.65)] hover:brightness-110'
        : 'border border-[var(--border-default)] bg-[var(--bg-glass)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] hover:border-[var(--border-hover)]'
    }`}
  >
    <span className="shrink-0 flex items-center justify-center">{icon}</span>
    {compactLabel && (
      <span className="hidden lg:inline 2xl:hidden text-[13px] font-medium truncate max-w-[64px]">{compactLabel}</span>
    )}
    <span className="hidden 2xl:inline text-[13px] font-medium truncate max-w-[120px]">{label}</span>
  </button>
);

/**
 * 顶栏：三段式布局。
 * 左「侧栏开关 + 导入」→ 中「搜索 + 筛选」→ 右「视图控制」。
 *
 * 顶栏只放「作用于当前视图」的东西：左区一处主操作（导入），右区两处视图开关
 * （网格 / 列表、详情面板）。凡是不作用于当前视图的——相似照片、清空照片列表、
 * 快捷键帮助——一律归侧栏，那才是「除了整理照片之外的事」的归属。
 */
const Toolbar: React.FC<ToolbarProps> = ({
  onImport,
  viewMode,
  setViewMode,
  isDetailsPaneOpen,
  setIsDetailsPaneOpen,
  isLeftPaneOpen,
  setIsLeftPaneOpen,
  searchQuery,
  onSearchQueryChange,
  searchInputRef,
  filters,
  onFiltersChange,
  onResetFilters,
  filterOptions,
  hasVideos,
  onFilterOpenChange,
}) => {
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const setFilterOpen = useCallback((open: boolean) => {
    setIsFilterOpen(open);
    onFilterOpenChange?.(open);
  }, [onFilterOpenChange]);
  const advancedFilterCount = countAdvancedFilters(filters);

  return (
    <header className={`app-drag h-10 shrink-0 bg-[var(--bg-elevated)] backdrop-blur-xl border-b border-[var(--border-subtle)] shadow-[var(--shadow-toolbar)] z-20 sticky top-0 ${isLeftPaneOpen ? 'px-3' : 'pl-[78px] pr-3'}`}>
      <div className="app-no-drag flex items-center gap-2 h-full">

        {/* ===== 左：主要导航与常用操作 ===== */}
        <div className="flex items-center gap-1.5 shrink-0 min-w-0">
          {/* 侧边栏开关：常驻浅色圆角底（参照系统照片应用），收起后紧邻红绿灯。
              与搜索框共用同一档容器语言（32px 高 / 10px 圆角 / 输入底色），
              整条顶带才像同一套零件拼出来的 */}
          <button
            type="button"
            onClick={() => setIsLeftPaneOpen(!isLeftPaneOpen)}
            title={isLeftPaneOpen ? '隐藏侧边栏' : '显示侧边栏'}
            aria-label={isLeftPaneOpen ? '隐藏侧边栏' : '显示侧边栏'}
            aria-expanded={isLeftPaneOpen}
            className="flex items-center justify-center w-8 h-8 rounded-[10px] bg-[var(--bg-input)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] hover:border-[var(--border-hover)] active:scale-[0.97] transition-all duration-200 shrink-0"
          >
            <SidebarIcon />
          </button>

          <ActionButton
            onClick={onImport}
            icon={<ImageIcon />}
            title="导入图片、视频或文件夹（可批量多选）"
            label="导入图片 / 文件夹"
            compactLabel="导入"
            variant="solid"
          />
        </div>

        {/* ===== 中：搜索（⌘F 聚焦，Esc 清空）+ 筛选 ===== */}
        <div className="flex-1 min-w-0 flex justify-center items-center gap-1.5 px-2">
          <div className="relative w-full min-w-[124px] xl:min-w-[140px] max-w-[420px] group">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-quaternary)] group-focus-within:text-[var(--accent-cyan)] transition-colors">
              <SearchIcon className="w-[15px] h-[15px]" />
            </span>
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  if (searchQuery) {
                    onSearchQueryChange('');
                  } else {
                    searchInputRef.current?.blur();
                  }
                } else if (e.key === 'Enter') {
                  searchInputRef.current?.blur();
                }
              }}
              className="w-full h-8 pl-9 pr-8 xl:pr-14 rounded-[10px] bg-[var(--bg-input)] border border-[var(--border-subtle)] text-[13px] text-[var(--text-primary)] placeholder-[var(--text-quaternary)] outline-hidden transition-all duration-200 focus:border-[var(--accent-blue)] focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.2)] hover:border-[var(--border-hover)]"
              placeholder="搜索照片、相机、格式…"
              aria-label="搜索照片"
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={() => {
                  onSearchQueryChange('');
                  searchInputRef.current?.focus();
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center justify-center w-[18px] h-[18px] rounded-full text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] transition-all"
                title="清除搜索"
                aria-label="清除搜索"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"></path></svg>
              </button>
            ) : (
              <span className="absolute right-2 top-1/2 -translate-y-1/2 hidden xl:flex items-center pointer-events-none">
                <span className="kbd !h-[18px] !min-w-[18px] !px-1 !text-[10px]">⌘F</span>
              </span>
            )}
          </div>

          {/* 筛选入口：角标只统计「高级条件」（日期/相机/格式/大小/时长），
              收藏与媒体类型在侧栏已有一眼可见的选中态，不重复计数 */}
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setFilterOpen(!isFilterOpen)}
              title="筛选条件"
              aria-label="筛选条件"
              aria-expanded={isFilterOpen}
              className={`relative flex items-center justify-center w-8 h-8 rounded-[10px] border border-transparent transition-all duration-200 ${
                advancedFilterCount > 0 || isFilterOpen
                  ? SOFT_ACTIVE
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] active:bg-[var(--bg-glass-active)]'
              }`}
            >
              <FunnelIcon />
              {advancedFilterCount > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[15px] h-[15px] px-1 rounded-full bg-[var(--accent-blue)] text-[var(--accent-contrast)] text-[10px] font-semibold leading-[15px] text-center border border-[var(--bg-elevated)]">
                  {advancedFilterCount}
                </span>
              )}
            </button>

            {isFilterOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setFilterOpen(false)} />
                <FilterPanel
                  filters={filters}
                  onChange={onFiltersChange}
                  onReset={onResetFilters}
                  options={filterOptions}
                  hasVideos={hasVideos}
                  onClose={() => setFilterOpen(false)}
                />
              </>
            )}
          </div>
        </div>

        {/* ===== 右：视图与辅助控制 ===== */}
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="flex items-center gap-0.5 h-8 p-0.5 rounded-[10px] bg-[var(--bg-input)] border border-[var(--border-subtle)]">
            <ToolButton
              onClick={() => setViewMode('grid')}
              icon={<GridIcon />}
              title="网格视图"
              active={viewMode === 'grid'}
              size="sm"
            />
            <ToolButton
              onClick={() => setViewMode('list')}
              icon={<ListIcon />}
              title="列表视图"
              active={viewMode === 'list'}
              size="sm"
            />
          </div>

          <ToolButton
            onClick={() => setIsDetailsPaneOpen(!isDetailsPaneOpen)}
            icon={<PanelIcon />}
            title={isDetailsPaneOpen ? '收起详情面板' : '展开详情面板'}
            active={isDetailsPaneOpen}
          />
        </div>
      </div>
    </header>
  );
};

// 与 Sidebar 同理：工具栏不需要随「点选 / QuickLook」等高频状态重渲染。
export default React.memo(Toolbar);
