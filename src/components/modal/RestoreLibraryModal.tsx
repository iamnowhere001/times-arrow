import React, { useEffect, useRef } from 'react';

interface RestoreLibraryModalProps {
  isOpen: boolean;
  /** 上次记录的全部来源数量（文件夹 + 单独文件） */
  sourceCount: number;
  /** 文件夹来源数量 */
  directoryCount: number;
  /** 单独添加的文件数量 */
  fileCount: number;
  /** 文件夹名称（最多取前几个展示，让人一眼认出「上次的图库」） */
  directoryNames: string[];
  /** 当前不可用的来源数量（文件夹不存在 / 卷未挂载） */
  unavailableCount: number;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * 「恢复上次的图库」确认框（N8）。
 *
 * 重启后不静默扫描用户磁盘，也不让用户每次开机重找目录：
 * 先问一次，确认后再按来源逐项重扫（复用导入进度浮层与取消链路）。
 * 文案把「会恢复哪些目录」摆出来，让确认有依据，而不是一个抽象的是 / 否。
 */
const RestoreLibraryModal: React.FC<RestoreLibraryModalProps> = ({
  isOpen,
  sourceCount,
  directoryCount,
  fileCount,
  directoryNames,
  unavailableCount,
  onClose,
  onConfirm,
}) => {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Esc 暂不恢复、Enter 恢复：与系统弹窗一致的键盘习惯
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose, onConfirm]);

  useEffect(() => {
    if (isOpen) confirmRef.current?.focus();
  }, [isOpen]);

  if (!isOpen) return null;

  const preview = directoryNames.slice(0, 4);
  const restCount = directoryCount - preview.length;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(0,0,0,0.7)] backdrop-blur-md animate-fadeIn"
      onClick={onClose}
    >
      <div
        className="bg-[var(--bg-modal)] backdrop-blur-xl rounded-xl shadow-2xl w-[440px] max-w-[90vw] overflow-hidden border border-[var(--border-subtle)] animate-scaleIn p-6"
        role="dialog"
        aria-modal="true"
        aria-label="恢复上次的图库"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-4 mb-5">
          <div className="shrink-0 w-10 h-10 rounded-full bg-[rgba(var(--accent-blue-rgb),0.15)] flex items-center justify-center">
            <svg
              className="w-5 h-5 text-[var(--accent-blue)]"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path>
              <path d="M3 3v5h5"></path>
            </svg>
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-[var(--text-primary)]">恢复上次的图库</h3>
            <p className="text-sm text-[var(--text-secondary)] mt-1 leading-relaxed">
              上次整理时有 {directoryCount} 个文件夹
              {fileCount > 0 ? `（另有 ${fileCount} 个单独添加的文件）` : ''}
              ，共 {sourceCount} 个来源。是否重新扫描并恢复？
            </p>
          </div>
        </div>

        {preview.length > 0 && (
          <div className="mb-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-glass)] px-3.5 py-2.5 space-y-1">
            {preview.map((name, index) => (
              <p
                key={`${index}-${name}`}
                className="text-xs text-[var(--text-secondary)] truncate"
                title={name}
              >
                {name}
              </p>
            ))}
            {restCount > 0 && (
              <p className="text-xs text-[var(--text-quaternary)]">另有 {restCount} 个文件夹…</p>
            )}
          </div>
        )}

        <p className="text-xs text-[var(--text-tertiary)] leading-relaxed mb-5">
          收藏、标签、时间修正与 AI 结果会按原路径自动对上，不必重新整理。
          {unavailableCount > 0
            ? `其中 ${unavailableCount} 个来源当前不可用（已移动或未挂载），恢复后会单独标注。`
            : ''}
        </p>

        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-glass-hover)] rounded-lg transition-colors"
          >
            暂不恢复
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className="px-4 py-2 text-sm font-semibold text-[var(--accent-contrast)] bg-[var(--accent-blue)] hover:opacity-90 rounded-lg transition-opacity"
          >
            恢复图库
          </button>
        </div>
      </div>
    </div>
  );
};

export default RestoreLibraryModal;
