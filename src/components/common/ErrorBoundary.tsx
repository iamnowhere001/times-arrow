import React from 'react';
import { logger } from '@/lib/logger';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** 自定义兜底 UI；不传则使用默认的整屏错误页 */
  fallback?: React.ReactNode;
  /** 出错区域名称，便于定位是哪个模块崩溃 */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
  /** 本次会话里连续重试的次数：单纯 reset 会以相同入参重挂载，常常立刻再崩一次 */
  retryCount: number;
  /** 是否展开技术细节（错误堆栈摘要） */
  showDetails: boolean;
}

/**
 * 错误边界。
 * 渲染期异常（例如某张图片元数据异常导致组件抛错）会向上冒泡到最近的边界，
 * 由边界降级渲染兜底 UI，从而保住边界之外的其余功能不白屏。
 * 支持局部使用（传 fallback）与整屏使用（默认兜底）。
 *
 * v0.6.2 批次 4：默认兜底的「重试」以前只是把 error 清空、以相同入参重挂载，
 * 用户点几次都回到同一屏，既不知道哪里坏了，也不知道下一步该做什么。
 * 现在给出出错区域、连续失败次数、可展开的错误详情，并在反复失败后把
 * 「重新加载」明确为主要动作。
 */
class ErrorBoundary extends React.Component {
  state: ErrorBoundaryState = { error: null, retryCount: 0, showDetails: false };

  // 本项目未引入 @types/react，React.Component 无类型成员；
  // 这里显式声明用到的基类成员，仅为通过类型检查，运行期由 React 提供。
  declare props: ErrorBoundaryProps;
  declare setState: (
    state: Partial<ErrorBoundaryState> | ((prev: ErrorBoundaryState) => Partial<ErrorBoundaryState>)
  ) => void;

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    logger.error(
      `[ErrorBoundary${this.props.label ? ` · ${this.props.label}` : ''}] 渲染异常：`,
      error,
      info.componentStack
    );
  }

  private handleRetry = () => {
    this.setState((prev: ErrorBoundaryState) => ({
      error: null,
      retryCount: prev.retryCount + 1,
    }));
  };

  private handleReload = () => {
    window.location.reload();
  };

  private toggleDetails = () => {
    this.setState((prev: ErrorBoundaryState) => ({ showDetails: !prev.showDetails }));
  };

  render() {
    const { error, retryCount, showDetails } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback !== undefined) {
      return this.props.fallback;
    }

    const repeated = retryCount >= 2;
    const area = this.props.label || '界面';

    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[var(--bg-primary)] p-6">
        <div className="max-w-md w-full bg-[var(--bg-modal)] border border-[var(--border-default)] rounded-2xl shadow-2xl p-8 text-center">
          <div className="w-14 h-14 mx-auto mb-5 rounded-2xl bg-[rgba(var(--accent-pink-rgb),0.15)] flex items-center justify-center">
            <svg
              className="w-7 h-7 text-[var(--accent-pink)]"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth="1.8"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m0 3.75h.008M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
              />
            </svg>
          </div>
          <h1 className="text-lg font-semibold text-[var(--text-primary)] mb-2">
            {area}出了点问题
          </h1>
          <p className="text-sm text-[var(--text-secondary)] mb-1">
            {repeated
              ? `已连续重试 ${retryCount} 次仍失败，同样的操作很可能再次出错。`
              : '应用的一部分意外崩溃，其余功能可能仍然可用。'}
          </p>
          <p className="text-xs text-[var(--text-tertiary)] mb-3">
            {repeated
              ? '建议重新加载应用：收藏、标签与相簿已保存在本机，不会因此丢失。'
              : '可以先试着重试；若反复出现，重新加载应用通常能恢复。'}
          </p>

          <button
            onClick={this.toggleDetails}
            aria-expanded={showDetails}
            className="text-xs text-[var(--accent-blue)] hover:opacity-80 mb-4"
          >
            {showDetails ? '收起错误详情' : '查看错误详情'}
          </button>
          {showDetails ? (
            <pre className="text-left text-xs text-[var(--text-quaternary)] font-mono break-all whitespace-pre-wrap max-h-40 overflow-y-auto custom-scrollbar bg-[var(--bg-input)] rounded-xl p-3 mb-5">
              {error.stack || `${error.name}: ${error.message}`}
            </pre>
          ) : (
            <p className="text-xs text-[var(--text-quaternary)] font-mono break-all mb-5">
              {error.message}
            </p>
          )}

          <div className="flex justify-center gap-3">
            <button
              onClick={this.handleRetry}
              className={`px-5 py-2 text-sm font-medium rounded-xl border border-[var(--border-default)] hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] transition-colors ${
                repeated ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]'
              }`}
            >
              重试
            </button>
            <button
              onClick={this.handleReload}
              className={`px-5 py-2 text-sm font-semibold rounded-xl shadow-lg shadow-[rgba(var(--accent-blue-rgb),0.3)] hover:opacity-90 transition-opacity ${
                repeated
                  ? 'text-[var(--accent-contrast)] bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-hover))]'
                  : 'text-[var(--text-secondary)] border border-[var(--border-default)] bg-[var(--bg-glass)]'
              }`}
            >
              重新加载
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
