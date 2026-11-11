import { useMemo, useState } from 'react';
import type { Photo } from '@/types';
import {
  normalizeTag,
  suggestTags,
  tagCoverage,
  type RankedTag,
  type TagOperation,
} from '@/lib/tags/tagOperations';

/**
 * 多选时的批量标签面板（v0.7.0 第一批 / D9）。
 *
 * 独立成组件，避免继续把 1000 行的 DetailsPane 往上堆。
 * 所有数字都来自 tagOperations 的纯函数，与侧栏标签列表同源。
 */

export interface BatchTagsPanelProps {
  selectedPhotos: Photo[];
  /** 全库标签频次，供输入建议与常用标签 */
  rankedTags: RankedTag[];
  isApplying: boolean;
  progress: { done: number; total: number } | null;
  onApply: (op: TagOperation) => void;
  onCancel: () => void;
}

export const BatchTagsPanel = ({
  selectedPhotos,
  rankedTags,
  isApplying,
  progress,
  onApply,
  onCancel,
}: BatchTagsPanelProps) => {
  const [input, setInput] = useState('');
  const coverage = useMemo(() => tagCoverage(selectedPhotos).slice(0, 5), [selectedPhotos]);
  const suggestions = useMemo(() => suggestTags(rankedTags, input), [rankedTags, input]);
  const tag = normalizeTag(input);

  const submit = (kind: TagOperation['kind']) => {
    if (!tag || isApplying) return;
    onApply({ kind, tag });
    setInput('');
  };

  const percent =
    progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="bg-[var(--bg-glass)] rounded-xl p-4 border border-[var(--border-subtle)]">
      <div className="flex items-baseline justify-between gap-2">
        <label className="text-xs font-semibold text-[var(--text-secondary)]">批量标签</label>
        <span className="text-xs text-[var(--text-quaternary)] tabular-nums">
          已选 {selectedPhotos.length} 张
        </span>
      </div>

      {coverage.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {coverage.map((item) => (
            <button
              key={item.name}
              type="button"
              onClick={() => onApply({ kind: 'remove', tag: item.name })}
              disabled={isApplying}
              title={`从所选照片移除标签「${item.name}」`}
              className="px-2 py-0.5 rounded-full text-xs bg-[rgba(var(--accent-cyan-rgb),0.15)] text-[var(--accent-cyan)] border border-[rgba(var(--accent-cyan-rgb),0.25)] hover:opacity-80 disabled:opacity-50"
            >
              #{item.name} ×{item.count}
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit('add');
            }
          }}
          placeholder="输入标签名，回车添加"
          disabled={isApplying}
          className="min-w-0 flex-1 px-3 py-1.5 bg-[var(--bg-input)] border border-[var(--border-default)] rounded-lg text-xs text-[var(--text-primary)] placeholder-[var(--text-quaternary)] outline-hidden focus:border-[var(--accent-blue)] disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => submit('add')}
          disabled={!tag || isApplying}
          className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium text-[var(--accent-contrast)] bg-[var(--accent-blue)] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          添加
        </button>
        <button
          type="button"
          onClick={() => submit('remove')}
          disabled={!tag || isApplying}
          title="从所选照片移除这个标签"
          className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium text-[var(--text-secondary)] border border-[var(--border-default)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          移除
        </button>
      </div>

      {suggestions.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <span className="text-xs text-[var(--text-quaternary)]">常用</span>
          {suggestions.map((item) => (
            <button
              key={item.name}
              type="button"
              onClick={() => onApply({ kind: 'add', tag: item.name })}
              disabled={isApplying}
              className="text-xs text-[var(--text-tertiary)] hover:text-[var(--accent-blue)] px-1.5 py-0.5 rounded hover:bg-[var(--bg-glass-hover)] disabled:opacity-50"
              title={`${item.count} 张照片使用；点击添加到所选照片`}
            >
              #{item.name}
            </button>
          ))}
        </div>
      )}

      {isApplying && progress && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs text-[var(--text-tertiary)] tabular-nums">
            <span>
              正在处理 {progress.done} / {progress.total}
            </span>
            <button
              type="button"
              onClick={onCancel}
              className="text-[var(--accent-pink)] hover:opacity-80"
            >
              取消
            </button>
          </div>
          <div className="mt-1.5 h-1 rounded-full bg-[var(--bg-glass-hover)] overflow-hidden">
            <div
              className="h-full rounded-full bg-[var(--accent-blue)] transition-[width] duration-150"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      )}

      <p className="mt-3 text-xs leading-relaxed text-[var(--text-quaternary)]">
        整批只写一次配置；完成后可在提示里「撤销」本次操作。
      </p>
    </div>
  );
};

export default BatchTagsPanel;
