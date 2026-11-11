/**
 * 重复检测右栏的「本次检测」报告与「已忽略组」管理（v0.6.2 批次 3）。
 *
 * 从 DuplicateDetector 抽出来，不是为了少几行，而是因为这块有独立的状态（展开 / 收起）
 * 和独立的数据来源（报告 + 忽略集），留在主组件里会继续把那个 1100 行文件往上涨。
 * 数字一律来自 `buildScanReport()`，组件不做第二套统计。
 */

import { useState } from 'react';
import { formatBytes } from '@/lib/format/format';
import { Stat, StatPill } from '@/components/common/Stat';
import type { DuplicateScanReport, IgnoredDuplicateGroup } from '@/lib/duplicate/ignoredGroups';

interface DuplicateReportPanelProps {
  report: DuplicateScanReport;
  ignoredGroups: IgnoredDuplicateGroup[];
  onRestoreIgnored: (key: string) => void;
}

/** 忽略时间只精确到日：这里要认出「哪次标记的」，不需要时分秒 */
const formatIgnoredDate = (ts: number): string => {
  if (!ts) return '时间未知';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return date.toLocaleDateString('zh-CN');
};

export const DuplicateReportPanel = ({
  report,
  ignoredGroups,
  onRestoreIgnored,
}: DuplicateReportPanelProps) => {
  const [isIgnoredListOpen, setIsIgnoredListOpen] = useState(false);

  return (
    <>
      <section className="px-4 py-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-quaternary)] mb-3">
          本次检测
        </h2>
        {/* 「可释放」仍是本页唯一的 hero：它是最能推动「按下删除」的那个结论 */}
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-[var(--text-tertiary)]">可释放</span>
          <Stat value={formatBytes(report.releasableBytes)} emphasis="hero" />
        </div>
        <div className="mt-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
          <Stat value={report.scanned} unit="张" label="扫描" emphasis="micro" />
          <Stat value={report.groupsFound} unit="组" label="成组" emphasis="micro" />
          <Stat value={report.releasableCount} unit="张" label="可清理" emphasis="micro" />
        </div>

        {report.ignoredGroups > 0 && (
          <p className="mt-2.5 text-[11px] leading-relaxed text-[var(--text-quaternary)]">
            已标记 {report.ignoredGroups} 组「不是重复」，当前显示 {report.visibleGroups} 组。
          </p>
        )}
        {report.deletedCount > 0 && (
          <div className="mt-3 rounded-lg border border-[rgba(var(--accent-green-rgb),0.28)] bg-[rgba(var(--accent-green-rgb),0.08)] px-2.5 py-2">
            <p className="text-[11px] text-[var(--text-secondary)]">本次已清理</p>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <Stat value={report.deletedCount} unit="张" emphasis="micro" />
              <Stat value={formatBytes(report.deletedBytes)} emphasis="micro" />
            </div>
          </div>
        )}

        <p className="mt-4 text-[11px] leading-relaxed text-[var(--text-quaternary)]">
          每组以创建时间最早的一张作为原图。删除只会移入系统回收站，随时可以还原。
        </p>
      </section>

      {ignoredGroups.length > 0 && (
        <section className="px-4 py-4 border-t border-[var(--border-subtle)]">
          <div className="flex items-center justify-between gap-2 mb-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-quaternary)]">
              已忽略
            </h2>
            <StatPill value={ignoredGroups.length} unit="组" />
          </div>
          <button
            onClick={() => setIsIgnoredListOpen((open) => !open)}
            aria-expanded={isIgnoredListOpen}
            className="w-full text-left text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] px-2 py-1.5 rounded-lg hover:bg-[var(--bg-glass-hover)] transition-colors"
          >
            {isIgnoredListOpen ? '收起列表' : '管理已忽略的组'}
          </button>

          {isIgnoredListOpen && (
            <>
              <ul className="mt-2 max-h-64 overflow-y-auto custom-scrollbar space-y-1.5">
                {ignoredGroups.map((item) => (
                  <li
                    key={item.key}
                    className="flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-glass)] px-2.5 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-[var(--text-primary)] truncate" title={item.label}>
                        {item.label}
                      </p>
                      <p className="text-xs text-[var(--text-quaternary)] tabular-nums">
                        {item.memberCount} 张 · {formatIgnoredDate(item.ignoredAt)}
                      </p>
                    </div>
                    <button
                      onClick={() => onRestoreIgnored(item.key)}
                      className="shrink-0 text-xs text-[var(--accent-blue)] hover:opacity-80 px-2 py-1 rounded-lg hover:bg-[var(--bg-glass-active)]"
                      title="取消忽略，下次检测重新显示这一组"
                    >
                      恢复
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-2.5 text-[11px] leading-relaxed text-[var(--text-quaternary)]">
                按组内成员的内容指纹记录。增删照片或调整阈值让成员变化后，这组会重新出现。
              </p>
            </>
          )}
        </section>
      )}
    </>
  );
};

export default DuplicateReportPanel;
