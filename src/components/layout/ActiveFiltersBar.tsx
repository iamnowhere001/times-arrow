import React from 'react';
import { PhotoFilters } from '../types';
import { buildFilterChips, isFilterActive } from '../filters';

interface ActiveFiltersBarProps {
  filters: PhotoFilters;
  /** 单条条件的清除补丁 */
  onPatch: (patch: Partial<PhotoFilters>) => void;
  /** 一键清除全部筛选 */
  onReset: () => void;
  /** 把当前条件存为智能相簿 */
  onSaveAsAlbum: () => void;
  /** 当前筛选命中的结果数，用于即时反馈 */
  resultCount: number;
  /** 结果总数（清除筛选后的大小），用于「N / M」表达 */
  totalCount: number;
}

const CloseIcon = () => (
  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5" strokeLinecap="round">
    <path d="M6 18L18 6M6 6l12 12" />
  </svg>
);

const FunnelIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
  </svg>
);

/**
 * 已启用筛选条件条（N3）。
 * 存在的意义是「所见即所得」：任何会缩小结果集的条件都在这里显式列出，
 * 既能一眼看清当前视图为什么少了照片，也能逐条或一次性清除。
 */
const ActiveFiltersBar: React.FC<ActiveFiltersBarProps> = ({
  filters,
  onPatch,
  onReset,
  onSaveAsAlbum,
  resultCount,
  totalCount,
}) => {
  if (!isFilterActive(filters)) return null;

  const chips = buildFilterChips(filters);

  return (
    <div className="mx-4 mt-3 shrink-0 rounded-xl border border-[rgba(var(--accent-blue-rgb),0.25)] bg-[rgba(var(--accent-blue-rgb),0.07)] backdrop-blur-xl px-3 py-2 flex items-center gap-2 flex-wrap">
      <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--accent-blue)] shrink-0">
        <FunnelIcon />
        筛选
      </span>

      {chips.map(chip => (
        <button
          key={chip.key}
          type="button"
          onClick={() => onPatch(chip.patch)}
          title={`清除「${chip.label}」`}
          className="group flex items-center gap-1 pl-2 pr-1.5 py-0.5 rounded-full bg-[var(--bg-glass)] border border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] hover:border-[var(--border-hover)] hover:text-[var(--text-primary)] transition-all duration-200 max-w-[200px]"
        >
          <span className="truncate">{chip.label}</span>
          <span className="flex items-center justify-center w-4 h-4 rounded-full text-[var(--text-tertiary)] group-hover:bg-[var(--bg-glass-hover)] group-hover:text-[var(--text-primary)] transition-colors shrink-0">
            <CloseIcon />
          </span>
        </button>
      ))}

      <span className="text-xs text-[var(--text-tertiary)] tabular-nums shrink-0">
        {resultCount} / {totalCount} 项
      </span>

      <div className="flex-1 min-w-2" />

      <button
        type="button"
        onClick={onSaveAsAlbum}
        title="把当前条件保存为智能相簿，内容会随图库自动更新"
        className="shrink-0 flex items-center gap-1 text-xs font-medium text-[var(--accent-blue)] px-2 py-1 rounded-lg hover:bg-[rgba(var(--accent-blue-rgb),0.12)] transition-all duration-200"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
          <polyline points="17 21 17 13 7 13 7 21" />
          <polyline points="7 3 7 8 15 8" />
        </svg>
        存为相簿
      </button>

      <button
        type="button"
        onClick={onReset}
        className="shrink-0 text-xs font-medium text-[var(--text-tertiary)] hover:text-[var(--accent-pink)] px-2 py-1 rounded-lg hover:bg-[var(--bg-glass-hover)] transition-all duration-200"
      >
        清除全部
      </button>
    </div>
  );
};

export default ActiveFiltersBar;
