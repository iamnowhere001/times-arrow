
import React from 'react';
import { MediaFilter, SmartAlbum } from '../types';

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

const PlusIcon = () => (
  <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.2" strokeLinecap="round">
    <path d="M12 5v14M5 12h14"></path>
  </svg>
);

/** 最近打开：带指针的时钟 */
const HistoryIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
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
 * 左栏：图库导航 + 媒体类型 + 最近打开 + 底部规模与外观设置。
 * 「图库」承载分类入口，「媒体类型」承载仿 macOS 照片的智能分类
 * （视频 / 自拍 / 实况照片 / 截屏），两组共用同一套选中语义与筛选状态。
 * 底部只承载「全局信息」（库规模、外观），选中态归顶部情境条，避免同一信息说两遍。
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
  isOpen,
  themeMode,
  onThemeModeChange,
}) => {
  /** 最近打开：最多展示 5 条 */
  const recentList = recentDirectories.slice(0, 5);
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

  /** 一组导航项：选中态由「分类 + 媒体类型」共同决定 */
  const renderNav = (items: NavItem[]) => (
    <ul className="space-y-1">
      {items.map(item => {
        const active = activeCategory === item.category && mediaFilter === item.filter;
        // 空分类降一级，别和真有内容的分类抢注意力
        const isZero = item.count === 0;
        return (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onSelectNav(item.category, item.filter)}
              aria-current={active ? 'page' : undefined}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-[13px] font-medium transition-all duration-200 ${
                active
                  ? 'bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-deep))] text-[var(--accent-contrast)] shadow-lg shadow-[rgba(var(--accent-blue-rgb),0.3)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-glass-hover)] active:bg-[var(--bg-glass-active)]'
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className={`shrink-0 ${
                  active
                    ? 'text-[var(--accent-contrast)]'
                    : isZero
                      ? 'text-[var(--text-quaternary)]'
                      : 'text-[var(--accent-cyan)]'
                }`}>
                  {item.icon}
                </span>
                <span className={`truncate ${isZero && !active ? 'text-[var(--text-tertiary)]' : ''}`}>{item.label}</span>
              </div>
              <span className={`shrink-0 text-[11px] font-medium rounded-full px-2 py-0.5 ${
                active
                  ? 'text-[var(--accent-contrast)] bg-[var(--accent-contrast-soft)]'
                  : isZero
                    ? 'text-[var(--text-quaternary)] bg-transparent'
                    : 'text-[var(--text-tertiary)] bg-[var(--bg-glass)]'
              }`}>
                {item.count}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <aside className={`${isOpen ? 'w-[220px]' : 'w-0 border-0'} bg-[var(--bg-secondary)] backdrop-blur-xl border-r border-[var(--border-subtle)] h-full select-none transition-[width] duration-300 ease-entrance overflow-hidden`}>
      {/* 抽屉式收展：外层只动宽度，内容整体滑出，避免被挤扁 */}
      <div className={`h-full flex flex-col transition-[opacity,transform] duration-200 ease-entrance ${isOpen ? 'opacity-100 translate-x-0 delay-75' : 'opacity-0 -translate-x-3'}`}>
      {/* 顶部拖拽区：原生标题栏隐藏后为红绿灯按钮让位，同时承担窗口拖动 */}
      <div className="app-drag h-[38px] shrink-0"></div>
      <nav className="flex-1 overflow-y-auto px-3 space-y-5 custom-scrollbar">

        <div>
          <h2 className="px-2.5 text-[11px] font-semibold text-[var(--text-quaternary)] tracking-wider mb-2.5 transition-colors">图库</h2>
          {renderNav(libraryItems)}
        </div>

        <div className="pt-4 border-t border-[var(--border-subtle)]">
          <h2 className="px-2.5 text-[11px] font-semibold text-[var(--text-quaternary)] tracking-wider mb-2.5 transition-colors">媒体类型</h2>
          {renderNav(mediaTypeItems)}
        </div>

        <div className="pt-4 border-t border-[var(--border-subtle)]">
          <div className="flex items-center justify-between px-2.5 mb-2.5">
            <h2 className="text-[11px] font-semibold text-[var(--text-quaternary)] tracking-wider transition-colors">
              智能相簿
            </h2>
            <button
              type="button"
              onClick={onRequestSaveAlbum}
              title="把当前筛选条件存为相簿"
              aria-label="新建智能相簿"
              className="flex items-center justify-center w-5 h-5 rounded-md text-[var(--text-quaternary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] transition-all duration-200"
            >
              <PlusIcon />
            </button>
          </div>

          {albums.length === 0 ? (
            <p className="px-2.5 text-[11px] leading-relaxed text-[var(--text-quaternary)]">
              设置筛选条件后，点右上角「+」即可存成相簿，内容会随图库自动更新。
            </p>
          ) : (
            <ul className="space-y-1">
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
                      className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-[13px] font-medium transition-all duration-200 ${
                        active
                          ? 'bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-deep))] text-[var(--accent-contrast)] shadow-lg shadow-[rgba(var(--accent-blue-rgb),0.3)]'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-glass-hover)] active:bg-[var(--bg-glass-active)]'
                      }`}
                    >
                      <span className="flex items-center gap-3 min-w-0">
                        <span className={`shrink-0 ${active ? 'text-[var(--accent-contrast)]' : 'text-[var(--accent-cyan)]'}`}>
                          <AlbumIcon />
                        </span>
                        <span className="truncate">{album.name}</span>
                      </span>
                      <span
                        className={`shrink-0 text-[11px] font-medium rounded-full px-2 py-0.5 transition-opacity group-hover/album:opacity-0 ${
                          active
                            ? 'text-[var(--accent-contrast)] bg-[var(--accent-contrast-soft)]'
                            : 'text-[var(--text-tertiary)] bg-[var(--bg-glass)]'
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
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-6 h-6 rounded-lg opacity-0 group-hover/album:opacity-100 text-[var(--accent-pink)] hover:bg-[rgba(var(--accent-pink-rgb),0.14)] transition-all duration-200"
                    >
                      <TrashIcon />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="pt-4 border-t border-[var(--border-subtle)]">
          {recentList.length > 0 && (
            <>
              <h2 className="px-2.5 mb-1.5 text-[11px] font-semibold text-[var(--text-quaternary)] tracking-wider transition-colors">
                最近打开
              </h2>
              <ul className="space-y-0.5">
                {recentList.map(dir => (
                  <li key={dir}>
                    <button
                      type="button"
                      onClick={() => onSelectRecentFolder(dir)}
                      title={dir}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-[12px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] active:bg-[var(--bg-glass-active)] transition-all duration-200"
                    >
                      <span className="shrink-0 text-[var(--text-quaternary)]">
                        <HistoryIcon />
                      </span>
                      <span className="truncate">{dir.split(/[\\/]/).filter(Boolean).pop() ?? dir}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </nav>

      <div className="px-3 py-3 border-t border-[var(--border-subtle)] bg-[var(--bg-glass)] backdrop-blur-sm space-y-2.5">
        {/* 外观：全局偏好，跟随左栏收展，不占用顶栏的视图控制位。
            三态分段：「跟随系统」实时响应 OS 深浅色，明亮 / 暗黑为显式覆盖。 */}
        <div className="flex items-center gap-1 p-0.5 rounded-xl bg-[var(--bg-input)] border border-[var(--border-subtle)]">
          {([
            { id: 'system', label: '跟随系统', icon: <MonitorIcon /> },
            { id: 'light', label: '明亮', icon: <SunIcon /> },
            { id: 'dark', label: '暗黑', icon: <MoonIcon /> },
          ] as const).map((option) => {
            const active = themeMode === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => { if (!active) onThemeModeChange(option.id); }}
                aria-pressed={active}
                title={
                  active
                    ? `当前为${option.label}模式`
                    : option.id === 'system'
                      ? '跟随系统深色 / 浅色偏好'
                      : `切换到${option.label}模式`
                }
                className={`flex-1 flex items-center justify-center gap-1 h-7 rounded-[10px] text-[12px] font-medium transition-all duration-200 min-w-0 ${
                  active
                    ? 'bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-deep))] text-[var(--accent-contrast)] shadow-md shadow-[rgba(var(--accent-blue-rgb),0.3)]'
                    : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] active:bg-[var(--bg-glass-active)]'
                }`}
              >
                <span className="shrink-0">{option.icon}</span>
                <span className="truncate">{option.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      </div>
    </aside>
  );
};

export default Sidebar;
