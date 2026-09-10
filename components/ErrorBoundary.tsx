import React from 'react';
import { logger } from '../logger';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** 自定义兜底 UI；不传则使用默认的整屏错误页 */
  fallback?: React.ReactNode;
  /** 出错区域名称，便于定位是哪个模块崩溃 */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * 错误边界。
 * 渲染期异常（例如某张图片元数据异常导致组件抛错）会向上冒泡到最近的边界，
 * 由边界降级渲染兜底 UI，从而保住边界之外的其余功能不白屏。
 * 支持局部使用（传 fallback）与整屏使用（默认兜底）。
 */
class ErrorBoundary extends React.Component {
  state: ErrorBoundaryState = { error: null };

  // 本项目未引入 @types/react，React.Component 无类型成员；
  // 这里显式声明用到的基类成员，仅为通过类型检查，运行期由 React 提供。
  declare props: ErrorBoundaryProps;
  declare setState: (state: Partial<ErrorBoundaryState>) => void;

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    logger.error(`[ErrorBoundary${this.props.label ? ` · ${this.props.label}` : ''}] 渲染异常：`, error, info.componentStack);
  }

  private handleRetry = () => {
    this.setState({ error: null });
  };

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback !== undefined) {
      return this.props.fallback;
    }

    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[var(--bg-primary)] p-6">
        <div className="max-w-md w-full bg-[var(--bg-modal)] border border-[var(--border-default)] rounded-2xl shadow-2xl p-8 text-center">
          <div className="w-14 h-14 mx-auto mb-5 rounded-2xl bg-[rgba(var(--accent-pink-rgb),0.15)] flex items-center justify-center">
            <svg className="w-7 h-7 text-[var(--accent-pink)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.8">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3.75h.008M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
          </div>
          <h1 className="text-lg font-semibold text-[var(--text-primary)] mb-2">界面出了点问题</h1>
          <p className="text-sm text-[var(--text-secondary)] mb-1">应用的一部分意外崩溃，其余功能可能仍然可用。</p>
          <p className="text-xs text-[var(--text-quaternary)] font-mono break-all mb-6">{error.message}</p>
          <div className="flex justify-center gap-3">
            <button
              onClick={this.handleRetry}
              className="px-5 py-2 text-sm font-medium rounded-xl text-[var(--text-secondary)] border border-[var(--border-default)] hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] transition-colors"
            >
              重试
            </button>
            <button
              onClick={this.handleReload}
              className="px-5 py-2 text-sm font-semibold rounded-xl text-[var(--accent-contrast)] bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-hover))] shadow-lg shadow-[rgba(var(--accent-blue-rgb),0.3)] hover:opacity-90 transition-opacity"
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
