/**
 * 运行环境判断。
 *
 * 组件里只需要知道「是否是 Electron 渲染进程」来做窗口装饰等纯 UI 判断，
 * 不应该直接读 `window.electronAPI`（分层守卫要求 components 直连为 0）。
 */

/** 是否运行在 Electron 渲染进程；不触发任何 IPC */
export function isElectronRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean(window.electronAPI);
}
