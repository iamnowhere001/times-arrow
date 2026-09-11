
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Photo } from '@/types';
import { isVideoPhoto } from '@/utils';
import { reportVideoMetaFromElement, videoMetaKeyOf } from '@/lib/media/videoMeta';

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
}

/** 幻灯片自动播放间隔 */
const SLIDESHOW_INTERVAL = 3000;

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
  onToggleFavorite
}) => {
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [showControls, setShowControls] = useState(true);
  const [isSlideshow, setIsSlideshow] = useState(false);
  // 大图加载状态：按 photo.id 记录，避免上一张的 load 事件误判当前这张（HEIC / 大图解码较慢）
  const [mediaStatus, setMediaStatus] = useState<{ id: string; state: 'ready' | 'error' } | null>(null);
  // 慢图才显示转圈：连续翻页时快速命中缓存，不应每张都闪一下加载动画
  const [showSpinner, setShowSpinner] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const isVideo = isVideoPhoto(photo);

  const imageReady = mediaStatus?.id === photo.id && mediaStatus.state === 'ready';
  const imageFailed = mediaStatus?.id === photo.id && mediaStatus.state === 'error';

  useEffect(() => {
    setScale(1);
    setRotation(0);
    setPosition({ x: 0, y: 0 });
    // 切换条目时停止上一个视频的播放
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
  }, [photo.id]);

  useEffect(() => {
    if (imageReady || imageFailed) {
      setShowSpinner(false);
      return;
    }
    const timer = window.setTimeout(() => setShowSpinner(true), 160);
    return () => window.clearTimeout(timer);
  }, [imageReady, imageFailed, photo.id]);

  const handleZoom = (delta: number) => {
    setScale(prev => {
      const newScale = Math.max(0.1, Math.min(5, prev + delta));
      if (newScale <= 1) setPosition({ x: 0, y: 0 });
      return newScale;
    });
  };

  /** 双击在 1x 与 2x 之间切换（Photos.app 习惯） */
  const handleToggleZoom = useCallback(() => {
    setScale(prev => {
      if (prev > 1) {
        setPosition({ x: 0, y: 0 });
        return 1;
      }
      return 2;
    });
  }, []);

  const handleRotate = (deg: number) => {
    setRotation(prev => prev + deg);
  };

  const toggleFavorite = useCallback(() => {
    onToggleFavorite?.(photo.id);
  }, [onToggleFavorite, photo.id]);

  /** 无法在应用内解码时，用系统播放器兜底 */
  const revealInFinder = useCallback(() => {
    if (photo.path && window.electronAPI?.showInFolder) {
      void window.electronAPI.showInFolder(photo.path);
    }
  }, [photo.path]);

  // 幻灯片播放：每 3.2s 自动前进，末尾回到第一张（视频不参与自动轮播）
  useEffect(() => {
    if (!isSlideshow || isVideo) return;
    const timer = setInterval(() => {
      if (hasNext) {
        onNext();
      } else if (onFirst) {
        onFirst();
      } else {
        setIsSlideshow(false);
      }
    }, SLIDESHOW_INTERVAL);
    return () => clearInterval(timer);
  }, [isSlideshow, isVideo, hasNext, onNext, onFirst]);

  // 切到视频时自动退出幻灯片模式
  useEffect(() => {
    if (isVideo && isSlideshow) setIsSlideshow(false);
  }, [isVideo, isSlideshow]);

  /** 空格：图片切换幻灯片，视频切换播放 / 暂停 */
  const toggleVideoPlayback = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play().catch(() => {});
    } else {
      el.pause();
    }
  }, []);

  // 幻灯片播放期间保持控制条可见，方便暂停
  useEffect(() => {
    if (isSlideshow) {
      setShowControls(true);
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
        controlsTimeoutRef.current = null;
      }
    }
  }, [isSlideshow]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
    }

    switch (e.key) {
      case 'ArrowRight':
      case 'l':
      case 'PageDown':
        if (hasNext) onNext();
        break;
      case 'ArrowLeft':
      case 'h':
      case 'PageUp':
        if (hasPrev) onPrev();
        break;
      case 'Escape':
      case 'q':
        onClose();
        break;
      case '+':
      case '=':
        handleZoom(0.25);
        break;
      case '-':
      case '_':
        handleZoom(-0.25);
        break;
      case '0':
        setScale(1);
        setRotation(0);
        setPosition({ x: 0, y: 0 });
        break;
      case 'r':
      case 'R':
        handleRotate(e.shiftKey ? -90 : 90);
        break;
      case 'f':
      case 'F':
        toggleFavorite();
        break;
      case ' ':
        e.preventDefault();
        if (isVideo) toggleVideoPlayback();
        else setIsSlideshow(prev => !prev);
        break;
      default:
        break;
    }
  }, [onClose, onNext, onPrev, hasNext, hasPrev, handleZoom, handleRotate, toggleFavorite, isVideo, toggleVideoPlayback]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const resetControlsTimeout = () => {
    if (isSlideshow) return;
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => {
      if (scale === 1) setShowControls(false);
    }, 3000);
  };

  useEffect(() => {
    window.addEventListener('mousemove', resetControlsTimeout);
    resetControlsTimeout();
    return () => {
      window.removeEventListener('mousemove', resetControlsTimeout);
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    };
  }, [scale, isSlideshow]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (scale > 1) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
      e.preventDefault();
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      setPosition({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-[rgba(0,0,0,0.95)] backdrop-blur-xl flex flex-col animate-fadeIn overflow-hidden select-none"
      onClick={onClose}
    >
      <div
        className={`absolute top-6 left-0 right-0 flex justify-center z-30 transition-opacity duration-500 ${showControls ? 'opacity-100' : 'opacity-0'}`}
        onClick={(e) => e.stopPropagation()}
      >
         <div className="bg-[rgba(30,30,40,0.85)] backdrop-blur-xl border border-[rgba(255,255,255,0.1)] px-6 py-2 rounded-full shadow-2xl flex items-center gap-4 text-sm font-medium text-[rgba(255,255,255,0.95)]">
             <span className="truncate max-w-[280px]">{photo.name}</span>
             {typeof currentIndex === 'number' && currentIndex >= 0 && typeof totalCount === 'number' && (
               <>
                 <div className="w-px h-3 bg-[rgba(255,255,255,0.2)]"></div>
                 <span className="text-[rgba(255,255,255,0.6)] font-mono text-xs">{currentIndex + 1} / {totalCount}</span>
               </>
             )}
             {!isVideo && (
               <>
                 <div className="w-px h-3 bg-[rgba(255,255,255,0.2)]"></div>
                 <span className="text-[rgba(255,255,255,0.6)] font-mono text-xs">{Math.round(scale * 100)}%</span>
               </>
             )}
             {isVideo && (
               <>
                 <div className="w-px h-3 bg-[rgba(255,255,255,0.2)]"></div>
                 <span className="flex items-center gap-1.5 text-[var(--accent-cyan)] text-xs">
                   <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                   视频
                 </span>
               </>
             )}
             {isSlideshow && (
               <>
                 <div className="w-px h-3 bg-[rgba(255,255,255,0.2)]"></div>
                 <span className="flex items-center gap-1.5 text-[var(--accent-cyan)] text-xs">
                   <span className="relative flex h-2 w-2">
                     <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent-cyan)] opacity-60"></span>
                     <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--accent-cyan)]"></span>
                   </span>
                   幻灯片播放中
                 </span>
               </>
             )}
         </div>
      </div>

      <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className={`absolute top-6 right-6 z-30 w-10 h-10 bg-[rgba(30,30,40,0.85)] backdrop-blur-xl hover:bg-[rgba(50,50,60,0.9)] rounded-full flex items-center justify-center text-[rgba(255,255,255,0.9)] transition-all duration-300 border border-[rgba(255,255,255,0.1)] hover:scale-105 active:scale-95 ${showControls ? 'opacity-100' : 'opacity-0'}`}
          title="关闭（Esc）"
          aria-label="关闭预览"
      >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>

      {onToggleFavorite && (
        <button
          onClick={(e) => { e.stopPropagation(); toggleFavorite(); }}
          className={`absolute top-6 right-20 z-30 w-10 h-10 backdrop-blur-xl rounded-full flex items-center justify-center transition-all duration-300 border hover:scale-105 active:scale-95 ${showControls ? 'opacity-100' : 'opacity-0'} ${
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

      <div
        className="flex-1 relative flex items-center justify-center w-full h-full overflow-hidden"
        ref={containerRef}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {/* 大图解码期间给出明确反馈，避免整屏黑屏像是卡死 */}
        {showSpinner && !imageFailed && (
          <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
            <div className="w-12 h-12 rounded-full border-2 border-[rgba(255,255,255,0.18)] border-t-[rgba(255,255,255,0.9)] animate-spin" />
          </div>
        )}
        {imageFailed && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 px-8 text-center pointer-events-none">
            <svg className="w-10 h-10 text-[rgba(255,255,255,0.4)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <p className="text-sm font-medium text-[rgba(255,255,255,0.85)]">
              {isVideo ? '无法播放这段视频' : '无法显示这张图片'}
            </p>
            <p className="text-xs text-[rgba(255,255,255,0.5)] truncate max-w-full">
              {isVideo ? `${photo.name}（编码格式可能不受支持）` : photo.name}
            </p>
            {isVideo && photo.path && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  revealInFinder();
                }}
                className="mt-2 pointer-events-auto px-3.5 py-1.5 text-xs font-medium rounded-lg text-[rgba(255,255,255,0.9)] bg-[rgba(255,255,255,0.12)] border border-[rgba(255,255,255,0.22)] hover:bg-[rgba(255,255,255,0.2)] transition-all duration-200 active:scale-[0.98]"
              >
                在访达中打开
              </button>
            )}
          </div>
        )}

        {hasPrev && (
          <div
             className="absolute left-0 inset-y-0 w-24 z-20 flex items-center justify-start pl-4 group cursor-pointer hover:bg-gradient-to-r hover:from-[rgba(0,0,0,0.4)] hover:to-transparent transition-all"
             onClick={(e) => { e.stopPropagation(); onPrev(); }}
          >
             <button className="w-12 h-12 bg-[rgba(30,30,40,0.85)] backdrop-blur-xl border border-[rgba(255,255,255,0.1)] rounded-full flex items-center justify-center text-[rgba(255,255,255,0.9)] opacity-40 group-hover:opacity-100 group-hover:border-[rgba(var(--accent-blue-rgb),0.5)] transform -translate-x-2 group-hover:translate-x-0 transition-all duration-300 shadow-lg" title="上一张（←）" aria-label="上一张">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6"/></svg>
             </button>
          </div>
        )}

        {hasNext && (
          <div
             className="absolute right-0 inset-y-0 w-24 z-20 flex items-center justify-end pr-4 group cursor-pointer hover:bg-gradient-to-l hover:from-[rgba(0,0,0,0.4)] hover:to-transparent transition-all"
             onClick={(e) => { e.stopPropagation(); onNext(); }}
          >
             <button className="w-12 h-12 bg-[rgba(30,30,40,0.85)] backdrop-blur-xl border border-[rgba(255,255,255,0.1)] rounded-full flex items-center justify-center text-[rgba(255,255,255,0.9)] opacity-40 group-hover:opacity-100 group-hover:border-[rgba(var(--accent-blue-rgb),0.5)] transform translate-x-2 group-hover:translate-x-0 transition-all duration-300 shadow-lg" title="下一张（→）" aria-label="下一张">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg>
             </button>
          </div>
        )}

        <div
          className={`relative transition-transform will-change-transform ${isDragging ? 'duration-0 ease-linear' : 'duration-500 ease-[cubic-bezier(0.19,1,0.22,1)]'}`}
          style={{
            transform: `translate(${position.x}px, ${position.y}px) rotate(${rotation}deg) scale(${scale})`,
            cursor: scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default'
          }}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (!isVideo) handleToggleZoom();
          }}
          onMouseDown={handleMouseDown}
        >
          {isVideo ? (
            <video
              ref={videoRef}
              src={photo.url}
              controls
              autoPlay
              playsInline
              preload="metadata"
              onLoadedMetadata={e => reportVideoMetaFromElement(videoMetaKeyOf(photo), e.currentTarget)}
              onLoadedData={() => setMediaStatus({ id: photo.id, state: 'ready' })}
              onError={() => setMediaStatus({ id: photo.id, state: 'error' })}
              className={`max-w-[90vw] max-h-[85vh] w-auto h-auto object-contain shadow-2xl rounded-lg border border-[rgba(255,255,255,0.1)] bg-black ${
                imageFailed ? 'opacity-0' : ''
              }`}
            />
          ) : (
            <img
              src={photo.url}
              alt={photo.name}
              draggable={false}
              onLoad={() => setMediaStatus({ id: photo.id, state: 'ready' })}
              onError={() => setMediaStatus({ id: photo.id, state: 'error' })}
              className={`max-w-[90vw] max-h-[85vh] object-contain shadow-2xl rounded-lg border border-[rgba(255,255,255,0.1)] ${
                imageFailed ? 'opacity-0' : ''
              }`}
            />
          )}
        </div>
      </div>

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
                 <svg width="20" height="20" fill={photo.isFavorite ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"/></svg>
               </button>
               <div className="w-px h-5 bg-[rgba(255,255,255,0.2)] mx-1"></div>
             </>
           )}

           {/* 缩放 / 旋转 / 幻灯片 / 重置：仅对图片有意义 */}
           {!isVideo && (<>
           <div className="flex items-center">
             <button onClick={() => handleZoom(-0.25)} className="w-10 h-10 flex items-center justify-center text-[rgba(255,255,255,0.8)] hover:text-white hover:bg-[rgba(255,255,255,0.1)] rounded-xl transition-all active:scale-90" title="缩小（-）">
               <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>
             </button>
             <button onClick={() => handleZoom(0.25)} className="w-10 h-10 flex items-center justify-center text-[rgba(255,255,255,0.8)] hover:text-white hover:bg-[rgba(255,255,255,0.1)] rounded-xl transition-all active:scale-90" title="放大（+）">
               <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="11" y1="8" x2="11" y2="14"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>
             </button>
           </div>

           <div className="w-px h-5 bg-[rgba(255,255,255,0.2)] mx-1"></div>

           <div className="flex items-center">
             <button onClick={() => handleRotate(-90)} className="w-10 h-10 flex items-center justify-center text-[rgba(255,255,255,0.8)] hover:text-white hover:bg-[rgba(255,255,255,0.1)] rounded-xl transition-all active:scale-90" title="向左旋转（⇧R）">
               <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></svg>
             </button>
             <button onClick={() => handleRotate(90)} className="w-10 h-10 flex items-center justify-center text-[rgba(255,255,255,0.8)] hover:text-white hover:bg-[rgba(255,255,255,0.1)] rounded-xl transition-all active:scale-90" title="向右旋转（R）">
               <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path></svg>
             </button>
           </div>

           <div className="w-px h-5 bg-[rgba(255,255,255,0.2)] mx-1"></div>

           {/* 幻灯片播放 / 暂停 */}
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
               <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>
             ) : (
               <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
             )}
           </button>

           <div className="w-px h-5 bg-[rgba(255,255,255,0.2)] mx-1"></div>

           <button
             onClick={() => { setScale(1); setRotation(0); setPosition({x:0, y:0}); }}
             className="px-4 h-10 text-xs font-semibold uppercase tracking-wider text-[rgba(255,255,255,0.8)] hover:text-white hover:bg-[rgba(255,255,255,0.1)] rounded-xl transition-all active:scale-90"
             title="重置缩放与旋转（0）"
           >
             重置
           </button>
           </>) }
           </div>
      </div>
    </div>
  );
};

export default QuickLook;
