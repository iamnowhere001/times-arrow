/**
 * Toast 队列渲染（从 App 抽出）。
 *
 * 队列数据由 useToasts 管理（最多 4 条、错误级常驻），这里只负责
 * 底部居中堆叠的展示；无 Toast 时不渲染任何内容。
 */

import Toast, { type ToastData } from '@/components/common/Toast';

export interface ToastStackProps {
  toasts: ToastData[];
  /** 关闭单条 Toast（由 useToasts 的 dismissToast 提供） */
  onDismiss: (id: number) => void;
}

export default function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] flex flex-col items-center gap-2 pointer-events-none w-[min(440px,90vw)]">
      {toasts.map(toast => (
        <Toast
          key={toast.id}
          message={toast.message}
          type={toast.type}
          action={toast.action}
          onClose={() => onDismiss(toast.id)}
        />
      ))}
    </div>
  );
}
