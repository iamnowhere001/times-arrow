import React, { useEffect, useRef, useState } from 'react';
import { PhotoFilters } from '@/types';
import { buildFilterChips, isFilterActive } from '@/lib/filter/filters';

interface SaveAlbumModalProps {
  isOpen: boolean;
  /** 要保存的筛选条件（通常是当前视图） */
  filters: PhotoFilters;
  onClose: () => void;
  onSave: (name: string) => void;
}

const SUGGESTED_NAMES = ['我的精选', '待整理', '家人', '旅行'];

/**
 * 把当前筛选条件存成智能相簿。
 * 相簿只记录条件，因此日后新增的照片只要符合条件就会自动进入相簿。
 */
const SaveAlbumModal: React.FC<SaveAlbumModalProps> = ({ isOpen, filters, onClose, onSave }) => {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const chips = buildFilterChips(filters);
  const hasConditions = isFilterActive(filters);

  useEffect(() => {
    if (!isOpen) return;
    setName('');
    const timer = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const trimmed = name.trim();
  const canSave = hasConditions && trimmed.length > 0;

  const submit = () => {
    if (canSave) onSave(trimmed);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[var(--bg-overlay)] backdrop-blur-md animate-fadeIn">
      <div
        className="bg-[var(--bg-elevated)] backdrop-blur-xl rounded-2xl shadow-2xl w-[440px] max-w-[90vw] overflow-hidden border border-[var(--border-default)] animate-scaleIn flex flex-col"
        role="dialog"
        aria-modal="true"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-[var(--border-subtle)]">
          <h3 className="text-lg font-semibold text-[var(--text-primary)]">存为智能相簿</h3>
          <p className="text-sm text-[var(--text-tertiary)] mt-1">
            相簿保存的是筛选条件；符合条件的新照片会自动进入相簿。
          </p>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-[var(--text-tertiary)] mb-1.5">相簿名称</label>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="例如：2024 旅行"
              className="w-full px-4 py-2.5 bg-[var(--bg-input)] border border-[var(--border-default)] rounded-xl text-sm text-[var(--text-primary)] placeholder-[var(--text-quaternary)] outline-hidden focus:border-[var(--accent-blue)] focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.25)] transition-all"
            />
          </div>

          {!trimmed && (
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTED_NAMES.map(suggestion => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => setName(suggestion)}
                  className="px-2.5 py-1 rounded-lg text-xs text-[var(--text-secondary)] bg-[var(--bg-glass)] border border-[var(--border-subtle)] hover:border-[var(--border-hover)] hover:text-[var(--text-primary)] transition-all"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}

          <div className="border border-[var(--border-subtle)] bg-[var(--bg-glass)] rounded-xl p-4">
            <p className="text-xs font-medium text-[var(--text-quaternary)] mb-2.5">包含以下条件</p>
            {hasConditions ? (
              <div className="flex flex-wrap gap-1.5">
                {chips.map(chip => (
                  <span
                    key={chip.key}
                    className="px-2 py-0.5 rounded-full text-xs text-[var(--text-secondary)] bg-[var(--bg-input)] border border-[var(--border-subtle)]"
                  >
                    {chip.label}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-[var(--accent-pink)]">
                当前没有任何筛选条件，请先设置筛选（如「仅收藏」或在筛选面板中选择条件）。
              </p>
            )}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-[var(--border-subtle)] flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-6 py-2.5 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] border border-[var(--border-default)] rounded-xl transition-all duration-200"
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={!canSave}
            className={`px-6 py-2.5 text-sm font-semibold rounded-xl transition-all duration-200 ${
              canSave
                ? 'text-[var(--accent-contrast)] bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-hover))] shadow-lg shadow-[rgba(var(--accent-blue-rgb),0.3)] active:scale-[0.98]'
                : 'text-[var(--text-quaternary)] bg-[var(--bg-input)] border border-[var(--border-subtle)] cursor-not-allowed'
            }`}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
};

export default SaveAlbumModal;
