import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useModalA11y } from '@/hooks/useModalA11y';
import { Photo, RenameOptions } from '@/types';
// K11：预览规则抽到 lib 后可单测，且与落盘共用同一份 RenameOptions
import {
  RENAME_PREVIEW_MAX_ROWS,
  applyRenameProbe,
  buildRenamePreview,
  type RenameProbeResult,
} from '@/lib/fs/renamePreview';
import { probeRenameTargets } from '@/lib/fs/renameProbe';

interface RenameModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (options: RenameOptions) => void;
  /** 当前选中的待重命名文件（用于生成真实预览） */
  photos: Photo[];
  count: number;
  /** K19：批量重命名进行中 —— 按钮置灰、Esc 不关闭，避免重复提交 */
  isBusy?: boolean;
}

const RenameModal: React.FC<RenameModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  photos,
  count,
  isBusy = false,
}) => {
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

  /**
   * 预览与落盘共用同一份 options。此前组件内联了一份生成规则、useFileOperations
   * 另写一份，两边各自演化正是「预览 照片_001 / 落盘 照片_001-1」的根源（K11）。
   */
  const options = useMemo<RenameOptions>(
    () => ({
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
    }),
    [
      mode,
      prefix,
      startNumber,
      numberPadding,
      findText,
      replaceText,
      useRegex,
      dateFormat,
      datePrefix,
      fixMojibake,
      stripJunkPrefix,
      stripCopyMarks,
      fallbackToDate,
    ]
  );

  const basePreview = useMemo(() => buildRenamePreview(photos, options), [photos, options]);

  /**
   * K11：磁盘上未被选中的同名文件只有主进程看得到，渲染层不该拿到目录读权限。
   * 走只读 IPC 预演（不写盘、不创建占位文件），250ms 防抖避免逐字输入时刷 IPC。
   */
  const [probeResults, setProbeResults] = useState<RenameProbeResult[] | null>(null);
  const [isProbing, setIsProbing] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  useModalA11y({ isOpen, onClose, containerRef: dialogRef, disabled: isBusy });

  useEffect(() => {
    // 参数一变就丢弃旧结果：否则旧探测会被套到新候选名上，反而制造新的不一致
    setProbeResults(null);
    if (!isOpen || basePreview.error || basePreview.plans.length === 0) {
      setIsProbing(false);
      return;
    }
    let cancelled = false;
    setIsProbing(true);
    const timer = window.setTimeout(() => {
      const entries = basePreview.plans.map(({ oldPath, desiredPath }) => ({
        oldPath,
        desiredPath,
      }));
      // 封装内部吞掉失败并返回 null：预览降级为「未校准」，不阻塞重命名
      void probeRenameTargets(entries).then((results) => {
        if (cancelled) return;
        setProbeResults(results);
        setIsProbing(false);
      });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isOpen, basePreview]);

  const preview = useMemo(
    () =>
      probeResults ? applyRenameProbe(basePreview, basePreview.plans, probeResults) : basePreview,
    [basePreview, probeResults]
  );

  const canConfirm = !preview.error && photos.length > 0 && !isBusy;

  const handleConfirm = () => {
    if (!canConfirm) return;
    onConfirm(options);
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
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--bg-overlay)] backdrop-blur-md animate-fadeIn">
      <div
        className="bg-[var(--bg-elevated)] backdrop-blur-xl rounded-2xl shadow-2xl w-[460px] max-w-[90vw] overflow-hidden border border-[var(--border-default)] animate-scaleIn flex flex-col max-h-[90vh]"
        role="dialog"
        aria-modal="true"
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-[var(--border-subtle)]">
          <h3 className="text-lg font-semibold text-[var(--text-primary)]">批量重命名</h3>
          <p className="text-sm text-[var(--text-tertiary)] mt-1">
            将重命名 {count} 个项目（图片 /
            视频），磁盘上的文件名会被直接改写（同名时自动追加序号，不会覆盖）。
          </p>
        </div>

        <div className="p-6 space-y-5 overflow-y-auto">
          <div className="grid grid-cols-2 gap-1 bg-[var(--bg-input)] p-1 rounded-xl">
            {(
              [
                ['sequence', '格式化名称'],
                ['replace', '替换文本'],
                ['date', '按拍摄时间命名'],
                ['repair', '乱码修复'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
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

          {mode === 'sequence' ? (
            <div className="space-y-5 animate-fadeIn">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--text-tertiary)] mb-2">
                    名称前缀
                  </label>
                  <input
                    type="text"
                    value={prefix}
                    onChange={(e) => setPrefix(e.target.value)}
                    className="w-full px-4 py-2.5 bg-[var(--bg-input)] border border-[var(--border-default)] rounded-xl focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.5)] focus:border-[var(--accent-blue)] outline-hidden transition-all text-sm text-[var(--text-primary)] placeholder-[var(--text-quaternary)]"
                    placeholder="照片_"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--text-tertiary)] mb-2">
                    起始编号
                  </label>
                  <input
                    type="number"
                    value={startNumber}
                    onChange={(e) => {
                      // 清空输入框时 parseInt('') 为 NaN，会让预览和文件名都变成 "NaN"
                      const next = parseInt(e.target.value, 10);
                      setStartNumber(Number.isFinite(next) && next >= 0 ? next : 0);
                    }}
                    className="w-full px-4 py-2.5 bg-[var(--bg-input)] border border-[var(--border-default)] rounded-xl focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.5)] focus:border-[var(--accent-blue)] outline-hidden transition-all text-sm text-[var(--text-primary)]"
                    min="0"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--text-tertiary)] mb-2">
                  编号位数
                </label>
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
                  <label className="block text-sm font-medium text-[var(--text-tertiary)] mb-2">
                    名称前缀
                  </label>
                  <input
                    type="text"
                    value={datePrefix}
                    onChange={(e) => setDatePrefix(e.target.value)}
                    className="w-full px-4 py-2.5 bg-[var(--bg-input)] border border-[var(--border-default)] rounded-xl focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.5)] focus:border-[var(--accent-blue)] outline-hidden transition-all text-sm text-[var(--text-primary)] placeholder-[var(--text-quaternary)]"
                    placeholder="photo_（可留空）"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--text-tertiary)] mb-2">
                    日期格式
                  </label>
                  <input
                    type="text"
                    value={dateFormat}
                    onChange={(e) => setDateFormat(e.target.value)}
                    className="w-full px-4 py-2.5 bg-[var(--bg-input)] border border-[var(--border-default)] rounded-xl focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.5)] focus:border-[var(--accent-blue)] outline-hidden transition-all text-sm text-[var(--text-primary)] placeholder-[var(--text-quaternary)]"
                    placeholder="yyyy-MM-dd_HHmmss"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--text-tertiary)] mb-2">
                  可用占位符
                </label>
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
                      onClick={() =>
                        setDateFormat((f) =>
                          f.includes(token)
                            ? f
                            : f + (f.endsWith('_') || f === '' ? token : `_${token}`)
                        )
                      }
                      className="flex items-center gap-1.5 px-2 py-1.5 bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg hover:border-[var(--accent-blue)] transition-all text-left"
                      title={`点击插入 ${token}`}
                    >
                      <span className="px-1.5 py-0.5 bg-[rgba(var(--accent-blue-rgb),0.15)] text-[var(--accent-cyan)] rounded-md text-xs font-mono">
                        {token}
                      </span>
                      <span className="text-xs text-[var(--text-tertiary)] truncate">{desc}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : mode === 'repair' ? (
            <div className="space-y-5 animate-fadeIn">
              <div>
                <label className="block text-sm font-medium text-[var(--text-tertiary)] mb-2">
                  处理规则
                </label>
                <div className="space-y-2">
                  {(
                    [
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
                    ] as const
                  ).map((rule) => (
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
                        className="mt-0.5 rounded-sm border-[var(--border-input)] bg-[var(--bg-input)] text-[var(--accent-blue)] focus:ring-[rgba(var(--accent-blue-rgb),0.5)] cursor-pointer accent-[var(--accent-blue)]"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm text-[var(--text-secondary)]">
                          {rule.title}
                        </span>
                        <span className="block text-xs text-[var(--text-quaternary)] mt-0.5">
                          {rule.desc}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {fallbackToDate && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-[var(--text-tertiary)] mb-2">
                      名称前缀
                    </label>
                    <input
                      type="text"
                      value={datePrefix}
                      onChange={(e) => setDatePrefix(e.target.value)}
                      className="w-full px-4 py-2.5 bg-[var(--bg-input)] border border-[var(--border-default)] rounded-xl focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.5)] focus:border-[var(--accent-blue)] outline-hidden transition-all text-sm text-[var(--text-primary)] placeholder-[var(--text-quaternary)]"
                      placeholder="photo_（可留空）"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-[var(--text-tertiary)] mb-2">
                      日期格式
                    </label>
                    <input
                      type="text"
                      value={dateFormat}
                      onChange={(e) => setDateFormat(e.target.value)}
                      className="w-full px-4 py-2.5 bg-[var(--bg-input)] border border-[var(--border-default)] rounded-xl focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.5)] focus:border-[var(--accent-blue)] outline-hidden transition-all text-sm text-[var(--text-primary)] placeholder-[var(--text-quaternary)]"
                      placeholder="yyyy-MM-dd_HHmmss"
                    />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-5 animate-fadeIn">
              <div>
                <label className="block text-sm font-medium text-[var(--text-tertiary)] mb-2">
                  查找
                </label>
                <input
                  type="text"
                  value={findText}
                  onChange={(e) => setFindText(e.target.value)}
                  className={`w-full px-4 py-2.5 bg-[var(--bg-input)] border rounded-xl focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.5)] outline-hidden transition-all text-sm text-[var(--text-primary)] placeholder-[var(--text-quaternary)] ${
                    preview.error && !useRegex
                      ? 'border-[rgba(var(--accent-pink-rgb),0.5)]'
                      : 'border-[var(--border-default)] focus:border-[var(--accent-blue)]'
                  }`}
                  placeholder={useRegex ? '正则表达式...' : '要查找的文本...'}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--text-tertiary)] mb-2">
                  替换为
                </label>
                <input
                  type="text"
                  value={replaceText}
                  onChange={(e) => setReplaceText(e.target.value)}
                  className="w-full px-4 py-2.5 bg-[var(--bg-input)] border border-[var(--border-default)] rounded-xl focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.5)] focus:border-[var(--accent-blue)] outline-hidden transition-all text-sm text-[var(--text-primary)] placeholder-[var(--text-quaternary)]"
                  placeholder={useRegex ? '替换内容（支持 $1, $2...）' : '留空以移除'}
                />
              </div>

              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="useRegex"
                  checked={useRegex}
                  onChange={(e) => setUseRegex(e.target.checked)}
                  className="rounded-sm border-[var(--border-input)] bg-[var(--bg-input)] text-[var(--accent-blue)] focus:ring-[rgba(var(--accent-blue-rgb),0.5)] cursor-pointer accent-[var(--accent-blue)]"
                />
                <label
                  htmlFor="useRegex"
                  className="text-sm text-[var(--text-secondary)] select-none cursor-pointer"
                >
                  使用正则表达式
                </label>
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
                    : `预览${preview.truncated > 0 ? `（前 ${RENAME_PREVIEW_MAX_ROWS} 项，共 ${preview.rows.length} 项）` : `（共 ${preview.rows.length} 项）`}`}
                </p>
                <div className="space-y-2">
                  {preview.rows.slice(0, RENAME_PREVIEW_MAX_ROWS).map((row, idx) => (
                    <div key={`${row.from}-${idx}`} className="min-w-0">
                      <div className="flex items-center gap-2 text-xs font-mono min-w-0">
                        <span
                          className="text-[var(--text-tertiary)] truncate max-w-[38%]"
                          title={row.from}
                        >
                          {row.from}
                        </span>
                        <span className="text-[var(--text-quaternary)] shrink-0">→</span>
                        <span
                          className={`truncate ${row.from === row.to ? 'text-[var(--text-quaternary)]' : 'text-[var(--text-primary)]'}`}
                          title={row.to}
                        >
                          {row.to}
                          {(row.adjusted || row.diskAdjusted) && (
                            <span className="text-[var(--accent-cyan)]">
                              {row.diskAdjusted
                                ? ' （磁盘同名，已预演 -序号）'
                                : ' （批内重名已加序号）'}
                            </span>
                          )}
                        </span>
                      </div>
                      {row.note && (
                        <p className="text-xs text-[var(--text-quaternary)] mt-0.5 truncate">
                          · {row.note}
                        </p>
                      )}
                    </div>
                  ))}
                  {preview.truncated > 0 && (
                    <p className="text-xs text-[var(--text-quaternary)]">
                      …等共 {preview.rows.length} 项
                    </p>
                  )}
                </div>
                <p className="mt-2.5 text-[11px] leading-relaxed text-[var(--text-quaternary)]">
                  {isProbing
                    ? '正在核对磁盘上的同名文件…'
                    : probeResults
                      ? '预览已按当前磁盘状态校准；执行时若文件有变动，仍以实际落盘结果为准。'
                      : '仅显示批内重名处理；同名文件会在执行时自动加序号。'}
                </p>
              </>
            )}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-[var(--border-subtle)] mt-auto">
          <div className="flex justify-end gap-3">
            <button
              onClick={onClose}
              disabled={isBusy}
              className="px-6 py-2.5 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] border border-[var(--border-default)] hover:border-[var(--border-hover)] rounded-xl transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
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
              {isBusy ? '重命名中…' : '重命名'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RenameModal;
