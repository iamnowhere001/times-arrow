import React from 'react';

/**
 * 全局拖放提示遮罩（纯展示组件）。
 *
 * 进 / 出场由父级通过 `mounted`（是否挂载）与 `active`（是否淡入到位）控制：
 * 拖入时先挂载、下一帧再淡入；拖出时先淡出、动画结束才卸载。
 */
interface DragOverlayProps {
  /** 是否已挂载（决定是否渲染到 DOM） */
  mounted: boolean;
  /** 是否处于激活态（决定透明度 / 缩放） */
  active: boolean;
}

const DragOverlay: React.FC<DragOverlayProps> = ({ mounted, active }) => {
  if (!mounted) return null;

  return (
    <div className={`fixed inset-0 z-50 bg-[var(--bg-overlay)] backdrop-blur-xl flex items-center justify-center pointer-events-none transition-opacity duration-200 ease-entrance ${active ? 'opacity-100' : 'opacity-0'}`}>
      <div className={`bg-[var(--bg-modal)] backdrop-blur-xl rounded-3xl shadow-2xl p-14 border border-[var(--border-default)] text-center transition-[transform,opacity] duration-200 ease-entrance ${active ? 'scale-100 opacity-100' : 'scale-[0.98] opacity-0'}`}>
        <div className="w-24 h-24 mx-auto mb-8 rounded-full bg-[rgba(var(--accent-blue-rgb),0.12)] flex items-center justify-center shadow-xl shadow-[rgba(var(--accent-blue-rgb),0.15)]">
          <svg className="w-12 h-12 text-[var(--accent-blue)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path>
          </svg>
        </div>
        <h3 className="text-2xl font-semibold text-[var(--text-primary)] mb-3 tracking-wide">拖放图片或视频到此处</h3>
        <p className="text-sm text-[var(--text-tertiary)]">支持 JPG、PNG、WEBP、HEIC 与 MP4、MOV、WEBM、MKV 等格式</p>
      </div>
    </div>
  );
};

export default DragOverlay;
