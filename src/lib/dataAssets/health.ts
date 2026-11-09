/**
 * 「数据健康检查」的渲染层薄封装（v1.0.0）。
 *
 * 组件不直接调 IPC：一是分层守卫要求组件直连 IPC 只减不增，
 * 二是这两个动作都属于「数据资产」域，放在 lib 里更容易被将来的入口复用。
 */

/** 拉取健康报告；不可用环境返回失败结果，由调用方展示 */
export const loadDataHealth = async (): Promise<IpcResult<DataHealthReport>> => {
  const api = window.electronAPI;
  if (!api?.getDataHealth) {
    return { ok: false, error: '当前环境不支持数据健康检查' };
  }
  return api.getDataHealth();
};

/** 打开崩溃日志；成功返回 null，失败返回可直接展示的文案 */
export const openCrashLogFile = async (): Promise<string | null> => {
  const api = window.electronAPI;
  if (!api?.openCrashLog) return '当前环境不支持打开日志';
  const result = await api.openCrashLog();
  return result.ok ? null : result.error;
};
