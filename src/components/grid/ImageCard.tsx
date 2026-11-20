import React, { useCallback, useRef, useState } from 'react';
import { Photo } from '@/types';
import { formatVideoDuration, isVideoPhoto } from '@/utils';
import { cameraKeyOf } from '@/lib/filter/filters';
import { useThumbnailSrc } from '@/hooks/useThumbnailSrc';
import { useVideoPoster } from '@/hooks/useVideoPoster';

/**
 * 网格中的一张卡片。
 *
 * 这个组件被 `React.memo` 包着，所以两条纪律必须守住：
 * 1. **所有回调都必须是稳定引用**（调用方用 ref 转发），否则 memo 完全失效，
 *    万级图库滚动时每帧都会重渲染全部可见卡片；
 * 2. **不要在这里读全局状态**（选择态、拖拽态都由 props 传入），
 *    否则 memo 的比较逻辑与真实依赖不一致。
 */
/** 注意：所有回调都必须是稳定引用，否则 React.memo 会失效 */
interface ImageCardProps {
  photo: Photo;
  isSelected: boolean;
  onSelect: (id: string, multiSelect: boolean) => void;
  onRange: (id: string) => void;
  onOpen: (photo: Photo) => void;
  onMenu: (e: React.MouseEvent, photo: Photo) => void;
  onToggleFavorite: (id: string) => void;
  onShowDeleteConfirm: () => void;
  /** 卡片渲染宽度（CSS px），用于按屏幕像素比按需提升缩略图分辨率 */
  cardWidth: number;
  /** 已从磁盘删除、正在播塌陷动画：此时卡片还在，但已不可交互 */
  isExiting: boolean;
  /** 首屏入场的交错延迟（ms）；undefined 表示不参与入场动画 */
  enterDelay?: number;
}

/**
 * 缩略图浮层控件（选择 / 删除 / 收藏）共用同一套几何参数：
 * 三个按钮尺寸、圆角、描边、图标盒子完全相同，任意组合下都等大、居中、水平对齐。
 * - 28px 圆底 + 16px 图标：缩略图缩到很小时仍留有可点面积，图标也不会糊成一团；
 * - 半透明黑底 + 1px 白描边：亮底、暗底照片上都有稳定对比度；
 * - 选择 / 收藏平时隐藏，hover 或选中时才出现，不遮挡照片本身。
 */
const OVERLAY_BTN =
  'flex items-center justify-center w-7 h-7 rounded-full border border-[rgba(255,255,255,0.3)] bg-[rgba(0,0,0,0.45)] text-white backdrop-blur-md transition-all duration-200 hover:scale-110 active:scale-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[rgba(var(--accent-blue-rgb),0.6)]';

/** 图标盒子统一 16px：几何上对齐，视觉重量再靠 strokeWidth 微调 */
const OVERLAY_ICON = 'w-4 h-4';

/** 卡片角落与浮层共用的极简相机轮廓 */
const CameraGlyph = ({ className = 'w-3.5 h-3.5' }: { className?: string }) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
    <circle cx="12" cy="13" r="4" />
  </svg>
);

const ImageCard = React.memo(
  ({
    photo,
    isSelected,
    onSelect,
    onRange,
    onOpen,
    onMenu,
    onToggleFavorite,
    onShowDeleteConfirm,
    cardWidth,
    isExiting,
    enterDelay,
  }: ImageCardProps) => {
    const [loaded, setLoaded] = useState(false);
    const [loadError, setLoadError] = useState(false);
    const imgRef = useRef<HTMLImageElement>(null);

    const isVideo = isVideoPhoto(photo);

    // 磁盘缩略图按需解析：进入视口才请求，并按「渲染宽度 × 屏幕像素比」自动提升清晰度
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const targetSize = cardWidth * dpr;
    const src = useThumbnailSrc(photo, targetSize);
    // 视频首帧：命中缩略图直接当图片用；否则退化为 <video> 静帧
    const poster = useVideoPoster(photo, targetSize);

    const handleImageLoad = useCallback(() => {
      setLoaded(true);
    }, []);

    const handleImageError = useCallback(() => {
      setLoadError(true);
    }, []);

    const retryLoading = useCallback(() => {
      setLoadError(false);
      setLoaded(false);
      if (imgRef.current && src) {
        imgRef.current.src = src;
      }
    }, [src]);

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

    // 视频且主进程/抓帧均不可用：直接用 <video> 渲染首帧兜底
    const useVideoElement = isVideo && !poster.src && poster.failed;
    const mediaSrc = isVideo ? poster.src : src;
    const mediaPending = isVideo ? !poster.src && !poster.failed : !src;

    // 视频时长角标：元数据只能由播放器加载后上报，未就绪时不显示（而不是显示 0:00）
    const durationLabel = isVideo ? formatVideoDuration(photo.duration) : '';
    // 统一相机标识（厂商 + 机型，自动去重前缀）；缺省 EXIF 时返回 null
    const cameraLabel = cameraKeyOf(photo);

    return (
      <div
        onClick={handleClick}
        onDoubleClick={() => onOpen(photo)}
        onContextMenu={(e) => onMenu(e, photo)}
        style={enterDelay !== undefined ? { animationDelay: `${enterDelay}ms` } : undefined}
        className={`group relative flex flex-col items-center p-px rounded-lg cursor-pointer w-full h-full transition-[transform,opacity,background-color,box-shadow] duration-200 ease-entrance ${enterDelay !== undefined ? 'animate-fadeInUp ' : ''}${
          isExiting
            ? 'opacity-0 scale-[0.92] pointer-events-none'
            : isSelected
              ? 'shadow-lg shadow-[rgba(var(--accent-blue-rgb),0.2)] hover:-translate-y-0.5'
              : 'hover:bg-[var(--bg-glass)] hover:-translate-y-0.5'
        }`}
      >
        <div
          className={`relative flex-1 min-h-0 w-full rounded-md overflow-hidden bg-[var(--bg-card)] border shadow-[var(--shadow-photo)] transition-[border-color,box-shadow] duration-200 ease-entrance ${
            isSelected
              ? 'border-transparent ring-2 ring-inset ring-[var(--accent-blue)] group-hover:shadow-[var(--shadow-photo-hover)]'
              : 'border-[var(--border-subtle)] group-hover:border-[var(--border-hover)] group-hover:shadow-[var(--shadow-photo-hover)]'
          }`}
        >
          {/* 选择圈：入场做淡入 + 轻微放大，与右侧两个按钮同尺寸、同顶边对齐 */}
          <div
            className={`absolute top-1.5 left-1.5 z-10 transition-[opacity,transform] duration-200 ease-entrance ${
              isSelected
                ? 'opacity-100 scale-100'
                : 'opacity-0 scale-90 group-hover:opacity-100 group-hover:scale-100'
            }`}
          >
            <button
              type="button"
              role="checkbox"
              aria-checked={isSelected}
              aria-label={isSelected ? '取消选择' : '选择'}
              title={isSelected ? '取消选择' : '选择'}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(photo.id, true);
              }}
              className={`${OVERLAY_BTN} cursor-pointer ${
                isSelected
                  ? 'border-[var(--accent-blue)] bg-[var(--accent-blue)] text-[var(--accent-contrast)] shadow-lg shadow-[rgba(var(--accent-blue-rgb),0.45)]'
                  : 'text-transparent hover:border-white hover:bg-[rgba(0,0,0,0.65)]'
              }`}
            >
              {/* 勾选出现在圆心：从小放大 + 回弹，让「选中」这个动作看得见。
                描边比右侧线性图标粗一档，补偿实心底上的视觉重量差 */}
              <svg
                className={`${OVERLAY_ICON} transition-transform duration-200 ease-entrance ${isSelected ? 'scale-100' : 'scale-50'}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 13l4 4L19 7" />
              </svg>
            </button>
          </div>

          {/* 删除 + 收藏：放在同一个右对齐的 flex 行里，
            删除按钮出现/消失时只向左扩展，收藏按钮的位置始终不变 */}
          <div className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1.5">
            {isSelected && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onShowDeleteConfirm();
                }}
                className={`${OVERLAY_BTN} hover:text-[var(--accent-pink)] hover:border-[rgba(var(--accent-pink-rgb),0.7)] hover:bg-[rgba(var(--accent-pink-rgb),0.28)]`}
                title="删除"
                aria-label="删除选中"
              >
                <svg className={OVERLAY_ICON} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              </button>
            )}

            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite(photo.id);
              }}
              className={`${OVERLAY_BTN} ${
                photo.isFavorite
                  ? 'border-[rgba(var(--accent-pink-rgb),0.55)] bg-[rgba(var(--accent-pink-rgb),0.25)] text-[var(--accent-pink)] shadow-lg shadow-[rgba(var(--accent-pink-rgb),0.25)] hover:bg-[rgba(var(--accent-pink-rgb),0.35)]'
                  : isSelected
                    ? 'opacity-100 hover:border-white hover:bg-[rgba(0,0,0,0.65)]'
                    : 'opacity-0 group-hover:opacity-100 hover:border-white hover:bg-[rgba(0,0,0,0.65)]'
              }`}
              title="收藏"
              aria-label="收藏"
            >
              <svg
                className={OVERLAY_ICON}
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
          </div>

          {(!loaded || mediaPending) && !loadError && (
            <div className="absolute inset-0 bg-[rgba(255,255,255,0.03)] animate-pulse flex items-center justify-center">
              <div className="w-10 h-10 rounded-full border-2 border-[rgba(255,255,255,0.1)] border-t-[var(--accent-blue)] animate-spin"></div>
            </div>
          )}

          {loadError && (
            <div className="absolute inset-0 bg-[rgba(var(--accent-pink-rgb),0.05)] backdrop-blur-xs flex flex-col items-center justify-center p-4">
              <svg
                className="w-12 h-12 text-[rgba(var(--accent-pink-rgb),0.4)] mb-3"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              <p className="text-sm text-[rgba(var(--accent-pink-rgb),0.7)] text-center">
                {isVideo ? '无法预览此视频' : '图片加载失败'}
              </p>
              {isVideo && (
                <p className="mt-1.5 text-xs leading-snug text-[rgba(var(--accent-pink-rgb),0.55)] text-center">
                  编码格式可能不受支持，可右键「在访达中显示」用系统播放器打开
                </p>
              )}
              {!isVideo && (
                <button
                  onClick={retryLoading}
                  className="mt-3 px-3 py-1.5 text-xs bg-[rgba(var(--accent-pink-rgb),0.2)] text-[var(--accent-pink-hover)] rounded-lg hover:bg-[rgba(var(--accent-pink-rgb),0.3)] transition-colors border border-[rgba(var(--accent-pink-rgb),0.3)]"
                >
                  重试
                </button>
              )}
            </div>
          )}

          {useVideoElement ? (
            <video
              src={`${photo.url}#t=0.1`}
              preload="metadata"
              muted
              playsInline
              className={`w-full h-full object-contain transition-[opacity,transform] duration-300 ease-entrance ${
                loaded ? 'opacity-100 scale-100 group-hover:scale-[1.03]' : 'opacity-0 scale-105'
              }`}
              onLoadedData={handleImageLoad}
              onError={handleImageError}
            />
          ) : (
            <img
              ref={imgRef}
              src={mediaSrc ?? undefined}
              alt={photo.name}
              className={`w-full h-full object-contain transition-[opacity,transform] duration-300 ease-entrance ${
                loaded ? 'opacity-100 scale-100 group-hover:scale-[1.03]' : 'opacity-0 scale-105'
              }`}
              loading="lazy"
              decoding="async"
              /* <img> 默认可拖，会拖出一张半透明残影并触发全局导入遮罩 */
              draggable={false}
              onLoad={handleImageLoad}
              onError={handleImageError}
            />
          )}

          {/* 视频播放标识：让静态首帧一眼可辨 */}
          {isVideo && !loadError && (
            <div className="absolute inset-0 z-[5] flex items-center justify-center pointer-events-none">
              <span className="w-11 h-11 rounded-full bg-[rgba(0,0,0,0.45)] backdrop-blur-md border border-[rgba(255,255,255,0.25)] flex items-center justify-center text-white shadow-lg transition-transform duration-300 group-hover:scale-110">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </span>
            </div>
          )}

          {/* 时长角标：贴在左下角，位于文件名浮层之上 */}
          {isVideo && durationLabel && !loadError && (
            <div className="absolute bottom-1.5 left-1.5 z-[7] px-1.5 py-0.5 rounded-md bg-[rgba(0,0,0,0.6)] text-white text-xs font-medium tabular-nums backdrop-blur-md shadow-xs">
              {durationLabel}
            </div>
          )}

          {/* 右下角常驻相机图标：仅当照片或视频携带 EXIF 相机信息时微显，悬停提亮并提示机型 */}
          {cameraLabel && !loadError && loaded && (
            <div
              title={cameraLabel}
              aria-label={`拍摄设备：${cameraLabel}`}
              className={`absolute bottom-1.5 right-1.5 z-[7] flex items-center justify-center w-6 h-6 rounded-full border transition-all duration-200 ease-entrance ${
                isSelected
                  ? 'border-[rgba(255,255,255,0.3)] bg-[rgba(0,0,0,0.6)] text-white'
                  : 'border-[rgba(255,255,255,0.18)] bg-[rgba(0,0,0,0.44)] text-[rgba(255,255,255,0.72)] group-hover:border-[rgba(255,255,255,0.34)] group-hover:bg-[rgba(0,0,0,0.65)] group-hover:text-white'
              }`}
            >
              <CameraGlyph className="w-3.5 h-3.5" />
            </div>
          )}

          {/* 文件名与相机型号浮层：悬停或选中时贴在图底渐显，左右预留角落图标安全边距 */}
          {!loadError && (
            <div
              className={`pointer-events-none absolute inset-x-0 bottom-0 z-[6] ${
                durationLabel ? 'pl-14' : 'pl-2.5'
              } ${
                cameraLabel ? 'pr-9' : 'pr-2.5'
              } pt-6 pb-1.5 bg-[linear-gradient(to_top,rgba(0,0,0,0.82),rgba(0,0,0,0.48)_58%,transparent)] transition-opacity duration-200 ease-entrance ${
                isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              }`}
            >
              <p
                title={photo.name}
                className="text-xs leading-tight font-medium truncate text-white"
              >
                {photo.name}
              </p>
              {cameraLabel && (
                <p
                  title={cameraLabel}
                  className="mt-0.5 flex items-center gap-1 text-xs leading-tight text-[rgba(255,255,255,0.78)] truncate"
                >
                  <CameraGlyph className="w-3 h-3 shrink-0 opacity-85" />
                  <span className="truncate">{cameraLabel}</span>
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }
);

ImageCard.displayName = 'ImageCard';

export default ImageCard;
