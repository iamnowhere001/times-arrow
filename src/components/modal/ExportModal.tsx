
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Photo } from '@/types';
import { logger } from '@/lib/logger';
import { humanizeFsError, isFileGoneError } from '@/lib/fs/fileOperations';

export type ExportFormat = 'original' | 'image/jpeg' | 'image/png' | 'image/webp';

export interface ExportSummary {
  succeeded: number;
  failed: number;
  cancelled: boolean;
  /** 首个失败原因（已翻译成用户可读的说明），供调用方在汇总里带上 */
  firstError?: string;
  /** 实际写入的目标目录，让用户知道文件去哪了 */
  targetDir: string;
  /**
   * 源文件已不在磁盘（外部删除 / 移动）的照片：调用方应把它们从列表剔除，
   * 并从「重新导出」集合中排除 —— 再试多少次都只会失败。
   */
  gonePhotos?: Photo[];
}

interface ExportModalProps {
  isOpen: boolean;
  /** 待导出的照片（通常是当前选中项） */
  photos: Photo[];
  onClose: () => void;
  /** 导出结束回调：计入成功 / 失败 / 取消与首个失败原因 */
  onFinish: (summary: ExportSummary) => void;
}

/**
 * 导出失败原因：已经是面向用户的中文说明（如「图片解码失败」）就原样保留，
 * 只有 fs 原始错误（ENOENT / ENOSPC…）才需要翻译。
 */
const describeExportError = (err: unknown): string => {
  const message = (err as Error)?.message ?? '';
  if (/[\u4e00-\u9fa5]/.test(message)) return message;
  return humanizeFsError(message);
};

/** 格式 → 扩展名 */
const extOf = (format: ExportFormat, originalName: string): string => {
  if (format === 'original') {
    const ext = originalName.includes('.') ? originalName.split('.').pop()! : 'jpg';
    return ext.toLowerCase();
  }
  if (format === 'image/png') return 'png';
  if (format === 'image/webp') return 'webp';
  return 'jpg';
};

/**
 * 单张导出：
 *  - original：主进程直接读 base64 落盘（不解码，HEIC 也能导）
 *  - 转换格式：img → canvas → toBlob 再落盘
 * 同名冲突由主进程 writeFileUnique 自动追加序号。
 */
const exportOne = async (
  photo: Photo,
  format: ExportFormat,
  quality: number,
  targetDir: string
): Promise<void> => {
  const baseName = photo.name.includes('.')
    ? photo.name.substring(0, photo.name.lastIndexOf('.'))
    : photo.name;
  const fileName = `${baseName}.${extOf(format, photo.name)}`;

  if (!photo.path || !window.electronAPI) {
    throw new Error('缺少磁盘路径');
  }

  if (format === 'original') {
    const readRes = await window.electronAPI.readFile(photo.path);
    if (!readRes.ok) throw new Error(readRes.error);
    const result = await window.electronAPI.writeFileUnique(targetDir, fileName, readRes.data);
    if (!result.ok) throw new Error(result.error);
    return;
  }

  // 格式转换路径
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('图片解码失败（HEIC 等格式请选择「原格式」导出）'));
    el.src = photo.url;
  });

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 不可用');
  // JPEG 无透明通道：白底填充避免透明区域变黑
  if (format === 'image/jpeg') {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(img, 0, 0);

  const blob = await new Promise<Blob | null>(resolve =>
    canvas.toBlob(resolve, format, quality)
  );
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new Error('格式转换失败');

  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = () => reject(new Error('读取转换结果失败'));
    reader.readAsDataURL(blob);
  });

  const result = await window.electronAPI.writeFileUnique(targetDir, fileName, base64);
  if (!result.ok) throw new Error(result.error);
};

const ExportModal: React.FC<ExportModalProps> = ({ isOpen, photos, onClose, onFinish }) => {
  const [format, setFormat] = useState<ExportFormat>('image/jpeg');
  const [quality, setQuality] = useState(0.9);
  const [targetDir, setTargetDir] = useState<string | null>(null);

  // 导出进行中的状态
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentFile, setCurrentFile] = useState('');
  const cancelRef = useRef(false);

  useEffect(() => {
    if (isOpen) {
      setFormat('image/jpeg');
      setQuality(0.9);
      setTargetDir(null);
      setIsExporting(false);
      setProgress(0);
      setCurrentFile('');
      cancelRef.current = false;
    }
  }, [isOpen]);

  // Esc：导出中视为取消请求，否则直接关闭
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (isExporting) cancelRef.current = true;
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, isExporting, onClose]);

  const pickDirectory = useCallback(async () => {
    if (!window.electronAPI) return;
    const res = await window.electronAPI.chooseDirectory();
    // 用户取消选择时 data 为 null，属正常结果，不提示
    if (res.ok && res.data) setTargetDir(res.data);
  }, []);

  const startExport = useCallback(async () => {
    if (!targetDir || photos.length === 0) return;
    setIsExporting(true);
    setProgress(0);
    cancelRef.current = false;

    let succeeded = 0;
    let failed = 0;
    let cancelled = false;
    let firstError: string | undefined;
    const gonePhotos: Photo[] = [];

    for (let i = 0; i < photos.length; i++) {
      if (cancelRef.current) {
        cancelled = true;
        break;
      }
      setCurrentFile(photos[i].name);
      try {
        await exportOne(photos[i], format, quality, targetDir);
        succeeded++;
      } catch (err) {
        logger.error(`导出 ${photos[i].name} 失败:`, err);
        failed++;
        // 读取源文件时 ENOENT = 文件已被外部删除 / 移动：单独收集，由调用方剔除出列表
        if (isFileGoneError((err as Error)?.message)) gonePhotos.push(photos[i]);
        // 只留首个原因：汇总里带一句就够，逐条弹提示反而会被 Toast 队列顶掉
        firstError ??= describeExportError(err);
      }
      setProgress(i + 1);
    }

    setIsExporting(false);
    onFinish({ succeeded, failed, cancelled, firstError, targetDir, gonePhotos });
  }, [targetDir, photos, format, quality, onFinish]);

  if (!isOpen) return null;

  const formatOptions: Array<{ value: ExportFormat; label: string; hint: string }> = [
    { value: 'original', label: '原格式', hint: '直接复制，不重新编码' },
    { value: 'image/jpeg', label: 'JPEG', hint: '通用兼容' },
    { value: 'image/png', label: 'PNG', hint: '无损' },
    { value: 'image/webp', label: 'WebP', hint: '更小体积' },
  ];
  const qualityFormats = format === 'image/jpeg' || format === 'image/webp';
  const percent = photos.length > 0 ? Math.round((progress / photos.length) * 100) : 0;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--bg-overlay)] backdrop-blur-md animate-fadeIn">
      <div
        className="bg-[var(--bg-elevated)] backdrop-blur-xl rounded-2xl shadow-2xl w-[440px] max-w-[90vw] overflow-hidden border border-[var(--border-subtle)] flex flex-col max-h-[90vh]"
        role="dialog"
        aria-modal="true"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-[var(--border-subtle)]">
          <h3 className="text-lg font-semibold text-[var(--text-primary)]">导出照片</h3>
          <p className="text-sm text-[var(--text-tertiary)] mt-1">
            {isExporting ? `正在导出 ${progress} / ${photos.length}` : `已选择 ${photos.length} 张照片`}
          </p>
        </div>

        <div className="p-6 space-y-5 overflow-y-auto">
          {/* 格式选择 */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-2.5">输出格式</label>
            <div className="grid grid-cols-2 gap-2">
              {formatOptions.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setFormat(opt.value)}
                  disabled={isExporting}
                  className={`px-3 py-2.5 rounded-xl border text-left transition-all disabled:opacity-60 ${
                    format === opt.value
                      ? 'border-[var(--accent-blue)] bg-[rgba(var(--accent-blue-rgb),0.12)]'
                      : 'border-[var(--border-subtle)] hover:border-[var(--border-hover)] bg-[var(--bg-input)]'
                  }`}
                >
                  <span className={`block text-sm font-medium ${format === opt.value ? 'text-[var(--accent-blue)]' : 'text-[var(--text-primary)]'}`}>
                    {opt.label}
                  </span>
                  <span className="block text-xs text-[var(--text-quaternary)] mt-0.5">{opt.hint}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 质量滑块（仅 JPEG / WebP） */}
          {qualityFormats && (
            <div>
              <div className="flex justify-between items-center mb-2">
                <label className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">质量</label>
                <span className="text-xs font-mono text-[var(--accent-cyan)]">{Math.round(quality * 100)}%</span>
              </div>
              <input
                type="range"
                min={0.5}
                max={1}
                step={0.05}
                value={quality}
                onChange={e => setQuality(parseFloat(e.target.value))}
                disabled={isExporting}
                className="w-full accent-[var(--accent-blue)]"
              />
            </div>
          )}

          {/* 目标目录 */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-2.5">保存到</label>
            <button
              onClick={pickDirectory}
              disabled={isExporting}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-input)] hover:border-[var(--border-hover)] transition-all text-left disabled:opacity-60"
            >
              <svg className="w-5 h-5 shrink-0 text-[var(--accent-blue)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.8">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" strokeLinecap="round" strokeLinejoin="round"></path>
              </svg>
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-[var(--text-primary)] truncate">
                  {targetDir ? targetDir.split('/').pop() : '选择导出文件夹…'}
                </span>
                {targetDir && (
                  <span className="block text-xs text-[var(--text-quaternary)] truncate">{targetDir}</span>
                )}
              </span>
            </button>
          </div>

          {/* 进度 */}
          {isExporting && (
            <div className="space-y-2 animate-fadeIn">
              <div className="relative h-2 bg-[var(--bg-glass)] rounded-full overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 bg-gradient-to-r from-[var(--accent-blue)] via-[var(--accent-cyan)] to-[var(--accent-purple)] rounded-full transition-all duration-300"
                  style={{ width: `${Math.max(5, percent)}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-[var(--text-quaternary)]">
                <span className="truncate font-mono">{currentFile}</span>
                <span className="shrink-0 ml-2">{percent}%</span>
              </div>
            </div>
          )}
        </div>

        {/* 操作区 */}
        <div className="px-6 py-4 border-t border-[var(--border-subtle)] flex justify-end gap-3">
          {isExporting ? (
            <button
              onClick={() => { cancelRef.current = true; }}
              className="px-4 py-2 text-sm font-medium rounded-xl text-[var(--text-secondary)] hover:bg-[var(--bg-glass-hover)] transition-colors"
            >
              取消导出
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium rounded-xl text-[var(--text-secondary)] hover:bg-[var(--bg-glass-hover)] transition-colors"
              >
                取消
              </button>
              <button
                onClick={startExport}
                disabled={!targetDir || photos.length === 0}
                className="px-5 py-2 text-sm font-semibold rounded-xl text-[var(--accent-contrast)] bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-hover))] shadow-lg shadow-[rgba(var(--accent-blue-rgb),0.3)] hover:shadow-xl hover:shadow-[rgba(var(--accent-blue-rgb),0.4)] transition-all duration-200 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
              >
                导出 {photos.length} 张
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default ExportModal;
