
import React from 'react';
import { MediaFilter, SmartAlbum } from '@/types';

type Theme = 'dark' | 'light' | 'system';

interface SidebarProps {
  counts: {
    all: number;
    images: number;
    videos: number;
    favorites: number;
    /** 已隐藏项数量 */
    hidden: number;
    /** 智能分类计数（本地启发式，见 mediaTypes.ts） */
    selfies: number;
    livePhotos: number;
    screenshots: number;
  };
  /** 智能相簿（只存筛选条件） */
  albums: SmartAlbum[];
  /** 每个相簿当前命中的数量 */
  albumCounts: Record<string, number>;
  /** 当前视图正好等价于哪个相簿 */
  activeAlbumId: string | null;
  onSelectAlbum: (album: SmartAlbum) => void;
  onDeleteAlbum: (id: string) => void;
  /** 打开「存为智能相簿」弹窗 */
  onRequestSaveAlbum: () => void;
  activeCategory: string;
  /** 当前媒体类型筛选：与分类共同决定哪一项处于选中态 */
  mediaFilter: MediaFilter;
  /** 选择图库分类（分类 + 媒体类型同时落地，避免出现「收藏夹里的视频」这类组合） */
  onSelectNav: (category: string, filter: MediaFilter) => void;
  /** 最近打开过的目录（新在前），用于一键重新打开 */
  recentDirectories: string[];
  onSelectRecentFolder: (path: string) => void;
  /** 打开时光画廊（整页时间线视图） */
  onSelectTimeline: () => void;
  /** 当前是否处于时光画廊视图 */
  isTimelineActive: boolean;
  /** 打开相似照片（整页视图）：与筛选无关，属「视图」而非分类 */
  onCheckDuplicates: () => void;
  /** 请求清空照片列表：破坏性操作，由 App 统一弹二次确认 */
  onRequestReset: () => void;
  /** 库中是否有内容：决定「相似照片 / 清空照片列表」是否可用 */
  hasPhotos: boolean;
  /** 打开快捷键总览层：与外观同属底部全局区，不作用于当前视图 */
  onOpenShortcuts: () => void;
  isOpen: boolean;
  /** 当前外观模式 */
  themeMode: Theme;
  /** 选择外观模式（明亮 / 暗黑 / 跟随系统） */
  onThemeModeChange: (mode: Theme) => void;
}

const PhotosIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
);

const PhotoIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="4.5" width="19" height="15" rx="2.5"></rect><circle cx="8" cy="10" r="1.5"></circle><polyline points="21 15 16 10 5 19"></polyline></svg>
);

const VideoIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="14" height="14" rx="2"></rect><polygon points="16 10 22 7 22 17 16 14 16 10" fill="currentColor" stroke="none"></polygon></svg>
);

/** 自拍：人像轮廓 */
const SelfieIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="3"></rect>
    <circle cx="12" cy="10" r="2.6"></circle>
    <path d="M7.4 18c.9-2 2.6-3.1 4.6-3.1s3.7 1.1 4.6 3.1"></path>
  </svg>
);

/** 实况照片：同心圆（与系统图标语义一致） */
const LivePhotoIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9"></circle>
    <circle cx="12" cy="12" r="5.4"></circle>
    <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"></circle>
  </svg>
);

/** 截屏：取景框内的相机 */
const ScreenshotIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 8.5V6a3 3 0 0 1 3-3h2.5"></path>
    <path d="M15.5 3H18a3 3 0 0 1 3 3v2.5"></path>
    <path d="M21 15.5V18a3 3 0 0 1-3 3h-2.5"></path>
    <path d="M8.5 21H6a3 3 0 0 1-3-3v-2.5"></path>
    <rect x="8" y="9" width="8" height="6" rx="1.6"></rect>
  </svg>
);

const HeartIcon = ({ filled }: { filled?: boolean }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
);

/** 已隐藏：闭眼 */
const HiddenIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"></path>
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"></path>
    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"></path>
    <line x1="1" y1="1" x2="23" y2="23"></line>
  </svg>
);

/** 智能相簿：叠放的照片 */
const AlbumIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="7" width="14" height="12" rx="2"></rect>
    <path d="M7 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2"></path>
  </svg>
);

/** 时光画廊：时钟 + 胶片，表达「沿时间线回顾记忆」 */
const TimelineIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9"></circle>
    <polyline points="12 7 12 12 15.5 14"></polyline>
    <rect x="3.2" y="10.5" width="2.2" height="3" rx="0.6" fill="currentColor" stroke="none" opacity="0.55"></rect>
    <rect x="18.6" y="10.5" width="2.2" height="3" rx="0.6" fill="currentColor" stroke="none" opacity="0.55"></rect>
  </svg>
);

/** 相似照片检测：叠放的两张照片 */
const DuplicateIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="8" y="8" width="12" height="12" rx="2"></rect>
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path>
  </svg>
);

/** 整页视图入口的右侧标记：不是计数，而是「会离开当前列表」 */
const ChevronRightIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 5 16 12 9 19"></polyline>
  </svg>
);

const PlusIcon = () => (
  <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.2" strokeLinecap="round">
    <path d="M12 5v14M5 12h14"></path>
  </svg>
);

/** 品牌标记：光圈叶片。摄影语汇里最简洁的身份符号，与「暗房」配色同源 */
const ApertureIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"></circle>
    <line x1="14.31" y1="8" x2="20.05" y2="17.94"></line>
    <line x1="9.69" y1="8" x2="21.17" y2="8"></line>
    <line x1="7.38" y1="12" x2="13.12" y2="2.06"></line>
    <line x1="9.69" y1="16" x2="3.95" y2="6.06"></line>
    <line x1="14.31" y1="16" x2="2.83" y2="16"></line>
    <line x1="16.62" y1="12" x2="10.88" y2="21.94"></line>
  </svg>
);

const HistoryIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path>
    <path d="M3 3v5h5"></path>
    <path d="M12 7.5V12l3 2"></path>
  </svg>
);

const TrashIcon = () => (
  <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6"></polyline>
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
  </svg>
);

/** 清空照片列表：刷新箭头，表达「回到空库重新开始」 */
const ResetIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10"></polyline>
    <polyline points="1 20 1 14 7 14"></polyline>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
  </svg>
);

/**
 * 快捷键：键盘轮廓。比一个「?」更直说它打开的是什么 ——
 * 「?」是「我不懂」的求助语义，而这里给的是操作说明。
 */
const KeyboardIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="5" width="20" height="14" rx="2.5"></rect>
    <path d="M6 9.5h.01M10 9.5h.01M14 9.5h.01M18 9.5h.01M6 13h.01M18 13h.01M9 16.5h6"></path>
  </svg>
);

const SunIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="5"></circle>
    <line x1="12" y1="1" x2="12" y2="3"></line>
    <line x1="12" y1="21" x2="12" y2="23"></line>
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
    <line x1="1" y1="12" x2="3" y2="12"></line>
    <line x1="21" y1="12" x2="23" y2="12"></line>
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
  </svg>
);

const MoonIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
  </svg>
);

const MonitorIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="3" width="20" height="14" rx="2"></rect>
    <line x1="8" y1="21" x2="16" y2="21"></line>
    <line x1="12" y1="17" x2="12" y2="21"></line>
  </svg>
);

/**
 * 一行只有一套走法。全栏共用这三个片段拼行，
 * 保证「导航行 / 相簿行 / 最近打开行」只是同一件事的不同密度，而不是三种控件。
 */
const ROW_BASE = 'group w-full flex items-center rounded-[10px] font-medium transition-colors duration-150';
const ROW_STATE = (active: boolean, disabled?: boolean) =>
  active
    ? 'bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-deep))] text-[var(--accent-contrast)] shadow-md shadow-[rgba(var(--accent-blue-rgb),0.25)]'
    : disabled
      ? 'text-[var(--text-quaternary)] cursor-not-allowed'
      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] active:bg-[var(--bg-glass-active)]';
/** 图标静止时只作「行首标尺」存在，不参与彩色叙事；悬停才给一点琥珀 */
const ROW_ICON = (active: boolean, dim?: boolean) =>
  `shrink-0 transition-colors duration-150 ${
    active
      ? 'text-[var(--accent-contrast)]'
      : dim
        ? 'text-[var(--text-quaternary)]'
        : 'text-[var(--text-tertiary)] group-hover:text-[var(--accent-cyan)]'
  }`;

interface NavRowProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  /** 计数列：整栏右对齐成一竖排，用等宽数字对齐（见 styles.css 的 --font-numeric） */
  count?: number;
  /** 整页视图入口：右端显示箭头，代替计数 */
  chevron?: boolean;
  active?: boolean;
  disabled?: boolean;
  title?: string;
}

const NavRow: React.FC<NavRowProps> = ({ icon, label, onClick, count, chevron, active, disabled, title }) => {
  const isZero = count === 0;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-current={active ? 'page' : undefined}
      title={title}
      className={`${ROW_BASE} h-9 gap-2.5 px-2.5 text-[13px] ${ROW_STATE(!!active, disabled)}`}
    >
      <span className={ROW_ICON(!!active, isZero && !active)}>{icon}</span>
      <span className={`truncate ${isZero && !active ? 'text-[var(--text-tertiary)]' : ''}`}>{label}</span>
      {chevron ? (
        <span className={`ml-auto shrink-0 transition-colors duration-150 ${
          active ? 'text-[var(--accent-contrast)] opacity-70' : 'text-[var(--text-quaternary)] group-hover:text-[var(--text-tertiary)]'
        }`}>
          <ChevronRightIcon />
        </span>
      ) : (
        <span className={`ml-auto shrink-0 font-numeric text-[11.5px] tabular-nums transition-colors duration-150 ${
          active
            ? 'text-[var(--accent-contrast)] opacity-75'
            : isZero
              ? 'text-[var(--text-quaternary)]'
              : 'text-[var(--text-tertiary)] group-hover:text-[var(--text-secondary)]'
        }`}>
          {count}
        </span>
      )}
    </button>
  );
};

/** 分段标题：只做「这一段是什么」，不加总量（分类之间有重叠，加总会说谎） */
const SectionLabel: React.FC<{ children: React.ReactNode; action?: React.ReactNode }> = ({ children, action }) => (
  <div className="flex items-center justify-between h-6 px-2.5 mb-0.5">
    <h2 className="text-[10.5px] font-semibold tracking-[0.09em] text-[var(--text-quaternary)] transition-colors">{children}</h2>
    {action}
  </div>
);

/**
 * 左栏：视图入口 + 图库分类 + 媒体类型 + 智能相簿 + 最近打开，底部为全局设置。
 *
 * 组织原则：
 * 1. 全栏只有「视图行」（去往整页视图，右端是箭头）与「筛选行」（留下并改变列表，
 *    右端是计数）两类行；相簿与最近打开沿用同一套行走法，只调密度不做新控件。
 * 2. 计数右对齐成等宽数字列，代替此前每行一颗的胶囊——胶囊是容器，数字才是信息。
 * 3. 分隔线只出现在「内容类型改变」处（视图→分类→媒体类型→我的内容），
 *    不再每段一条，避免把导航读成一串互不相干的清单。
 * 4. 彩色与体量只留给当前选中行，其余一律退到文字层级里。
 * 5. 底部收成一条全局工具带：外观、快捷键参考、清空列表都不作用于
 *    当前视图，同一行排开，不与导航争夺纵向空间。
 */
const Sidebar: React.FC<SidebarProps> = ({
  counts,
  activeCategory,
  mediaFilter,
  onSelectNav,
  albums,
  albumCounts,
  activeAlbumId,
  onSelectAlbum,
  onDeleteAlbum,
  onRequestSaveAlbum,
  recentDirectories,
  onSelectRecentFolder,
  onSelectTimeline,
  isTimelineActive,
  onCheckDuplicates,
  onRequestReset,
  hasPhotos,
  onOpenShortcuts,
  isOpen,
  themeMode,
  onThemeModeChange,
}) => {
  /** 最近打开：最多 3 条。它只是回访入口，再多就把分类挤出首屏 */
  const recentList = recentDirectories.slice(0, 3);

  type NavItem = {
    id: string;
    label: string;
    category: string;
    filter: MediaFilter;
    count: number;
    icon: React.ReactNode;
  };

  // 「图库」：分类入口（所有照片 / 图片 / 收藏夹 / 已隐藏）
  const libraryItems: NavItem[] = [
    { id: 'all', label: '所有照片', category: 'all', filter: 'all', count: counts.all, icon: <PhotosIcon /> },
    { id: 'images', label: '图片', category: 'all', filter: 'image', count: counts.images, icon: <PhotoIcon /> },
    { id: 'favorites', label: '收藏夹', category: 'favorites', filter: 'all', count: counts.favorites, icon: <HeartIcon filled={activeCategory === 'favorites' && mediaFilter === 'all'} /> },
    { id: 'hidden', label: '已隐藏', category: 'hidden', filter: 'all', count: counts.hidden, icon: <HiddenIcon /> },
  ];

  // 「媒体类型」：仿 macOS 照片的智能分类，与「图库」共用同一套选中语义
  const mediaTypeItems: NavItem[] = [
    { id: 'videos', label: '视频', category: 'all', filter: 'video', count: counts.videos, icon: <VideoIcon /> },
    { id: 'selfies', label: '自拍', category: 'all', filter: 'selfie', count: counts.selfies, icon: <SelfieIcon /> },
    { id: 'livePhotos', label: '实况照片', category: 'all', filter: 'live', count: counts.livePhotos, icon: <LivePhotoIcon /> },
    { id: 'screenshots', label: '截屏', category: 'all', filter: 'screenshot', count: counts.screenshots, icon: <ScreenshotIcon /> },
  ];

  return (
    <aside className={`${isOpen ? 'w-[220px]' : 'w-0 border-0'} bg-[var(--bg-secondary)] backdrop-blur-xl border-r border-[var(--border-subtle)] h-full select-none transition-[width] duration-300 ease-entrance overflow-hidden`}>
      {/* 抽屉式收展：外层只动宽度，内容整体滑出，避免被挤扁 */}
      <div className={`h-full flex flex-col transition-[opacity,transform] duration-200 ease-entrance ${isOpen ? 'opacity-100 translate-x-0 delay-75' : 'opacity-0 -translate-x-3'}`}>
      {/* 顶部：原生标题栏隐藏后，左侧 78px 留给红绿灯按钮，右侧作为品牌区，整条同时承担窗口拖动。
          品牌与红绿灯同高同中线（40px 带内垂直居中），原本纯空白的一条因此有了身份信息。

          这一条刻意与右邻的 Toolbar 用同一套高度、材质、底线与投影：
          两者本是同一条顶带被侧栏的分隔线切开，若材质或高度差一档，
          左上角就会露出一个台阶，整页的「齐」感就是从那里开始崩的。 */}
      <div className="app-drag h-10 shrink-0 flex items-center gap-2 pl-[78px] pr-3 bg-[var(--bg-elevated)] backdrop-blur-xl border-b border-[var(--border-subtle)]">
        <span className="shrink-0 flex items-center justify-center w-6 h-6 rounded-[7px] bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-deep))] text-[var(--accent-contrast)] shadow-[0_2px_8px_-3px_rgba(var(--accent-blue-rgb),0.8)]">
          <ApertureIcon />
        </span>
        <span className="flex flex-col items-start justify-center leading-tight min-w-0">
          <span className="text-[13px] font-semibold text-[var(--text-primary)] truncate">时光画框</span>
          <span className="text-[10px] text-[var(--text-quaternary)] truncate">按时间线自动归档</span>
        </span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-3 custom-scrollbar">

        {/* 视图：两个「换一种方式看照片」的整页入口。它们不筛选当前列表，
            因此右端是箭头而不是计数——一眼就能和下面的分类区分开 */}
        <div>
          <SectionLabel>视图</SectionLabel>
          <div className="space-y-[3px]">
            <NavRow
              icon={<TimelineIcon />}
              label="时光画廊"
              onClick={onSelectTimeline}
              active={isTimelineActive}
              chevron
              title="按时间线沉浸式回顾全部记忆"
            />
            <NavRow
              icon={<DuplicateIcon />}
              label="相似照片"
              onClick={onCheckDuplicates}
              disabled={!hasPhotos}
              chevron
              title={hasPhotos ? '找出相似照片，逐组比对后清理' : '导入照片后可用'}
            />
          </div>
        </div>

        <div className="mt-3 pt-3 border-t border-[var(--border-subtle)]">
          <SectionLabel>图库</SectionLabel>
          <ul className="space-y-[3px]">
            {libraryItems.map(item => (
              <li key={item.id}>
                <NavRow
                  icon={item.icon}
                  label={item.label}
                  count={item.count}
                  active={activeCategory === item.category && mediaFilter === item.filter}
                  onClick={() => onSelectNav(item.category, item.filter)}
                />
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-3 pt-3 border-t border-[var(--border-subtle)]">
          <SectionLabel>媒体类型</SectionLabel>
          <ul className="space-y-[3px]">
            {mediaTypeItems.map(item => (
              <li key={item.id}>
                <NavRow
                  icon={item.icon}
                  label={item.label}
                  count={item.count}
                  active={activeCategory === item.category && mediaFilter === item.filter}
                  onClick={() => onSelectNav(item.category, item.filter)}
                />
              </li>
            ))}
          </ul>
        </div>

        {/* 智能相簿：从这里开始是「你的内容」，不再是系统分类，
            所以分隔线继续保留，但内部不再切段 */}
        <div className="mt-3 pt-3 border-t border-[var(--border-subtle)]">
          <SectionLabel
            action={
              <button
                type="button"
                onClick={onRequestSaveAlbum}
                title="把当前筛选条件存为相簿"
                aria-label="新建智能相簿"
                className="flex items-center justify-center w-6 h-6 -mr-1 rounded-md text-[var(--text-quaternary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] transition-colors duration-150"
              >
                <PlusIcon />
              </button>
            }
          >
            智能相簿
          </SectionLabel>

          {/* 空态不是说明文字，而是一条可直接点的幽灵行：把「读提示 → 找 + → 再点」
              压成一步。没有筛选条件时弹窗自己会拦截（见 SaveAlbumModal 的 canSave），
              所以这里不必提前判断 */}
          {albums.length === 0 ? (
            <button
              type="button"
              onClick={onRequestSaveAlbum}
              title="把当前筛选条件存为相簿，之后一键回到同样的筛选"
              className="group/empty mt-0.5 w-full flex items-center gap-2.5 h-8 px-2.5 rounded-[10px] border border-dashed border-[var(--border-default)] text-[12.5px] text-[var(--text-quaternary)] hover:border-[var(--border-hover)] hover:text-[var(--text-tertiary)] hover:bg-[var(--bg-glass-hover)] transition-colors duration-150"
            >
              <span className="shrink-0 flex items-center justify-center w-[18px] transition-colors duration-150 group-hover/empty:text-[var(--accent-cyan)]">
                <PlusIcon />
              </span>
              <span className="truncate">把当前筛选存为相簿</span>
            </button>
          ) : (
            <ul className="space-y-[2px]">
              {albums.map(album => {
                const active = activeAlbumId === album.id;
                const count = albumCounts[album.id] ?? 0;
                return (
                  <li key={album.id} className="group/album relative">
                    <button
                      type="button"
                      onClick={() => onSelectAlbum(album)}
                      aria-current={active ? 'page' : undefined}
                      title={album.name}
                      className={`${ROW_BASE} h-8 gap-2.5 px-2.5 pr-8 text-[12.5px] ${ROW_STATE(active)}`}
                    >
                      <span className={ROW_ICON(active)}>
                        <AlbumIcon />
                      </span>
                      <span className="truncate">{album.name}</span>
                      <span
                        className={`ml-auto shrink-0 font-numeric text-[11px] tabular-nums transition-opacity duration-150 group-hover/album:opacity-0 ${
                          active ? 'text-[var(--accent-contrast)] opacity-75' : 'text-[var(--text-tertiary)]'
                        }`}
                      >
                        {count}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteAlbum(album.id)}
                      title={`删除相簿「${album.name}」`}
                      aria-label={`删除相簿 ${album.name}`}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-6 h-6 rounded-md opacity-0 group-hover/album:opacity-100 focus-visible:opacity-100 text-[var(--accent-pink)] hover:bg-[rgba(var(--accent-pink-rgb),0.14)] transition-opacity duration-150"
                    >
                      <TrashIcon />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* 最近打开：与「智能相簿」同属「你的内容」，只靠间距分层，不再补一条分隔线 */}
        {recentList.length > 0 && (
          <div className="mt-4">
            <SectionLabel>最近打开</SectionLabel>
            <ul className="space-y-[2px]">
              {recentList.map(dir => (
                <li key={dir}>
                  <button
                    type="button"
                    onClick={() => onSelectRecentFolder(dir)}
                    title={dir}
                    className={`${ROW_BASE} h-7 gap-2 px-2.5 text-left text-[12px] text-[var(--text-tertiary)] hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] active:bg-[var(--bg-glass-active)]`}
                  >
                    <span className="shrink-0 text-[var(--text-quaternary)]">
                      <HistoryIcon />
                    </span>
                    <span className="truncate">{dir.split(/[\\/]/).filter(Boolean).pop() ?? dir}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </nav>

      {/* 底部：一条全局工具带。外观 / 快捷键参考 / 清空列表都不作用于当前视图，
          收进同一行后底栏高度减半，导航区多出两行呼吸空间。
          低频偏好不再用带文字的大分段（每段 ~52px 必然截断），收成仅图标的三态分段；
          语义全部交给 title / aria。 */}
      <div className="px-3 py-2 border-t border-[var(--border-subtle)] bg-[var(--bg-glass)] backdrop-blur-xs">
        <div className="flex items-center gap-1">
          {/* 外观：三态分段。「跟随系统」实时响应 OS 深浅色，明亮 / 暗黑为显式覆盖。
              图标是这三态的通用词汇（显示器 / 太阳 / 月亮），全称悬停可读。
              选中态与顶带共用同一套「软激活」：实心琥珀只留给当前导航项 ——
              「我现在在看哪一类照片」才是这一栏里唯一值得抢眼的信息。 */}
          <div
            role="radiogroup"
            aria-label="外观模式"
            className="flex items-center gap-0.5 p-0.5 rounded-[10px] bg-[var(--bg-input)] border border-[var(--border-subtle)]"
          >
            {([
              { id: 'system', fullLabel: '跟随系统', icon: <MonitorIcon /> },
              { id: 'light', fullLabel: '明亮', icon: <SunIcon /> },
              { id: 'dark', fullLabel: '暗黑', icon: <MoonIcon /> },
            ] as const).map((option) => {
              const active = themeMode === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={`外观：${option.fullLabel}`}
                  title={
                    active
                      ? `当前为${option.fullLabel}模式`
                      : option.id === 'system'
                        ? '跟随系统深色 / 浅色偏好'
                        : `切换到${option.fullLabel}模式`
                  }
                  onClick={() => { if (!active) onThemeModeChange(option.id); }}
                  className={`flex items-center justify-center w-[30px] h-7 rounded-lg border border-transparent transition-colors duration-150 ${
                    active
                      ? 'border-[rgba(var(--accent-blue-rgb),0.32)] bg-[rgba(var(--accent-blue-rgb),0.15)] text-[var(--accent-blue)]'
                      : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] active:bg-[var(--bg-glass-active)]'
                  }`}
                >
                  {option.icon}
                </button>
              );
            })}
          </div>

          {/* 快捷键参考：同属「除了整理照片之外的事」，退到工具带右端 */}
          <button
            type="button"
            onClick={onOpenShortcuts}
            title="键盘快捷键（? 也可唤出）"
            aria-label="键盘快捷键"
            className="ml-auto shrink-0 flex items-center justify-center w-8 h-8 rounded-[10px] text-[var(--text-quaternary)] hover:text-[var(--accent-cyan)] hover:bg-[var(--bg-glass-hover)] active:bg-[var(--bg-glass-active)] transition-colors duration-150"
          >
            <KeyboardIcon />
          </button>

          {/* 清空照片列表：低频破坏性操作，收成工具带最右的一颗图标——
              位置比体量更次要，悬停才亮出危险色；点击仍有二次确认兜底。
              名字直说它做什么：清空的是列表，磁盘文件不动，所以不叫「重置」 */}
          <button
            type="button"
            onClick={onRequestReset}
            disabled={!hasPhotos}
            title={hasPhotos ? '清空列表中的全部照片并重置筛选与缓存；磁盘上的原文件不会被删除' : '列表为空'}
            aria-label="清空照片列表"
            className={`shrink-0 flex items-center justify-center w-8 h-8 rounded-[10px] transition-colors duration-150 ${
              hasPhotos
                ? 'text-[var(--text-quaternary)] hover:text-[var(--accent-pink)] hover:bg-[rgba(var(--accent-pink-rgb),0.1)]'
                : 'text-[var(--text-quaternary)] opacity-40 cursor-not-allowed'
            }`}
          >
            <ResetIcon />
          </button>
        </div>
      </div>
      </div>
    </aside>
  );
};

// 侧栏内容随图库计数 / 相簿变化，但与「选中项、QuickLook、右键菜单」等高频状态无关。
// 用 memo 包一层：只要父级传入的回调保持稳定引用，点选照片时就不会白重渲染整栏。
export default React.memo(Sidebar);
