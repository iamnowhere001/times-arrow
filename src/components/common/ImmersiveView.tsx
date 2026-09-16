import React from 'react';

/**
 * 沉浸态外壳（K28）。
 *
 * 时光画廊 / 按地点浏览 / QuickLook 三处都是「照片主导」的整页视图：
 * 界面该退后，让照片自己说话。此前只有 QuickLook 是深色底，另两处跟随
 * 全局主题 —— 在浅色主题下照片被放在一张白纸上，与「看照片」这件事相悖，
 * 三处也各用各的颜色（QuickLook 甚至是冷灰 rgba(30,30,40)，与暖石墨的
 * 暗房色板不是一套）。
 *
 * 这里把沉浸态抽成一层外壳，三处共用：
 *   1. 隐藏 chrome —— 整页视图不渲染侧栏 / 工具栏（由 App 的 mainView 分支保证），
 *      外壳本身只负责内容铺满，不引入任何装饰；
 *   2. 暗底 —— `.immersive-surface` 在子树内把暗房色板重新声明一遍，
 *      无论全局是浅色还是深色，照片都落在同一张黑纸上；
 *   3. 内容铺满 —— flex-1 + min-h-0 + overflow-hidden，交给内部视图自行滚动。
 *
 * 色板只声明一次：styles.css 里 `:root, .immersive-surface` 共用同一组变量，
 * 不复制一份值，改色时不会只改到一半。
 */
interface ImmersiveViewProps {
  /** 追加类名（如定位方式 / 层级）；不要在这里改背景色 */
  className?: string;
  children: React.ReactNode;
}

export const ImmersiveView: React.FC<ImmersiveViewProps> = ({ className, children }) => (
  <div
    className={`immersive-surface flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bg-primary)] ${className ?? ''}`}
  >
    {children}
  </div>
);

export default ImmersiveView;
