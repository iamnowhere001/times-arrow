import { describe, expect, it, vi } from 'vitest';
import {
  UNDOABLE_TYPES,
  createUndoActionFactory,
  dataAssetsAction,
  describeOperation,
  undoLastOperation,
  type LastOperationApi,
} from '@/lib/fs/lastOperation';

/** v0.6.2 批次 2：现场撤销的降级口径与失败出口 */
type ApiOverrides = {
  getOperationLog?: LastOperationApi['getOperationLog'];
  undoOperation?: LastOperationApi['undoOperation'];
};

function makeApi(overrides: ApiOverrides = {}): LastOperationApi {
  return {
    getOperationLog: vi.fn(async () => ({
      ok: true,
      data: { entries: [{ id: 'op-1', type: 'delete', undone: false }], total: 1 },
    })),
    undoOperation: vi.fn(async () => ({ ok: true, data: { path: '/tmp/a.jpg' } })),
    ...overrides,
  };
}

function makeDeps(api: LastOperationApi | undefined) {
  return {
    api,
    showToast: vi.fn(),
    openDataAssets: vi.fn(),
  };
}

const toastText = (deps: ReturnType<typeof makeDeps>) => deps.showToast.mock.calls[0]?.[0];
const toastType = (deps: ReturnType<typeof makeDeps>) => deps.showToast.mock.calls[0]?.[1];
const toastAction = (deps: ReturnType<typeof makeDeps>) => deps.showToast.mock.calls[0]?.[2];

describe('撤销上次操作', () => {
  it('删除成功后一次调用即撤销，并回报结果', async () => {
    const api = makeApi();
    const deps = makeDeps(api);
    expect(await undoLastOperation(deps)).toBe(true);
    expect(api.undoOperation).toHaveBeenCalledWith('op-1');
    expect(toastText(deps)).toBe('已撤销最近一次删除');
    expect(toastType(deps)).toBe('success');
  });

  it('重命名也走同一条链路', async () => {
    const api = makeApi({
      getOperationLog: vi.fn(async () => ({
        ok: true,
        data: { entries: [{ id: 'op-2', type: 'rename', undone: false }], total: 1 },
      })),
    });
    const deps = makeDeps(api);
    expect(await undoLastOperation(deps)).toBe(true);
    expect(toastText(deps)).toBe('已撤销最近一次重命名');
  });

  it('只取日志里最新一条（批量操作的降级口径）', async () => {
    const api = makeApi();
    const deps = makeDeps(api);
    await undoLastOperation(deps);
    expect(api.getOperationLog).toHaveBeenCalledWith({ offset: 0, limit: 1, type: 'all' });
  });

  it('没有记录时明确说明，不假装成功', async () => {
    const api = makeApi({
      getOperationLog: vi.fn(async () => ({ ok: true, data: { entries: [], total: 0 } })),
    });
    const deps = makeDeps(api);
    expect(await undoLastOperation(deps)).toBe(false);
    expect(toastText(deps)).toBe('没有可撤销的操作');
    expect(api.undoOperation).not.toHaveBeenCalled();
  });

  it('最近一条已撤销时拒绝重复撤销，并给数据资产出口', async () => {
    const api = makeApi({
      getOperationLog: vi.fn(async () => ({
        ok: true,
        data: { entries: [{ id: 'op-1', type: 'delete', undone: true }], total: 1 },
      })),
    });
    const deps = makeDeps(api);
    expect(await undoLastOperation(deps)).toBe(false);
    expect(toastAction(deps)?.label).toBe('在数据资产中查看');
    expect(api.undoOperation).not.toHaveBeenCalled();
  });

  it.each(['move', 'export'])('最近一条是 %s 时说明不支持，不去碰 undoOperation', async (type) => {
    const api = makeApi({
      getOperationLog: vi.fn(async () => ({
        ok: true,
        data: { entries: [{ id: 'op-3', type, undone: false }], total: 1 },
      })),
    });
    const deps = makeDeps(api);
    expect(await undoLastOperation(deps)).toBe(false);
    expect(String(toastText(deps))).toContain('暂不支持自动撤销');
    expect(api.undoOperation).not.toHaveBeenCalled();
  });

  it('读日志失败时带出口', async () => {
    const api = makeApi({ getOperationLog: vi.fn(async () => ({ ok: false, error: '日志损坏' })) });
    const deps = makeDeps(api);
    expect(await undoLastOperation(deps)).toBe(false);
    expect(String(toastText(deps))).toContain('日志损坏');
    expect(toastAction(deps)?.label).toBe('在数据资产中查看');
  });

  it('读日志抛异常也不吞错', async () => {
    const api = makeApi({
      getOperationLog: vi.fn(async () => {
        throw new Error('IPC 断了');
      }),
    });
    const deps = makeDeps(api);
    expect(await undoLastOperation(deps)).toBe(false);
    expect(String(toastText(deps))).toContain('IPC 断了');
  });

  it('撤销失败显示主进程给的具体原因', async () => {
    const api = makeApi({
      undoOperation: vi.fn(async () => ({ ok: false, error: '回收站里未找到匹配的文件' })),
    });
    const deps = makeDeps(api);
    expect(await undoLastOperation(deps)).toBe(false);
    expect(toastText(deps)).toBe('回收站里未找到匹配的文件');
    expect(toastType(deps)).toBe('error');
    expect(toastAction(deps)?.label).toBe('在数据资产中查看');
  });

  it('撤销抛异常也不吞错', async () => {
    const api = makeApi({
      undoOperation: vi.fn(async () => {
        throw new Error('权限被拒');
      }),
    });
    const deps = makeDeps(api);
    expect(await undoLastOperation(deps)).toBe(false);
    expect(String(toastText(deps))).toContain('权限被拒');
  });

  it('Web 环境没有 electronAPI 时给明确出口', async () => {
    const deps = makeDeps(undefined);
    expect(await undoLastOperation(deps)).toBe(false);
    expect(toastText(deps)).toContain('无法读取操作日志');
    expect(toastAction(deps)?.label).toBe('在数据资产中查看');
  });
});

describe('撤销动作工厂与描述', () => {
  it('默认标签是「撤销」，点击触发撤销', async () => {
    const api = makeApi();
    const deps = makeDeps(api);
    const action = createUndoActionFactory(deps)();
    expect(action.label).toBe('撤销');
    action.onClick();
    await vi.waitFor(() => expect(api.undoOperation).toHaveBeenCalled());
  });

  it('批量场景可自定义标签说明只撤 1 项', () => {
    const deps = makeDeps(makeApi());
    expect(createUndoActionFactory(deps)('撤销 1 项').label).toBe('撤销 1 项');
  });

  it('只有 rename / delete 可自动撤销', () => {
    expect([...UNDOABLE_TYPES].sort()).toEqual(['delete', 'rename']);
  });

  it('describeOperation 覆盖四类已知操作', () => {
    expect(describeOperation('rename')).toBe('重命名');
    expect(describeOperation('delete')).toBe('删除');
    expect(describeOperation('move')).toBe('移动');
    expect(describeOperation('export')).toBe('导出');
    expect(describeOperation('unknown')).toBe('文件操作');
  });

  it('数据资产出口点击后打开面板', () => {
    const open = vi.fn();
    dataAssetsAction(open).onClick();
    expect(open).toHaveBeenCalledOnce();
  });
});
