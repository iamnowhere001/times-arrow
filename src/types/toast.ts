/**
 * Toast 的数据模型。
 *
 * 放在 types/ 而不是 components/：hooks 需要构造 Toast 数据（含操作按钮回调），
 * 但不应为此反向依赖展示组件。组件只负责渲染这些结构。
 */
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
