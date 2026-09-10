
import React, { useState } from 'react';
import { PhotoFilters, ViewMode } from '../types';
import { countAdvancedFilters } from '../filters';
import FilterPanel from './FilterPanel';

interface ToolbarProps {
  /** 打开 / 更换文件夹（左侧主要导航） */
  onOpenDirectory: () => Promise<boolean>;
  /** 添加单个或多个图片 / 视频 */
  onAddImages: () => void;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  onCheckDuplicates: () => void;
  onResetList: () => void;
  /** 库中是否已有内容：决定「检测重复 / 重置列表」是否可用 */
  hasPhotos: boolean;
  scale: number;
  setScale: (scale: number) => void;
  /** 当前已打开的文件夹名（无则显示「打开文件夹」） */
  currentFolder: string | null;
  isDetailsPaneOpen: boolean;
  setIsDetailsPaneOpen: (isOpen: boolean) => void;
  isLeftPaneOpen: boolean;
  setIsLeftPaneOpen: (isOpen: boolean) => void;
  /** 搜索关键词（文件名 / 相机 / 格式） */
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  /** ⌘F 聚焦搜索框 */
  searchInputRef: React.RefObject<HTMLInputElement>;
  /** 可组合筛选条件（N3） */
  filters: PhotoFilters;
  onFiltersChange: (patch: Partial<PhotoFilters>) => void;
  onResetFilters: () => void;
  /** 筛选面板的可选项（相机 / 格式 / 标签），来自当前库 */
  filterOptions: { cameras: string[]; formats: string[]; tags: string[] };
  /** 库中是否含视频：决定筛选面板是否展示时长条件 */
  hasVideos: boolean;
}

const FolderIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
  </svg>
);

const ImageIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
    <circle cx="8.5" cy="8.5" r="1.5"></circle>
    <polyline points="21 15 16 10 5 21"></polyline>
  </svg>
);

const DuplicateIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="8" y="8" width="12" height="12" rx="2"></rect>
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path>
  </svg>
);

const RefreshIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10"></polyline>
    <polyline points="1 20 1 14 7 14"></polyline>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
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

const ChevronLeftIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6"></polyline>
  </svg>
);

const ChevronRightIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6"></polyline>
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
  <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"></path>
  </svg>
);

/** 网格缩放：对角双向箭头，避免与「搜索」的放大镜图标混淆 */
const ResizeIcon = ({ className = 'w-4 h-4' }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 9 4 4 9 4"></polyline>
    <polyline points="20 15 20 20 15 20"></polyline>
    <line x1="4" y1="4" x2="10" y2="10"></line>
    <line x1="20" y1="20" x2="14" y2="14"></line>
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
   * 静止态统一为中性灰 —— 顶栏只保留「打开文件夹 / 添加」两处彩色，
   * 其余功能靠悬停变色与 Tooltip 识别，避免一排图标五颜六色。
   */
  hoverColor?: string;
  size?: 'sm' | 'md';
}

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
  const dim = size === 'sm' ? 'w-8 h-8' : 'w-9 h-9';
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
        className={`flex items-center justify-center ${dim} rounded-xl transition-all duration-200 ${
          disabled
            ? 'opacity-30 cursor-not-allowed text-[var(--text-quaternary)]'
            : danger
              ? 'text-[var(--accent-pink)] hover:bg-[rgba(var(--accent-pink-rgb),0.12)] active:bg-[rgba(var(--accent-pink-rgb),0.2)]'
              : active
                ? 'bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-deep))] text-[var(--accent-contrast)] shadow-lg shadow-[rgba(var(--accent-blue-rgb),0.35)]'
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
 * 主操作在一屏里始终要有名字，所以分两档标签：xl 起显示短标签，2xl 起显示完整标签
 * （例如文件夹按钮在 xl 显示「打开」、2xl 显示文件夹名），避免只剩两个图标靠猜。
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
    className={`flex items-center h-9 pl-2 pr-2.5 gap-1.5 rounded-xl shrink-0 transition-all duration-200 active:scale-[0.98] ${
      variant === 'solid'
        ? 'bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-deep))] text-[var(--accent-contrast)] shadow-lg shadow-[rgba(var(--accent-blue-rgb),0.3)] hover:brightness-110'
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
 * 左「主要导航」→ 中「搜索」→ 右「视图与辅助控制」，把常用操作压在左侧拇指/视线起点，
 * 右侧只留视图类开关；批量重命名 / 删除等条目级操作交给内容区的情境条与右键菜单。
 */
const Toolbar: React.FC<ToolbarProps> = ({
  onOpenDirectory,
  onAddImages,
  viewMode,
  setViewMode,
  onCheckDuplicates,
  onResetList,
  hasPhotos,
  scale,
  setScale,
  currentFolder,
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
}) => {
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const advancedFilterCount = countAdvancedFilters(filters);

  return (
    <header className="bg-[var(--bg-elevated)] backdrop-blur-xl border-b border-[var(--border-subtle)] z-20 sticky top-0 px-3 py-2 shadow-lg shadow-[rgba(0,0,0,0.15)]">
      <div className="flex items-center gap-2 h-9">

        {/* ===== 左：主要导航与常用操作 ===== */}
        <div className="flex items-center gap-1 shrink-0 min-w-0">
          <ToolButton
            onClick={() => setIsLeftPaneOpen(!isLeftPaneOpen)}
            icon={isLeftPaneOpen ? <ChevronLeftIcon /> : <ChevronRightIcon />}
            title={isLeftPaneOpen ? '收起侧边栏' : '展开侧边栏'}
            hoverColor="var(--accent-cyan)"
          />

          <ActionButton
            onClick={() => { void onOpenDirectory(); }}
            icon={<span className="text-[var(--accent-cyan)] flex items-center"><FolderIcon /></span>}
            title={currentFolder ? `更换文件夹（当前：${currentFolder}）` : '打开文件夹'}
            label={currentFolder ?? '打开文件夹'}
            variant="outline"
          />

          <ActionButton
            onClick={onAddImages}
            icon={<ImageIcon />}
            title="添加图片 / 视频"
            label="添加"
            compactLabel="添加"
            variant="solid"
          />

          <div className="w-px h-5 bg-[var(--border-default)] mx-1.5"></div>

          <ToolButton
            onClick={onCheckDuplicates}
            icon={<DuplicateIcon />}
            title="检测相似照片"
            disabled={!hasPhotos}
            hoverColor="var(--accent-purple)"
          />

          <ToolButton
            onClick={onResetList}
            icon={<RefreshIcon />}
            title="重置列表"
            disabled={!hasPhotos}
            hoverColor="var(--accent-yellow)"
          />
        </div>

        {/* ===== 中：搜索（⌘F 聚焦，Esc 清空）+ 筛选 ===== */}
        <div className="flex-1 min-w-0 flex justify-center items-center gap-1.5 px-1">
          <div className="relative w-full min-w-[124px] xl:min-w-[140px] max-w-[420px] group">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-quaternary)] group-focus-within:text-[var(--accent-cyan)] transition-colors">
              <SearchIcon />
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
              className="w-full h-9 pl-9 pr-9 xl:pr-16 rounded-xl bg-[var(--bg-input)] border border-[var(--border-subtle)] text-[13px] text-[var(--text-primary)] placeholder-[var(--text-quaternary)] outline-none transition-all duration-200 focus:border-[var(--accent-blue)] focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.25)] hover:border-[var(--border-hover)]"
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
                className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] transition-all"
                title="清除搜索"
                aria-label="清除搜索"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"></path></svg>
              </button>
            ) : (
              <span className="absolute right-2.5 top-1/2 -translate-y-1/2 hidden xl:flex items-center pointer-events-none">
                <span className="kbd !h-5 !min-w-[20px] !text-[10px]">⌘F</span>
              </span>
            )}
          </div>

          {/* 筛选入口：角标只统计「高级条件」（日期/相机/格式/大小/时长），
              收藏与媒体类型在侧栏已有一眼可见的选中态，不重复计数 */}
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setIsFilterOpen(open => !open)}
              title="筛选条件"
              aria-label="筛选条件"
              aria-expanded={isFilterOpen}
              className={`relative flex items-center justify-center w-9 h-9 rounded-xl transition-all duration-200 ${
                advancedFilterCount > 0 || isFilterOpen
                  ? 'bg-[rgba(var(--accent-blue-rgb),0.14)] text-[var(--accent-blue)] border border-[rgba(var(--accent-blue-rgb),0.35)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] active:bg-[var(--bg-glass-active)] border border-transparent'
              }`}
            >
              <FunnelIcon />
              {advancedFilterCount > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-[var(--accent-blue)] text-[var(--accent-contrast)] text-[10px] font-semibold leading-4 text-center border border-[var(--bg-elevated)]">
                  {advancedFilterCount}
                </span>
              )}
            </button>

            {isFilterOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setIsFilterOpen(false)} />
                <FilterPanel
                  filters={filters}
                  onChange={onFiltersChange}
                  onReset={onResetFilters}
                  options={filterOptions}
                  hasVideos={hasVideos}
                  onClose={() => setIsFilterOpen(false)}
                />
              </>
            )}
          </div>
        </div>

        {/* ===== 右：视图与辅助控制 ===== */}
        <div className="flex items-center gap-1 shrink-0">
          {viewMode === 'grid' && (
            <div
              className="hidden lg:flex items-center gap-2 h-9 pl-2.5 pr-2 rounded-xl bg-[var(--bg-input)] border border-[var(--border-subtle)]"
              title="调整网格大小"
            >
              <ResizeIcon className="w-3.5 h-3.5 text-[var(--text-tertiary)] shrink-0" />
              <input
                type="range"
                min="0.5"
                max="2"
                step="0.1"
                value={scale}
                onChange={(e) => setScale(parseFloat(e.target.value))}
                className="w-16 2xl:w-20 appearance-none cursor-pointer accent-[var(--accent-blue)] focus:outline-none"
                aria-label="网格大小"
              />
              <span className="text-[11px] font-mono text-[var(--text-tertiary)] w-8 text-right">{Math.round(scale * 100)}%</span>
            </div>
          )}

          <div className="flex items-center gap-0.5 h-9 p-0.5 rounded-xl bg-[var(--bg-input)] border border-[var(--border-subtle)]">
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

export default Toolbar;
