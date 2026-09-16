/**
 * 整页视图的错误兜底展示（从 App 抽出）。
 *
 * 重复检测 / 时光画廊 / 按地点浏览 / 图库四个视图的 ErrorBoundary 共用同一套
 * 版式：标题 + 一句「内容仍然完好」的说明 + 一个脱困按钮。
 * 此前这四份 JSX 在 App 里逐字重复（仅文案与按钮行为不同），抽成组件后
 * 新增整页视图只需传三个文案参数。
 */

export interface ViewErrorFallbackProps {
  /** 出错标题（如「时光画廊渲染出错」） */
  title: string;
  /** 补充说明：告诉用户数据没坏、可以怎么办 */
  description: string;
  /** 脱困按钮文案；默认「返回图库」 */
  actionLabel?: string;
  /** 脱困按钮行为；不传时按钮不渲染 */
  onAction?: () => void;
}

export default function ViewErrorFallback({
  title,
  description,
  actionLabel = '返回图库',
  onAction,
}: ViewErrorFallbackProps) {
  return (
    <div className="flex-1 flex items-center justify-center p-8 text-center">
      <div>
        <p className="text-sm font-medium text-[var(--text-primary)] mb-1">{title}</p>
        <p className="text-xs text-[var(--text-tertiary)] mb-4">{description}</p>
        {onAction && (
          <button
            onClick={onAction}
            className="px-4 py-2 text-sm font-medium rounded-xl text-[var(--text-secondary)] border border-[var(--border-default)] hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] transition-colors"
          >
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}
