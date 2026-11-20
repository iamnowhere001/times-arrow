import { useEffect } from 'react';

/**
 * 应用菜单 → 渲染层的事件桥。
 *
 * ## 为什么单独一个 hook
 *
 * 这四个订阅散落在 App 里时，读者无法判断「主进程菜单到底能触发哪些动作」——
 * 要通读全部 `useEffect` 才能拼出来。集中之后，**菜单能做什么**在这里一目了然；
 * 主进程侧对应的发送点在 `electron/main/menu.cjs`，两处对照即可核对契约。
 *
 * ## 两条纪律
 *
 * 1. 每个订阅都必须返回 unsubscribe（`window.electronAPI.onXxx` 返回的函数），
 *    useEffect 直接把它作为清理函数 —— 漏掉会让 HMR 或视图重建后累积多个监听，
 *    表现为「一次操作触发两次」。
 * 2. 依赖写真实用到的回调。这些回调在 App 里都是 `useCallback` 包裹的稳定引用，
 *    因此不会因为父组件重渲染而反复订阅。
 *
 * 注意：`⌘Z` 仍归 Chromium 原生文本撤销，「撤销上次文件操作」用的是 `⌥⌘Z`。
 */
export function useAppMenuEvents({
  onImportPaths,
  onOpenAiSettings,
  onOpenDataAssets,
  onUndoLastOperation,
}: {
  /** 「文件 → 导入图片或文件夹…」：主进程弹完选择框后回传分类好的路径 */
  onImportPaths: (picked: PickedPaths) => void;
  /** 「设置 → AI 分析设置…」 */
  onOpenAiSettings: () => void;
  /** 「文件 → 数据资产…」 */
  onOpenDataAssets: () => void;
  /** 「编辑 → 撤销上次文件操作」 */
  onUndoLastOperation: () => void;
}): void {
  useEffect(() => {
    if (!window.electronAPI) return;
    return window.electronAPI.onImportPaths(onImportPaths);
  }, [onImportPaths]);

  useEffect(() => {
    return window.electronAPI?.onOpenAiSettings?.(onOpenAiSettings);
  }, [onOpenAiSettings]);

  useEffect(() => {
    return window.electronAPI?.onOpenDataAssets?.(onOpenDataAssets);
  }, [onOpenDataAssets]);

  useEffect(() => {
    if (!window.electronAPI) return;
    return window.electronAPI.onUndoLastOperation?.(onUndoLastOperation);
  }, [onUndoLastOperation]);
}
