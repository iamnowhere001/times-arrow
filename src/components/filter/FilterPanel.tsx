import React from 'react';
import { PhotoFilters } from '@/types';
import {
  DATE_PRESET_OPTIONS,
  DURATION_FILTER_OPTIONS,
  MEDIA_FILTER_LABELS,
  MEDIA_FILTER_OPTIONS,
  SIZE_FILTER_OPTIONS,
  datePresetRange,
  endOfDayFromInput,
  matchDatePreset,
  startOfDayFromInput,
  toDateInputValue,
  toggleInList,
} from '@/lib/filter/filters';

interface FilterPanelProps {
  filters: PhotoFilters;
  /** 只更新传入的字段，其余保持不变 */
  onChange: (patch: Partial<PhotoFilters>) => void;
  /** 一键重置为默认视图 */
  onReset: () => void;
  /** 从当前库提取的可选项 */
  options: { cameras: string[]; formats: string[]; tags: string[] };
  /** 库中是否含视频：决定是否展示时长筛选 */
  hasVideos: boolean;
  onClose: () => void;
}

/** 小号可选胶囊：分段选择与多选清单共用一套视觉 */
const Chip: React.FC<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}> = ({ active, onClick, children, title }) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    aria-pressed={active}
    className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all duration-200 active:scale-[0.97] ${
      active
        ? 'border-[var(--accent-blue)] bg-[rgba(var(--accent-blue-rgb),0.14)] text-[var(--accent-blue)]'
        : 'border-[var(--border-subtle)] bg-[var(--bg-input)] text-[var(--text-secondary)] hover:border-[var(--border-hover)] hover:text-[var(--text-primary)]'
    }`}
  >
    {children}
  </button>
);

const SectionTitle: React.FC<{ children: React.ReactNode; extra?: React.ReactNode }> = ({
  children,
  extra,
}) => (
  <div className="flex items-center justify-between mb-2">
    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-quaternary)]">
      {children}
    </h3>
    {extra}
  </div>
);

/**
 * 高级筛选面板（N3）。
 * 与搜索框、侧栏分类共同组成「可组合筛选」：面板只负责编辑条件，
 * 真正过滤由 `filters.ts` 的纯函数完成，保证与条件条 / 列表结果一致。
 */
const FilterPanel: React.FC<FilterPanelProps> = ({
  filters,
  onChange,
  onReset,
  options,
  hasVideos,
  onClose,
}) => {
  const datePreset = matchDatePreset(filters);

  const applyPreset = (preset: 'today' | '7d' | '30d' | 'year') => {
    const range = datePresetRange(preset);
    // 再点一次已选中的预设 → 取消日期条件
    if (filters.dateFrom === range.from && filters.dateTo === range.to) {
      onChange({ dateFrom: null, dateTo: null });
    } else {
      onChange({ dateFrom: range.from, dateTo: range.to });
    }
  };

  return (
    <div
      className="absolute right-0 top-full mt-2 z-50 w-[336px] max-w-[calc(100vw-24px)] max-h-[72vh] overflow-y-auto custom-scrollbar rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] backdrop-blur-xl shadow-2xl p-4 space-y-4 animate-fadeIn"
      role="dialog"
      aria-label="筛选条件"
      onClick={e => e.stopPropagation()}
    >
      {/* 范围：收藏 + 媒体类型 */}
      <section>
        <SectionTitle>范围</SectionTitle>
        <div className="flex flex-wrap gap-1.5">
          <Chip
            active={filters.favoritesOnly}
            onClick={() => onChange({ favoritesOnly: !filters.favoritesOnly })}
            title="只显示已收藏的项目"
          >
            ♥ 仅收藏
          </Chip>
        </div>

        <span className="block text-xs font-medium text-[var(--text-secondary)] mt-3 mb-2">媒体类型</span>
        <div className="flex flex-wrap gap-1.5">
          {MEDIA_FILTER_OPTIONS.map(value => (
            <Chip
              key={value}
              active={filters.mediaFilter === value}
              onClick={() => onChange({ mediaFilter: value })}
            >
              {MEDIA_FILTER_LABELS[value]}
            </Chip>
          ))}
        </div>
      </section>

      {/* 日期范围 */}
      <section className="pt-4 border-t border-[var(--border-subtle)]">
        <SectionTitle
          extra={
            datePreset === 'custom' ? (
              <span className="text-[10px] text-[var(--accent-cyan)]">自定义</span>
            ) : null
          }
        >
          日期范围
        </SectionTitle>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {DATE_PRESET_OPTIONS.map(option => (
            <Chip
              key={option.value}
              active={datePreset === option.value}
              onClick={() => applyPreset(option.value)}
            >
              {option.label}
            </Chip>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={toDateInputValue(filters.dateFrom)}
            max={toDateInputValue(filters.dateTo) || undefined}
            onChange={e => onChange({ dateFrom: startOfDayFromInput(e.target.value) })}
            className="flex-1 min-w-0 px-2.5 py-1.5 text-xs rounded-lg bg-[var(--bg-input)] border border-[var(--border-subtle)] text-[var(--text-primary)] outline-hidden focus:border-[var(--accent-blue)] focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.25)] transition-all"
            aria-label="起始日期"
          />
          <span className="text-xs text-[var(--text-quaternary)] shrink-0">至</span>
          <input
            type="date"
            value={toDateInputValue(filters.dateTo)}
            min={toDateInputValue(filters.dateFrom) || undefined}
            onChange={e => onChange({ dateTo: endOfDayFromInput(e.target.value) })}
            className="flex-1 min-w-0 px-2.5 py-1.5 text-xs rounded-lg bg-[var(--bg-input)] border border-[var(--border-subtle)] text-[var(--text-primary)] outline-hidden focus:border-[var(--accent-blue)] focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.25)] transition-all"
            aria-label="结束日期"
          />
        </div>
        <p className="mt-1.5 text-[11px] text-[var(--text-quaternary)]">
          按拍摄时间筛选，缺少拍摄信息时用文件修改时间。
        </p>
      </section>

      {/* 相机 / 机型 */}
      <section className="pt-4 border-t border-[var(--border-subtle)]">
        <SectionTitle>相机 / 机型</SectionTitle>
        {options.cameras.length === 0 ? (
          <p className="text-[11px] text-[var(--text-quaternary)]">当前图库暂无可用的相机信息（EXIF）。</p>
        ) : (
          <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto custom-scrollbar">
            {options.cameras.map(camera => (
              <Chip
                key={camera}
                active={filters.cameras.includes(camera)}
                onClick={() => onChange({ cameras: toggleInList(filters.cameras, camera) })}
                title={camera}
              >
                {camera}
              </Chip>
            ))}
          </div>
        )}
      </section>

      {/* 格式 */}
      <section className="pt-4 border-t border-[var(--border-subtle)]">
        <SectionTitle>格式</SectionTitle>
        <div className="flex flex-wrap gap-1.5">
          {options.formats.map(format => (
            <Chip
              key={format}
              active={filters.formats.includes(format)}
              onClick={() => onChange({ formats: toggleInList(filters.formats, format) })}
            >
              {format.toUpperCase()}
            </Chip>
          ))}
        </div>
      </section>

      {/* 用户标签 */}
      <section className="pt-4 border-t border-[var(--border-subtle)]">
        <SectionTitle>标签</SectionTitle>
        {options.tags.length === 0 ? (
          <p className="text-[11px] text-[var(--text-quaternary)]">
            还没有标签。在详情面板中给照片添加标签后即可按标签筛选。
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto custom-scrollbar">
            {options.tags.map(tag => (
              <Chip
                key={tag}
                active={filters.tags.includes(tag)}
                onClick={() => onChange({ tags: toggleInList(filters.tags, tag) })}
              >
                #{tag}
              </Chip>
            ))}
          </div>
        )}
      </section>

      {/* 文件大小 */}
      <section className="pt-4 border-t border-[var(--border-subtle)]">
        <SectionTitle>文件大小</SectionTitle>
        <div className="flex flex-wrap gap-1.5">
          {SIZE_FILTER_OPTIONS.map(option => (
            <Chip
              key={option.value}
              active={filters.sizeFilter === option.value}
              onClick={() => onChange({ sizeFilter: option.value })}
            >
              {option.label}
            </Chip>
          ))}
        </div>
      </section>

      {/* 视频时长：仅库中有视频时展示 */}
      {hasVideos && (
        <section className="pt-4 border-t border-[var(--border-subtle)]">
          <SectionTitle>视频时长</SectionTitle>
          <div className="flex flex-wrap gap-1.5">
            {DURATION_FILTER_OPTIONS.map(option => (
              <Chip
                key={option.value}
                active={filters.durationFilter === option.value}
                onClick={() => onChange({ durationFilter: option.value })}
              >
                {option.label}
              </Chip>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-[var(--text-quaternary)]">
            按时长筛选只看视频；时长在视频加载后才会显示。
          </p>
        </section>
      )}

      {/* 操作区 */}
      <div className="pt-4 border-t border-[var(--border-subtle)] flex items-center justify-between">
        <button
          type="button"
          onClick={onReset}
          className="px-3 py-1.5 text-xs font-medium rounded-lg text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] transition-all duration-200"
        >
          重置筛选
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-1.5 text-xs font-semibold rounded-lg text-[var(--accent-contrast)] bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-hover))] shadow-lg shadow-[rgba(var(--accent-blue-rgb),0.25)] hover:brightness-110 transition-all duration-200 active:scale-[0.98]"
        >
          完成
        </button>
      </div>
    </div>
  );
};

export default FilterPanel;
