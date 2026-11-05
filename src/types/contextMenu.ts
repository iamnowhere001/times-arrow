import type { ReactNode } from 'react';

/**
 * 右键菜单项的数据结构。
 *
 * 放在 types/ 而不是 ContextMenu.tsx：`src/lib/contextMenuActions.ts` 需要构造这些
 * 菜单项，但不应为了一份类型反向依赖展示组件；组件反过来从这里引用。
 */
export interface ContextMenuItem {
  label?: string;
  icon?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  separator?: boolean;
  disabled?: boolean;
  /** 右侧快捷键提示，如 "⌘⇧F" */
  shortcut?: string;
}
