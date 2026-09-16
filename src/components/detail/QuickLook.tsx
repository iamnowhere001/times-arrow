import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Photo } from '@/types';
import { formatVideoDuration, isVideoPhoto, isVideoPlaybackUncertain } from '@/utils';
import VideoPlayer, { VideoPlayerHandle } from '@/components/detail/VideoPlayer';

interface QuickLookProps {
  photo: Photo;
  onClose: () => void;
  onNext: () => void;
  onPrev: () => void;
  /** 跳回第一张（幻灯片循环播放） */
  onFirst?: () => void;
  hasNext: boolean;
  hasPrev: boolean;
  /** 当前视图中的位置（1-based 展示）与总数 */
  currentIndex?: number;
  totalCount?: number;
  /** 收藏切换 */
  onToggleFavorite?: (id: string) => void;
  /**
   * 相邻条目的原图地址：提前预热解码，翻页时不再看到「从黑到亮」的过程。
   * 由调用方按当前翻页范围给出（通常只有前后各一张）。
   */
  preloadSources?: string[];
}

/** 幻灯片自动播放间隔选项（秒） */
const SLIDESHOW_INTERVAL_OPTIONS = [2, 3, 5, 8, 12] as const;
const SLIDESHOW_INTERVAL_STORAGE_KEY = 'pm:slideshow-interval';
const DEFAULT_SLIDESHOW_INTERVAL = 3;

/** 读取上次选择的间隔：与时光画廊的密度偏好同样落在 localStorage，失败静默回退默认值 */
const readSlideshowInterval = (): number => {
  try {
    const raw = window.localStorage.getItem(SLIDESHOW_INTERVAL_STORAGE_KEY);
    const parsed = raw ? Number(raw) : NaN;
    if ((SLIDESHOW_INTERVAL_OPTIONS as readonly number[]).includes(parsed)) return parsed;
  } catch {
    /* 隐私模式 / 存储被禁用时忽略 */
  }
  return DEFAULT_SLIDESHOW_INTERVAL;
};

/** 图片交叉淡入的过渡时长；与下方 CSS duration 保持一致 */
const MEDIA_CROSSFADE_MS = 500;

/** 缩放范围：1 = 适应窗口 */
const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
/** 滚轮 / 触控板捏合的缩放灵敏度 */
const WHEEL_ZOOM_SENSITIVITY = 0.0016;

const clampScale = (value: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));

/**
 * 全屏预览（QuickLook）。
 *
 * 图片与视频共用同一层外壳（顶栏 / 翻页 / 收藏 / 幻灯片），
 * 媒体本身分别交给图片查看逻辑与 `VideoPlayer`：
 * - 图片：缩略图占位 → 原图淡入、滚轮锚点缩放、拖动边界约束；
 * - 视频：自定义控制条、缓冲反馈、倍速 / 画质 / 音量 / 循环 / PiP / 全屏。
 */
const QuickLook: React.FC<QuickLookProps> = ({
  photo,
  onClose,
  onNext,
  onPrev,
  onFirst,
  hasNext,
  hasPrev,
  currentIndex,
  totalCount,
  onToggleFavorite,
  preloadSources,
}) => {
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [showControls, setShowControls] = useState(true);
  const [isSlideshow, setIsSlideshow] = useState(false);
  /** 幻灯片间隔（秒）：跨会话记忆，播放中可随时调整、立即生效 */
  const [slideshowInterval, setSlideshowInterval] = useState(readSlideshowInterval);
  const [isIntervalMenuOpen, setIsIntervalMenuOpen] = useState(false);
  // 大图加载状态：按 photo.id 记录，避免上一张的 load 事件误判当前这张（HEIC / 大图解码较慢）
  const [mediaStatus, setMediaStatus] = useState<{ id: string; state: 'ready' | 'error' } | null>(null);
  // 慢图才显示转圈：连续翻页时快速命中缓存，不应每张都闪一下加载动画
  const [showSpinner, setShowSpinner] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  const controlsTimeoutRef = useRef<number | null>(null);
  const videoControlRef = useRef<VideoPlayerHandle | null>(null);

  const isVideo = isVideoPhoto(photo);
  /** 容器可能不被内置解码器支持：给出一次性的提示（而非长期占据画面） */
  const playbackUncertain = isVideo ? isVideoPlaybackUncertain(photo.name) : false;
  const [showCodecHint, setShowCodecHint] = useState(playbackUncertain);

  const imageReady = mediaStatus?.id === photo.id && mediaStatus.state === 'ready';
  const imageFailed = mediaStatus?.id === photo.id && mediaStatus.state === 'error';
  /** 缩略图占位：先铺一层模糊小图，原图解码完成后再无缝替换 */
  const placeholderSrc = !isVideo ? photo.thumbnail || '' : '';

  // 兼容性提示只出现一次，8 秒后自动退场，不干扰观看
  useEffect(() => {
    if (!playbackUncertain) return;
    setShowCodecHint(true);
    const timer = window.setTimeout(() => setShowCodecHint(false), 8000);
    return () => window.clearTimeout(timer);
  }, [photo.id, playbackUncertain]);

  useEffect(() => {
    setScale(1);
    setRotation(0);
    setPosition({ x: 0, y: 0 });
  }, [photo.id]);

  useEffect(() => {
    if (imageReady || imageFailed) {
      setShowSpinner(false);
      return;
    }
    const timer = window.setTimeout(() => setShowSpinner(true), 160);
    return () => window.clearTimeout(timer);
  }, [imageReady, imageFailed, photo.id]);

  /* ------------------------------ 缩放 / 平移 ------------------------------ */

  /**
   * 以某个屏幕点为中心缩放：该点下方的画面内容保持不动。
   * 这是图片查看器最关键的「手感」——只做中心缩放时，放大人脸需要反复来回拖。
   */
  const zoomTo = useCallback(
    (next: number, clientX?: number, clientY?: number) => {
      const target = clampScale(next);
      const container = containerRef.current;
      if (!container || target <= 1 || scale <= 0) {
        setScale(target);
        if (target <= 1) setPosition({ x: 0, y: 0 });
        return;
      }

      const rect = container.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const px = clientX ?? cx;
      const py = clientY ?? cy;
      // 光标下的内容在「未缩放坐标系」中的位置
      const ux = (px - cx - position.x) / scale;
      const uy = (py - cy - position.y) / scale;

      setScale(target);
      setPosition({
        x: px - cx - ux * target,
        y: py - cy - uy * target,
      });
    },
    [position.x, position.y, scale]
  );

  const handleZoom = useCallback((delta: number) => zoomTo(scale + delta), [scale, zoomTo]);

  /** 双击在 1x 与 2x 之间切换（Photos.app 习惯） */
  const handleToggleZoom = useCallback(() => {
    if (scale > 1) {
      setScale(1);
      setPosition({ x: 0, y: 0 });
    } else {
      setScale(2);
    }
  }, [scale]);

  /** 把位移约束在「画面边缘不越过视口」的范围内，避免把照片拖出屏幕再也找不回来 */
  const clampPosition = useCallback(
    (pos: { x: number; y: number }, s: number, rot: number) => {
      const container = containerRef.current;
      const media = mediaRef.current;
      if (!container || !media) return pos;

      const cRect = container.getBoundingClientRect();
      const mRect = media.getBoundingClientRect();
      const current = scale || 1;
      let baseW = mRect.width / current;
      let baseH = mRect.height / current;
      // 旋转 90° / 270° 时长宽互换
      if (Math.abs(Math.round(rot / 90)) % 2 === 1) {
        const swap = baseW;
        baseW = baseH;
        baseH = swap;
      }

      const maxX = Math.max(0, (baseW * s - cRect.width) / 2);
      const maxY = Math.max(0, (baseH * s - cRect.height) / 2);
      return {
        x: Math.min(maxX, Math.max(-maxX, pos.x)),
        y: Math.min(maxY, Math.max(-maxY, pos.y)),
      };
    },
    [scale]
  );

  // 缩放 / 旋转后重新约束位置
  useEffect(() => {
    if (isVideo) return;
    setPosition(prev => clampPosition(prev, scale, rotation));
  }, [scale, rotation, isVideo, clampPosition]);

  // 滚轮 / 触控板捏合缩放：必须用非 passive 监听才能 preventDefault（否则会触发整页缩放）
  useEffect(() => {
    const el = containerRef.current;
    if (!el || isVideo) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_SENSITIVITY);
      zoomTo(scale * factor, e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [isVideo, scale, zoomTo]);

  const handleRotate = useCallback((deg: number) => {
    setRotation(prev => prev + deg);
  }, []);

  const resetView = useCallback(() => {
    setScale(1);
    setRotation(0);
    setPosition({ x: 0, y: 0 });
  }, []);

  /* ------------------------------ 相邻预加载 ------------------------------ */
  const preloadKey = (preloadSources ?? []).join('|');
  useEffect(() => {
    if (isVideo || !preloadKey) return;
    const images = preloadKey.split('|').filter(Boolean).map(src => {
      const img = new Image();
      img.decoding = 'async';
      img.src = src;
      return img;
    });
    return () => {
      // 显式断引用与取消挂载，避免为「已翻过去」的图片保留解码结果
      images.forEach(img => {
        img.onload = null;
        img.onerror = null;
        img.src = '';
      });
    };
  }, [isVideo, preloadKey]);

  const toggleFavorite = useCallback(() => {
    onToggleFavorite?.(photo.id);
  }, [onToggleFavorite, photo.id]);

  // 刚打开的一瞬间忽略点击：地图上双击光点会先打开预览，紧接着的第二次点击
  // 若不拦截，就会把刚打开（或正在入场）的预览直接关掉
  const openedAtRef = useRef(Date.now());
  const handleBackdropClick = useCallback(() => {
    if (Date.now() - openedAtRef.current < 300) return;
    onClose();
  }, [onClose]);

  /** 无法在应用内解码时，用系统播放器兜底 */
  const revealInFinder = useCallback(() => {
    if (photo.path && window.electronAPI?.showInFolder) {
      void window.electronAPI.showInFolder(photo.path);
    }
  }, [photo.path]);

  const resetViewAll = useCallback(() => {
    resetView();
    videoControlRef.current?.resetView();
  }, [resetView]);

  /* ------------------------------ 切换过渡 ------------------------------ */

  /**
   * 交叉淡入：翻页时把上一张的定格快照垫在底层，新图就绪后再一起淡出淡入。
   * 只处理「图片 ⇄ 图片」；涉及视频时由播放器接管，直接切换。
   * 快照连带读走当时的缩放 / 平移变换 —— 放大端详时翻页，旧图不会「弹回原位」。
   */
  const prevPhotoRef = useRef(photo);
  const [outgoing, setOutgoing] = useState<{ photo: Photo; transform: string } | null>(null);

  // 快照层的尺寸规则：与它当时在主层里的呈现方式保持一致（占位分支 / 自适应分支），
  // 否则过渡的瞬间会看到一次尺寸跳动
  const outgoingDims = outgoing?.photo.dimensions;
  const outgoingRatio =
    outgoingDims?.width && outgoingDims?.height ? outgoingDims.width / outgoingDims.height : 0;
  const outgoingBoxed = Boolean(outgoing?.photo.thumbnail) && outgoingRatio > 0;

  useLayoutEffect(() => {
    const prev = prevPhotoRef.current;
    if (prev.id === photo.id) return;
    prevPhotoRef.current = photo;

    if (isVideoPhoto(prev) || isVideoPhoto(photo)) {
      setOutgoing(null);
      return;
    }
    // 此时 DOM 上仍是上一张的变换（缩放重置发生在 passive effect 里，晚于这里）
    setOutgoing({ photo: prev, transform: mediaRef.current?.style.transform ?? '' });
  }, [photo]);

  useEffect(() => {
    if (!outgoing) return;
    // 新图未就绪时先垫着旧图：宁可多停一会儿，也不要在加载中途把画面抽走
    if (!imageReady && !imageFailed) {
      const guard = window.setTimeout(() => setOutgoing(null), 6000);
      return () => window.clearTimeout(guard);
    }
    const timer = window.setTimeout(() => setOutgoing(null), MEDIA_CROSSFADE_MS);
    return () => window.clearTimeout(timer);
  }, [outgoing, imageReady, imageFailed]);

  /* ------------------------------ 幻灯片 ------------------------------ */
  useEffect(() => {
    if (!isSlideshow || isVideo) return;
    const timer = window.setInterval(() => {
      if (hasNext) {
        onNext();
      } else if (onFirst) {
        onFirst();
      } else {
        setIsSlideshow(false);
      }
    }, slideshowInterval * 1000);
    return () => window.clearInterval(timer);
  }, [isSlideshow, isVideo, hasNext, onNext, onFirst, slideshowInterval]);

  // 间隔选择即记忆，下次打开预览沿用
  useEffect(() => {
    try {
      window.localStorage.setItem(SLIDESHOW_INTERVAL_STORAGE_KEY, String(slideshowInterval));
    } catch {
      /* 忽略 */
    }
  }, [slideshowInterval]);

  // 播放期间控件常显：随时能暂停 / 改间隔（并清掉播放开始前挂起的隐藏计时器）
  useEffect(() => {
    if (!isSlideshow) return;
    if (controlsTimeoutRef.current !== null) {
      window.clearTimeout(controlsTimeoutRef.current);
      controlsTimeoutRef.current = null;
    }
    setShowControls(true);
  }, [isSlideshow]);

  // 切到视频时自动退出幻灯片模式
  useEffect(() => {
    if (isVideo && isSlideshow) setIsSlideshow(false);
  }, [isVideo, isSlideshow]);

  // 间隔菜单：点到外面即收起
  const intervalMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isIntervalMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!intervalMenuRef.current?.contains(e.target as Node)) setIsIntervalMenuOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [isIntervalMenuOpen]);

  /* ------------------------------ 键盘 ------------------------------ */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // 带修饰键的组合留给系统 / 应用级快捷键：否则 ⌘F 会被当成「收藏」、
      // ⌘R 旋转图片、⌘0 重置缩放，与系统习惯直接冲突
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // 全屏时 Esc 交给浏览器退出全屏，不能让预览被一并关掉
      if (e.key === 'Escape' && document.fullscreenElement) return;

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
      }

      const videoHandle = videoControlRef.current;

      switch (e.key) {
        // 翻页：视频模式下 H 仍可上一张，L 让位给「快进」
        case 'ArrowRight':
        case 'PageDown':
          if (hasNext) onNext();
          break;
        case 'l':
          if (isVideo) videoHandle?.seekBy(10);
          else if (hasNext) onNext();
          break;
        case 'ArrowLeft':
        case 'PageUp':
          if (hasPrev) onPrev();
          break;
        case 'h':
        case 'H':
          if (hasPrev) onPrev();
          break;
        case 'j':
        case 'J':
          if (isVideo) videoHandle?.seekBy(-10);
          break;
        case 'k':
        case 'K':
          if (isVideo) videoHandle?.togglePlay();
          break;
        case 'm':
        case 'M':
          if (isVideo) videoHandle?.toggleMute();
          break;
        case 'ArrowUp':
          if (isVideo) { e.preventDefault(); videoHandle?.nudgeVolume(0.05); }
          break;
        case 'ArrowDown':
          if (isVideo) { e.preventDefault(); videoHandle?.nudgeVolume(-0.05); }
          break;
        case 'Escape':
        case 'q':
        case 'Q':
          onClose();
          break;
        case '+':
        case '=':
          if (!isVideo) handleZoom(0.25);
          break;
        case '-':
        case '_':
          if (!isVideo) handleZoom(-0.25);
          break;
        case '0':
          resetViewAll();
          break;
        case 'r':
        case 'R':
          if (!isVideo) handleRotate(e.shiftKey ? -90 : 90);
          break;
        case 'f':
        case 'F':
          toggleFavorite();
          break;
        case ' ':
          e.preventDefault();
          if (isVideo) videoHandle?.togglePlay();
          else setIsSlideshow(prev => !prev);
          break;
        default:
          break;
      }
    },
    [
      onClose,
      onNext,
      onPrev,
      hasNext,
      hasPrev,
      handleZoom,
      handleRotate,
      toggleFavorite,
      isVideo,
      resetViewAll,
    ]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  /* ------------------------------ 控制条显隐 ------------------------------ */
  const resetControlsTimeout = useCallback(() => {
    setShowControls(true);
    if (controlsTimeoutRef.current !== null) window.clearTimeout(controlsTimeoutRef.current);
    // 幻灯片播放期间顶栏常显，方便随时暂停
    if (isSlideshow) return;
    controlsTimeoutRef.current = window.setTimeout(() => {
      if (scale === 1) setShowControls(false);
    }, 3000);
  }, [isSlideshow, scale]);

  useEffect(() => {
    window.addEventListener('mousemove', resetControlsTimeout);
    resetControlsTimeout();
    return () => {
      window.removeEventListener('mousemove', resetControlsTimeout);
      if (controlsTimeoutRef.current !== null) window.clearTimeout(controlsTimeoutRef.current);
    };
  }, [resetControlsTimeout]);

  /* ------------------------------ 图片拖动 ------------------------------ */
  const handleMouseDown = (e: React.MouseEvent) => {
    if (scale > 1) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
      e.preventDefault();
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setPosition(
      clampPosition({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y }, scale, rotation)
    );
  };

  const handleMouseUp = () => setIsDragging(false);

  /* ------------------------------ 顶栏信息 ------------------------------ */
  const dims = photo.dimensions;
  /** 宽高比：用于按比例撑开占位容器（缺失时退化为不做占位） */
  const aspectRatio = dims?.width && dims?.height ? dims.width / dims.height : 0;
  const durationText = isVideo ? formatVideoDuration(photo.duration) : '';
  const chromeClass = showControls ? 'opacity-100' : 'opacity-0 pointer-events-none';

  const videoMetaText = useMemo(() => {
    if (!isVideo) return '';
    const parts = ['视频'];
    if (dims?.width && dims?.height) parts.push(`${dims.width}×${dims.height}`);
    if (durationText) parts.push(durationText);
    return parts.join(' · ');
  }, [dims?.height, dims?.width, durationText, isVideo]);

  return (
    <div
      className="fixed inset-0 z-[100] bg-[rgba(12,11,10,0.96)] backdrop-blur-xl flex flex-col animate-fadeIn overflow-hidden select-none"
      onClick={handleBackdropClick}
    >
      {/* 顶栏：文件名 / 序号 / 缩放或视频信息 */}
      <div
        className={`absolute top-6 left-0 right-0 flex justify-center z-30 transition-opacity duration-500 ${chromeClass}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="max-w-[min(72vw,560px)] bg-[rgba(30,30,40,0.85)] backdrop-blur-xl border border-[rgba(255,255,255,0.1)] px-6 py-2 rounded-full shadow-2xl flex items-center gap-4 text-sm font-medium text-[rgba(255,255,255,0.95)]">
          <span className="truncate max-w-[280px]">{photo.name}</span>
          {typeof currentIndex === 'number' && currentIndex >= 0 && typeof totalCount === 'number' && (
            <>
              <div className="w-px h-3 bg-[rgba(255,255,255,0.2)]" />
              <span className="text-[rgba(255,255,255,0.6)] font-mono text-xs whitespace-nowrap">{currentIndex + 1} / {totalCount}</span>
            </>
          )}
          {!isVideo && (
            <>
              <div className="w-px h-3 bg-[rgba(255,255,255,0.2)]" />
              <span className="text-[rgba(255,255,255,0.6)] font-mono text-xs whitespace-nowrap">{Math.round(scale * 100)}%</span>
            </>
          )}
          {isVideo && (
            <>
              <div className="w-px h-3 bg-[rgba(255,255,255,0.2)]" />
              <span className="flex items-center gap-1.5 text-[var(--accent-cyan)] text-xs whitespace-nowrap">
                <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                {videoMetaText}
              </span>
            </>
          )}
          {isSlideshow && (
            <>
              <div className="w-px h-3 bg-[rgba(255,255,255,0.2)]" />
              <span className="flex items-center gap-1.5 text-[var(--accent-cyan)] text-xs whitespace-nowrap">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent-cyan)] opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--accent-cyan)]" />
                </span>
                幻灯片播放中
                <span className="font-numeric tabular-nums text-[rgba(255,255,255,0.55)]">{slideshowInterval}s</span>
              </span>
            </>
          )}
        </div>
      </div>

      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        className={`absolute top-6 right-6 z-30 w-10 h-10 bg-[rgba(30,30,40,0.85)] backdrop-blur-xl hover:bg-[rgba(50,50,60,0.9)] rounded-full flex items-center justify-center text-[rgba(255,255,255,0.9)] transition-all duration-300 border border-[rgba(255,255,255,0.1)] hover:scale-105 active:scale-95 ${chromeClass}`}
        title="关闭（Esc）"
        aria-label="关闭预览"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </button>

      {onToggleFavorite && (
        <button
          onClick={(e) => { e.stopPropagation(); toggleFavorite(); }}
          className={`absolute top-6 right-20 z-30 w-10 h-10 backdrop-blur-xl rounded-full flex items-center justify-center transition-all duration-300 border hover:scale-105 active:scale-95 ${chromeClass} ${
            photo.isFavorite
              ? 'bg-[rgba(var(--accent-pink-rgb),0.25)] border-[rgba(var(--accent-pink-rgb),0.4)] text-[var(--accent-pink)]'
              : 'bg-[rgba(30,30,40,0.85)] border-[rgba(255,255,255,0.1)] text-[rgba(255,255,255,0.9)] hover:text-[var(--accent-pink)]'
          }`}
          title={photo.isFavorite ? '取消收藏（F）' : '收藏（F）'}
          aria-label="收藏"
        >
          <svg width="18" height="18" fill={photo.isFavorite ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
          </svg>
        </button>
      )}

      {/* 媒体区 */}
      <div
        className="flex-1 relative flex items-center justify-center w-full h-full overflow-hidden"
        ref={containerRef}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {isVideo ? (
          <VideoPlayer photo={photo} controlRef={videoControlRef} onRevealInFinder={revealInFinder} />
        ) : (
          <>
            {/* 交叉淡入：上一张的定格快照垫底；新图就绪时两层一起换位。
                尺寸规则与被替换的主图完全一致，否则过渡瞬间会看到一次缩放跳动 */}
            {outgoing && (
              <div
                aria-hidden
                className={`absolute inset-0 z-0 flex items-center justify-center pointer-events-none transition-opacity duration-500 ${
                  imageReady || imageFailed ? 'opacity-0' : 'opacity-100'
                }`}
                style={outgoing.transform ? { transform: outgoing.transform } : undefined}
              >
                {outgoingBoxed ? (
                  <div
                    className="relative"
                    style={{
                      aspectRatio: String(outgoingRatio),
                      width: `min(90vw, calc(85vh * ${outgoingRatio}))`,
                    }}
                  >
                    <img
                      src={outgoing.photo.url}
                      alt=""
                      draggable={false}
                      className="absolute inset-0 w-full h-full object-contain shadow-2xl rounded-lg border border-[rgba(255,255,255,0.1)]"
                    />
                  </div>
                ) : (
                  <img
                    src={outgoing.photo.url}
                    alt=""
                    draggable={false}
                    className="max-w-[90vw] max-h-[85vh] object-contain shadow-2xl rounded-lg border border-[rgba(255,255,255,0.1)]"
                  />
                )}
              </div>
            )}
            {/* 大图解码期间给出明确反馈，避免整屏黑屏像是卡死 */}
            {showSpinner && !imageFailed && (
              <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                <div className="w-12 h-12 rounded-full border-2 border-[rgba(255,255,255,0.18)] border-t-[rgba(255,255,255,0.9)] animate-spin" />
              </div>
            )}
            {imageFailed && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 px-8 text-center pointer-events-none">
                <svg className="w-10 h-10 text-[rgba(255,255,255,0.4)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <p className="text-sm font-medium text-[rgba(255,255,255,0.85)]">无法显示这张图片</p>
                <p className="text-xs text-[rgba(255,255,255,0.5)] truncate max-w-full">{photo.name}</p>
              </div>
            )}

            <div
              ref={mediaRef}
              className={`grid place-items-center transition-transform will-change-transform ${isDragging ? 'duration-0 ease-linear' : 'duration-500 ease-[cubic-bezier(0.19,1,0.22,1)]'}`}
              style={{
                transform: `translate(${position.x}px, ${position.y}px) rotate(${rotation}deg) scale(${scale})`,
                cursor: scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default',
              }}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                e.stopPropagation();
                handleToggleZoom();
              }}
              onMouseDown={handleMouseDown}
            >
              {/* 缩略图占位（模糊）：原图就绪前提供画面，避免纯黑等待。
                  容器按照片宽高比显式撑开，缩略图不会被当成布局基准导致原图变小。 */}
              {placeholderSrc && aspectRatio > 0 ? (
                <div
                  className="relative"
                  style={{
                    aspectRatio: String(aspectRatio),
                    width: `min(90vw, calc(85vh * ${aspectRatio}))`,
                  }}
                >
                  <img
                    src={placeholderSrc}
                    alt=""
                    aria-hidden
                    draggable={false}
                    className={`absolute inset-0 w-full h-full object-contain rounded-lg blur-xl transition-opacity duration-500 ${imageReady || outgoing ? 'opacity-0' : 'opacity-80'}`}
                  />
                  <img
                    src={photo.url}
                    alt={photo.name}
                    draggable={false}
                    decoding="async"
                    onLoad={() => setMediaStatus({ id: photo.id, state: 'ready' })}
                    onError={() => setMediaStatus({ id: photo.id, state: 'error' })}
                    className={`absolute inset-0 w-full h-full object-contain shadow-2xl rounded-lg border border-[rgba(255,255,255,0.1)] transition-opacity duration-300 ${
                      imageFailed ? 'opacity-0' : imageReady ? 'opacity-100' : 'opacity-0'
                    }`}
                  />
                </div>
              ) : (
                <img
                  src={photo.url}
                  alt={photo.name}
                  draggable={false}
                  decoding="async"
                  onLoad={() => setMediaStatus({ id: photo.id, state: 'ready' })}
                  onError={() => setMediaStatus({ id: photo.id, state: 'error' })}
                  className={`max-w-[90vw] max-h-[85vh] object-contain shadow-2xl rounded-lg border border-[rgba(255,255,255,0.1)] transition-opacity duration-300 ${
                    imageFailed ? 'opacity-0' : imageReady ? 'opacity-100' : 'opacity-0'
                  }`}
                />
              )}
            </div>
          </>
        )}

        {hasPrev && (
          <div
            className={`absolute left-0 z-20 group cursor-pointer transition-opacity duration-300 ${chromeClass} ${
              isVideo ? 'top-1/2 -translate-y-1/2 -mt-3 p-3 pl-4' : 'inset-y-0 w-24 flex items-center justify-start pl-4 hover:bg-gradient-to-r hover:from-[rgba(0,0,0,0.4)] hover:to-transparent'
            }`}
            onClick={(e) => { e.stopPropagation(); onPrev(); }}
          >
            <button className="w-12 h-12 bg-[rgba(30,30,40,0.85)] backdrop-blur-xl border border-[rgba(255,255,255,0.1)] rounded-full flex items-center justify-center text-[rgba(255,255,255,0.9)] opacity-40 group-hover:opacity-100 group-hover:border-[rgba(var(--accent-blue-rgb),0.5)] transform -translate-x-2 group-hover:translate-x-0 transition-all duration-300 shadow-lg" title="上一张（←）" aria-label="上一张">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
          </div>
        )}

        {hasNext && (
          <div
            className={`absolute right-0 z-20 group cursor-pointer transition-opacity duration-300 ${chromeClass} ${
              isVideo ? 'top-1/2 -translate-y-1/2 -mt-3 p-3 pr-4' : 'inset-y-0 w-24 flex items-center justify-end pr-4 hover:bg-gradient-to-l hover:from-[rgba(0,0,0,0.4)] hover:to-transparent'
            }`}
            onClick={(e) => { e.stopPropagation(); onNext(); }}
          >
            <button className="w-12 h-12 bg-[rgba(30,30,40,0.85)] backdrop-blur-xl border border-[rgba(255,255,255,0.1)] rounded-full flex items-center justify-center text-[rgba(255,255,255,0.9)] opacity-40 group-hover:opacity-100 group-hover:border-[rgba(var(--accent-blue-rgb),0.5)] transform translate-x-2 group-hover:translate-x-0 transition-all duration-300 shadow-lg" title="下一张（→）" aria-label="下一张">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6" /></svg>
            </button>
          </div>
        )}
      </div>

      {/* 视频自带的控制条已足够完整，这里只在图片模式下给底部工具栏 */}
      {!isVideo && (
        <div
          className={`absolute bottom-8 left-0 right-0 flex justify-center z-30 pointer-events-none transition-all duration-500 transform ${showControls ? 'translate-y-0 opacity-100' : 'translate-y-8 opacity-0'}`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="bg-[rgba(30,30,40,0.85)] backdrop-blur-xl border border-[rgba(255,255,255,0.1)] rounded-2xl px-2 py-2 flex items-center gap-1 shadow-2xl pointer-events-auto">
            {onToggleFavorite && (
              <>
                <button
                  onClick={toggleFavorite}
                  className={`w-10 h-10 flex items-center justify-center rounded-xl transition-all active:scale-90 ${
                    photo.isFavorite
                      ? 'text-[var(--accent-pink)] hover:bg-[rgba(var(--accent-pink-rgb),0.15)]'
                      : 'text-[rgba(255,255,255,0.8)] hover:text-[var(--accent-pink)] hover:bg-[rgba(var(--accent-pink-rgb),0.12)]'
                  }`}
                  title={photo.isFavorite ? '取消收藏（F）' : '收藏（F）'}
                >
                  <svg width="20" height="20" fill={photo.isFavorite ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" /></svg>
                </button>
                <div className="w-px h-5 bg-[rgba(255,255,255,0.2)] mx-1" />
              </>
            )}

            <div className="flex items-center">
              <button onClick={() => handleZoom(-0.25)} className="w-10 h-10 flex items-center justify-center text-[rgba(255,255,255,0.8)] hover:text-white hover:bg-[rgba(255,255,255,0.1)] rounded-xl transition-all active:scale-90" title="缩小（-）">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="8" y1="11" x2="14" y2="11" /></svg>
              </button>
              <button onClick={() => zoomTo(1)} className="px-2 h-10 flex items-center justify-center text-xs font-semibold tabular-nums text-[rgba(255,255,255,0.8)] hover:text-white hover:bg-[rgba(255,255,255,0.1)] rounded-xl transition-all active:scale-90" title="适应窗口（0）">
                {Math.round(scale * 100)}%
              </button>
              <button onClick={() => handleZoom(0.25)} className="w-10 h-10 flex items-center justify-center text-[rgba(255,255,255,0.8)] hover:text-white hover:bg-[rgba(255,255,255,0.1)] rounded-xl transition-all active:scale-90" title="放大（+）">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" /></svg>
              </button>
            </div>

            <div className="w-px h-5 bg-[rgba(255,255,255,0.2)] mx-1" />

            <div className="flex items-center">
              <button onClick={() => handleRotate(-90)} className="w-10 h-10 flex items-center justify-center text-[rgba(255,255,255,0.8)] hover:text-white hover:bg-[rgba(255,255,255,0.1)] rounded-xl transition-all active:scale-90" title="向左旋转（⇧R）">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
              </button>
              <button onClick={() => handleRotate(90)} className="w-10 h-10 flex items-center justify-center text-[rgba(255,255,255,0.8)] hover:text-white hover:bg-[rgba(255,255,255,0.1)] rounded-xl transition-all active:scale-90" title="向右旋转（R）">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /></svg>
              </button>
            </div>

            <div className="w-px h-5 bg-[rgba(255,255,255,0.2)] mx-1" />

            <button
              onClick={() => setIsSlideshow(prev => !prev)}
              className={`w-10 h-10 flex items-center justify-center rounded-xl transition-all active:scale-90 ${
                isSlideshow
                  ? 'text-[var(--accent-cyan)] bg-[rgba(var(--accent-cyan-rgb),0.15)]'
                  : 'text-[rgba(255,255,255,0.8)] hover:text-white hover:bg-[rgba(255,255,255,0.1)]'
              }`}
              title={isSlideshow ? '暂停幻灯片（空格）' : '幻灯片播放（空格）'}
            >
              {isSlideshow ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
              )}
            </button>

            {/* 间隔：播放前后都能调，选中即记忆（顶栏会同步显示当前秒数） */}
            <div className="relative" ref={intervalMenuRef}>
              <button
                onClick={() => setIsIntervalMenuOpen(prev => !prev)}
                className={`h-10 min-w-[44px] px-2 flex items-center justify-center rounded-xl font-numeric text-xs font-semibold tabular-nums transition-all active:scale-90 ${
                  isIntervalMenuOpen
                    ? 'text-white bg-[rgba(255,255,255,0.14)]'
                    : 'text-[rgba(255,255,255,0.8)] hover:text-white hover:bg-[rgba(255,255,255,0.1)]'
                }`}
                title="幻灯片间隔"
                aria-haspopup="menu"
                aria-expanded={isIntervalMenuOpen}
                aria-label={`幻灯片间隔，当前 ${slideshowInterval} 秒`}
              >
                {slideshowInterval}s
              </button>
              {isIntervalMenuOpen && (
                <div
                  role="menu"
                  aria-label="幻灯片间隔"
                  className="absolute bottom-12 left-1/2 -translate-x-1/2 w-[132px] p-1 rounded-2xl bg-[rgba(30,30,40,0.95)] backdrop-blur-xl border border-[rgba(255,255,255,0.12)] shadow-2xl animate-scaleIn"
                >
                  {SLIDESHOW_INTERVAL_OPTIONS.map(seconds => {
                    const active = slideshowInterval === seconds;
                    return (
                      <button
                        key={seconds}
                        role="menuitemradio"
                        aria-checked={active}
                        onClick={() => {
                          setSlideshowInterval(seconds);
                          setIsIntervalMenuOpen(false);
                        }}
                        className={`w-full flex items-center justify-between h-8 px-3 rounded-xl text-xs transition-colors ${
                          active
                            ? 'text-[var(--accent-cyan)] bg-[rgba(var(--accent-cyan-rgb),0.14)]'
                            : 'text-[rgba(255,255,255,0.78)] hover:text-white hover:bg-[rgba(255,255,255,0.1)]'
                        }`}
                      >
                        <span className="font-numeric tabular-nums">{seconds} 秒</span>
                        {active && (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12"></polyline>
                          </svg>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="w-px h-5 bg-[rgba(255,255,255,0.2)] mx-1" />

            <button
              onClick={resetViewAll}
              className="px-4 h-10 text-xs font-semibold uppercase tracking-wider text-[rgba(255,255,255,0.8)] hover:text-white hover:bg-[rgba(255,255,255,0.1)] rounded-xl transition-all active:scale-90"
              title="重置缩放与旋转（0）"
            >
              重置
            </button>
          </div>
        </div>
      )}

      {/* 视频兼容性提示：容器可能不被内置解码器支持时提前给出预期管理 */}
      {isVideo && showCodecHint && (
        <div className="absolute bottom-32 left-0 right-0 flex justify-center z-20 pointer-events-none px-4">
          <span className="max-w-[min(80vw,520px)] px-3 py-1.5 rounded-full text-[11px] text-center font-medium text-[rgba(255,255,255,0.82)] bg-[rgba(30,30,40,0.85)] backdrop-blur-xl border border-[rgba(255,255,255,0.12)] animate-fadeInUp">
            该容器格式可能无法在应用内播放，若没有画面可用「在访达中打开」
          </span>
        </div>
      )}
    </div>
  );
};

export default QuickLook;
