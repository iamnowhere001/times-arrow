import React from 'react';
import { Photo } from '@/types';
import { isVideoPhoto } from '@/utils';
import { reportVideoMetaFromElement, videoMetaKeyOf } from '@/lib/media/videoMeta';
import { useThumbnailSrc } from '@/hooks/useThumbnailSrc';
import { useVideoPoster, VIDEO_POSTER_TIME } from '@/hooks/useVideoPoster';

/** 列表 / 详情等固定尺寸场景的缩略图 */
export const ThumbImage: React.FC<{
  photo: Photo;
  size: number;
  className?: string;
  alt?: string;
}> = ({ photo, size, className, alt }) => {
  const isVideo = isVideoPhoto(photo);
  const imageSrc = useThumbnailSrc(photo, size);
  const poster = useVideoPoster(photo, size);

  if (isVideo) {
    if (poster.src) {
      return (
        <img
          src={poster.src}
          alt={alt ?? photo.name}
          loading="lazy"
          decoding="async"
          /* 禁止拖拽：<img> 默认可拖，拖动题图标会弹出全局导入遮罩 */
          draggable={false}
          className={className}
        />
      );
    }
    // 抓帧失败（编码不支持 / 跨源污染）：退回到 <video> 直接渲染首帧
    if (poster.failed) {
      return (
        <video
          src={`${photo.url}#t=${VIDEO_POSTER_TIME}`}
          preload="metadata"
          muted
          playsInline
          onLoadedMetadata={(e) =>
            reportVideoMetaFromElement(videoMetaKeyOf(photo), e.currentTarget)
          }
          className={className}
          aria-label={alt ?? photo.name}
        />
      );
    }
    return <div className={className} aria-label={alt ?? photo.name} />;
  }

  // 尚未解析出缩略图时不要回退到原图（列表里加载整张原图代价极高），先占位
  if (!imageSrc) {
    return <div className={className} aria-label={alt ?? photo.name} />;
  }

  return (
    <img
      src={imageSrc}
      alt={alt ?? photo.name}
      loading="lazy"
      decoding="async"
      draggable={false}
      className={className}
    />
  );
};
