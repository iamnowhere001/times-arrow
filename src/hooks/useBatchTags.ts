/**
 * 批量标签编排（v0.7.0 第一批）。
 *
 * 关键取舍：**不复用 handleUpdatePhoto**。那个入口每张照片都会写一次 config，
 * 100 张就是 100 次 IPC；这里整批只更新一次内存、一次落盘，并在分片之间让出主线程，
 * 万级库也不会把界面卡住。
 *
 * 撤销用「本次变更的 before 快照」：精确还原到操作前，而不是粗暴地把标签从所有照片上删掉。
 * 快照只在会话内有效（Toast 生命周期），不跨重启 —— 与 v0.6.2 文件操作日志的口径分开。
 */

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { Photo } from '@/types';
import type { ToastAction, ToastType } from '@/types/toast';
import { yieldToMain } from '@/lib/concurrency';
import { assetKeyOf } from '@/lib/media/photoIdentity';
import { savePersistedConfig } from '@/lib/persistence/persistence';
import {
  normalizeTag,
  planBatchTagChange,
  rankTags,
  type RankedTag,
  type TagChange,
  type TagOperation,
} from '@/lib/tags/tagOperations';

/** 每批改多少张：标签是纯内存操作，分片只是为了让出主线程与上报进度 */
const BATCH_SIZE = 50;

export interface UseBatchTagsParams {
  photos: Photo[];
  selectedIds: Set<string>;
  tagsRef: RefObject<Map<string, string[]>>;
  setPhotos: Dispatch<SetStateAction<Photo[]>>;
  showToast: (message: string, type?: ToastType, action?: ToastAction) => void;
}

export interface BatchTagsResult {
  applyTag: (op: TagOperation) => Promise<void>;
  /** 中断仍在进行中的批量操作；已处理的条目保留，Toast 会说明处理了多少 */
  cancel: () => void;
  isApplying: boolean;
  progress: { done: number; total: number } | null;
  /** 全库标签按频次排序，供详情面板建议与侧栏列表共用 */
  rankedTags: RankedTag[];
}

export function useBatchTags({
  photos,
  selectedIds,
  tagsRef,
  setPhotos,
  showToast,
}: UseBatchTagsParams): BatchTagsResult {
  const [isApplying, setIsApplying] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const cancelRef = useRef(false);

  const rankedTags = useMemo(() => rankTags(photos), [photos]);

  const persist = useCallback(() => {
    void savePersistedConfig({ tags: Object.fromEntries(tagsRef.current) });
  }, [tagsRef]);

  /** 按 before 快照精确还原：内存 state、tagsRef 与磁盘一起回退 */
  const restore = useCallback(
    (changes: TagChange[]) => {
      const beforeById = new Map(changes.map((change) => [change.id, change.before]));
      setPhotos((prev) =>
        prev.map((photo) => {
          const before = beforeById.get(photo.id);
          return before ? { ...photo, tags: [...before] } : photo;
        })
      );
      for (const change of changes) {
        if (change.before.length > 0) tagsRef.current.set(change.key, [...change.before]);
        else tagsRef.current.delete(change.key);
      }
      persist();
    },
    [persist, setPhotos, tagsRef]
  );

  const applyTag = useCallback(
    async (op: TagOperation) => {
      const tag = normalizeTag(op.tag);
      if (!tag || isApplying) return;

      const selected = photos.filter((photo) => selectedIds.has(photo.id));
      if (selected.length === 0) {
        showToast('请先在图库中选择照片', 'info');
        return;
      }
      const changes = planBatchTagChange(selected, op, assetKeyOf);
      if (changes.length === 0) {
        showToast(op.kind === 'add' ? '所选照片都已有这个标签' : '所选照片都没有这个标签', 'info');
        return;
      }

      cancelRef.current = false;
      setIsApplying(true);
      setProgress({ done: 0, total: changes.length });

      const afterById = new Map<string, string[]>();
      for (let start = 0; start < changes.length; start += BATCH_SIZE) {
        if (cancelRef.current) break;
        for (const change of changes.slice(start, start + BATCH_SIZE)) {
          afterById.set(change.id, change.after);
        }
        setProgress({ done: Math.min(start + BATCH_SIZE, changes.length), total: changes.length });
        // eslint-disable-next-line no-await-in-loop
        await yieldToMain();
      }

      const wasCancelled = cancelRef.current;
      const applied = changes.slice(0, afterById.size);
      setIsApplying(false);
      setProgress(null);
      if (applied.length === 0) return;

      setPhotos((prev) =>
        prev.map((photo) => {
          const after = afterById.get(photo.id);
          return after ? { ...photo, tags: [...after] } : photo;
        })
      );
      for (const change of applied) {
        if (change.after.length > 0) tagsRef.current.set(change.key, [...change.after]);
        else tagsRef.current.delete(change.key);
      }
      persist();

      const verb = op.kind === 'add' ? '添加' : '移除';
      showToast(
        wasCancelled
          ? `已为 ${applied.length} 张${verb}标签（已取消剩余项）`
          : `已为 ${applied.length} 张照片${verb}标签「${tag}」`,
        'success',
        { label: '撤销', onClick: () => restore(applied) }
      );
    },
    [isApplying, persist, photos, restore, selectedIds, setPhotos, showToast, tagsRef]
  );

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  return { applyTag, cancel, isApplying, progress, rankedTags };
}
