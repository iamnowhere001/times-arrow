import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Photo } from '@/types';
import { isVideoPlaybackUncertain } from '@/utils';
import { reportVideoMetaFromElement, videoMetaKeyOf } from '@/lib/media/videoMeta';
import { BASE_THUMB_SIZE, useVideoPoster } from '@/components/grid/ThumbnailImage';

/**
 * 预览层的自定义视频播放器。
 *
 * 为什么不用原生 `controls`：
 * - 原生控件无法与「暗房」视觉统一，也不能承载倍速 / 画质 / 循环 / PiP；
 * - 原生的进度条拖拽体验受系统控制，无法显示「已缓冲区间」，大视频时用户看不出
 *   到底加载到哪了；
 * - 我们需要把「快进快退 / 音量」接进应用自己的键盘体系（见 QuickLook）。
 *
 * 因此这里自己实现一整套控制条，并补上缓冲反馈、画质（1:1 原始像素）与全屏。
 */

export interface VideoPlayerHandle {
  /** 播放 / 暂停 */
  togglePlay: () => void;
  /** 相对当前位置快进 / 快退（秒，正数前进） */
  seekBy: (seconds: number) => void;
  /** 调整音量（正负皆可，内部钳制到 0–1） */
  nudgeVolume: (delta: number) => void;
  /** 静音切换 */
  toggleMute: () => void;
  /** 全屏切换 */
  toggleFullscreen: () => void;
  /** 复位视图（回到适应窗口、清除平移） */
  resetView: () => void;
  /** 是否处于全屏（供外层键盘处理判断优先级） */
  isFullscreen: () => boolean;
}

interface VideoPlayerProps {
  photo: Photo;
  /** 无法解码时的兜底入口 */
  onRevealInFinder?: () => void;
  /** 命令式句柄：让 QuickLook 的全局键盘能驱动播放 */
  controlRef?: React.Ref<VideoPlayerHandle>;
}

/** 倍速档位 */
const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];
/** 快捷快进 / 快退秒数 */
const SEEK_STEP = 10;
/** 控制条自动隐藏延时（播放中） */
const CONTROLS_HIDE_DELAY = 2800;
/** 缓冲动画延时：短暂卡顿不闪转圈，避免本地文件 seek 时频繁闪烁 */
const BUFFERING_HIDE_DELAY = 220;
/** 单双击判定窗口 */
const CLICK_DELAY = 180;

/** 画质：适应窗口（等比缩放）/ 原始尺寸（1:1 像素，可拖动查看细节） */
type QualityMode = 'fit' | 'actual';

interface VideoPrefs {
  volume: number;
  muted: boolean;
  rate: number;
  loop: boolean;
  quality: QualityMode;
}

const PREFS_KEY = 'pm.videoPlayer.prefs';

const DEFAULT_PREFS: VideoPrefs = {
  volume: 1,
  muted: false,
  rate: 1,
  loop: false,
  quality: 'fit',
};

/** 读取上次的播放偏好（音量 / 倍速 / 循环 / 画质），失败时静默回退默认值 */
function loadPrefs(): VideoPrefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<VideoPrefs>;
    const rate = SPEED_OPTIONS.includes(parsed.rate as number) ? (parsed.rate as number) : 1;
    const volume = typeof parsed.volume === 'number' ? Math.min(1, Math.max(0, parsed.volume)) : 1;
    return {
      volume,
      muted: parsed.muted === true,
      rate,
      loop: parsed.loop === true,
      quality: parsed.quality === 'actual' ? 'actual' : 'fit',
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** 秒 → 「3:07」/「1:02:03」；用于控制条时间码（0 也要显示成 0:00） */
const formatClock = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};

/** 把媒体错误码翻译成用户能理解的原因，而不是干巴巴的「无法播放」 */
function describeMediaError(code?: number): string {
  switch (code) {
    case 1:
      return '播放被中断';
    case 2:
      return '读取文件失败，文件可能已被移动或删除';
    case 3:
      return '视频解码失败，文件可能已损坏';
    case 4:
      return '编码格式不受支持（例如 HEVC / ProRes 等）';
    default:
      return '编码格式可能不受支持';
  }
}

/** 视频表面可点击区域：单击播放/暂停，双击全屏 */
const VideoPlayer: React.FC<VideoPlayerProps> = ({ photo, onRevealInFinder, controlRef }) => {
  const prefs = useMemo(loadPrefs, []);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorReason, setErrorReason] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolume] = useState(prefs.volume);
  const [muted, setMuted] = useState(prefs.muted);
  const [rate, setRate] = useState(prefs.rate);
  const [loop, setLoop] = useState(prefs.loop);
  const [quality, setQuality] = useState<QualityMode>(prefs.quality);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [openMenu, setOpenMenu] = useState<'speed' | 'quality' | null>(null);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubRatio, setScrubRatio] = useState(0);
  const [mediaSize, setMediaSize] = useState({ width: 0, height: 0 });
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const videoRef = useRef<HTMLVideoElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<number | null>(null);
  const bufferingTimerRef = useRef<number | null>(null);
  const clickTimerRef = useRef<number | null>(null);
  const panStartRef = useRef({ pointerX: 0, pointerY: 0, originX: 0, originY: 0 });
  /** 本次指针交互是否真的发生了拖动：拖动结束时不应再触发「播放/暂停」 */
  const didPanRef = useRef(false);
  const [isPanning, setIsPanning] = useState(false);

  /** 首帧海报：视频解码完成前先用它铺底，避免黑屏闪烁。
   *  尺寸对齐网格用的基础档位，直接复用已抓过的帧，不额外触发解码。 */
  const poster = useVideoPoster(photo, BASE_THUMB_SIZE);
  const dims = photo.dimensions;
  const playbackUncertain = isVideoPlaybackUncertain(photo.name);
  /** 视频时长优先用已探测到的元数据，元数据未到时用播放器读到的值 */
  const effectiveDuration = duration || photo.duration || 0;

  /* ------------------------------ 偏好持久化 ------------------------------ */
  useEffect(() => {
    const next: VideoPrefs = { volume, muted, rate, loop, quality };
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      /* 忽略：隐私模式 / 存储不可用不影响播放 */
    }
  }, [volume, muted, rate, loop, quality]);

  /* ------------------------------ 控制条显隐 ------------------------------ */
  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setShowControls(false);
    }, CONTROLS_HIDE_DELAY);
  }, [clearHideTimer]);

  /** 鼠标 / 触摸活动：唤出控制条；播放中且无菜单打开时延时收起 */
  const revealControls = useCallback(() => {
    setShowControls(true);
    const video = videoRef.current;
    const idleAllowed = video ? !video.paused : true;
    if (idleAllowed && !openMenu && !isScrubbing) scheduleHide();
  }, [openMenu, isScrubbing, scheduleHide]);

  // 暂停 / 菜单展开 / 拖拽进度时锁定控制条，避免操作过程中控件消失
  useEffect(() => {
    if (!isPlaying || openMenu || isScrubbing) {
      clearHideTimer();
      setShowControls(true);
    } else {
      scheduleHide();
    }
  }, [isPlaying, openMenu, isScrubbing, clearHideTimer, scheduleHide]);

  useEffect(() => () => clearHideTimer(), [clearHideTimer]);

  /* ------------------------------ 缓冲反馈 ------------------------------ */
  const showBuffering = useCallback(() => {
    if (bufferingTimerRef.current !== null) window.clearTimeout(bufferingTimerRef.current);
    bufferingTimerRef.current = window.setTimeout(() => setIsBuffering(true), BUFFERING_HIDE_DELAY);
  }, []);

  const hideBuffering = useCallback(() => {
    if (bufferingTimerRef.current !== null) {
      window.clearTimeout(bufferingTimerRef.current);
      bufferingTimerRef.current = null;
    }
    setIsBuffering(false);
  }, []);

  useEffect(
    () => () => {
      if (bufferingTimerRef.current !== null) window.clearTimeout(bufferingTimerRef.current);
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    },
    []
  );

  /* ------------------------------ 播放控制 ------------------------------ */
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) {
      // 播完后再次点击：从头开始，符合大多数播放器的预期
      if (video.ended) video.currentTime = 0;
      void video.play().catch(() => {
        /* 自动播放被拦截时保持暂停，由中央按钮提示用户 */
      });
    } else {
      video.pause();
    }
  }, []);

  const seekBy = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    const total = Number.isFinite(video.duration) ? video.duration : 0;
    const next = Math.min(Math.max(0, video.currentTime + seconds), total || video.currentTime + seconds);
    video.currentTime = Math.max(0, next);
    setCurrentTime(video.currentTime);
  }, []);

  const nudgeVolume = useCallback((delta: number) => {
    const video = videoRef.current;
    if (!video) return;
    const next = Math.min(1, Math.max(0, (video.muted ? 0 : video.volume) + delta));
    video.volume = next;
    video.muted = false;
    setVolume(next);
    setMuted(false);
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }, []);

  const applyVolume = useCallback((value: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = value;
    if (value > 0 && video.muted) video.muted = false;
    setVolume(value);
    setMuted(video.muted);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void el.requestFullscreen?.().catch(() => {});
    }
  }, []);

  const togglePiP = useCallback(async () => {
    const video = videoRef.current as
      | (HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> })
      | null;
    if (!video?.requestPictureInPicture) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch {
      /* 系统不支持或用户拒绝时静默失败 */
    }
  }, []);

  /** 复位视图：回到适应窗口并清除平移（供外层「重置 / 0」调用） */
  const resetView = useCallback(() => {
    setQuality('fit');
    setPan({ x: 0, y: 0 });
  }, []);

  useImperativeHandle(
    controlRef,
    () => ({
      togglePlay,
      seekBy,
      nudgeVolume,
      toggleMute,
      toggleFullscreen,
      resetView,
      isFullscreen: () => Boolean(document.fullscreenElement),
    }),
    [togglePlay, seekBy, nudgeVolume, toggleMute, toggleFullscreen, resetView]
  );

  /* ------------------------------ 媒体事件 ------------------------------ */
  const handleLoadedMetadata = useCallback(
    (e: React.SyntheticEvent<HTMLVideoElement>) => {
      const video = e.currentTarget;
      reportVideoMetaFromElement(videoMetaKeyOf(photo), video);
      if (Number.isFinite(video.duration) && video.duration > 0) setDuration(video.duration);
      setMediaSize({ width: video.videoWidth, height: video.videoHeight });
      // 恢复上次的音量 / 倍速（在元数据就绪后写入，元素已可安全配置）
      video.volume = prefs.volume;
      video.muted = prefs.muted;
      video.playbackRate = prefs.rate;
    },
    [photo, prefs.muted, prefs.rate, prefs.volume]
  );

  const handleProgress = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = e.currentTarget;
    if (video.buffered.length > 0) {
      // 取包含当前播放位置的缓冲段末端，作为「已缓冲」进度
      const t = video.currentTime;
      let end = video.buffered.end(video.buffered.length - 1);
      for (let i = 0; i < video.buffered.length; i += 1) {
        if (t >= video.buffered.start(i) - 0.5 && t <= video.buffered.end(i) + 0.5) {
          end = video.buffered.end(i);
          break;
        }
      }
      setBufferedEnd(end);
    }
  }, []);

  const handleTimeUpdate = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
    if (!isScrubbing) setCurrentTime(e.currentTarget.currentTime);
  }, [isScrubbing]);

  const handleError = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
    hideBuffering();
    setStatus('error');
    const code = e.currentTarget.error?.code;
    setErrorReason(
      code === 4 && playbackUncertain
        ? `${describeMediaError(code)}，可尝试用系统播放器打开`
        : describeMediaError(code)
    );
  }, [hideBuffering, playbackUncertain]);

  /* ------------------------------ 全屏状态同步 ------------------------------ */
  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // 关闭预览 / 切换条目时若仍停留在全屏，必须显式退出，否则整个应用会卡在全屏态
  useEffect(
    () => () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    },
    []
  );

  /* ------------------------------ 进度拖拽 ------------------------------ */
  const ratioFromClientX = useCallback((clientX: number): number => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }, []);

  /** 拖拽过程中实时预览位置；松手时落到精确时间点 */
  const applyScrub = useCallback(
    (clientX: number, commit: boolean) => {
      const video = videoRef.current;
      const total = effectiveDuration;
      const ratio = ratioFromClientX(clientX);
      setScrubRatio(ratio);
      if (!video || total <= 0) return;
      const next = ratio * total;
      setCurrentTime(next);
      if (commit) {
        try {
          video.currentTime = next;
        } catch {
          /* 极少数容器在未就绪时会抛错，忽略即可 */
        }
      }
    },
    [effectiveDuration, ratioFromClientX]
  );

  const handleTrackPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (effectiveDuration <= 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      setIsScrubbing(true);
      setScrubRatio(ratioFromClientX(e.clientX));
      applyScrub(e.clientX, true);
    },
    [applyScrub, effectiveDuration, ratioFromClientX]
  );

  const handleTrackPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      setHoverRatio(ratioFromClientX(e.clientX));
      if (isScrubbing) applyScrub(e.clientX, true);
    },
    [applyScrub, isScrubbing, ratioFromClientX]
  );

  const handleTrackPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isScrubbing) return;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      applyScrub(e.clientX, true);
      setIsScrubbing(false);
    },
    [applyScrub, isScrubbing]
  );

  /* ------------------------------ 表面点击 / 拖动 ------------------------------ */
  const handleSurfaceClick = useCallback(() => {
    // 原始尺寸下刚拖动过画面：这次点击是拖动的收尾，不应切换播放状态
    if (didPanRef.current) {
      didPanRef.current = false;
      return;
    }
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      togglePlay();
    }, CLICK_DELAY);
  }, [togglePlay]);

  const handleSurfaceDoubleClick = useCallback(() => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    toggleFullscreen();
  }, [toggleFullscreen]);

  // 原始尺寸模式下画面可能超出视口，允许拖动查看（限制在画面范围内，避免拖飞）
  const handlePanStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (quality !== 'actual') return;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      panStartRef.current = { pointerX: e.clientX, pointerY: e.clientY, originX: pan.x, originY: pan.y };
      didPanRef.current = false;
      setIsPanning(true);
    },
    [pan.x, pan.y, quality]
  );

  const handlePanMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isPanning) return;
      const dx = e.clientX - panStartRef.current.pointerX;
      const dy = e.clientY - panStartRef.current.pointerY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didPanRef.current = true;

      const surface = surfaceRef.current;
      const maxX = surface ? Math.max(0, (mediaSize.width - surface.clientWidth) / 2) : 0;
      const maxY = surface ? Math.max(0, (mediaSize.height - surface.clientHeight) / 2) : 0;
      setPan({
        x: Math.min(maxX, Math.max(-maxX, panStartRef.current.originX + dx)),
        y: Math.min(maxY, Math.max(-maxY, panStartRef.current.originY + dy)),
      });
    },
    [isPanning, mediaSize.height, mediaSize.width]
  );

  const handlePanEnd = useCallback(() => setIsPanning(false), []);

  // 切换画质 / 条目时复位平移，避免上一段的偏移残留
  useEffect(() => setPan({ x: 0, y: 0 }), [quality, photo.id]);

  /* ------------------------------ 菜单外点击关闭 ------------------------------ */
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-video-menu]')) return;
      setOpenMenu(null);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [openMenu]);

  /* ------------------------------ 渲染 ------------------------------ */
  const progressRatio = effectiveDuration > 0
    ? (isScrubbing ? scrubRatio : currentTime / effectiveDuration)
    : 0;
  const bufferedRatio = effectiveDuration > 0 ? Math.min(1, bufferedEnd / effectiveDuration) : 0;
  const showCenterPlay = !isPlaying && status === 'ready' && hasStarted && !isBuffering;
  const actualMode = quality === 'actual' && mediaSize.width > 0;

  /**
   * 画面容器的比例。
   * 必须由「已知宽高比」显式撑开，而不能让 320px 的首帧海报去决定布局尺寸
   * ——否则海报会按自身像素占位，把视频也限制在 320px 宽。
   */
  const intrinsicAspect = mediaSize.width > 0 && mediaSize.height > 0
    ? mediaSize.width / mediaSize.height
    : dims?.width && dims?.height
      ? dims.width / dims.height
      : 0;
  /** 适应窗口模式：由固定比例容器决定画面尺寸 */
  const fixedBox = !actualMode && intrinsicAspect > 0;
  const canStackPoster = fixedBox || actualMode;

  return (
    <div
      ref={rootRef}
      className="relative w-full h-full flex items-center justify-center overflow-hidden bg-black"
      onMouseMove={revealControls}
      onMouseLeave={() => {
        if (isPlaying && !openMenu && !isScrubbing) setShowControls(false);
      }}
      // 阻断冒泡：QuickLook 外壳点击空白处会关闭预览，视频区域内不应触发
      onClick={(e) => e.stopPropagation()}
      data-video-player
    >
      {/* 画面区：单击播放/暂停，双击全屏 */}
      <div
        ref={surfaceRef}
        className={`absolute inset-0 flex items-center justify-center overflow-hidden ${
          actualMode ? (isPanning ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default'
        }`}
        onClick={handleSurfaceClick}
        onDoubleClick={handleSurfaceDoubleClick}
        onPointerDown={handlePanStart}
        onPointerMove={handlePanMove}
        onPointerUp={handlePanEnd}
        onPointerCancel={handlePanEnd}
      >
        <div
          className="relative flex items-center justify-center"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px)`,
            transition: isPanning ? 'none' : 'transform 220ms var(--ease-smooth)',
            ...(fixedBox
              ? { aspectRatio: String(intrinsicAspect), width: `min(92vw, calc(86vh * ${intrinsicAspect}))` }
              : {}),
          }}
        >
          {/* 首帧海报：解码完成前铺底，与视频做交叉淡入 */}
          {poster.src && status !== 'error' && canStackPoster && (
            <img
              src={poster.src}
              alt=""
              aria-hidden
              draggable={false}
              className={`absolute inset-0 w-full h-full object-contain transition-opacity duration-500 ${
                hasStarted ? 'opacity-0' : 'opacity-100'
              }`}
            />
          )}
          <video
            ref={videoRef}
            src={photo.url}
            autoPlay
            playsInline
            preload="auto"
            disablePictureInPicture={false}
            onLoadedMetadata={handleLoadedMetadata}
            onLoadedData={() => {
              setStatus('ready');
              setHasStarted(true);
            }}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onPlaying={() => {
              setIsPlaying(true);
              setHasStarted(true);
              hideBuffering();
            }}
            onWaiting={showBuffering}
            onStalled={showBuffering}
            onSeeking={showBuffering}
            onSeeked={hideBuffering}
            onCanPlay={hideBuffering}
            onProgress={handleProgress}
            onTimeUpdate={handleTimeUpdate}
            onEnded={() => setIsPlaying(false)}
            onError={handleError}
            onVolumeChange={(e) => {
              setVolume(e.currentTarget.volume);
              setMuted(e.currentTarget.muted);
            }}
            onRateChange={(e) => setRate(e.currentTarget.playbackRate)}
            aria-label={photo.name}
            className={`object-contain bg-black transition-opacity duration-500 ${
              // 未就绪时先藏起来，避免黑框盖住海报
              hasStarted ? 'opacity-100' : 'opacity-0'
            } ${fixedBox ? 'absolute inset-0 w-full h-full' : 'max-w-[92vw] max-h-[86vh]'}`}
            style={
              actualMode
                ? { width: mediaSize.width, height: mediaSize.height, maxWidth: 'none', maxHeight: 'none' }
                : undefined
            }
          />
        </div>
      </div>

      {/* 缓冲指示 */}
      {isBuffering && status !== 'error' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 pointer-events-none">
          <div className="w-12 h-12 rounded-full border-2 border-[rgba(255,255,255,0.18)] border-t-[var(--accent-blue)] animate-spin" />
          <span className="text-xs font-medium tracking-wide text-[rgba(255,255,255,0.7)]">缓冲中…</span>
        </div>
      )}

      {/* 中央播放按钮：自动播放被拦截或播完后提示 */}
      {showCenterPlay && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            togglePlay();
          }}
          aria-label="播放"
          className="absolute z-10 flex items-center justify-center w-20 h-20 rounded-full bg-[rgba(20,18,16,0.6)] backdrop-blur-md border border-[rgba(255,255,255,0.18)] text-[rgba(255,255,255,0.95)] shadow-2xl transition-transform duration-200 hover:scale-105 active:scale-95"
        >
          {currentTime >= effectiveDuration - 0.5 && effectiveDuration > 0 ? (
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 3-6.7" />
              <path d="M3 4v5h5" />
            </svg>
          ) : (
            <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" className="ml-1">
              <polygon points="6 4 20 12 6 20 6 4" />
            </svg>
          )}
        </button>
      )}

      {/* 解码失败：给出原因与外部播放器入口 */}
      {status === 'error' && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 px-8 text-center bg-black/70">
          <svg className="w-10 h-10 text-[rgba(255,255,255,0.4)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <p className="text-sm font-medium text-[rgba(255,255,255,0.88)]">无法播放这段视频</p>
          <p className="text-xs text-[rgba(255,255,255,0.5)] truncate max-w-full">{photo.name}</p>
          {errorReason && (
            <p className="text-xs text-[rgba(255,255,255,0.42)]">{errorReason}</p>
          )}
          {onRevealInFinder && photo.path && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRevealInFinder();
              }}
              className="mt-2 px-3.5 py-1.5 text-xs font-medium rounded-lg text-[rgba(255,255,255,0.9)] bg-[rgba(255,255,255,0.12)] border border-[rgba(255,255,255,0.22)] hover:bg-[rgba(255,255,255,0.2)] transition-all duration-200 active:scale-[0.98]"
            >
              在访达中打开
            </button>
          )}
        </div>
      )}

      {/* 控制条 */}
      {status !== 'error' && (
        <div
          className={`absolute bottom-0 left-0 right-0 z-20 px-4 pb-3 pt-10 bg-gradient-to-t from-[rgba(0,0,0,0.82)] via-[rgba(0,0,0,0.4)] to-transparent transition-opacity duration-300 ${
            showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 进度条 */}
          <div
            ref={trackRef}
            role="slider"
            tabIndex={0}
            aria-label="播放进度"
            aria-valuemin={0}
            aria-valuemax={Math.round(effectiveDuration)}
            aria-valuenow={Math.round(currentTime)}
            className="group relative h-4 flex items-center cursor-pointer touch-none"
            onPointerDown={handleTrackPointerDown}
            onPointerMove={handleTrackPointerMove}
            onPointerUp={handleTrackPointerUp}
            onPointerLeave={() => setHoverRatio(null)}
          >
            <div className="relative w-full h-1.5 rounded-full bg-[rgba(255,255,255,0.22)] overflow-hidden transition-[height] duration-150 group-hover:h-2">
              {/* 已缓冲 */}
              <div
                className="absolute inset-y-0 left-0 bg-[rgba(255,255,255,0.28)]"
                style={{ width: `${bufferedRatio * 100}%` }}
              />
              {/* 已播放 */}
              <div
                className="absolute inset-y-0 left-0 bg-[var(--accent-blue)]"
                style={{ width: `${progressRatio * 100}%` }}
              />
            </div>
            {/* 滑柄 */}
            <div
              className={`absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-white shadow-md transition-transform duration-150 ${
                isScrubbing || hoverRatio !== null ? 'scale-100' : 'scale-0'
              }`}
              style={{ left: `calc(${progressRatio * 100}% - 7px)` }}
            />
            {/* 悬停时间提示 */}
            {hoverRatio !== null && effectiveDuration > 0 && !isScrubbing && (
              <div
                className="absolute -top-8 -translate-x-1/2 px-2 py-1 rounded-md text-[11px] font-medium tabular-nums text-[rgba(255,255,255,0.95)] bg-[rgba(20,18,16,0.92)] border border-[rgba(255,255,255,0.14)] pointer-events-none whitespace-nowrap"
                style={{ left: `${hoverRatio * 100}%` }}
              >
                {formatClock(hoverRatio * effectiveDuration)}
              </div>
            )}
          </div>

          {/* 按钮区：窄窗口下允许换行，避免控件被挤出可视区 */}
          <div className="flex flex-wrap items-center gap-1 gap-y-1 mt-1.5 text-[rgba(255,255,255,0.9)]">
            <ControlButton label={isPlaying ? '暂停（空格）' : '播放（空格）'} onClick={togglePlay}>
              {isPlaying ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4" /></svg>
              )}
            </ControlButton>

            <ControlButton label={`快退 ${SEEK_STEP} 秒（J）`} onClick={() => seekBy(-SEEK_STEP)}>
              <RewindIcon />
            </ControlButton>
            <ControlButton label={`快进 ${SEEK_STEP} 秒（L）`} onClick={() => seekBy(SEEK_STEP)}>
              <ForwardIcon />
            </ControlButton>

            <span className="ml-1.5 mr-1 font-mono text-xs tabular-nums whitespace-nowrap text-[rgba(255,255,255,0.82)]">
              {formatClock(currentTime)}
              <span className="mx-1 text-[rgba(255,255,255,0.4)]">/</span>
              {formatClock(effectiveDuration)}
            </span>

            <div className="flex-1" />

            <ControlButton
              label={loop ? '关闭循环播放' : '循环播放'}
              active={loop}
              onClick={() => {
                const el = videoRef.current;
                const next = !loop;
                setLoop(next);
                if (el) el.loop = next;
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 2l4 4-4 4" />
                <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
                <path d="M7 22l-4-4 4-4" />
                <path d="M21 13v1a4 4 0 0 1-4 4H3" />
              </svg>
            </ControlButton>

            {/* 倍速 */}
            <div className="relative" data-video-menu>
              <button
                type="button"
                onClick={() => setOpenMenu(openMenu === 'speed' ? null : 'speed')}
                title="播放速度"
                aria-label="播放速度"
                className={`h-9 px-2.5 rounded-lg text-xs font-semibold tabular-nums transition-colors ${
                  openMenu === 'speed' || rate !== 1
                    ? 'text-[var(--accent-blue)] bg-[rgba(var(--accent-blue-rgb),0.15)]'
                    : 'text-[rgba(255,255,255,0.85)] hover:text-white hover:bg-[rgba(255,255,255,0.12)]'
                }`}
              >
                {rate === 1 ? '1×' : `${rate}×`}
              </button>
              {openMenu === 'speed' && (
                <Popover>
                  {SPEED_OPTIONS.map(option => (
                    <PopoverItem
                      key={option}
                      active={option === rate}
                      onClick={() => {
                        const video = videoRef.current;
                        if (video) video.playbackRate = option;
                        setRate(option);
                        setOpenMenu(null);
                      }}
                    >
                      {option === 1 ? '正常' : `${option}×`}
                    </PopoverItem>
                  ))}
                </Popover>
              )}
            </div>

            {/* 画质 */}
            <div className="relative" data-video-menu>
              <button
                type="button"
                onClick={() => setOpenMenu(openMenu === 'quality' ? null : 'quality')}
                title="画质：适应窗口 / 原始尺寸 1:1"
                aria-label="画质"
                className={`h-9 px-2.5 rounded-lg text-xs font-semibold transition-colors ${
                  openMenu === 'quality' || quality === 'actual'
                    ? 'text-[var(--accent-blue)] bg-[rgba(var(--accent-blue-rgb),0.15)]'
                    : 'text-[rgba(255,255,255,0.85)] hover:text-white hover:bg-[rgba(255,255,255,0.12)]'
                }`}
              >
                画质
              </button>
              {openMenu === 'quality' && (
                <Popover>
                  <PopoverItem
                    active={quality === 'fit'}
                    onClick={() => {
                      setQuality('fit');
                      setOpenMenu(null);
                    }}
                  >
                    适应窗口
                  </PopoverItem>
                  <PopoverItem
                    active={quality === 'actual'}
                    onClick={() => {
                      setQuality('actual');
                      setOpenMenu(null);
                    }}
                  >
                    原始尺寸 1:1
                  </PopoverItem>
                  <p className="px-3 pt-1 pb-1.5 text-[10px] leading-snug text-[rgba(255,255,255,0.42)] w-40">
                    {mediaSize.width > 0
                      ? `源分辨率 ${mediaSize.width}×${mediaSize.height}，原始尺寸按 1:1 像素显示，可拖动查看细节`
                      : '原始尺寸按 1:1 像素显示，可拖动查看细节'}
                  </p>
                </Popover>
              )}
            </div>

            {/* 音量 */}
            <div className="flex items-center gap-1 group/volume">
              <ControlButton label={muted ? '取消静音（M）' : '静音（M）'} onClick={toggleMute}>
                <VolumeIcon level={muted ? 0 : volume} />
              </ControlButton>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={muted ? 0 : volume}
                onChange={(e) => applyVolume(Number(e.target.value))}
                aria-label="音量"
                className="w-0 opacity-0 group-hover/volume:w-20 group-hover/volume:opacity-100 group-focus-within/volume:w-20 group-focus-within/volume:opacity-100 transition-all duration-200 cursor-pointer"
              />
            </div>

            <ControlButton label="画中画" onClick={() => void togglePiP()}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <rect x="12" y="12" width="8" height="6" rx="1" fill="currentColor" stroke="none" />
              </svg>
            </ControlButton>

            <ControlButton label={isFullscreen ? '退出全屏' : '全屏'} onClick={toggleFullscreen}>
              {isFullscreen ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3v3a2 2 0 0 1-2 2H3" />
                  <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
                  <path d="M3 16h3a2 2 0 0 1 2 2v3" />
                  <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                  <path d="M16 3h3a2 2 0 0 1 2 2v3" />
                  <path d="M3 16v3a2 2 0 0 0 2 2h3" />
                  <path d="M21 16v3a2 2 0 0 1-2 2h-3" />
                </svg>
              )}
            </ControlButton>
          </div>
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* 控制条基础件                                                        */
/* ------------------------------------------------------------------ */

const ControlButton: React.FC<{
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}> = ({ label, onClick, active, children }) => (
  <button
    type="button"
    onClick={onClick}
    title={label}
    aria-label={label}
    className={`w-9 h-9 flex items-center justify-center rounded-lg transition-colors active:scale-95 ${
      active
        ? 'text-[var(--accent-blue)] bg-[rgba(var(--accent-blue-rgb),0.15)]'
        : 'text-[rgba(255,255,255,0.85)] hover:text-white hover:bg-[rgba(255,255,255,0.12)]'
    }`}
  >
    {children}
  </button>
);

const Popover: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="absolute bottom-full right-0 mb-2 py-1 min-w-[88px] rounded-xl bg-[rgba(22,20,18,0.96)] backdrop-blur-xl border border-[rgba(255,255,255,0.14)] shadow-2xl animate-scaleIn origin-bottom-right">
    {children}
  </div>
);

const PopoverItem: React.FC<{
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    className={`w-full px-3 py-1.5 text-left text-xs font-medium whitespace-nowrap transition-colors ${
      active
        ? 'text-[var(--accent-blue)] bg-[rgba(var(--accent-blue-rgb),0.14)]'
        : 'text-[rgba(255,255,255,0.82)] hover:bg-[rgba(255,255,255,0.1)] hover:text-white'
    }`}
  >
    {children}
  </button>
);

/** 快退 10 秒：环形箭头 + 数字 */
const RewindIcon: React.FC = () => (
  <span className="relative flex items-center justify-center">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 19a8 8 0 1 0-7.4-5" />
      <path d="M3 4v5h5" />
    </svg>
    <span className="absolute text-[8px] font-bold leading-none pt-0.5">10</span>
  </span>
);

/** 快进 10 秒 */
const ForwardIcon: React.FC = () => (
  <span className="relative flex items-center justify-center">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 19a8 8 0 1 1 7.4-5" />
      <path d="M21 4v5h-5" />
    </svg>
    <span className="absolute text-[8px] font-bold leading-none pt-0.5">10</span>
  </span>
);

/** 音量图标：按档位切换静音 / 低 / 高 */
const VolumeIcon: React.FC<{ level: number }> = ({ level }) => {
  if (level <= 0) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none" />
        <line x1="23" y1="9" x2="17" y2="15" />
        <line x1="17" y1="9" x2="23" y2="15" />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none" />
      {level < 0.55 ? (
        <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      ) : (
        <>
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path d="M18.5 5.5a9 9 0 0 1 0 13" />
        </>
      )}
    </svg>
  );
};

export default VideoPlayer;
