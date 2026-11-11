/**
 * 重命名预演的渲染层薄封装（K11）。
 *
 * 组件不直接调 IPC：分层守卫要求 `src/components` 直连 `window.electronAPI` 保持为 0，
 * 且「探测磁盘同名」属于文件系统域，放在 lib 更容易被其它入口复用。
 *
 * 失败一律降级为 null：预览仍可用，只是不显示 -序号，由文案明确说明，
 * 绝不因为一次探测失败就阻塞重命名。
 */

import type { RenameProbeResult } from '@/lib/fs/renamePreview';

export interface RenameProbeEntry {
  oldPath: string;
  desiredPath: string;
}

export const probeRenameTargets = async (
  entries: RenameProbeEntry[]
): Promise<RenameProbeResult[] | null> => {
  const api = window.electronAPI;
  if (!api?.probeRenameTargets) return null;
  try {
    const result = await api.probeRenameTargets(entries);
    return result.ok ? result.data : null;
  } catch {
    return null;
  }
};
