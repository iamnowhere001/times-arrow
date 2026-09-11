
import React, { useState, useMemo, useCallback, useEffect, useRef, memo } from 'react';
import { Photo, type DuplicateScope } from '@/types';
import { formatBytes, hammingDistance, photoOriginalTime, type DuplicateScanProgress } from '@/utils';
import { useThumbnailSrc } from '@/components/grid/ThumbnailImage';

const getFolderPath = (path: string): string => {
  if (!path) return '';
  const fullPath = path.substring(0, path.lastIndexOf('/'));
  if (!fullPath) return '';
  
  const segments = fullPath.split('/').filter(segment => segment);
  if (segments.length <= 2) return fullPath;
  
  return segments.slice(-2).join('/');
};

/** 紧凑时间格式，便于同组内逐行对齐比较：2024-05-02 14:30 */
const formatDateTime = (ts?: number): string => {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 把毫秒转成「1 分 20 秒」这类易读的时长 */
const formatDuration = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes} 分 ${totalSeconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
};

/**
 * 阈值对外以「相似度百分比」暴露，内部再换算成汉明距离（bit）。
 * dHash 只有 64 bit，相似度低于 80%（距离 > 12 bit）时两组照片通常只是构图相近，
 * 已经不能叫「相似照片」—— 再松下去就是碰运气，所以下限收在 80%；
 * 想「只找完全相同的」把滑块拖到 100% 即可。
 */
export const DUPLICATE_SIMILARITY_MIN = 80;
export const DUPLICATE_SIMILARITY_MAX = 100;
export const DUPLICATE_SIMILARITY_DEFAULT = 90;

/** 相似度下限 → 汉明距离上限。向下取整，保证界面「≥ N%」这句话是真的 */
export const similarityToDistance = (similarity: number): number =>
  Math.max(0, Math.floor((100 - similarity) * (64 / 100)));

/** 图片与「保留项」的相似度百分比（以 64 bit dHash 的汉明距离换算） */
const similarityVs = (photo: Photo, base: Photo): number | null => {
  if (!photo.hash || !base.hash) return null;
  const distance = hammingDistance(photo.hash, base.hash);
  if (distance === Number.MAX_SAFE_INTEGER) return null;
  return Math.max(0, Math.round((1 - distance / 64) * 100));
};

/** 卡片上的一行「标签 + 时间」 */
const TimeRow: React.FC<{ label: string; value: string; strong?: boolean }> = ({ label, value, strong }) => (
  <div className="flex items-center justify-between gap-1">
    <span className="text-[10px] text-[var(--text-quaternary)] shrink-0">{label}</span>
    <span
      className={`text-[10px] tabular-nums truncate ${
        strong ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)]'
      }`}
      title={value}
    >
      {value}
    </span>
  </div>
);

const BackIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

const RefreshIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
);

const DuplicateGlyph = () => (
  <svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </svg>
);

const ChevronIcon = ({ expanded }: { expanded: boolean }) => (
  <svg
    className={`w-3.5 h-3.5 shrink-0 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M9 5l7 7-7 7" />
  </svg>
);

interface DuplicateDetectorProps {
  /** 返回图库（本页为整页视图，非弹窗） */
  onBack: () => void;
  duplicateGroups: Photo[][];
  onDeleteDuplicates: (photosToDelete: Photo[]) => void;
  isProcessing: boolean;
  /** 检测进度（阶段 / 已用时 / 预计剩余），未开始时为 null */
  progress: DuplicateScanProgress | null;
  onQuickLook: (photo: Photo) => void;
  onRecheck: () => void;
  /** 取消进行中的检测：大库跑到一半时中断，立刻释放 CPU 与内存 */
  onCancel: () => void;
  /** 相似度阈值（百分比，80–100）：越高越严格 */
  similarity: number;
  onSimilarityChange: (value: number) => void;
  /** 比对范围：全库跨目录 / 仅同目录 */
  scope: DuplicateScope;
  onScopeChange: (scope: DuplicateScope) => void;
  /** 侧边栏是否展开：收起时顶栏左侧需为红绿灯按钮让位 */
  isLeftPaneOpen: boolean;
}

/** 检测完成后默认展开的组数：首屏直接看到内容，又不至于把页面拉得过长 */
const DEFAULT_EXPANDED_GROUPS = 10;

/**
 * 组的稳定身份：组内按时间升序，第一张即最早的原图。
 * 用照片 id 而非数组下标 —— 删除整组后，后面的组不会因下标前移而「替位继承」展开态。
 */
const groupKeyOf = (group: Photo[]): string => group[0]?.id ?? '';

/**
 * 单张重复图片卡片。
 * 抽成 memo 组件：勾选某张图时只重渲染这一张，避免大列表整体 diff。
 * 图片走磁盘缩略图（useThumbnailSrc），不再加载全尺寸原图。
 */
const DuplicatePhotoCard = memo(function DuplicatePhotoCard({
  photo,
  marked,
  similarity,
  onToggle,
  onQuickLook,
}: {
  photo: Photo;
  marked: boolean;
  /** 与组内「保留项」的相似度百分比；原图自身为 100，无法计算时为 null */
  similarity: number | null;
  onToggle: (photo: Photo) => void;
  onQuickLook: (photo: Photo) => void;
}) {
  const folderPath = getFolderPath(photo.path || '');
  // 有磁盘路径时用缩略图（不加载原图）；拖放降级等无路径场景回退到原图地址
  const thumbSrc = useThumbnailSrc(photo, 360);
  const src = thumbSrc || (photo.path ? null : photo.url);

  return (
    <div
      role="checkbox"
      aria-checked={marked}
      aria-label={`${marked ? '取消选择' : '选择删除'} ${photo.name}`}
      title={`${photo.name}${photo.dateTaken ? `\n拍摄 ${formatDateTime(photo.dateTaken)}` : ''}\n创建 ${formatDateTime(photo.dateCreated)}\n修改 ${formatDateTime(photo.lastModified)}`}
      tabIndex={0}
      onClick={() => onToggle(photo)}
      onDoubleClick={() => onQuickLook(photo)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle(photo);
        }
      }}
      className={`group relative rounded-lg overflow-hidden border-2 cursor-pointer outline-hidden transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)] ${
        marked
          ? 'border-[var(--accent-pink)]'
          : photo.isRecommended
            ? 'border-[var(--accent-green)]'
            : 'border-[var(--border-subtle)] hover:border-[var(--border-hover)]'
      }`}
    >
      <div className="relative aspect-square bg-[var(--bg-card)]">
        {src ? (
          <img
            src={src}
            alt={photo.name}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover"
          />
        ) : null}

        {/* 选择圈：与图库页同一套圆形语言；本页「标记」= 待删除，因此选中用粉色而非蓝色。
            点击由整张卡片接管（卡片本身就是 role="checkbox"），这里只做状态显示。 */}
        <span
          className={`absolute top-1.5 left-1.5 w-6 h-6 rounded-full border-2 flex items-center justify-center backdrop-blur-md transition-all duration-200 ease-entrance ${
            marked
              ? 'border-[var(--accent-pink)] bg-[var(--accent-pink)] text-[var(--accent-contrast)] shadow-lg shadow-[rgba(var(--accent-pink-rgb),0.45)] scale-100'
              : 'border-[rgba(255,255,255,0.85)] bg-[rgba(0,0,0,0.35)] text-transparent group-hover:scale-105'
          }`}
        >
          <svg
            className={`w-3.5 h-3.5 transition-transform duration-200 ease-entrance ${marked ? 'scale-100' : 'scale-50'}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 13l4 4L19 7" />
          </svg>
        </span>

        {photo.isRecommended && !marked && (
          <div className="absolute top-1.5 right-1.5 bg-[var(--accent-green)] text-[var(--accent-contrast)] text-[10px] font-medium px-1.5 py-0.5 rounded-full shadow-xs">
            原图 · 建议保留
          </div>
        )}

        {/* 100% 就是哈希完全一致：说「完全相同」比说 100% 更有信息量，
            也只有 <100% 时百分比才值得占一个角标 */}
        {!photo.isRecommended && similarity !== null && (
          <div
            className="absolute top-1.5 right-1.5 bg-[rgba(0,0,0,0.55)] text-white text-[10px] font-medium px-1.5 py-0.5 rounded-full shadow-xs backdrop-blur-xs"
            title={similarity === 100 ? '与保留项哈希完全一致' : '与「建议保留」项的感知哈希相似度'}
          >
            {similarity === 100 ? '完全相同' : `相似 ${similarity}%`}
          </div>
        )}

        {marked && (
          <div className="absolute inset-x-0 bottom-0 bg-[var(--accent-pink)] text-[var(--accent-contrast)] text-[10px] font-medium text-center py-0.5">
            移至回收站
          </div>
        )}
      </div>

      <div className="p-2 bg-[var(--bg-glass)]">
        <p className="text-xs font-medium text-[var(--text-primary)] truncate" title={photo.name}>
          {photo.name}
        </p>

        {/* 拍摄 / 创建时间才是判断「哪张是原图」的依据（与 photoOriginalTime 的优先级一致）；
            「修改时间」几乎不参与决策，收进卡片悬浮说明里，不再占一行。 */}
        <div className="mt-1 space-y-0.5">
          {photo.dateTaken ? (
            <TimeRow label="拍摄" value={formatDateTime(photo.dateTaken)} strong={photo.isRecommended} />
          ) : null}
          <TimeRow label="创建" value={formatDateTime(photo.dateCreated)} strong={photo.isRecommended} />
        </div>

        <div className="flex items-center justify-between gap-1 mt-1">
          <span className="text-[10px] text-[var(--text-tertiary)] truncate" title={photo.path || folderPath}>
            {folderPath}
          </span>
          <span className="text-[10px] text-[var(--text-tertiary)] shrink-0">{formatBytes(photo.size)}</span>
        </div>
      </div>
    </div>
  );
});

const DuplicateDetector: React.FC<DuplicateDetectorProps> = ({
  onBack,
  duplicateGroups,
  onDeleteDuplicates,
  isProcessing,
  progress,
  onQuickLook,
  onRecheck,
  onCancel,
  similarity,
  onSimilarityChange,
  scope,
  onScopeChange,
  isLeftPaneOpen,
}) => {
  /** 展开的组（以组内最早照片 id 标识，见 groupKeyOf） */
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  /** 被勾选「待删除」的照片 id，默认空，不做任何默认选择 */
  const [markedIds, setMarkedIds] = useState<Set<string>>(new Set());

  const wasProcessingRef = useRef(isProcessing);

  // 仅在「新一轮检测开始 / 结束」时重置，避免删除几张后被折叠回顶部
  useEffect(() => {
    const wasProcessing = wasProcessingRef.current;
    if (isProcessing && !wasProcessing) {
      setMarkedIds(new Set());
      setExpandedGroups(new Set());
    } else if (!isProcessing && wasProcessing) {
      const expanded = new Set<string>();
      duplicateGroups.forEach((group, i) => {
        if (i < DEFAULT_EXPANDED_GROUPS) {
          const key = groupKeyOf(group);
          if (key) expanded.add(key);
        }
      });
      setExpandedGroups(expanded);
    }
    wasProcessingRef.current = isProcessing;
  }, [isProcessing, duplicateGroups]);

  // 分组变化（例如删除后）时，清掉已不存在的选中 id
  useEffect(() => {
    setMarkedIds(prev => {
      if (prev.size === 0) return prev;
      const valid = new Set<string>();
      duplicateGroups.forEach(group => group.forEach(p => valid.add(p.id)));
      let changed = false;
      const next = new Set<string>();
      prev.forEach(id => {
        if (valid.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [duplicateGroups]);

  // 同理：删除整组后，把不再存在的展开 key 清掉，避免集合无限累积
  useEffect(() => {
    setExpandedGroups(prev => {
      if (prev.size === 0) return prev;
      const valid = new Set(duplicateGroups.map(groupKeyOf).filter(Boolean));
      let changed = false;
      const next = new Set<string>();
      prev.forEach(key => {
        if (valid.has(key)) next.add(key);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [duplicateGroups]);

  const allPhotos = useMemo(() => duplicateGroups.flatMap(g => g), [duplicateGroups]);

  const markedPhotos = useMemo(
    () => allPhotos.filter(p => markedIds.has(p.id)),
    [allPhotos, markedIds]
  );

  const markedSize = useMemo(
    () => markedPhotos.reduce((sum, p) => sum + (p.size || 0), 0),
    [markedPhotos]
  );

  /** 每组被选中的数量，用于组头统计与「整组删除」提示 */
  const groupMarkedCounts = useMemo(
    () => duplicateGroups.map(group => group.reduce((n, p) => n + (markedIds.has(p.id) ? 1 : 0), 0)),
    [duplicateGroups, markedIds]
  );

  const stats = useMemo(() => {
    const totalDuplicateCount = duplicateGroups.reduce((sum, g) => sum + g.length, 0);
    return {
      groupCount: duplicateGroups.length,
      totalDuplicateCount,
      totalDeleteCount: totalDuplicateCount - duplicateGroups.length,
    };
  }, [duplicateGroups]);

  /**
   * 「拷贝」侧统计：每组除保留项外的照片数量与体积，
   * 用于回答「清干净能腾出多少空间」这个真正让人做决定的问题。
   */
  const copyStats = useMemo(() => {
    let count = 0;
    let size = 0;
    duplicateGroups.forEach(group => {
      const original = group.find(p => p.isRecommended) || group[0];
      group.forEach(p => {
        if (p.id !== original.id) {
          count += 1;
          size += p.size || 0;
        }
      });
    });
    return { count, size };
  }, [duplicateGroups]);

  const handleToggleGroup = useCallback((key: string) => {
    if (!key) return;
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleExpandAll = useCallback(() => {
    setExpandedGroups(prev => {
      const keys = duplicateGroups.map(groupKeyOf).filter(Boolean);
      const allOpen = keys.length > 0 && keys.every(key => prev.has(key));
      return allOpen ? new Set() : new Set(keys);
    });
  }, [duplicateGroups]);

  const handleTogglePhoto = useCallback((photo: Photo) => {
    setMarkedIds(prev => {
      const next = new Set(prev);
      if (next.has(photo.id)) next.delete(photo.id);
      else next.add(photo.id);
      return next;
    });
  }, []);

  const handleQuickLook = useCallback((photo: Photo) => onQuickLook(photo), [onQuickLook]);

  /** 整组全选 / 取消全选 */
  const handleGroupSelectAll = useCallback((photos: Photo[], mark: boolean) => {
    setMarkedIds(prev => {
      const next = new Set(prev);
      photos.forEach(p => (mark ? next.add(p.id) : next.delete(p.id)));
      return next;
    });
  }, []);

  const handleClearSelection = useCallback(() => setMarkedIds(new Set()), []);

  /** 把「除原图外的拷贝」加入待删除集合 */
  const markCopiesOfGroup = (group: Photo[], next: Set<string>) => {
    const original = group.find(p => p.isRecommended) || group[0];
    group.forEach(p => {
      if (p.id !== original.id) next.add(p.id);
    });
  };

  /** 单组：只保留最早的原始照片，其余拷贝标记为待删除 */
  const handleKeepOriginalInGroup = useCallback((group: Photo[]) => {
    setMarkedIds(prev => {
      const next = new Set<string>(prev);
      markCopiesOfGroup(group, next);
      return next;
    });
  }, []);

  /** 批量（非默认）：每组保留最初的原图，删除重复拷贝 */
  const handleKeepAllOriginals = useCallback(() => {
    const next = new Set<string>();
    duplicateGroups.forEach(group => markCopiesOfGroup(group, next));
    setMarkedIds(next);
  }, [duplicateGroups]);

  const handleConfirmDelete = useCallback(() => {
    if (markedPhotos.length === 0) return;
    onDeleteDuplicates(markedPhotos);
  }, [markedPhotos, onDeleteDuplicates]);

  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.processed / progress.total) * 100))
      : 0;

  const allExpanded =
    duplicateGroups.length > 0 && duplicateGroups.every(group => expandedGroups.has(groupKeyOf(group)));
  const inSelectionMode = markedPhotos.length > 0;

  /**
   * 顶栏副标题负责「这一页在做什么」，具体数量交给下面的情境条，
   * 避免同一组数字在同一屏里出现两次。
   */
  const summaryLine = isProcessing
    ? progress?.phase === 'comparing'
      ? '正在比对分组…'
      : '正在为图片计算指纹并分组…'
    : '以感知哈希比对相似图片，全部在本机完成';

  return (
    <div className="flex-1 flex flex-col w-full min-h-0">
      {/* 顶栏：与图库工具栏同位同高，形成同一套外壳 */}
      <div className={`app-drag bg-[var(--bg-elevated)] backdrop-blur-xl border-b border-[var(--border-subtle)] z-20 shrink-0 py-2.5 shadow-lg shadow-[rgba(0,0,0,0.15)] ${isLeftPaneOpen ? 'px-4' : 'pl-[78px] pr-4'}`}>
        <div className="app-no-drag flex items-center justify-between h-10 gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={onBack}
              className="flex items-center gap-1 h-9 pl-2 pr-3 rounded-xl text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] active:bg-[var(--bg-glass-active)] transition-all duration-200 shrink-0"
              title="返回图库（Esc）"
            >
              <BackIcon />
              <span className="text-[13px] font-medium">图库</span>
            </button>

            <div className="w-px h-6 bg-[var(--border-default)] shrink-0" />

            <div className="w-9 h-9 rounded-xl bg-[rgba(var(--accent-purple-rgb),0.14)] border border-[rgba(var(--accent-purple-rgb),0.3)] text-[var(--accent-purple)] flex items-center justify-center shrink-0">
              <DuplicateGlyph />
            </div>

            <div className="min-w-0">
              <h1 className="text-[15px] font-semibold text-[var(--text-primary)] leading-tight truncate">
                相似图片检测
              </h1>
              <p className="text-xs text-[var(--text-tertiary)] leading-tight truncate">{summaryLine}</p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <div className="hidden xl:flex items-center gap-1.5 text-[var(--text-tertiary)] mr-1 text-xs">
              <span className="kbd">单击</span>标记
              <span className="w-px h-3 bg-[var(--border-subtle)] mx-1" />
              <span className="kbd">双击</span>预览
            </div>
            <button
              onClick={onRecheck}
              disabled={isProcessing}
              className="flex items-center gap-1.5 h-9 px-3.5 rounded-xl text-[13px] font-medium text-[var(--text-secondary)] border border-[var(--border-default)] bg-[var(--bg-glass)] hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98]"
            >
              <RefreshIcon />
              重新检测
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* 中栏：情境条 + 分组列表 */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* 情境条：无选中 = 概览；有选中 = 待删除清单与操作 */}
          <div
            className={`my-3 mx-4 shrink-0 rounded-xl border backdrop-blur-xl px-3.5 py-2 flex items-center gap-2.5 min-h-[46px] transition-all duration-300 ${
              inSelectionMode
                ? 'bg-[rgba(var(--accent-pink-rgb),0.08)] border-[rgba(var(--accent-pink-rgb),0.25)] shadow-lg shadow-[rgba(var(--accent-pink-rgb),0.1)]'
                : 'bg-[var(--bg-elevated)] border-[var(--border-subtle)]'
            }`}
          >
            {inSelectionMode ? (
              <>
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="relative flex w-2.5 h-2.5 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--accent-pink)] opacity-50" />
                    <span className="relative inline-flex rounded-full w-2.5 h-2.5 bg-[var(--accent-pink)]" />
                  </span>
                  <span className="text-sm font-semibold text-[var(--text-primary)] whitespace-nowrap">
                    待删除 {markedPhotos.length} 张
                  </span>
                  <span className="text-xs text-[var(--text-tertiary)] whitespace-nowrap tabular-nums">
                    约 {formatBytes(markedSize)}
                  </span>
                  <button
                    onClick={handleClearSelection}
                    className="ml-1 text-xs font-medium text-[var(--text-tertiary)] hover:text-[var(--text-primary)] px-2 py-1 rounded-lg hover:bg-[var(--bg-glass-hover)] transition-all duration-200"
                  >
                    ✕ 清空
                  </button>
                </div>

                <div className="flex-1" />

                <button
                  onClick={handleConfirmDelete}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] bg-[linear-gradient(135deg,var(--accent-pink),var(--accent-pink-deep))] hover:brightness-110 rounded-lg shadow-lg shadow-[rgba(var(--accent-pink-rgb),0.25)] transition-all duration-200 active:scale-[0.98]"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                  移至回收站
                </button>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2.5 min-w-0 flex-wrap">
                  {isProcessing ? (
                    <span className="text-sm font-semibold text-[var(--text-primary)] whitespace-nowrap">
                      正在检测…
                    </span>
                  ) : duplicateGroups.length === 0 ? (
                    <span className="text-sm font-semibold text-[var(--text-primary)] whitespace-nowrap">
                      没有相似项
                    </span>
                  ) : (
                    <>
                      <span className="text-sm font-semibold text-[var(--text-primary)] whitespace-nowrap tabular-nums">
                        {stats.groupCount} 组相似
                      </span>
                      {/* 明亮模式下这两颗胶囊最容易糊在浅底上，文字各提一档、底色各加深一档 */}
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-[var(--bg-glass)] border border-[var(--border-subtle)] text-[var(--text-secondary)] whitespace-nowrap tabular-nums">
                        涉及 {stats.totalDuplicateCount} 张
                      </span>
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-[rgba(var(--accent-pink-rgb),0.16)] border border-[rgba(var(--accent-pink-rgb),0.35)] text-[var(--accent-pink)] whitespace-nowrap tabular-nums">
                        可清理 {copyStats.count} 张 · 约 {formatBytes(copyStats.size)}
                      </span>
                    </>
                  )}
                </div>

                <div className="flex-1" />

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={handleExpandAll}
                    disabled={duplicateGroups.length === 0}
                    className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors px-3 py-1.5 rounded-lg hover:bg-[var(--bg-glass-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {allExpanded ? '收起全部' : '展开全部'}
                  </button>
                  {/* 这页最高频的动作：把每组拷贝都标记出来。给它全页唯一的实心按钮 */}
                  <button
                    onClick={handleKeepAllOriginals}
                    disabled={duplicateGroups.length === 0}
                    className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg text-[var(--accent-contrast)] bg-[var(--accent-green)] hover:brightness-110 shadow-lg shadow-[rgba(var(--accent-green-rgb),0.25)] transition-all duration-200 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
                    title="每组保留时间最早的原图，其余相似拷贝标记为待删除"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                    只留每组原图
                  </button>
                  {duplicateGroups.length > 0 && (
                    <div className="hidden xl:flex items-center gap-3 text-xs text-[var(--text-tertiary)] ml-2 pl-3 border-l border-[var(--border-subtle)]">
                      <span className="flex items-center gap-1">
                        <span className="w-2.5 h-2.5 rounded-xs bg-[var(--accent-green)]" />
                        原图（最早）
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="w-2.5 h-2.5 rounded-xs bg-[var(--accent-pink)]" />
                        待移至回收站
                      </span>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* 内容区 */}
          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {/* 检测中 */}
            {isProcessing && (
              <div className="h-full flex items-center justify-center p-8">
                <div className="w-full max-w-md">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-5 h-5 rounded-full border-2 border-[var(--border-subtle)] border-t-[var(--accent-purple)] animate-spin shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-[var(--text-primary)] truncate">
                        {progress?.phase === 'comparing' ? '正在比对分组…' : '正在计算图片指纹（dHash）…'}
                      </div>
                      <div className="text-xs text-[var(--text-tertiary)]">
                        图片越多耗时越长，检测期间请保持窗口打开
                      </div>
                    </div>
                  </div>

                  <div className="flex items-end justify-between mb-2">
                    <span className="text-xs text-[var(--text-secondary)] tabular-nums">
                      已处理 {progress?.processed ?? 0} / {progress?.total ?? 0} 张
                    </span>
                    <span className="text-xl font-semibold text-[var(--accent-purple)] tabular-nums leading-none">
                      {percent}%
                    </span>
                  </div>

                  <div className="h-2 rounded-full bg-[var(--bg-glass-hover)] overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[var(--accent-purple)] transition-[width] duration-200 ease-out"
                      style={{ width: `${percent}%` }}
                    />
                  </div>

                  <div className="flex items-center justify-between mt-3 text-xs text-[var(--text-tertiary)]">
                    <span className="tabular-nums">已用时 {formatDuration(progress?.elapsedMs ?? 0)}</span>
                    <span className="tabular-nums">
                      {progress?.phase === 'comparing'
                        ? '即将完成'
                        : progress && progress.processed >= progress.total
                          ? '即将完成'
                          : progress?.etaMs && progress.etaMs > 1000
                            ? `预计剩余 ${formatDuration(progress.etaMs)}`
                            : '正在估算剩余时间…'}
                    </span>
                  </div>

                  {(progress?.skipped ?? 0) > 0 && (
                    <p className="mt-4 text-xs text-[var(--text-quaternary)]">
                      已跳过 {progress?.skipped} 张体积唯一、不可能相似的图片
                    </p>
                  )}
                  {(progress?.cached ?? 0) > 0 && (
                    <p className="mt-1 text-xs text-[var(--text-quaternary)]">
                      复用上次检测的指纹 {progress?.cached} 张
                    </p>
                  )}

                  <div className="mt-5 flex justify-center">
                    <button
                      onClick={onCancel}
                      className="px-4 py-1.5 text-xs font-medium text-[var(--text-secondary)] border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] transition-all duration-200 active:scale-[0.98]"
                    >
                      取消检测
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 无重复 */}
            {!isProcessing && duplicateGroups.length === 0 && (
              <div className="h-full flex items-center justify-center p-8 text-center">
                <div className="max-w-sm">
                  <div className="w-20 h-20 mx-auto mb-5 rounded-full bg-[rgba(var(--accent-green-rgb),0.1)] flex items-center justify-center">
                    <svg className="w-10 h-10 text-[var(--accent-green)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-2">未检测到相似图片</h3>
                  <p className="text-sm text-[var(--text-secondary)] mb-6">
                    当前图库中的图片彼此都不相似。放宽检测参数中的相似度阈值，可以找出更细微的相似图片。
                  </p>
                  <button
                    onClick={onRecheck}
                    className="px-5 py-2 text-sm font-medium text-[var(--accent-contrast)] bg-[var(--accent-blue)] rounded-xl hover:opacity-90 transition-opacity"
                  >
                    重新检测
                  </button>
                </div>
              </div>
            )}

            {/* 分组结果 */}
            {!isProcessing && duplicateGroups.length > 0 && (
              <div className="px-4 pb-4 space-y-3">
                {duplicateGroups.map((group, groupIndex) => {
                  const groupKey = groupKeyOf(group);
                  const isExpanded = !!groupKey && expandedGroups.has(groupKey);
                  const groupMarked = groupMarkedCounts[groupIndex] || 0;
                  const allMarked = groupMarked === group.length;
                  // 组内已按时间升序排列，第一张即最早的原始照片
                  const original = group.find(p => p.isRecommended) || group[0];
                  // 平均相似度：各拷贝相对「保留项」的百分比均值
                  const copySims = group
                    .filter(p => p.id !== original.id)
                    .map(p => similarityVs(p, original))
                    .filter((v): v is number => v !== null);
                  const groupAvgSim = copySims.length > 0
                    ? Math.round(copySims.reduce((sum, v) => sum + v, 0) / copySims.length)
                    : null;

                  return (
                    // content-visibility：上百组常驻 DOM 时，跳过屏外组的布局与绘制，滚动更跟手
                    <div
                      key={groupKey || groupIndex}
                      className="group/row rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-glass)] overflow-hidden [content-visibility:auto] [contain-intrinsic-size:auto_46px]"
                    >
                      {/* Group header：整行可点，悬停整体染色提示可折叠 */}
                      <div className="w-full flex items-center justify-between px-3 py-2.5 gap-2 transition-colors duration-150 hover:bg-[var(--bg-glass-hover)]">
                        <button
                          onClick={() => handleToggleGroup(groupKey)}
                          aria-expanded={isExpanded}
                          aria-controls={`duplicate-group-panel-${groupIndex}`}
                          title={isExpanded ? '收起本组' : '展开本组'}
                          className="flex items-center gap-2.5 min-w-0 flex-1 text-left select-none"
                        >
                          {/* 箭头专属热区：折叠时弱化、悬停 / 展开时提亮 */}
                          <span
                            className={`w-6 h-6 shrink-0 rounded-md flex items-center justify-center transition-colors duration-150 ${
                              isExpanded
                                ? 'bg-[var(--bg-glass-active)] text-[var(--text-secondary)]'
                                : 'text-[var(--text-tertiary)] group-hover/row:bg-[var(--bg-glass-active)] group-hover/row:text-[var(--text-secondary)]'
                            }`}
                          >
                            <ChevronIcon expanded={isExpanded} />
                          </span>
                          <span className="text-sm font-medium text-[var(--text-primary)] shrink-0 tabular-nums">
                            相似组 {groupIndex + 1}
                          </span>
                          {/* 完全相同时并进同一颗胶囊，避免两个中性 chip 并排；只有 <100% 才另起一颗 */}
                          <span
                            className="text-xs text-[var(--text-tertiary)] bg-[var(--bg-glass-hover)] px-2 py-0.5 rounded-full shrink-0 tabular-nums"
                            title={groupAvgSim === 100 ? '哈希完全一致：这些是同一张图的完全副本' : undefined}
                          >
                            1 原图 · {group.length - 1} 张拷贝{groupAvgSim === 100 ? ' · 完全相同' : ''}
                          </span>
                          {groupAvgSim !== null && groupAvgSim !== 100 && (
                            <span
                              className="text-xs text-[var(--accent-cyan)] bg-[rgba(var(--accent-cyan-rgb),0.12)] px-2 py-0.5 rounded-full shrink-0 tabular-nums"
                              title="各拷贝相对保留项的平均相似度"
                            >
                              平均相似 {groupAvgSim}%
                            </span>
                          )}
                          {groupMarked > 0 && (
                            <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 tabular-nums ${
                              allMarked
                                ? 'bg-[rgba(var(--accent-pink-rgb),0.15)] text-[var(--accent-pink)]'
                                : 'bg-[rgba(var(--accent-blue-rgb),0.15)] text-[var(--accent-blue)]'
                            }`}>
                              {allMarked ? '整组移入回收站' : `已选 ${groupMarked} 张`}
                            </span>
                          )}
                          <span className="hidden md:inline text-xs text-[var(--text-tertiary)] shrink-0 truncate tabular-nums">
                            原图 {formatDateTime(photoOriginalTime(original))}
                          </span>
                        </button>
                        {/* 行内操作：折叠时只在悬停 / 键盘聚焦时浮现，展开时才补上「全选本组」，
                            避免 14 行 × 2 个文字按钮在同屏里堆成一片 */}
                        <div className={`flex items-center gap-2 shrink-0 transition-opacity duration-200 ${
                          isExpanded ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100'
                        }`}>
                          <button
                            onClick={() => handleKeepOriginalInGroup(group)}
                            className="text-xs text-[var(--accent-green)] hover:opacity-80 transition-opacity px-2 py-1 rounded-lg hover:bg-[var(--bg-glass-active)]"
                            title="保留本组最早的原图，其余拷贝标记为待删除"
                          >
                            只留最早
                          </button>
                          {isExpanded && (
                            <button
                              onClick={() => handleGroupSelectAll(group, !allMarked)}
                              className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors px-2 py-1 rounded-lg hover:bg-[var(--bg-glass-active)]"
                              title="连原图一起选中本组全部照片"
                            >
                              {allMarked ? '取消全选' : '全选本组'}
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Group content：常驻渲染，用 grid-template-rows 0fr → 1fr 做展开过渡。
                          不必测量高度，收起时也不必卸载卡片（反复卸载会让缩略图重新解码） */}
                      <div
                        id={`duplicate-group-panel-${groupIndex}`}
                        className={`grid transition-[grid-template-rows] duration-300 ease-entrance ${isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
                        aria-hidden={!isExpanded}
                      >
                        <div className="overflow-hidden min-h-0">
                          <div className="border-t border-[var(--border-subtle)] p-3">
                            {/* 自适应列宽：卡片永远不小于 150px，避免「1 原图 + 1 拷贝」的小组里
                                日期被截断 —— 而时间恰好是判断哪张是原图的关键信息 */}
                            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5">
                              {group.map((photo) => (
                                <DuplicatePhotoCard
                                  key={photo.id}
                                  photo={photo}
                                  marked={markedIds.has(photo.id)}
                                  similarity={photo.id === original.id ? 100 : similarityVs(photo, original)}
                                  onToggle={handleTogglePhoto}
                                  onQuickLook={handleQuickLook}
                                />
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* 右侧检测面板：与图库的详情面板同位，承载参数与概况 */}
        {!isProcessing && (
          <aside className="hidden lg:flex w-72 xl:w-80 shrink-0 flex-col border-l border-[var(--border-subtle)] bg-[var(--bg-elevated)] backdrop-blur-xl overflow-y-auto custom-scrollbar">
            <section className="px-4 py-4 border-b border-[var(--border-subtle)]">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-quaternary)] mb-3">
                检测参数
              </h2>

              <div className="mb-4">
                <div className="flex items-baseline justify-between mb-2">
                  <span className="text-xs font-medium text-[var(--text-secondary)]" title="以 64 位感知哈希换算；调低会把构图相近但不同的照片也算成一组">
                    相似度阈值
                  </span>
                  <span className="text-xs tabular-nums text-[var(--accent-cyan)]">≥ {similarity}%</span>
                </div>
                <input
                  type="range"
                  min={DUPLICATE_SIMILARITY_MIN}
                  max={DUPLICATE_SIMILARITY_MAX}
                  step={2}
                  value={similarity}
                  onChange={(e) => onSimilarityChange(parseInt(e.target.value, 10))}
                  className="w-full accent-[var(--accent-blue)]"
                  aria-label="相似度阈值"
                />
                {/* 百分比本身就是刻度：右端越严越准，左端越松越多 */}
                <div className="flex items-center justify-between mt-1 text-[10px] text-[var(--text-quaternary)]">
                  <span>更宽松 · 找得多</span>
                  <span>更严格 · 找得准</span>
                </div>
              </div>

              <div>
                <span className="block text-xs font-medium text-[var(--text-secondary)] mb-2">比对范围</span>
                <div className="bg-[var(--bg-input)] p-0.5 rounded-xl flex items-center border border-[var(--border-subtle)]">
                  {([
                    ['all', '全库跨目录'],
                    ['sameFolder', '仅同目录'],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      onClick={() => onScopeChange(value)}
                      className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
                        scope === value
                          ? 'bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-hover))] text-[var(--accent-contrast)] shadow-xs'
                          : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-glass)]'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-quaternary)]">
                  调整后会自动重新分组，指纹已缓存，因此重跑很快。
                </p>
              </div>
            </section>

            <section className="px-4 py-4">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-quaternary)] mb-3">
                本次检测
              </h2>
              {/* 「14 组 / 建议保留 14 / 可清理 14」是同义重复，只留真正影响决定的数字 */}
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs text-[var(--text-tertiary)]">相似组</span>
                <span className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">{stats.groupCount}</span>
              </div>
              <p className="mt-2.5 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
                涉及 <span className="font-medium tabular-nums text-[var(--text-primary)]">{stats.totalDuplicateCount}</span> 张 ·
                可清理 <span className="font-medium tabular-nums text-[var(--accent-pink)]">{copyStats.count}</span> 张 ·
                可释放 <span className="font-medium tabular-nums text-[var(--accent-cyan)]">{formatBytes(copyStats.size)}</span>
              </p>

              <p className="mt-4 text-[11px] leading-relaxed text-[var(--text-quaternary)]">
                每组以创建时间最早的一张作为原图。删除只会移入系统回收站，随时可以还原。
              </p>
            </section>

            {inSelectionMode && (
              <section className="mt-auto px-4 py-4 border-t border-[var(--border-subtle)]">
                <p className="text-xs text-[var(--text-secondary)] mb-2.5">
                  待删除 <span className="font-semibold text-[var(--accent-pink)] tabular-nums">{markedPhotos.length}</span> 张
                  <span className="text-[var(--text-tertiary)]"> · 约 {formatBytes(markedSize)}</span>
                </p>
                <button
                  onClick={handleConfirmDelete}
                  className="w-full flex items-center justify-center gap-1.5 h-9 rounded-xl text-xs font-semibold text-[var(--accent-contrast)] bg-[linear-gradient(135deg,var(--accent-pink),var(--accent-pink-deep))] hover:brightness-110 transition-all duration-200 shadow-lg shadow-[rgba(var(--accent-pink-rgb),0.25)] active:scale-[0.98]"
                >
                  移至回收站
                </button>
              </section>
            )}
          </aside>
        )}
      </div>
    </div>
  );
};

export default DuplicateDetector;
