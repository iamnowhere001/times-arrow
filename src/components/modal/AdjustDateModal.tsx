import React, { useEffect, useMemo, useState } from 'react';
import { Photo } from '@/types';
import { formatDate } from '@/utils';

export type AdjustMode = 'shift' | 'set';

export interface DateAdjustment {
  photo: Photo;
  /** 调整后的拍摄时间戳 */
  timestamp: number;
}

interface AdjustDateModalProps {
  isOpen: boolean;
  /** 待调整的项目（通常是当前选中项） */
  photos: Photo[];
  onClose: () => void;
  onApply: (adjustments: DateAdjustment[]) => void;
}

/**
 * 照片的「原始时间」基准：EXIF 拍摄时间 > 文件创建时间 > 文件修改时间。
 * 平移与「保持相对间隔」都以它为准，避免缺少 EXIF 的照片无法调整。
 */
const baseTimeOf = (photo: Photo): number =>
  photo.dateTaken || photo.dateCreated || photo.lastModified || 0;

const pad2 = (value: number) => String(value).padStart(2, '0');

/** 时间戳 → `<input type="datetime-local">` 的 yyyy-MM-ddTHH:mm */
const toLocalInputValue = (ts: number): string => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const fromLocalInputValue = (value: string): number | null => {
  if (!value) return null;
  const parsed = new Date(value);
  const time = parsed.getTime();
  return Number.isNaN(time) ? null : time;
};

const PREVIEW_ROWS = 3;

/**
 * 调整日期与时间（仿 macOS 照片「调整日期与时间」）。
 *
 * 两种模式：
 * - 平移：在每张的现有时间上加固定偏移，适合「相机时区 / 时钟设错」这类整体偏移；
 * - 设定：给定一个基准时间。默认保持相对间隔（最早的一张设为该时间，其余按原间隔平移），
 *   关闭后则全部设为同一时间。
 *
 * 结果不会写回原文件，而是作为「时间修正」记录持久化（见 App 中的 dateOverrides）。
 */
const AdjustDateModal: React.FC<AdjustDateModalProps> = ({ isOpen, photos, onClose, onApply }) => {
  const [mode, setMode] = useState<AdjustMode>('shift');
  const [days, setDays] = useState(0);
  const [hours, setHours] = useState(0);
  const [minutes, setMinutes] = useState(0);
  const [keepRelative, setKeepRelative] = useState(true);
  const [targetValue, setTargetValue] = useState('');

  const earliest = useMemo(() => {
    if (photos.length === 0) return 0;
    return photos.reduce((min, photo) => {
      const time = baseTimeOf(photo);
      if (!time) return min;
      return min === 0 ? time : Math.min(min, time);
    }, 0);
  }, [photos]);

  // 打开时重置，并以「最早一张」的当前时间作为设定模式的初始值
  useEffect(() => {
    if (!isOpen) return;
    setMode('shift');
    setDays(0);
    setHours(0);
    setMinutes(0);
    setKeepRelative(true);
    const anchor = earliest || Date.now();
    setTargetValue(toLocalInputValue(anchor));
  }, [isOpen, earliest]);

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

  const offsetMs = ((days * 24 + hours) * 60 + minutes) * 60_000;

  /** 逐张算出调整后的时间戳 */
  const adjustments = useMemo<DateAdjustment[]>(() => {
    if (photos.length === 0) return [];

    if (mode === 'shift') {
      if (offsetMs === 0) return [];
      return photos.map(photo => ({ photo, timestamp: baseTimeOf(photo) + offsetMs }));
    }

    const target = fromLocalInputValue(targetValue);
    if (target === null) return [];
    if (!keepRelative) {
      return photos.map(photo => ({ photo, timestamp: target }));
    }
    // 保持间隔：以最早一张为锚点整体平移
    const anchor = earliest || target;
    const delta = target - anchor;
    return photos.map(photo => ({ photo, timestamp: baseTimeOf(photo) + delta }));
  }, [photos, mode, offsetMs, targetValue, keepRelative, earliest]);

  if (!isOpen) return null;

  const canApply = adjustments.length > 0;
  const preview = adjustments.slice(0, PREVIEW_ROWS);

  const modeDescription: Record<AdjustMode, string> = {
    shift: '在每张现有时间的基础上增加或减少一段固定时长，适合相机时区 / 时钟设错的情况。',
    set: keepRelative
      ? `把最早的一张设为指定时间，其余按原有时间间隔整体平移（保持顺序不变）。`
      : '把选中的项目全部设为同一个时间（会丢失原有的先后顺序）。',
  };

  const numberField = (
    label: string,
    value: number,
    setValue: (next: number) => void,
    step: number
  ) => (
    <div>
      <label className="block text-xs font-medium text-[var(--text-tertiary)] mb-1.5">{label}</label>
      <input
        type="number"
        value={value}
        step={step}
        onChange={e => {
          const next = parseInt(e.target.value, 10);
          setValue(Number.isFinite(next) ? next : 0);
        }}
        className="w-full px-3 py-2 bg-[var(--bg-input)] border border-[var(--border-default)] rounded-xl text-sm text-[var(--text-primary)] outline-hidden focus:border-[var(--accent-blue)] focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.25)] transition-all"
      />
    </div>
  );

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[rgba(0,0,0,0.7)] backdrop-blur-md animate-fadeIn">
      <div
        className="bg-[var(--bg-elevated)] backdrop-blur-xl rounded-2xl shadow-2xl w-[460px] max-w-[90vw] max-h-[90vh] overflow-hidden border border-[var(--border-default)] animate-scaleIn flex flex-col"
        role="dialog"
        aria-modal="true"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-[var(--border-subtle)]">
          <h3 className="text-lg font-semibold text-[var(--text-primary)]">调整日期与时间</h3>
          <p className="text-sm text-[var(--text-tertiary)] mt-1">
            将调整 {photos.length} 个项目。仅修改应用内记录的时间（用于排序与分组），不改动原文件。
          </p>
        </div>

        <div className="p-6 space-y-5 overflow-y-auto">
          <div className="grid grid-cols-2 gap-1 bg-[var(--bg-input)] p-1 rounded-xl">
            {([
              ['shift', '平移'],
              ['set', '设为指定时间'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={`py-2 text-sm font-medium rounded-lg transition-all ${
                  mode === value
                    ? 'bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-hover))] text-[var(--accent-contrast)] shadow-xs'
                    : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-glass)]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <p className="text-xs text-[var(--text-quaternary)] -mt-2">{modeDescription[mode]}</p>

          {mode === 'shift' ? (
            <div className="grid grid-cols-3 gap-3 animate-fadeIn">
              {numberField('天', days, setDays, 1)}
              {numberField('小时', hours, setHours, 1)}
              {numberField('分钟', minutes, setMinutes, 1)}
            </div>
          ) : (
            <div className="space-y-4 animate-fadeIn">
              <div>
                <label className="block text-xs font-medium text-[var(--text-tertiary)] mb-1.5">
                  基准时间
                </label>
                <input
                  type="datetime-local"
                  value={targetValue}
                  onChange={e => setTargetValue(e.target.value)}
                  className="w-full px-3 py-2 bg-[var(--bg-input)] border border-[var(--border-default)] rounded-xl text-sm text-[var(--text-primary)] outline-hidden focus:border-[var(--accent-blue)] focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.25)] transition-all"
                />
              </div>

              <label className="flex items-center gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={keepRelative}
                  onChange={e => setKeepRelative(e.target.checked)}
                  className="rounded-sm border-[var(--border-input)] bg-[var(--bg-input)] text-[var(--accent-blue)] accent-[var(--accent-blue)] cursor-pointer"
                />
                <span className="text-sm text-[var(--text-secondary)]">保持原有时间间隔</span>
              </label>
            </div>
          )}

          {/* 预览 */}
          <div
            className={`border p-4 rounded-xl ${
              canApply
                ? 'bg-[rgba(var(--accent-blue-rgb),0.08)] border-[rgba(var(--accent-blue-rgb),0.2)]'
                : 'bg-[var(--bg-glass)] border-[var(--border-subtle)]'
            }`}
          >
            {canApply ? (
              <>
                <p className="text-xs font-medium mb-2.5 text-[var(--accent-cyan)]">预览</p>
                <div className="space-y-2">
                  {preview.map(({ photo, timestamp }) => (
                    <div key={photo.id} className="flex items-center gap-2 text-xs font-mono min-w-0">
                      <span className="text-[var(--text-tertiary)] truncate flex-1" title={photo.name}>
                        {photo.name}
                      </span>
                      <span className="text-[var(--text-quaternary)] shrink-0">
                        {formatDate(baseTimeOf(photo))}
                      </span>
                      <span className="text-[var(--text-quaternary)] shrink-0">→</span>
                      <span className="text-[var(--text-primary)] shrink-0">{formatDate(timestamp)}</span>
                    </div>
                  ))}
                  {adjustments.length > preview.length && (
                    <p className="text-xs text-[var(--text-quaternary)]">
                      …等共 {adjustments.length} 项
                    </p>
                  )}
                </div>
              </>
            ) : (
              <p className="text-xs text-[var(--text-quaternary)]">
                {mode === 'shift' ? '请输入非零的时间偏移' : '请选择基准时间'}
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
            onClick={() => canApply && onApply(adjustments)}
            disabled={!canApply}
            className={`px-6 py-2.5 text-sm font-semibold rounded-xl transition-all duration-200 ${
              canApply
                ? 'text-[var(--accent-contrast)] bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-hover))] shadow-lg shadow-[rgba(var(--accent-blue-rgb),0.3)] active:scale-[0.98]'
                : 'text-[var(--text-quaternary)] bg-[var(--bg-input)] border border-[var(--border-subtle)] cursor-not-allowed'
            }`}
          >
            应用
          </button>
        </div>
      </div>
    </div>
  );
};

export default AdjustDateModal;
