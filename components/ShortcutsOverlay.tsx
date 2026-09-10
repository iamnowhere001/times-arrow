import React from 'react';

/**
 * 快捷键总览层：按角色（`⇧/` 唤出，`Esc` 关闭）分组列出当前应用的快捷键。
 * 纯展示层，不接管任何逻辑；数据与 README「快捷键」一节保持一致。
 */

/** 单个键位徽标，沿用全局 .kbd 样式，多键组合用 + 连接 */
const Key = ({ children }: { children: React.ReactNode }) => <kbd className="kbd">{children}</kbd>;

type ShortcutRow = { keys: string[]; desc: string };
type ShortcutGroup = { title: string; rows: ShortcutRow[] };

const GROUPS: ShortcutGroup[] = [
  {
    title: '主视图',
    rows: [
      { keys: ['⌘', 'A'], desc: '全选当前视图' },
      { keys: ['⌘', 'F'], desc: '聚焦搜索框' },
      { keys: ['⌘', '⇧', 'F'], desc: '批量收藏 / 取消收藏' },
      { keys: ['⌘', 'O'], desc: '打开目录' },
      { keys: ['Space'], desc: '打开预览' },
      { keys: ['←', '→', '↑', '↓'], desc: '移动单张选择' },
      { keys: ['⌫', 'Delete'], desc: '删除选中项' },
      { keys: ['Esc'], desc: '关闭菜单 / 清除选择' },
    ],
  },
  {
    title: '预览（QuickLook）',
    rows: [
      { keys: ['→', 'L', 'PgDn'], desc: '下一张' },
      { keys: ['←', 'H', 'PgUp'], desc: '上一张' },
      { keys: ['+', '-'], desc: '放大 / 缩小' },
      { keys: ['0'], desc: '重置缩放与旋转' },
      { keys: ['R'], desc: '顺时针旋转（⇧R 逆时针）' },
      { keys: ['F'], desc: '收藏 / 取消收藏' },
      { keys: ['Space'], desc: '图片：幻灯片；视频：播放/暂停' },
      { keys: ['Esc', 'Q'], desc: '关闭预览' },
    ],
  },
  {
    title: '重复检测',
    rows: [{ keys: ['Esc'], desc: '返回图库' }],
  },
  {
    title: '通用',
    rows: [
      { keys: ['⇧', '/'], desc: '打开本快捷键总览' },
      { keys: ['Esc'], desc: '关闭本总览' },
    ],
  },
];

const ShortcutsOverlay: React.FC<{ onClose: () => void }> = ({ onClose }) => (
  <div
    className="fixed inset-0 z-[150] bg-[var(--bg-overlay)] backdrop-blur-xl flex items-center justify-center p-6 animate-fadeIn"
    onClick={onClose}
    role="dialog"
    aria-modal="true"
    aria-label="键盘快捷键总览"
  >
    <div
      className="w-full max-w-2xl max-h-[80vh] overflow-y-auto custom-scrollbar bg-[var(--bg-modal)] backdrop-blur-xl rounded-2xl shadow-2xl border border-[var(--border-default)] p-7 animate-scaleIn"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-2">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)] tracking-tight">键盘快捷键</h2>
          <p className="text-xs text-[var(--text-tertiary)] mt-0.5">按 <kbd className="kbd">⇧/</kbd> 随时唤出，<kbd className="kbd">Esc</kbd> 关闭</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="flex items-center justify-center w-8 h-8 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] active:bg-[var(--bg-glass-active)] transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4 mt-4">
        {GROUPS.map((g) => (
          <section key={g.title} className="min-w-0">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-1.5">{g.title}</h3>
            <div>
              {g.rows.map((r, i) => (
                <div key={i} className="flex items-center justify-between gap-6 py-2.5 border-b border-[var(--border-subtle)] last:border-0">
                  <span className="text-[13px] text-[var(--text-secondary)]">{r.desc}</span>
                  <span className="flex items-center gap-1 shrink-0">
                    {r.keys.map((k, n) => (
                      <React.Fragment key={n}>
                        {n > 0 && <span className="text-[var(--text-quaternary)]">+</span>}
                        <Key>{k}</Key>
                      </React.Fragment>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  </div>
);

export default ShortcutsOverlay;