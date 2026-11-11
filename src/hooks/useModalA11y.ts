/**
 * 弹层无障碍基座（v0.6.2 批次 5 / D17）。
 *
 * 9 个 Modal 此前各自写了 Esc，但**没有一个**做焦点管理：Tab 会跑到弹层后面的
 * 图库按钮上、打开时焦点还留在触发按钮、关闭后焦点掉回 body —— 键盘用户等于
 * 每次开弹窗都要重新 Tab 一遍。这里把四件事收成一份：
 *   1. 打开时把焦点移进弹层（第一个可聚焦元素，没有则容器本身）；
 *   2. Tab / Shift+Tab 在弹层内循环，不逸出；
 *   3. Esc 关闭（执行中可禁用，避免把进度遮罩下的弹层关掉）；
 *   4. 关闭后把焦点归还给打开它的那个元素。
 *
 * 用 hook 而不是统一的 `<ModalShell>`，是为了不动 9 个弹层各自的视觉外壳与布局 ——
 * 基座统一的是**行为**，不是长相。
 */

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export interface ModalA11yOptions {
  isOpen: boolean;
  onClose: () => void;
  /** 挂 role="dialog" 的那个容器 */
  containerRef: RefObject<HTMLElement | null>;
  /** 批量操作进行中：Esc 不关闭 */
  disabled?: boolean;
}

/** 可见的可聚焦元素；隐藏元素（display:none）不该进入 Tab 循环 */
const focusableIn = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getClientRects().length > 0
  );

export const useModalA11y = ({
  isOpen,
  onClose,
  containerRef,
  disabled = false,
}: ModalA11yOptions): void => {
  // 回调与禁用态用 ref 镜像：避免 onClose 每次渲染新建导致 effect 反复重挂、
  // 进而把焦点反复抢回弹层第一个元素
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const container = containerRef.current;
    if (!container) return;

    const active = document.activeElement;
    restoreRef.current = active instanceof HTMLElement ? active : null;

    if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
    const initial = focusableIn(container)[0] ?? container;
    initial.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (disabledRef.current) return;
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = focusableIn(container);
      if (items.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || current === container)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // 捕获阶段：弹层内的输入框可能自己 stopPropagation，焦点陷阱仍要生效
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const restore = restoreRef.current;
      restoreRef.current = null;
      if (restore && document.contains(restore)) restore.focus();
    };
  }, [isOpen, containerRef]);
};
