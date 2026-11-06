import type { ToastAction, ToastType } from '@/types/toast';

/**
 * v0.6.2 批次 2：把「撤销」从数据资产面板搬到操作现场。
 *
 * 已确认的现实口径：文件操作是逐文件埋点、IPC 不回传 operation id，所以
 * 现场撤销只能取日志里**最近一条**未撤销记录，不承诺「撤销整批」。
 * 因此这里把范围写在按钮文案里（批量场景传「撤销 1 项」），失败一律给
 * 「在数据资产中查看」出口，绝不静默假装成功。
 *
 * 纯函数，不读 window：调用方注入 api / showToast / openDataAssets，便于测试。
 */

/** 与 global.d.ts 的 OperationEntry 保持结构兼容的最小子集 */
export interface UndoableEntry {
  id: string;
  type: string;
  undone?: boolean;
}

export interface LastOperationApi {
  getOperationLog(query?: { offset?: number; limit?: number; type?: string }): Promise<{
    ok: boolean;
    data?: { entries: UndoableEntry[]; total: number };
    error?: string;
  }>;
  undoOperation(id: string): Promise<{
    ok: boolean;
    data?: { path: string };
    error?: string;
  }>;
}

export type ShowToast = (message: string, type?: ToastType, action?: ToastAction) => void;

export interface UndoDeps {
  api: LastOperationApi | undefined;
  showToast: ShowToast;
  openDataAssets: () => void;
}

/** 主进程只实现了这两类的自动撤销；移动 / 导出只记日志 */
export const UNDOABLE_TYPES = new Set(['rename', 'delete']);

export function describeOperation(type: string): string {
  switch (type) {
    case 'rename':
      return '重命名';
    case 'delete':
      return '删除';
    case 'move':
      return '移动';
    case 'export':
      return '导出';
    default:
      return '文件操作';
  }
}

/** 失败 / 受限场景的统一出口：数据资产面板保留完整日志，可逐条撤销 */
export function dataAssetsAction(openDataAssets: () => void): ToastAction {
  return { label: '在数据资产中查看', onClick: openDataAssets };
}

export async function undoLastOperation({
  api,
  showToast,
  openDataAssets,
}: UndoDeps): Promise<boolean> {
  if (!api?.getOperationLog || !api?.undoOperation) {
    showToast('无法读取操作日志，请在数据资产中查看', 'error', dataAssetsAction(openDataAssets));
    return false;
  }

  let log: Awaited<ReturnType<LastOperationApi['getOperationLog']>>;
  try {
    log = await api.getOperationLog({ offset: 0, limit: 1, type: 'all' });
  } catch (error) {
    showToast(
      `读取操作日志失败：${(error as Error).message}`,
      'error',
      dataAssetsAction(openDataAssets)
    );
    return false;
  }

  if (!log.ok) {
    showToast(
      `读取操作日志失败：${log.error ?? '未知错误'}`,
      'error',
      dataAssetsAction(openDataAssets)
    );
    return false;
  }

  const entry = log.data?.entries?.[0];
  if (!entry) {
    showToast('没有可撤销的操作', 'info');
    return false;
  }
  if (entry.undone) {
    showToast(
      '最近一次操作已撤销；更早的记录可在数据资产中逐条撤销',
      'warning',
      dataAssetsAction(openDataAssets)
    );
    return false;
  }
  if (!UNDOABLE_TYPES.has(entry.type)) {
    showToast(
      `最近一次是${describeOperation(entry.type)}，暂不支持自动撤销；记录可在数据资产中查看`,
      'warning',
      dataAssetsAction(openDataAssets)
    );
    return false;
  }

  let result: Awaited<ReturnType<LastOperationApi['undoOperation']>>;
  try {
    result = await api.undoOperation(entry.id);
  } catch (error) {
    showToast(`撤销失败：${(error as Error).message}`, 'error', dataAssetsAction(openDataAssets));
    return false;
  }

  if (result.ok) {
    showToast(`已撤销最近一次${describeOperation(entry.type)}`, 'success');
    return true;
  }
  showToast(result.error ?? '撤销失败', 'error', dataAssetsAction(openDataAssets));
  return false;
}

/** 供各成功 Toast 复用；label 由调用点按「单张 / 批量」说明作用域 */
export function createUndoActionFactory(deps: UndoDeps) {
  return (label = '撤销'): ToastAction => ({
    label,
    onClick: () => {
      void undoLastOperation(deps);
    },
  });
}
