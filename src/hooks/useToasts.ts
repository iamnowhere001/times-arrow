/**
 * Toast 队列 Hook（从 App 抽出）。
 *
 * 支持多条同时展示、错误级常驻；最多保留最近 4 条。
 * 仅管理队列数据，渲染由 App 负责（底部居中堆叠）。
 */

import { useCallback, useRef, useState } from 'react';
import { ToastAction, ToastData, type ToastType } from '../components/Toast';

export interface UseToastsResult {
  toasts: ToastData[];
  showToast: (message: string, type?: ToastType, action?: ToastAction) => void;
  dismissToast: (id: number) => void;
}

export function useToasts(): UseToastsResult {
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const toastIdRef = useRef(0);

  const showToast = useCallback((
    message: string,
    type: ToastType = 'info',
    /** 可选操作按钮（如「重试」）：带按钮的 Toast 不会自动消失 */
    action?: ToastAction
  ) => {
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev.slice(-3), { id, message, type, action }]); // 最多同时 4 条
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return { toasts, showToast, dismissToast };
}
