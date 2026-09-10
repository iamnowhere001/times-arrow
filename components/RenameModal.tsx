
import React, { useState, useEffect, useMemo } from 'react';
import { Photo, RenameOptions } from '../types';
import { folderOfPath, formatDateForNaming, repairFileName } from '../utils';

interface RenameModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (options: RenameOptions) => void;
  /** 当前选中的待重命名文件（用于生成真实预览） */
  photos: Photo[];
  count: number;
}

const INVALID_CHARS = /[<>:"|?*\\/]/;
const RESERVED_WINDOW_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

const sortByTakenTime = (a: Photo, b: Photo) =>
  (a.dateTaken || a.lastModified || 0) - (b.dateTaken || b.lastModified || 0);

/** 扩展名（含点）；无扩展名返回空串 */
const extWithDot = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
};

interface PreviewRow {
  from: string;
  to: string;
  /** 该行因重名被自动追加了序号 */
  adjusted?: boolean;
  /** 该行的处理说明（乱码修复模式） */
  note?: string;
}

interface PreviewResult {
  rows: PreviewRow[];
  error?: string;
  truncated: number; // 未展示的行数
  /** 名称会真正发生变化的项数 */
  changedCount: number;
}

const PREVIEW_MAX_ROWS = 5;

const RenameModal: React.FC<RenameModalProps> = ({ isOpen, onClose, onConfirm, photos, count }) => {
  const [mode, setMode] = useState<'sequence' | 'replace' | 'date' | 'repair'>('sequence');

  const [prefix, setPrefix] = useState('照片_');
  const [startNumber, setStartNumber] = useState(1);
  const [numberPadding, setNumberPadding] = useState(3);

  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [useRegex, setUseRegex] = useState(false);

  const [datePrefix, setDatePrefix] = useState('photo_');
  const [dateFormat, setDateFormat] = useState('yyyy-MM-dd_HHmmss');

  // 乱码修复模式的规则开关
  const [fixMojibake, setFixMojibake] = useState(true);
  const [stripJunkPrefix, setStripJunkPrefix] = useState(true);
  const [stripCopyMarks, setStripCopyMarks] = useState(true);
  const [fallbackToDate, setFallbackToDate] = useState(true);

  useEffect(() => {
    if (isOpen) {
      setMode('sequence');
      setPrefix('照片_');
      setStartNumber(1);
      setNumberPadding(3);
      setFindText('');
      setReplaceText('');
      setUseRegex(false);
      setDatePrefix('photo_');
      setDateFormat('yyyy-MM-dd_HHmmss');
      setFixMojibake(true);
      setStripJunkPrefix(true);
      setStripCopyMarks(true);
      setFallbackToDate(true);
    }
  }, [isOpen]);

  // Esc 关闭弹层（与系统弹窗习惯一致）
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

  /**
   * 基于真实选中文件生成重命名预览，逻辑与 App.handleBatchRename 保持一致：
   * 按「拍摄时间 / 修改时间」排序后依次编号；批内重名自动追加序号。
   */
  const preview = useMemo<PreviewResult>(() => {
    const sorted = [...photos].sort(sortByTakenTime);
    const rows: PreviewRow[] = [];
    const used = new Set<string>();
    let error: string | undefined;
    let truncated = 0;
    let changedCount = 0;

    if (mode === 'replace' && !useRegex && findText === '') {
      return { rows, error: '请输入要查找的文本', truncated: 0, changedCount: 0 };
    }

    if (mode === 'replace' && useRegex && findText !== '') {
      try {
        // eslint-disable-next-line no-new
        new RegExp(findText);
      } catch {
        return { rows, error: '无效的正则表达式', truncated: 0, changedCount: 0 };
      }
    }

    if (mode === 'repair' && !fixMojibake && !stripJunkPrefix && !stripCopyMarks && !fallbackToDate) {
      return { rows, error: '请至少启用一条处理规则', truncated: 0, changedCount: 0 };
    }

    for (let i = 0; i < sorted.length; i++) {
      const photo = sorted[i];
      const ext = extWithDot(photo.name);
      const stem = ext ? photo.name.slice(0, photo.name.length - ext.length) : photo.name;
      let to: string;
      let note: string | undefined;

      if (mode === 'repair') {
        const repaired = repairFileName(
          photo.name,
          { fixMojibake, stripJunkPrefix, stripCopyMarks, fallbackToDate, dateFormat, datePrefix },
          photo.dateTaken || photo.lastModified
        );
        to = repaired.name;
        note = repaired.changed ? (repaired.notes.join('、') || '已处理') : '无需修改';
      } else if (mode === 'sequence') {
        to = `${prefix}${(startNumber + i).toString().padStart(numberPadding, '0')}${ext}`;
      } else if (mode === 'replace') {
        let base = stem;
        if (useRegex) {
          base = base.replace(new RegExp(findText, 'g'), replaceText);
        } else if (findText !== '') {
          base = base.split(findText).join(replaceText);
        }
        to = `${base}${ext}`;
      } else {
        const photoDate = new Date(photo.dateTaken || photo.lastModified || Date.now());
        const dateStr = formatDateForNaming(photoDate, dateFormat || 'yyyy-MM-dd_HHmmss');
        to = `${datePrefix}${dateStr}${ext}`;
      }

      // 批内重名：追加序号；只有同一个目录下才算重名（磁盘冲突由主进程兜底）
      const dot = to.lastIndexOf('.');
      const toStem = dot > 0 ? to.slice(0, dot) : to;
      const toExt = dot > 0 ? to.slice(dot) : '';
      const dirKey = folderOfPath(photo.path || '');
      let finalTo = to;
      let counter = 1;
      let adjusted = false;
      while (used.has(`${dirKey}\u0000${finalTo}`)) {
        finalTo = `${toStem}_${counter}${toExt}`;
        counter++;
        adjusted = true;
      }
      used.add(`${dirKey}\u0000${finalTo}`);

      if (INVALID_CHARS.test(finalTo) || RESERVED_WINDOW_NAMES.has(toStem.toLowerCase())) {
        error = `「${finalTo}」包含系统不允许的字符（<>:"/\\|?*）或为保留名称`;
        break;
      }

      if (finalTo !== photo.name) changedCount++;

      if (rows.length < PREVIEW_MAX_ROWS) {
        rows.push({ from: photo.name, to: finalTo, adjusted, note });
      } else {
        truncated++;
      }
    }

    return { rows, error, truncated, changedCount };
  }, [
    photos, mode, prefix, startNumber, numberPadding, findText, replaceText, useRegex,
    datePrefix, dateFormat, fixMojibake, stripJunkPrefix, stripCopyMarks, fallbackToDate,
  ]);

  const canConfirm = !preview.error && photos.length > 0;

  const handleConfirm = () => {
    if (!canConfirm) return;
    onConfirm({
      mode,
      prefix,
      startNumber,
      numberPadding,
      findText,
      replaceText,
      useRegex,
      dateFormat,
      datePrefix,
      repair: {
        fixMojibake,
        stripJunkPrefix,
        stripCopyMarks,
        fallbackToDate,
        dateFormat,
        datePrefix,
      },
    });
  };

  if (!isOpen) return null;

  const modeDescription: Record<typeof mode, string> = {
    sequence: `按拍摄时间排序后，依次编号为 ${prefix}${String(startNumber).padStart(numberPadding, '0')} 起、步长 1 的序号。`,
    replace: useRegex
      ? '在原文件名中查找正则表达式并替换（支持 $1, $2… 引用捕获组），扩展名不受影响。'
      : '在原文件名中查找指定文本并替换，扩展名不受影响。',
    date: `用每张照片的拍摄时间（缺失时用文件时间）按指定格式生成名称。`,
    repair: '清理乱码文件名与 IMG_2639、mmexport… 这类无意义名称，尽量还原成可读文件名。',
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(0,0,0,0.7)] backdrop-blur-md animate-fadeIn">
      <div
        className="bg-[var(--bg-elevated)] backdrop-blur-xl rounded-2xl shadow-2xl w-[460px] max-w-[90vw] overflow-hidden border border-[var(--border-default)] animate-scaleIn flex flex-col max-h-[90vh]"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-[var(--border-subtle)]">
          <h3 className="text-lg font-semibold text-[var(--text-primary)]">批量重命名</h3>
          <p className="text-sm text-[var(--text-tertiary)] mt-1">
            将重命名 {count} 个项目（图片 / 视频），磁盘上的文件名会被直接改写（同名时自动追加序号，不会覆盖）。
          </p>
        </div>

        <div className="p-6 space-y-5 overflow-y-auto">
          <div className="grid grid-cols-2 gap-1 bg-[var(--bg-input)] p-1 rounded-xl">
            {([
              ['sequence', '格式化名称'],
              ['replace', '替换文本'],
              ['date', '按拍摄时间命名'],
              ['repair', '乱码修复'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setMode(value)}
                className={`py-2 text-sm font-medium rounded-lg transition-all ${
                  mode === value
                    ? 'bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-hover))] text-[var(--accent-contrast)] shadow-sm'
                    : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-glass)]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <p className="text-xs text-[var(--text-quaternary)] -mt-2">{modeDescription[mode]}</p>

          {mode === 'sequence' ? (
            <div className="space-y-5 animate-fadeIn">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--text-tertiary)] mb-2">名称前缀</label>
                  <input
                    type="text"
                    value={prefix}
                    onChange={(e) => setPrefix(e.target.value)}
                    className="w-full px-4 py-2.5 bg-[var(--bg-input)] border border-[var(--border-default)] rounded-xl focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.5)] focus:border-[var(--accent-blue)] outline-none transition-all text-sm text-[var(--text-primary)] placeholder-[var(--text-quaternary)]"
                    placeholder="照片_"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--text-tertiary)] mb-2">起始编号</label>
                  <input
                    type="number"
                    value={startNumber}
                    onChange={(e) => {
                      // 清空输入框时 parseInt('') 为 NaN，会让预览和文件名都变成 "NaN"
                      const next = parseInt(e.target.value, 10);
                      setStartNumber(Number.isFinite(next) && next >= 0 ? next : 0);
                    }}
                    className="w-full px-4 py-2.5 bg-[var(--bg-input)] border border-[var(--border-default)] rounded-xl focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.5)] focus:border-[var(--accent-blue)] outline-none transition-all text-sm text-[var(--text-primary)]"
                    min="0"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--text-tertiary)] mb-2">编号位数</label>
                <div className="flex gap-2">
                  {[1, 2, 3, 4, 5].map((digits) => (
                    <button
                      key={digits}
                      onClick={() => setNumberPadding(digits)}
                      className={`flex-1 py-2 text-sm font-medium rounded-xl border transition-all ${
                        numberPadding === digits
                          ? 'bg-[rgba(var(--accent-blue-rgb),0.15)] border-[var(--accent-blue)] text-[var(--accent-blue)]'
                          : 'bg-[var(--bg-input)] border-[var(--border-default)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:border-[var(--border-hover)]'
                      }`}
                    >
                      {digits} 位
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : mode === 'date' ? (
            <div className="space-y-5 animate-fadeIn">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--text-tertiary)] mb-2">名称前缀</label>
                  <input
                    type="text"
                    value={datePrefix}
                    onChange={(e) => setDatePrefix(e.target.value)}
                    className="w-full px-4 py-2.5 bg-[var(--bg-input)] border border-[var(--border-default)] rounded-xl focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.5)] focus:border-[var(--accent-blue)] outline-none transition-all text-sm text-[var(--text-primary)] placeholder-[var(--text-quaternary)]"
                    placeholder="photo_（可留空）"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--text-tertiary)] mb-2">日期格式</label>
                  <input
                    type="text"
                    value={dateFormat}
                    onChange={(e) => setDateFormat(e.target.value)}
                    className="w-full px-4 py-2.5 bg-[var(--bg-input)] border border-[var(--border-default)] rounded-xl focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.5)] focus:border-[var(--accent-blue)] outline-none transition-all text-sm text-[var(--text-primary)] placeholder-[var(--text-quaternary)]"
                    placeholder="yyyy-MM-dd_HHmmss"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--text-tertiary)] mb-2">可用占位符</label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ['yyyy', '年份 (4位)'],
                    ['MM', '月份 (2位)'],
                    ['dd', '日期 (2位)'],
                    ['HH', '小时 (24制)'],
                    ['mm', '分钟 (2位)'],
                    ['ss', '秒 (2位)'],
                  ].map(([token, desc]) => (
                    <button
                      key={token}
                      onClick={() => setDateFormat((f) => (f.includes(token) ? f : f + (f.endsWith('_') || f === '' ? token : `_${token}`)))}
                      className="flex items-center gap-1.5 px-2 py-1.5 bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg hover:border-[var(--accent-blue)] transition-all text-left"
                      title={`点击插入 ${token}`}
                    >
                      <span className="px-1.5 py-0.5 bg-[rgba(var(--accent-blue-rgb),0.15)] text-[var(--accent-cyan)] rounded-md text-xs font-mono">{token}</span>
                      <span className="text-xs text-[var(--text-tertiary)] truncate">{desc}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : mode === 'repair' ? (
            <div className="space-y-5 animate-fadeIn">
              <div>
                <label className="block text-sm font-medium text-[var(--text-tertiary)] mb-2">处理规则</label>
                <div className="space-y-2">
                  {([
                    {
                      id: 'fixMojibake',
                      checked: fixMojibake,
                      onChange: setFixMojibake,
                      title: '修复乱码字符',
                      desc: '如「æµ·æ»¨」「º£±õ」还原为中文（编码被错误解码造成）',
                    },
                    {
                      id: 'stripJunkPrefix',
                      checked: stripJunkPrefix,
                      onChange: setStripJunkPrefix,
                      title: '去掉无意义前缀',
                      desc: '如 IMG_2639、DSC01234、mmexport1712… 这类自动命名',
                    },
                    {
                      id: 'stripCopyMarks',
                      checked: stripCopyMarks,
                      onChange: setStripCopyMarks,
                      title: '去掉重复标记',
                      desc: '如「照片 (1)」「照片 - 副本」「照片 copy 2」',
                    },
                    {
                      id: 'fallbackToDate',
                      checked: fallbackToDate,
                      onChange: setFallbackToDate,
                      title: '无意义时改用拍摄时间',
                      desc: '清理后只剩数字或符号的名称，按拍摄时间重新命名',
                    },
                  ] as const).map((rule) => (
                    <label
                      key={rule.id}
                      htmlFor={rule.id}
                      className="flex items-start gap-3 p-3 bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-xl cursor-pointer hover:border-[var(--border-hover)] transition-all"
                    >
                      <input
                        type="checkbox"
                        id={rule.id}
                        checked={rule.checked}
                        onChange={(e) => rule.onChange(e.target.checked)}
                        className="mt-0.5 rounded border-[var(--border-input)] bg-[var(--bg-input)] text-[var(--accent-blue)] focus:ring-[rgba(var(--accent-blue-rgb),0.5)] cursor-pointer accent-[var(--accent-blue)]"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm text-[var(--text-secondary)]">{rule.title}</span>
                        <span className="block text-xs text-[var(--text-quaternary)] mt-0.5">{rule.desc}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {fallbackToDate && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-[var(--text-tertiary)] mb-2">名称前缀</label>
                    <input
                      type="text"
                      value={datePrefix}
                      onChange={(e) => setDatePrefix(e.target.value)}
                      className="w-full px-4 py-2.5 bg-[var(--bg-input)] border border-[var(--border-default)] rounded-xl focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.5)] focus:border-[var(--accent-blue)] outline-none transition-all text-sm text-[var(--text-primary)] placeholder-[var(--text-quaternary)]"
                      placeholder="photo_（可留空）"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-[var(--text-tertiary)] mb-2">日期格式</label>
                    <input
                      type="text"
                      value={dateFormat}
                      onChange={(e) => setDateFormat(e.target.value)}
                      className="w-full px-4 py-2.5 bg-[var(--bg-input)] border border-[var(--border-default)] rounded-xl focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.5)] focus:border-[var(--accent-blue)] outline-none transition-all text-sm text-[var(--text-primary)] placeholder-[var(--text-quaternary)]"
                      placeholder="yyyy-MM-dd_HHmmss"
                    />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-5 animate-fadeIn">
              <div>
                <label className="block text-sm font-medium text-[var(--text-tertiary)] mb-2">查找</label>
                <input
                  type="text"
                  value={findText}
                  onChange={(e) => setFindText(e.target.value)}
                  className={`w-full px-4 py-2.5 bg-[var(--bg-input)] border rounded-xl focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.5)] outline-none transition-all text-sm text-[var(--text-primary)] placeholder-[var(--text-quaternary)] ${
                    preview.error && !useRegex
                      ? 'border-[rgba(var(--accent-pink-rgb),0.5)]'
                      : 'border-[var(--border-default)] focus:border-[var(--accent-blue)]'
                  }`}
                  placeholder={useRegex ? '正则表达式...' : '要查找的文本...'}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--text-tertiary)] mb-2">替换为</label>
                <input
                  type="text"
                  value={replaceText}
                  onChange={(e) => setReplaceText(e.target.value)}
                  className="w-full px-4 py-2.5 bg-[var(--bg-input)] border border-[var(--border-default)] rounded-xl focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.5)] focus:border-[var(--accent-blue)] outline-none transition-all text-sm text-[var(--text-primary)] placeholder-[var(--text-quaternary)]"
                  placeholder={useRegex ? '替换内容（支持 $1, $2...）' : '留空以移除'}
                />
              </div>

              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="useRegex"
                  checked={useRegex}
                  onChange={(e) => setUseRegex(e.target.checked)}
                  className="rounded border-[var(--border-input)] bg-[var(--bg-input)] text-[var(--accent-blue)] focus:ring-[rgba(var(--accent-blue-rgb),0.5)] cursor-pointer accent-[var(--accent-blue)]"
                />
                <label htmlFor="useRegex" className="text-sm text-[var(--text-secondary)] select-none cursor-pointer">使用正则表达式</label>
              </div>
            </div>
          )}

          {/* 真实预览：基于当前选中的文件 */}
          <div
            className={`border p-4 rounded-xl ${
              preview.error
                ? 'bg-[rgba(var(--accent-pink-rgb),0.1)] border-[rgba(var(--accent-pink-rgb),0.25)]'
                : 'bg-[rgba(var(--accent-blue-rgb),0.08)] border-[rgba(var(--accent-blue-rgb),0.2)]'
            }`}
          >
            {preview.error ? (
              <p className="text-sm text-[var(--accent-pink)]">{preview.error}</p>
            ) : (
              <>
                <p className="text-xs font-medium mb-2.5 text-[var(--accent-cyan)]">
                  {mode === 'repair'
                    ? `预览（${preview.changedCount} 项将被修改，${photos.length - preview.changedCount} 项保持原名）`
                    : `预览${preview.truncated > 0 ? `（前 ${preview.rows.length} 项，共 ${photos.length} 项）` : `（共 ${photos.length} 项）`}`}
                </p>
                <div className="space-y-2">
                  {preview.rows.map((row, idx) => (
                    <div key={`${row.from}-${idx}`} className="min-w-0">
                      <div className="flex items-center gap-2 text-xs font-mono min-w-0">
                        <span className="text-[var(--text-tertiary)] truncate max-w-[38%]" title={row.from}>{row.from}</span>
                        <span className="text-[var(--text-quaternary)] shrink-0">→</span>
                        <span
                          className={`truncate ${row.from === row.to ? 'text-[var(--text-quaternary)]' : 'text-[var(--text-primary)]'}`}
                          title={row.to}
                        >
                          {row.to}
                          {row.adjusted && <span className="text-[var(--accent-cyan)]"> （重名已加序号）</span>}
                        </span>
                      </div>
                      {row.note && (
                        <p className="text-[10px] text-[var(--text-quaternary)] mt-0.5 truncate">· {row.note}</p>
                      )}
                    </div>
                  ))}
                  {preview.truncated > 0 && (
                    <p className="text-xs text-[var(--text-quaternary)]">…等共 {photos.length} 项</p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-[var(--border-subtle)] mt-auto">
          <div className="flex justify-end gap-3">
            <button
              onClick={onClose}
              className="px-6 py-2.5 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] border border-[var(--border-default)] hover:border-[var(--border-hover)] rounded-xl transition-all duration-200"
            >
              取消
            </button>
            <button
              onClick={handleConfirm}
              disabled={!canConfirm}
              className={`px-6 py-2.5 text-sm font-semibold rounded-xl transition-all duration-200 ${
                canConfirm
                  ? 'text-[var(--accent-contrast)] bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-hover))] hover:bg-[linear-gradient(135deg,var(--accent-blue-hover),var(--accent-blue))] shadow-lg shadow-[rgba(var(--accent-blue-rgb),0.3)] active:scale-[0.98]'
                  : 'text-[var(--text-quaternary)] bg-[var(--bg-input)] border border-[var(--border-subtle)] cursor-not-allowed'
              }`}
            >
              重命名
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RenameModal;
