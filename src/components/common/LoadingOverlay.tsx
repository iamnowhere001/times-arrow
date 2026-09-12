import React from 'react';

/**
 * 大文件导入 / 扫描的进度遮罩（纯展示组件）。
 *
 * `total` 为 0 表示「扫描阶段」（总数未知），此时进度条展示为不确定态动画；
 * 大于 0 表示「入库阶段」，按 `progress / total` 展示百分比。
 */
interface LoadingOverlayProps {
  /** 总条目数；0 表示无法预知总数（不确定态动画） */
  total: number;
  /** 已处理条目数 */
  progress: number;
  /** 当前正在处理的文件名 */
  currentFile: string;
  /** 取消操作；不传则不显示取消按钮（如重命名 / 移动这类不可中断的批量操作） */
  onCancel?: () => void;
  /** 主标题；默认按 total 区分「正在处理媒体 / 正在扫描文件夹」 */
  title?: string;
  /** 底部状态文案；默认「个项目 / 请稍候」 */
  hint?: string;
}

const LoadingOverlay: React.FC<LoadingOverlayProps> = ({
  total,
  progress,
  currentFile,
  onCancel,
  title,
  hint,
}) => (
  <div className="fixed inset-0 bg-[var(--bg-overlay)] backdrop-blur-2xl z-[100] flex items-center justify-center">
    <div className="relative">
      <div className="absolute inset-0 bg-gradient-to-br from-[var(--accent-blue)]/20 via-transparent to-[var(--accent-purple)]/20 rounded-3xl blur-3xl animate-pulse"></div>

      <div className="relative bg-[var(--bg-modal)] backdrop-blur-xl rounded-3xl shadow-2xl p-8 w-80 border border-[var(--border-default)]">
        <div className="flex flex-col items-center">
          <div className="relative w-20 h-20 mb-6">
            <div className="absolute inset-0 rounded-full bg-gradient-to-br from-[var(--accent-blue)] to-[var(--accent-purple)] opacity-20 animate-ping"></div>
            <div className="absolute inset-2 rounded-full bg-[var(--bg-modal)]"></div>
            <div className="absolute inset-0 rounded-full border-2 border-[var(--border-default)]"></div>
            <div className="absolute inset-0 rounded-full border-t-2 border-r-2 border-[var(--accent-blue)] animate-spin" style={{ animationDuration: '1.5s' }}></div>
            <div className="absolute inset-1 rounded-full border-b-2 border-l-2 border-[var(--accent-purple)] animate-spin" style={{ animationDuration: '2s', animationDirection: 'reverse' }}></div>
            <div className="absolute inset-0 flex items-center justify-center">
              <svg className="w-8 h-8 text-[var(--accent-cyan)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
          </div>

          <h3 className="text-xl font-semibold text-[var(--text-primary)] mb-4 tracking-wide">
            {title ?? (total > 0 ? '正在处理媒体' : '正在扫描文件夹')}
          </h3>

          <div className="w-full space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-[var(--text-tertiary)]">{total > 0 ? '进度' : '状态'}</span>
              <span className="font-medium bg-gradient-to-r from-[var(--accent-cyan)] to-[var(--accent-purple)] bg-clip-text text-transparent">
                {total > 0 ? `${Math.round((progress / total) * 100)}%` : '处理中'}
              </span>
            </div>

            <div className="relative h-2.5 bg-[var(--bg-glass-hover)] rounded-full overflow-hidden">
              {total > 0 ? (
                <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-[var(--accent-blue)] via-[var(--accent-cyan)] to-[var(--accent-purple)] rounded-full transition-all duration-500 ease-out shadow-lg"
                  style={{ width: `${Math.max(5, (progress / total) * 100)}%` }}>
                </div>
              ) : (
                // 扫描阶段无法预知总数：用不确定态动画，避免误导性的百分比
                <div
                  className="absolute inset-y-0 rounded-full bg-gradient-to-r from-transparent via-[var(--accent-cyan)] to-transparent"
                  style={{ width: '33%', animation: 'loadingSlide 1.4s ease-in-out infinite' }}
                />
              )}
            </div>

            <div className="flex justify-between items-center">
              <span className="text-xs text-[var(--text-quaternary)] font-mono">
                {total > 0 ? `${progress} / ${total}` : '—'}
              </span>
              <span className="text-xs text-[var(--text-quaternary)]">{hint ?? (total > 0 ? '个项目' : '请稍候')}</span>
            </div>

            <div className="h-8 mt-2 px-3 py-1.5 bg-[var(--bg-glass)] rounded-xl border border-[var(--border-subtle)] flex items-center justify-center overflow-hidden">
              <p className="text-xs text-[var(--text-tertiary)] truncate">
                {currentFile || '等待处理...'}
              </p>
            </div>

            {onCancel && (
              <button
                onClick={onCancel}
                className="w-full mt-1 py-2 text-sm font-medium rounded-xl border border-[var(--border-default)] bg-[var(--bg-glass)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] transition-all duration-200 active:scale-[0.98]"
              >
                取消添加
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  </div>
);

export default LoadingOverlay;
