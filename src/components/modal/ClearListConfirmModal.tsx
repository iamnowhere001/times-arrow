import React, { useEffect, useRef } from 'react';

interface ClearListConfirmModalProps {
  isOpen: boolean;
  /** 将被清空的条目数，让「清空」这件事有具体规模，而不是抽象按钮 */
  count: number;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * 清空照片列表确认框。
 *
 * 名字直说后果：清空的是列表，磁盘文件不动。此前的入口写作「重置」，
 * 既没说是清空照片、也没说清空的是哪一层，且是无确认的直接执行 ——
 * 与「移至回收站」的谨慎程度不对等。这里统一收口：
 * 入口可以做得更轻（侧栏底部次级按钮），但执行前必须把代价说清楚。
 */
const ClearListConfirmModal: React.FC<ClearListConfirmModalProps> = ({
  isOpen,
  count,
  onClose,
  onConfirm,
}) => {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Esc 关闭、Enter 确认：保持与系统弹窗一致的键盘习惯
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

  // 焦点落到主操作按钮上：键盘用户一眼能看出回车会落在哪
  useEffect(() => {
    if (isOpen) confirmRef.current?.focus();
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(0,0,0,0.7)] backdrop-blur-md animate-fadeIn">
      <div
        className="bg-[var(--bg-modal)] backdrop-blur-xl rounded-xl shadow-2xl w-[400px] max-w-[90vw] overflow-hidden border border-[var(--border-subtle)] animate-scaleIn p-6"
        role="dialog"
        aria-modal="true"
        aria-label="清空照片列表确认"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-4 mb-5">
          <div className="shrink-0 w-10 h-10 rounded-full bg-[rgba(var(--accent-pink-rgb),0.15)] flex items-center justify-center">
            <svg className="w-5 h-5 text-[var(--accent-pink)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
            </svg>
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-[var(--text-primary)]">清空照片列表</h3>
            <p className="text-sm text-[var(--text-secondary)] mt-1 leading-relaxed">
              当前的 {count} 个照片将从列表中全部移除，筛选、搜索与缩略图缓存一并重置，
              记录的来源也会清空（下次启动不再自动恢复）。磁盘上的原文件不会被删除，
              之后重新打开文件夹或添加文件即可恢复。
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-glass-hover)] rounded-lg transition-colors"
          >
            取消
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className="px-4 py-2 text-sm font-semibold text-[var(--accent-contrast)] bg-[var(--accent-pink)] hover:opacity-90 rounded-lg transition-opacity"
          >
            清空列表
          </button>
        </div>
      </div>
    </div>
  );
};

export default ClearListConfirmModal;
