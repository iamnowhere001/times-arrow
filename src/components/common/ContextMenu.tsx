
import React, { useEffect, useRef } from 'react';

export interface ContextMenuItem {
  label?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
  separator?: boolean;
  disabled?: boolean;
  /** 右侧快捷键提示，如 "⌘⇧F" */
  shortcut?: string;
}

interface ContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  actions: ContextMenuItem[];
}

const MENU_WIDTH = 232;

const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, onClose, actions }) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleResize = () => onClose();

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleResize, true);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleResize, true);
    };
  }, [onClose]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 贴边翻转：菜单朝哪个方向展开，就让它从那个角「长」出来
  const flipX = window.innerWidth - x < MENU_WIDTH;
  const estHeight = actions.reduce((h, a) => h + (a.separator ? 9 : 38), 6);
  const flipY = window.innerHeight - y < estHeight;

  const style: React.CSSProperties = {
    top: flipY ? Math.max(8, y - estHeight) : y,
    left: flipX ? x - MENU_WIDTH : x,
    transformOrigin: `${flipY ? 'bottom' : 'top'} ${flipX ? 'right' : 'left'}`,
  };

  return (
    <div
      ref={menuRef}
      className="fixed z-[9999] w-[232px] rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tooltip)] py-1.5 shadow-2xl backdrop-blur-xl animate-scaleIn select-none"
      style={style}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {actions.map((action, index) => (
        <React.Fragment key={index}>
          {action.separator ? (
            <div className="mx-3 my-1 h-px bg-[var(--border-subtle)]" />
          ) : (
            <button
              onClick={() => {
                if (!action.disabled && action.onClick) {
                  action.onClick();
                  onClose();
                }
              }}
              disabled={action.disabled}
              className={`mx-1 flex w-[calc(100%-8px)] items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium transition-colors duration-150
                ${action.disabled
                    ? 'cursor-default text-[var(--text-quaternary)]'
                    : action.danger
                      ? 'text-[var(--accent-pink)] hover:bg-[rgba(var(--accent-pink-rgb),0.12)]'
                      : 'text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)]'
                }`}
            >
              {action.icon && (
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center ${!action.disabled && !action.danger ? 'text-[var(--text-tertiary)]' : ''}`}>
                  {action.icon}
                </span>
              )}
              <span className="flex-1 truncate">{action.label}</span>
              {action.shortcut && (
                <span className="shrink-0 font-mono text-[11px] tracking-tight text-[var(--text-quaternary)]">{action.shortcut}</span>
              )}
            </button>
          )}
        </React.Fragment>
      ))}
    </div>
  );
};

export default ContextMenu;
