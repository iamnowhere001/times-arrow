import { useCallback, useMemo, useState } from 'react';

/**
 * 弹层开关的集中管理。
 *
 * ## 为什么值得单独一个 hook
 *
 * 改造前 App 里有十个 `const [isXxxOpen, setIsXxxOpen] = useState(false)`，
 * 外加五个 `useCallback(() => setIsXxxOpen(true), [])` 的单行包装。
 * 这些状态彼此完全独立、没有业务依赖，唯一的信息是「谁控制谁」——
 * 而散在 1339 行里时，这个信息只能靠读 AppOverlays 的 JSX 反推。
 *
 * 收进来之后有三点变化：
 * 1. 加一个弹窗 = 在这里加一个键，App 侧零改动；
 * 2. `modals.rename.isOpen` 自带归属，比 `isRenameModalOpen` 更难串味
 *    （尤其 rename / deleteConfirm / adjustDate 三个经常一起出现）；
 * 3. open / close 是稳定引用，传给 memo 组件或 hook 依赖数组都安全。
 *
 * ## 什么不该进来
 *
 * 带副作用或业务的弹层状态：例如导出弹层的关闭要顺带清空 `exportTargets`，
 * 那属于 App 的业务约束，只把「开关」放在这里，副作用留在调用点。
 */

export interface ModalHandle {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  /**
   * 显式设置。给「需要把 setter 原样传给下游」的场景用
   * （如 useFileOperations 的 setIsRenameModalOpen），语义与 useState 的 setter 一致。
   */
  set: (open: boolean) => void;
}

/** 单个开关：open / close / set 用 useCallback 固定，避免每次渲染都给下游新引用 */
function useModalHandle(): ModalHandle {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const set = useCallback((next: boolean) => setIsOpen(next), []);
  return useMemo(() => ({ isOpen, open, close, set }), [isOpen, open, close, set]);
}

export interface AppModals {
  /** 批量重命名 */
  rename: ModalHandle;
  /** 删除确认（移至回收站） */
  deleteConfirm: ModalHandle;
  /** 调整日期与时间 */
  adjustDate: ModalHandle;
  /** 存为智能相簿 */
  saveAlbum: ModalHandle;
  /** 清空照片列表二次确认 */
  clearList: ModalHandle;
  /** AI 分析设置 */
  aiSettings: ModalHandle;
  /** 数据资产（配置导出导入 / 路径重连 / 操作日志 / 备份） */
  dataAssets: ModalHandle;
  /** 快捷键总览 */
  shortcuts: ModalHandle;
  /** 导出 */
  exportModal: ModalHandle;
  /** 工具栏的筛选面板（不是弹窗，但同样是「开 / 关」语义，一并收在这里） */
  filterPanel: ModalHandle;
}

export function useAppModals(): AppModals {
  return {
    rename: useModalHandle(),
    deleteConfirm: useModalHandle(),
    adjustDate: useModalHandle(),
    saveAlbum: useModalHandle(),
    clearList: useModalHandle(),
    aiSettings: useModalHandle(),
    dataAssets: useModalHandle(),
    shortcuts: useModalHandle(),
    exportModal: useModalHandle(),
    filterPanel: useModalHandle(),
  };
}
