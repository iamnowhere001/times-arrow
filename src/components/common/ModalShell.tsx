import React, { useRef } from 'react';
import { useModalA11y } from '@/hooks/useModalA11y';

interface ModalShellProps {
  isOpen: boolean;
  onClose: () => void;
  /** 面板完整样式：长相由各弹窗自定，基座只统一结构与行为 */
  panelClassName: string;
  /** 遮罩层级：确认类 60 / 功能类 70 / 设置与资产 80 */
  zIndex?: 60 | 70 | 80;
  ariaLabel?: string;
  /** 批量操作进行中：Esc 不关闭 */
  a11yDisabled?: boolean;
  /** 点击遮罩关闭（默认不关，避免误触丢下填到一半的表单） */
  closeOnOverlayClick?: boolean;
  children: React.ReactNode;
}

/* Tailwind 只静态扫描字面类名，动态拼接的 z-[${n}] 不会生成，必须整串写明 */
const OVERLAY_CLASS: Record<60 | 70 | 80, string> = {
  60: 'fixed inset-0 z-[60] flex items-center justify-center bg-[var(--bg-overlay)] backdrop-blur-md animate-fadeIn',
  70: 'fixed inset-0 z-[70] flex items-center justify-center bg-[var(--bg-overlay)] backdrop-blur-md animate-fadeIn',
  80: 'fixed inset-0 z-[80] flex items-center justify-center bg-[var(--bg-overlay)] backdrop-blur-md animate-fadeIn',
};

/**
 * 弹窗结构基座：遮罩 + role="dialog" 面板 + 无障碍接线（焦点陷阱 / Esc / 焦点归还）。
 * 收敛的是 9 个弹窗逐字重复的外壳结构与 useModalA11y 接线；
 * 面板视觉（宽度 / 圆角 / 背景 / 动画）仍由 panelClassName 原样传入，长相零变化。
 */
const ModalShell: React.FC<ModalShellProps> = ({
  isOpen,
  onClose,
  panelClassName,
  zIndex = 60,
  ariaLabel,
  a11yDisabled = false,
  closeOnOverlayClick = false,
  children,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalA11y({ isOpen, onClose, containerRef: dialogRef, disabled: a11yDisabled });

  if (!isOpen) return null;

  return (
    <div className={OVERLAY_CLASS[zIndex]} onClick={closeOnOverlayClick ? onClose : undefined}>
      <div
        className={panelClassName}
        role="dialog"
        aria-modal="true"
        ref={dialogRef}
        aria-label={ariaLabel}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
};

export default ModalShell;
