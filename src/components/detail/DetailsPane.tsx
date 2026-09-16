
import React, { useState, useEffect, useRef } from 'react';
import { Photo } from '@/types';
import {
  extOfName,
  formatBytes,
  formatDate,
  formatVideoDuration,
  isVideoPhoto,
  isVideoPlaybackUncertain,
} from '@/utils';
import { reportVideoMetaFromElement, videoMetaKeyOf } from '@/lib/media/videoMeta';
import { analyzeImage, analyzeImageFromBase64 } from '@/services/aiService';
import { logger } from '@/lib/logger';
import { useThumbnailSrc } from '@/components/grid/ThumbnailImage';

/**
 * 详情预览图：先用磁盘缩略图把画面立刻铺出来，原图在后台解码完成后再无缝替换。
 * 面板通栏只有 380px，按 2x 截屏也只需要 ~760px 的像素，
 * 直接上原图意味着每切一张就要解码一张全尺寸大图 —— 切换照片因此发顿。
 * 缩略图路径与网格共用同一份磁盘缓存，通常已命中，切换是即时的。
 */
const DETAIL_PREVIEW_SIZE = 760;
/** 预览图统一：宽度占满、高度封顶（长截图/竖幅不会把面板撑爆），等比缩放不裁切 */
const PREVIEW_IMG_CLASS = 'w-full h-auto max-h-[44vh] object-contain';

const PreviewImage: React.FC<{ photo: Photo; alt: string }> = ({ photo, alt }) => {
  const thumbSrc = useThumbnailSrc(photo, DETAIL_PREVIEW_SIZE);
  const [fullReady, setFullReady] = useState(false);

  useEffect(() => {
    setFullReady(false);
    // 没有缩略图（或缩略图就是原图）时无需预解码，直接显示原图即可
    if (!thumbSrc || thumbSrc === photo.url) return;

    let cancelled = false;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { if (!cancelled) setFullReady(true); };
    img.onerror = () => { if (!cancelled) setFullReady(false); };
    img.src = photo.url;
    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
      // 清空 src 让浏览器立刻放弃这张全尺寸图的解码缓存
      img.src = '';
    };
  }, [photo.id, photo.url, thumbSrc]);

  return <img src={fullReady || !thumbSrc ? photo.url : thumbSrc} alt={alt} className={PREVIEW_IMG_CLASS} />;
};

interface DetailsPaneProps {
  selectedPhotos: Photo[];
  onUpdatePhoto: (id: string, data: Partial<Photo>) => void;
  onRenamePhoto?: (id: string, newName: string) => void;
  isDetailsPaneOpen: boolean;
  /** 通知回调（替代 alert） */
  onNotify?: (message: string, type: 'success' | 'info' | 'error' | 'warning') => void;
  /** 打开「AI 分析设置」弹窗（配置 DeepSeek API Key 等） */
  onOpenAiSettings?: () => void;
}

interface ExportSettings {
  format: string;
  quality: number;
}

const DetailsPane: React.FC<DetailsPaneProps> = ({ selectedPhotos, onUpdatePhoto, onRenamePhoto, isDetailsPaneOpen, onNotify, onOpenAiSettings }) => {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  
  const [isExportMode, setIsExportMode] = useState(false);
  const [exportSettings, setExportSettings] = useState<ExportSettings>({ format: 'image/jpeg', quality: 0.9 });
  const [previewData, setPreviewData] = useState<{ url: string, size: number, blob: Blob } | null>(null);
  const [isGeneratingPreview, setIsGeneratingPreview] = useState(false);
  
  const [isEditingName, setIsEditingName] = useState(false);
  const [tempName, setTempName] = useState('');
  const [tagInput, setTagInput] = useState('');
  /** 视频解码状态：元数据读取成功 / 失败（失败时给出外部播放器兜底） */
  const [videoStatus, setVideoStatus] = useState<'idle' | 'ready' | 'error'>('idle');
  const nameInputRef = useRef<HTMLInputElement>(null);

  const isMulti = selectedPhotos.length > 1;
  const photo = selectedPhotos[0];
  const isVideo = photo ? isVideoPhoto(photo) : false;

  useEffect(() => {
    setIsExportMode(false);
    setPreviewData(null);
    setExportSettings({ format: 'image/jpeg', quality: 0.9 });
    setIsEditingName(false);
    setTagInput('');
    setVideoStatus('idle');
    // 分析中的状态也要跟着切图重置：否则切到下一张后新照片的按钮会卡在「分析中…」，
    // 让人以为正在分析新照片（实际上跑的是上一张）
    setIsAnalyzing(false);
  }, [photo?.id]);

  useEffect(() => {
      if (isEditingName && nameInputRef.current) {
          nameInputRef.current.focus();
          const lastDot = tempName.lastIndexOf('.');
          if (lastDot > 0) {
              nameInputRef.current.setSelectionRange(0, lastDot);
          } else {
              nameInputRef.current.select();
          }
      }
  }, [isEditingName]);

  const startEditing = () => {
      if (isMulti) return;
      setTempName(photo.name);
      setIsEditingName(true);
  };

  const handleRenameSubmit = () => {
      if (!tempName.trim() || tempName === photo.name) {
          setIsEditingName(false);
          return;
      }
      if (onRenamePhoto) {
          onRenamePhoto(photo.id, tempName.trim());
      }
      setIsEditingName(false);
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
          handleRenameSubmit();
      } else if (e.key === 'Escape') {
          setIsEditingName(false);
          setTempName(photo.name);
      }
  };

  /** 添加用户标签：去掉前导 # 与首尾空白，重复则忽略 */
  const handleAddTag = (raw: string) => {
      const value = raw.trim().replace(/^#+/, '').trim();
      if (!value || isMulti) return;
      const current = photo.tags ?? [];
      if (current.includes(value)) {
          setTagInput('');
          return;
      }
      onUpdatePhoto(photo.id, { tags: [...current, value] });
      setTagInput('');
  };

  const handleRemoveTag = (tag: string) => {
      if (isMulti) return;
      onUpdatePhoto(photo.id, { tags: (photo.tags ?? []).filter(item => item !== tag) });
  };

  /** 视频元数据就绪：上报时长 / 分辨率，供网格角标与详情面板共用 */
  const handleVideoMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
      if (reportVideoMetaFromElement(videoMetaKeyOf(photo), e.currentTarget)) {
          setVideoStatus('ready');
      }
  };

  /** 视频无法在应用内解码：给出明确的兜底入口 */
  const handleRevealInFinder = () => {
      if (photo.path && window.electronAPI?.showInFolder) {
          void window.electronAPI.showInFolder(photo.path);
      }
  };

  const videoDuration = isVideo ? formatVideoDuration(photo.duration) : '';
  const videoExt = isVideo ? extOfName(photo.name) : '';
  const playbackUncertain = isVideo ? isVideoPlaybackUncertain(photo.name) : false;

  useEffect(() => {
      return () => {
          if (previewData?.url) URL.revokeObjectURL(previewData.url);
      };
  }, [previewData]);

  useEffect(() => {
      if (!isExportMode || !photo) return;

      // 生成过程是异步且较重的：卸载 / 切图后必须丢弃结果，
      // 否则会往已卸载的组件写状态，并白白留下一个未被回收的 ObjectURL 与全尺寸 canvas。
      let cancelled = false;

      const generate = async () => {
          setIsGeneratingPreview(true);
          try {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.src = photo.url;
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = () => reject(new Error('Image failed to load'));
            });
            if (cancelled) {
                img.src = '';
                return;
            }

            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            
            if (!ctx) {
                throw new Error('Canvas context not available');
            }

            if (exportSettings.format === 'image/jpeg') {
                ctx.fillStyle = '#FFFFFF';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            }
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0);

            // 画完即可松开对解码后位图（全尺寸）的引用，避免多张预览叠加占内存
            img.src = '';
            img.onload = null;
            img.onerror = null;

            await new Promise<void>((resolve, reject) => {
                canvas.toBlob((blob) => {
                    if (blob) {
                        const newUrl = URL.createObjectURL(blob);
                        if (cancelled) {
                            URL.revokeObjectURL(newUrl);
                            resolve();
                            return;
                        }
                        setPreviewData(prev => {
                            if (prev?.url) URL.revokeObjectURL(prev.url);
                            return { url: newUrl, size: blob.size, blob };
                        });
                        resolve();
                    } else {
                        reject(new Error('Canvas toBlob failed'));
                    }
                }, exportSettings.format, exportSettings.quality);
            });

            // 释放 canvas 占用的显存 / 内存
            canvas.width = 0;
            canvas.height = 0;
          } catch (error) {
              if (cancelled) return;
              logger.error("Preview generation failed", error);
          } finally {
              if (!cancelled) setIsGeneratingPreview(false);
          }
      };

      const timer = setTimeout(generate, 500);
      return () => {
          cancelled = true;
          clearTimeout(timer);
      };
  }, [exportSettings, isExportMode, photo]);

  const handleDownload = () => {
      if (!previewData || !photo) return;
      
      const link = document.createElement('a');
      link.href = previewData.url;
      
      let ext = 'jpg';
      if (exportSettings.format === 'image/png') ext = 'png';
      else if (exportSettings.format === 'image/webp') ext = 'webp';
      
      const originalName = photo.name.substring(0, photo.name.lastIndexOf('.')) || photo.name;
      link.download = `${originalName}_edited.${ext}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
  };

  const handleAnalyze = async () => {
    if (isMulti) return;

    // 未配置密钥时直接引导到「AI 设置」，而不是等请求失败再报错
    if (window.electronAPI?.getAiConfig) {
      try {
        const configRes = await window.electronAPI.getAiConfig();
        if (configRes.ok && !configRes.data.apiKey) {
          onNotify?.('尚未配置 DeepSeek API Key，请在「AI 设置」中填写。', 'warning');
          onOpenAiSettings?.();
          return;
        }
      } catch {
        /* 读取配置失败时继续走分析流程，由后续错误提示兜底 */
      }
    }

    setIsAnalyzing(true);
    try {
      // 优先走磁盘路径（Photo.file 已不再填充）：
      // 主进程读出 base64 后代理请求 DeepSeek，避免渲染进程持有 File 对象
      let result;
      if (photo.path && window.electronAPI) {
        const readRes = await window.electronAPI.readFile(photo.path);
        if (!readRes.ok) {
          onNotify?.(`读取图片失败：${readRes.error}`, 'error');
          return;
        }
        const mimeType = photo.type || 'image/jpeg';
        result = await analyzeImageFromBase64(readRes.data, mimeType);
      } else if (photo.file) {
        result = await analyzeImage(photo.file);
      } else {
        onNotify?.('该照片没有磁盘路径，无法进行 AI 分析', 'warning');
        return;
      }

      if (result) {
        onUpdatePhoto(photo.id, {
          aiDescription: result.description,
          aiTags: result.tags
        });
        onNotify?.('AI 分析完成', 'success');
      } else {
        onNotify?.('AI 分析未能生成结果', 'warning');
      }
    } catch (e) {
      logger.error('AI分析失败:', e);
      const detail = e instanceof Error && e.message ? e.message : '';
      onNotify?.(
        detail || 'AI 分析失败，请检查「AI 设置」中的 DeepSeek 配置与图片格式是否受支持。',
        'error'
      );
    } finally {
      setIsAnalyzing(false);
    }
  };

  if (selectedPhotos.length === 0) {
    return (
      // 抽屉式收展：外层只过渡宽度并裁掉溢出，内层保持固定宽度，
      // 内容因此是「滑出去」而不是被挤扁
      <div className={`h-full overflow-hidden transition-[width] duration-300 ease-entrance ${isDetailsPaneOpen ? 'w-[380px]' : 'w-0'}`}>
        <div className={`w-[380px] h-full bg-[var(--bg-elevated)] backdrop-blur-xl border-l border-[var(--border-subtle)] p-6 flex flex-col items-center justify-center text-center transition-[opacity,transform] duration-200 ease-entrance ${
          isDetailsPaneOpen ? 'opacity-100 translate-x-0 delay-75' : 'opacity-0 translate-x-3'
        }`}>
            <div className="w-16 h-16 rounded-xl bg-[var(--bg-glass)] flex items-center justify-center mb-4">
              <svg className="w-8 h-8 text-[var(--text-quaternary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
            </div>
            <p className="text-[var(--text-tertiary)] font-medium">选择一张照片查看详情</p>
        </div>
      </div>
    );
  }

  return (
    // 抽屉式收展：外层只过渡宽度并裁掉溢出，内层保持固定宽度，
    // 内容因此是「滑出去」而不是被挤扁
    <div className={`h-full overflow-hidden transition-[width] duration-300 ease-entrance ${isDetailsPaneOpen ? 'w-[380px]' : 'w-0'}`}>
      <div className={`w-[380px] h-full bg-[var(--bg-elevated)] backdrop-blur-xl border-l border-[var(--border-subtle)] overflow-y-auto custom-scrollbar flex flex-col transition-[opacity,transform] duration-200 ease-entrance ${
        isDetailsPaneOpen ? 'opacity-100 translate-x-0 delay-75' : 'opacity-0 translate-x-3'
      }`}>
        <div className="p-5 border-b border-[var(--border-subtle)]">
        <h2 className="text-sm font-semibold text-[var(--text-primary)] uppercase tracking-wide">
            {isMulti ? `已选择 ${selectedPhotos.length} 张照片` : '详情'}
        </h2>
      </div>

      {!isMulti && (
        <>
            {/* 预览图通栏展示：无圆角、无内边距与外框，图片按原始比例占满整栏 */}
            <div className="w-full flex flex-col items-center border-b border-[var(--border-subtle)] relative">
                <div key={photo.id} className="w-full overflow-hidden relative group animate-fadeIn">
                    {isVideo ? (
                        <video
                            src={photo.url}
                            controls
                            playsInline
                            preload="metadata"
                            onLoadedMetadata={handleVideoMetadata}
                            onError={() => setVideoStatus('error')}
                            className="w-full aspect-video object-contain bg-black"
                        />
                    ) : isExportMode && previewData ? (
                        <img src={previewData.url} className={PREVIEW_IMG_CLASS} alt="导出预览" />
                    ) : (
                        <PreviewImage photo={photo} alt={photo.name} />
                    )}
                    
                    {isExportMode && isGeneratingPreview && (
                        <div className="absolute inset-0 bg-[rgba(0,0,0,0.6)] flex items-center justify-center backdrop-blur-xs">
                            <div className="w-10 h-10 rounded-full border-2 border-[rgba(255,255,255,0.2)] border-t-[var(--accent-blue)] animate-spin"></div>
                        </div>
                    )}

                    {isExportMode && (
                        <div className="absolute top-2.5 right-2.5 bg-[var(--accent-blue)] text-[var(--accent-contrast)] text-[10px] font-medium px-2.5 py-1 rounded-full shadow-lg">
                            预览
                        </div>
                    )}
                </div>
                
                {/* 文件名：点击即重命名。此处刻意补一个铅笔提示 —— 原先只有一个 title 属性，
                    鼠标没悬停上去之前，完全看不出这行字是可以改的 */}
                <div className="w-full px-2 mt-3.5">
                    {isEditingName ? (
                        <input
                            ref={nameInputRef}
                            type="text"
                            value={tempName}
                            onChange={(e) => setTempName(e.target.value)}
                            onBlur={handleRenameSubmit}
                            onKeyDown={handleNameKeyDown}
                            className="w-full text-center font-medium text-[var(--text-primary)] bg-[var(--bg-input)] border border-[var(--accent-blue)] rounded-full px-3 py-1.5 focus:outline-hidden focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.4)]"
                        />
                    ) : (
                        <button
                            type="button"
                            onClick={startEditing}
                            title="重命名"
                            className="group/name w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full border border-transparent hover:border-[var(--border-subtle)] hover:bg-[var(--bg-glass-hover)] transition-colors duration-200"
                        >
                            <span className="min-w-0 font-medium text-[var(--text-primary)] text-center break-all">{photo.name}</span>
                            <svg className="shrink-0 w-3.5 h-3.5 text-[var(--text-quaternary)] opacity-0 group-hover/name:opacity-100 transition-opacity duration-200" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"></path>
                                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                            </svg>
                        </button>
                    )}
                </div>

                <div className="flex items-center gap-2 mt-2">
                    <p className={`text-xs ${isExportMode ? 'text-[var(--text-tertiary)] line-through' : 'text-[var(--text-secondary)]'}`}>
                        {formatBytes(photo.size)}
                    </p>
                    {isExportMode && previewData && (
                        <>
                            <span className="text-[var(--text-tertiary)]">→</span>
                            <p className={`text-xs font-bold ${previewData.size > photo.size ? 'text-[var(--accent-pink)]' : 'text-[var(--accent-green)]'}`}>
                                {formatBytes(previewData.size)}
                            </p>
                        </>
                    )}
                </div>
                
                {photo.path && (
                    <div className="mt-2 w-full px-2">
                        <p className="text-xs text-[var(--text-tertiary)] truncate text-center leading-snug" title={photo.path}>
                            {(() => {
                                const pathParts = photo.path.split('/');
                                if (pathParts.length <= 5) return photo.path;
                                return `.../${pathParts.slice(-5, -1).join('/')}`;
                            })()}
                        </p>
                    </div>
                )}
            </div>

            <div className="p-5 space-y-6">
                
                {/* 导出与压缩基于 canvas 重编码，仅对图片有意义。
                    这里是「操作」，和下方「文件信息」那类「数据」分开表达：
                    一行标题 + 副标题 + 一个真正的开关（点击区覆盖整行右侧，语义清晰）。 */}
                {!isVideo && (
                <div className="pb-4 border-b border-[var(--border-subtle)]">
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <label className="text-xs font-semibold text-[var(--text-secondary)] block">导出与压缩</label>
                            <p className="text-[11px] text-[var(--text-quaternary)] mt-0.5">转换格式或降低体积后另存</p>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={isExportMode}
                            onClick={() => setIsExportMode(!isExportMode)}
                            title={isExportMode ? '关闭导出与压缩' : '开启导出与压缩'}
                            className="shrink-0 group flex items-center gap-2"
                        >
                            <span className={`text-[11px] font-medium transition-colors ${
                              isExportMode ? 'text-[var(--accent-cyan)]' : 'text-[var(--text-quaternary)] group-hover:text-[var(--text-tertiary)]'
                            }`}>
                                {isExportMode ? '已启用' : '启用'}
                            </span>
                            <span className={`relative w-9 h-5 rounded-full transition-colors duration-200 ${
                              isExportMode ? 'bg-[var(--accent-blue)]' : 'bg-[var(--bg-glass-active)]'
                            }`}>
                                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ease-entrance ${
                                  isExportMode ? 'translate-x-4' : 'translate-x-0'
                                }`} />
                            </span>
                        </button>
                    </div>

                    {isExportMode && (
                        <div className="mt-3 bg-[var(--bg-glass)] rounded-xl p-3 border border-[var(--border-subtle)] space-y-4 animate-fadeIn">
                             <div>
                                 <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block">格式</label>
                                 <div className="flex bg-[var(--bg-input)] rounded-xl p-1 border border-[var(--border-subtle)] shadow-xs">
                                     {['image/jpeg', 'image/png', 'image/webp'].map(fmt => (
                                         <button
                                             key={fmt}
                                             onClick={() => setExportSettings(s => ({ ...s, format: fmt }))}
                                             className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-all ${
                                               exportSettings.format === fmt 
                                                 ? 'bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-hover))] text-[var(--accent-contrast)] shadow-xs' 
                                                 : 'text-[var(--text-secondary)] hover:bg-[var(--bg-glass-hover)]'
                                             }`}
                                         >
                                             {fmt === 'image/jpeg' ? 'JPEG' : fmt === 'image/png' ? 'PNG' : 'WEBP'}
                                         </button>
                                     ))}
                                 </div>
                             </div>

                             {exportSettings.format !== 'image/png' && (
                                 <div>
                                     <div className="flex justify-between mb-1">
                                     <label className="text-xs font-medium text-[var(--text-secondary)]">质量</label>
                                         <span className="text-xs font-medium text-[var(--accent-cyan)]">{Math.round(exportSettings.quality * 100)}%</span>
                                     </div>
                                     <input 
                                         type="range" 
                                         min="0.1" 
                                         max="1" 
                                         step="0.05"
                                         value={exportSettings.quality}
                                         onChange={(e) => setExportSettings(s => ({ ...s, quality: parseFloat(e.target.value) }))}
                                         className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-[var(--accent-blue)]"
                                     />
                                 </div>
                             )}

                             <button
                                 onClick={handleDownload}
                                 className="w-full py-2 bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-hover))] hover:bg-[linear-gradient(135deg,var(--accent-blue-hover),var(--accent-blue))] text-[var(--accent-contrast)] text-xs font-medium rounded-xl shadow-lg shadow-[rgba(var(--accent-blue-rgb),0.3)] transition-all active:scale-95 flex items-center justify-center gap-2"
                             >
                                 <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                                 保存图片
                             </button>
                        </div>
                    )}
                </div>
                )}

                {/* 视频信息：时长 / 分辨率 / 容器只能由播放器读取后上报 */}
                {isVideo && (
                    <div key={`video-${photo.id}`} className="bg-[var(--bg-glass)] rounded-xl p-4 border border-[var(--border-subtle)] animate-fadeIn">
                        <label className="text-xs font-semibold text-[var(--text-secondary)]">视频信息</label>
                        <div className="mt-3 space-y-2.5 text-sm">
                            <div className="flex justify-between">
                                <span className="text-[var(--text-secondary)]">时长</span>
                                <span className={`font-medium tabular-nums ${videoDuration ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]'}`}>
                                    {videoDuration || (videoStatus === 'error' ? '无法读取' : '读取中…')}
                                </span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-[var(--text-secondary)]">分辨率</span>
                                <span className={`font-medium tabular-nums ${photo.dimensions ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]'}`}>
                                    {photo.dimensions ? `${photo.dimensions.width} × ${photo.dimensions.height}` : '—'}
                                </span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-[var(--text-secondary)]">容器格式</span>
                                <span className="font-medium text-[var(--text-primary)] uppercase">{videoExt || '—'}</span>
                            </div>
                        </div>

                        {playbackUncertain && videoStatus !== 'error' && (
                            <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-quaternary)]">
                                该容器（{videoExt.toUpperCase()}）能否播放取决于封装内的编码，可能需要在系统播放器中打开。
                            </p>
                        )}

                        {videoStatus === 'error' && (
                            <div className="mt-3 rounded-lg border border-[rgba(var(--accent-pink-rgb),0.25)] bg-[rgba(var(--accent-pink-rgb),0.08)] p-3">
                                <p className="text-[11px] leading-relaxed text-[var(--accent-pink)]">
                                    无法在应用内解码此视频（编码格式不受支持）。文件本身完好，可用系统播放器打开。
                                </p>
                                {photo.path && (
                                    <button
                                        type="button"
                                        onClick={handleRevealInFinder}
                                        className="mt-2 w-full py-1.5 text-xs font-medium rounded-lg text-[var(--text-secondary)] border border-[var(--border-default)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] transition-all duration-200 active:scale-[0.98]"
                                    >
                                        在访达中显示
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                )}

                <div key={`info-${photo.id}`} className="bg-[var(--bg-glass)] rounded-xl p-4 border border-[var(--border-subtle)] animate-fadeIn">
                    <label className="text-xs font-semibold text-[var(--text-secondary)]">文件信息</label>
                    <div className="mt-3 space-y-3 text-sm">
                        {!isVideo && photo.dimensions && (
                            <div className="flex justify-between">
                                <span className="text-[var(--text-secondary)]">尺寸</span>
                                <span className="text-[var(--text-primary)] font-medium tabular-nums">{photo.dimensions.width} × {photo.dimensions.height}</span>
                            </div>
                        )}
                        <div className="flex justify-between items-start">
                            <span className="text-[var(--text-secondary)]">
                                内容创建时间
                                {photo.dateAdjusted && (
                                    <span
                                        className="ml-1.5 text-[10px] font-medium text-[var(--accent-cyan)]"
                                        title="该时间已被手动调整（原文件未改动）"
                                    >
                                        已修正
                                    </span>
                                )}
                            </span>
                            <span
                                title={photo.dateTaken ? undefined : '该照片未包含拍摄时间（EXIF）信息'}
                                className={`font-medium text-right w-40 truncate ${photo.dateTaken ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]'}`}
                            >
                                {/* 缺失值统一用长破折号：与视频信息里的「分辨率 / 容器格式」保持同一套占位符号 */}
                                {photo.dateTaken ? formatDate(photo.dateTaken) : '—'}
                            </span>
                        </div>
                        <div className="flex justify-between items-start">
                            <span className="text-[var(--text-secondary)]">修改时间</span>
                            <span className="text-[var(--text-primary)] font-medium text-right w-40 truncate">
                                {formatDate(photo.lastModified)}
                            </span>
                        </div>
                        <div className="flex justify-between items-start">
                            <span className="text-[var(--text-secondary)]">创建时间</span>
                            {/* 文件系统没给出 birthtime 时不再拿「修改时间」顶替：
                                两者一旦长得一样，就分不清这是真值还是兜底值 */}
                            <span
                                title={photo.dateCreated ? undefined : '文件系统未提供该文件创建时间（birthtime）'}
                                className={`font-medium text-right w-40 truncate ${photo.dateCreated ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]'}`}
                            >
                                {photo.dateCreated ? formatDate(photo.dateCreated) : '—'}
                            </span>
                        </div>
                        
                        {photo.exif && (photo.exif.make || photo.exif.model || photo.exif.fNumber || photo.exif.orientation || photo.exif.colorSpace || photo.exif.gps) && (
                            <div className="pt-3 mt-3 border-t border-dashed border-[var(--border-subtle)] space-y-2">
                                {photo.exif.model && (
                                    <div className="flex justify-between gap-2">
                                        <span className="text-[var(--text-secondary)] shrink-0">相机</span>
                                        <span className="min-w-0 text-right text-[var(--text-primary)] font-medium truncate" title={photo.exif.model}>{photo.exif.make} {photo.exif.model}</span>
                                    </div>
                                )}
                                {photo.exif.lensModel && (
                                    <div className="flex justify-between gap-2">
                                        <span className="text-[var(--text-secondary)] shrink-0">镜头</span>
                                        <span className="min-w-0 text-right text-[var(--text-primary)] font-medium truncate" title={photo.exif.lensModel}>{photo.exif.lensModel}</span>
                                    </div>
                                )}
                                <div className="flex justify-between text-xs text-[var(--text-tertiary)] font-mono pt-1">
                                    <span>{photo.exif.focalLength ? `${photo.exif.focalLength}` : ''}</span>
                                    <div className="flex gap-2">
                                        <span>{photo.exif.fNumber ? `${photo.exif.fNumber}` : ''}</span>
                                        <span>{photo.exif.exposureTime ? `${photo.exif.exposureTime}s` : ''}</span>
                                        <span>{photo.exif.iso ? `ISO ${photo.exif.iso}` : ''}</span>
                                    </div>
                                </div>
                                {photo.exif.orientation && (
                                    <div className="flex justify-between gap-2">
                                        <span className="text-[var(--text-secondary)] shrink-0">方向</span>
                                        <span className="min-w-0 text-right text-[var(--text-primary)] font-medium truncate">{photo.exif.orientation}</span>
                                    </div>
                                )}
                                {photo.exif.colorSpace && (
                                    <div className="flex justify-between gap-2">
                                        <span className="text-[var(--text-secondary)] shrink-0">色彩空间</span>
                                        <span className="min-w-0 text-right text-[var(--text-primary)] font-medium truncate">{photo.exif.colorSpace}</span>
                                    </div>
                                )}
                                {photo.exif.gps && (
                                    <div className="flex justify-between gap-2">
                                        <span className="text-[var(--text-secondary)] shrink-0">位置</span>
                                        <span
                                            className="min-w-0 text-right text-[var(--text-primary)] font-medium font-mono text-xs truncate"
                                            title={`${photo.exif.gps.latitude}, ${photo.exif.gps.longitude}`}
                                        >
                                            {photo.exif.gps.latitude.toFixed(4)}, {photo.exif.gps.longitude.toFixed(4)}
                                        </span>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                {/* 用户标签：可编辑、参与搜索，也可作为筛选 / 智能相簿条件 */}
                <div key={`tags-${photo.id}`} className="bg-[var(--bg-glass)] rounded-xl p-4 border border-[var(--border-subtle)] animate-fadeIn">
                    <label className="text-xs font-semibold text-[var(--text-secondary)]">标签</label>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                        {(photo.tags ?? []).map(tag => (
                            <span
                                key={tag}
                                className="group flex items-center gap-0.5 pl-2.5 pr-1 py-0.5 rounded-full text-xs font-medium bg-[rgba(var(--accent-cyan-rgb),0.15)] text-[var(--accent-cyan)] border border-[rgba(var(--accent-cyan-rgb),0.25)]"
                            >
                                #{tag}
                                <button
                                    type="button"
                                    onClick={() => handleRemoveTag(tag)}
                                    title={`移除标签「${tag}」`}
                                    className="flex items-center justify-center w-4 h-4 rounded-full text-[var(--accent-cyan)] hover:bg-[rgba(var(--accent-cyan-rgb),0.25)] transition-colors"
                                >
                                    <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3" strokeLinecap="round">
                                        <path d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                </button>
                            </span>
                        ))}
                        {(photo.tags ?? []).length === 0 && (
                            <span className="text-xs text-[var(--text-quaternary)]">还没有标签</span>
                        )}
                    </div>

                    <div className="mt-3 flex gap-2">
                        <input
                            type="text"
                            value={tagInput}
                            onChange={e => setTagInput(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    handleAddTag(tagInput);
                                }
                            }}
                            placeholder="输入标签后回车"
                            className="flex-1 min-w-0 px-3 py-2 text-xs rounded-lg bg-[var(--bg-input)] border border-[var(--border-subtle)] text-[var(--text-primary)] placeholder-[var(--text-quaternary)] outline-hidden focus:border-[var(--accent-blue)] focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.25)] transition-all"
                        />
                        <button
                            type="button"
                            onClick={() => handleAddTag(tagInput)}
                            disabled={!tagInput.trim()}
                            className="shrink-0 px-3 py-2 text-xs font-medium rounded-lg text-[var(--text-secondary)] border border-[var(--border-default)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            添加
                        </button>
                    </div>
                    <p className="mt-2 text-[11px] text-[var(--text-quaternary)]">
                        标签会参与搜索，也可在筛选面板中按标签过滤。
                    </p>
                </div>

                {/* AI 分析需要把整段内容读成 base64，视频体积过大，暂不提供 */}
                {!isVideo && (
                <div className="rounded-xl p-4 border border-[var(--border-subtle)] bg-[var(--bg-glass)]">
                    <div className="flex items-center justify-between mb-3">
                         <label className="text-xs font-semibold text-[var(--text-secondary)] flex items-center gap-1">
                            ✨ DeepSeek AI 分析
                         </label>
                         <button
                            type="button"
                            onClick={() => onOpenAiSettings?.()}
                            title="AI 设置（配置 API Key / 接口地址 / 模型）"
                            aria-label="打开 AI 设置"
                            className="flex items-center justify-center w-6 h-6 rounded-lg text-[var(--text-quaternary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] transition-all duration-200"
                         >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="3"></circle>
                                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10.6 3V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 16.09 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 20.4 9v.09A1.65 1.65 0 0 0 21.6 10.6H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                            </svg>
                         </button>
                    </div>
                    
                    {!photo.aiDescription && !photo.aiTags && (
                         <button 
                            onClick={handleAnalyze}
                            disabled={isAnalyzing}
                            className="w-full py-2.5 bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-hover))] hover:brightness-110 text-[var(--accent-contrast)] text-sm font-medium rounded-xl shadow-lg shadow-[rgba(var(--accent-blue-rgb),0.25)] transition-all duration-200 active:scale-[0.98] disabled:opacity-70 disabled:cursor-not-allowed flex justify-center items-center gap-2"
                         >
                            {isAnalyzing ? (
                                <>
                                    <div className="w-4 h-4 rounded-full border-2 border-[color-mix(in_srgb,var(--accent-contrast)_30%,transparent)] border-t-[var(--accent-contrast)] animate-spin"></div>
                                    分析中...
                                </>
                            ) : (
                                '分析图片'
                            )}
                         </button>
                    )}

                    {(photo.aiDescription || photo.aiTags) && (
                        <div className="bg-[var(--bg-input)] rounded-xl p-4 border border-[var(--border-subtle)] animate-fadeInUp">
                             {photo.aiDescription && (
                                 <p className="text-sm text-[var(--text-primary)] italic mb-3 leading-relaxed">“{photo.aiDescription}”</p>
                             )}
                             {photo.aiTags && (
                                 <div className="flex flex-wrap gap-1.5">
                                     {photo.aiTags.map(tag => (
                                         <span key={tag} className="px-2.5 py-0.5 bg-[rgba(var(--accent-cyan-rgb),0.15)] text-[var(--accent-cyan)] border border-[rgba(var(--accent-cyan-rgb),0.25)] rounded-full text-xs font-medium">
                                             #{tag}
                                         </span>
                                     ))}
                                 </div>
                             )}
                        </div>
                    )}
                </div>
                )}
            </div>
        </>
      )}

      {isMulti && (
          <div className="p-5">
              <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                  对多张照片的操作用图库上方的操作条完成：收藏、重命名、移动到文件夹、导出或移入回收站。
              </p>
              <div className="mt-4 p-4 bg-[var(--bg-glass)] rounded-lg border border-[var(--border-subtle)]">
                  <div className="flex justify-between mb-2">
                    <span className="text-[var(--text-secondary)] text-sm">总大小</span>
                    <span className="text-[var(--text-primary)] font-medium text-sm">
                        {formatBytes(selectedPhotos.reduce((acc, p) => acc + p.size, 0))}
                    </span>
                  </div>
              </div>
          </div>
      )}
      </div>
    </div>
  );
};

export default DetailsPane;
