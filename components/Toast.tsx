
import React, { useCallback, useEffect, useRef, useState } from 'react';

export type ToastType = 'success' | 'info' | 'error' | 'warning';

/** Toast 上的可选操作按钮（如「重试」） */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastData {
  id: number;
  message: string;
  type: ToastType;
  action?: ToastAction;
}

interface ToastProps {
  message: string;
  type?: ToastType;
  onClose: () => void;
  /** 自动关闭时长；0 表示不自动关闭（错误级 / 带操作按钮时常驻，需用户处理） */
  duration?: number;
  /** 操作按钮：点击后执行回调并关闭本条通知 */
  action?: ToastAction;
}

/** 单条 Toast 卡片：定位与堆叠由外层容器负责 */
const Toast: React.FC<ToastProps> = ({ message, type = 'info', onClose, duration, action }) => {
  // 错误级 / 带操作按钮的默认常驻，其余 3.2s 自动消失
  const autoDismiss = duration !== undefined ? duration : type === 'error' || action ? 0 : 3200;
  const [isVisible, setIsVisible] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const leaveTimerRef = useRef<number | null>(null);
  // 剩余自动关闭时间：指针悬停在卡片上时暂停倒计时，移开后从剩余时间继续
  const remainingRef = useRef(autoDismiss);
  const startedAtRef = useRef(0);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    clearCloseTimer();
    setIsLeaving(true);
    // 等离场动画播完再真正移除
    leaveTimerRef.current = window.setTimeout(onClose, 260);
  }, [clearCloseTimer, onClose]);

  const startCloseTimer = useCallback((delay: number) => {
    clearCloseTimer();
    if (delay <= 0) return;
    startedAtRef.current = Date.now();
    closeTimerRef.current = window.setTimeout(dismiss, delay);
  }, [clearCloseTimer, dismiss]);

  useEffect(() => {
    const enterTimer = window.setTimeout(() => setIsVisible(true), 10);
    startCloseTimer(remainingRef.current);
    return () => {
      window.clearTimeout(enterTimer);
      clearCloseTimer();
      if (leaveTimerRef.current !== null) window.clearTimeout(leaveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 悬停：暂停倒计时，并记住还剩多久 */
  const handleMouseEnter = () => {
    if (autoDismiss <= 0 || closeTimerRef.current === null) return;
    clearCloseTimer();
    remainingRef.current = Math.max(200, remainingRef.current - (Date.now() - startedAtRef.current));
  };

  /** 移开：从剩余时间接着倒计时 */
  const handleMouseLeave = () => {
    if (autoDismiss <= 0 || isLeaving) return;
    startCloseTimer(remainingRef.current);
  };

  const ringColors: Record<ToastType, string> = {
    success: 'ring-[rgba(var(--accent-green-rgb),0.3)]',
    info: 'ring-[rgba(var(--accent-cyan-rgb),0.3)]',
    error: 'ring-[rgba(var(--accent-pink-rgb),0.35)]',
    warning: 'ring-[rgba(var(--accent-orange-rgb),0.35)]',
  };

  const iconColors: Record<ToastType, string> = {
    success: 'bg-[rgba(var(--accent-green-rgb),0.15)] text-[var(--accent-green)]',
    info: 'bg-[rgba(var(--accent-cyan-rgb),0.15)] text-[var(--accent-cyan)]',
    error: 'bg-[rgba(var(--accent-pink-rgb),0.15)] text-[var(--accent-pink)]',
    warning: 'bg-[rgba(var(--accent-orange-rgb),0.18)] text-[var(--accent-orange)]',
  };

  return (
    <div
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={`pointer-events-auto flex items-center gap-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-tooltip)] px-4 py-3 shadow-2xl ring-1 backdrop-blur-xl transition-all duration-300 ease-out ${
        isLeaving
          ? 'translate-y-3 opacity-0'
          : isVisible
            ? 'translate-y-0 opacity-100'
            : 'translate-y-3 opacity-0'
      } ${ringColors[type]}`}
      role={type === 'error' || type === 'warning' ? 'alert' : 'status'}
    >
      {type === 'success' && (
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${iconColors.success}`}>
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"></path></svg>
        </span>
      )}
      {type === 'info' && (
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${iconColors.info}`}>
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
        </span>
      )}
      {type === 'error' && (
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${iconColors.error}`}>
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
        </span>
      )}
      {type === 'warning' && (
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${iconColors.warning}`}>
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
        </span>
      )}
      <span className="min-w-0 flex-1 text-sm font-medium text-[var(--text-primary)]">{message}</span>
      {action && (
        <button
          onClick={() => {
            action.onClick();
            dismiss();
          }}
          className="shrink-0 rounded-lg border border-[var(--border-default)] bg-[var(--bg-glass)] px-2.5 py-1 text-xs font-semibold text-[var(--accent-blue)] transition-colors hover:bg-[var(--bg-glass-hover)]"
        >
          {action.label}
        </button>
      )}
      <button
        onClick={dismiss}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)]"
        aria-label="关闭通知"
      >
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"></path></svg>
      </button>
    </div>
  );
};

export default Toast;
