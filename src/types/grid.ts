/**
 * ImageGrid 的命令式句柄。
 *
 * 放在 types/ 而不是 ImageGrid.tsx：快捷键 hook 只需要这个接口做 ref 的类型约束，
 * 不应为了一个类型反向 import 整个网格组件。
 */
export interface ImageGridHandle {
  scrollToPhoto: (id: string) => void;
  /** 网格视图上下键导航：返回目标行中最接近的项 id；列表视图返回 null（由调用方顺序步进） */
  getVerticalNeighbor: (id: string, direction: 'up' | 'down') => string | null;
}
