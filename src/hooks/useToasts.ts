/**
 * Toast 队列 Hook（从 App 抽出）。
 *
 * 支持多条同时展示、错误级常驻；最多保留最近 4 条。
 * 仅管理队列数据，渲染由 App 负责（底部居中堆叠）。
 */

import { useCallback, useRef, useState } from 'react';
import { ToastAction, ToastData, type ToastType } from '@/components/common/Toast';

/** 同时最多展示几条：超出的按「优先淘汰无操作按钮的旧条目」策略移除 */
const MAX_TOASTS = 4;

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
    setToasts(prev => {
      const next = [...prev, { id, message, type, action }];
      if (next.length <= MAX_TOASTS) return next;

      // 超限时优先淘汰「不带操作按钮」的旧条目。
      // 直接砍最早一条的话，带「重试」的失败提示会被后来的普通提示静默顶掉，
      // 用户就失去了唯一的恢复入口（只有最后一条不参与淘汰）。
      const candidates = next.slice(0, -1);
      const index = Math.max(0, candidates.findIndex(t => !t.action));
      next.splice(index, 1);
      return next;
    });
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return { toasts, showToast, dismissToast };
}
