/**
 * 卡片塌陷动画 Hook（从 App 抽出）。
 *
 * 删除后的「先淡出、再移除」统一走 removeWithCollapse：磁盘上的文件已经没了，
 * 但界面上必须让人看见它离开；同时回收降级路径（拖放无磁盘路径）产生的
 * blob: URL，否则 ObjectURL 会常驻到「清空照片列表」才释放。
 *
 * scheduleAfterExit 供需要与动画对齐的收敛逻辑（如重复检测分组）复用
 * 同一套计时器，卸载时由本 Hook 统一清理。
 */

import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { Photo } from '@/types';

/** 卡片塌陷动画时长：与 ImageGrid 中卡片淡出的 duration 保持一致 */
export const EXIT_DURATION = 200;

export interface UseCollapseAnimationParams {
  /** 照片列表镜像：动画结束时要读最新值以回收 blob URL，避免闭包过期 */
  photosRef: RefObject<Photo[]>;
  setPhotos: Dispatch<SetStateAction<Photo[]>>;
}

export interface CollapseAnimationResult {
  /** 已从磁盘删除、正在播塌陷动画的条目：卡片还在，但已淡出且不可交互 */
  exitingIds: Set<string>;
  /** 先让卡片播完淡出，再真正从列表里移除 */
  removeWithCollapse: (ids: Set<string>) => void;
  /** 卡片塌陷动画结束后执行回调（复用同一批计时器，卸载时统一清理） */
  scheduleAfterExit: (callback: () => void) => void;
}

export function useCollapseAnimation({
  photosRef,
  setPhotos,
}: UseCollapseAnimationParams): CollapseAnimationResult {
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set());
  const exitTimersRef = useRef<number[]>([]);

  const removeWithCollapse = useCallback((ids: Set<string>) => {
    if (ids.size === 0) return;
    setExitingIds(prev => new Set([...prev, ...ids]));

    const timer = window.setTimeout(() => {
      exitTimersRef.current = exitTimersRef.current.filter(t => t !== timer);

      // 释放降级路径（拖放无磁盘路径）产生的 blob: URL。
      // 这些条目在磁盘上没有对应文件，若不在这里回收，ObjectURL 会一直常驻内存，
      // 直到「清空照片列表」才被清掉 —— 长时间增删就是典型的内存只增不减。
      const blobUrls: string[] = [];
      photosRef.current.forEach(photo => {
        if (ids.has(photo.id) && photo.url.startsWith('blob:')) blobUrls.push(photo.url);
      });

      setPhotos(prev => prev.filter(p => !ids.has(p.id)));
      setExitingIds(prev => {
        const next = new Set(prev);
        ids.forEach(id => next.delete(id));
        return next;
      });

      // 等卡片卸载后再释放，避免淡出动画过程中图片变成破图
      if (blobUrls.length > 0) {
        window.requestAnimationFrame(() => {
          blobUrls.forEach(url => URL.revokeObjectURL(url));
        });
      }
    }, EXIT_DURATION);
    exitTimersRef.current.push(timer);
  }, [photosRef, setPhotos]);

  // 卸载时清掉尚未播完的塌陷计时器
  useEffect(() => () => {
    exitTimersRef.current.forEach(t => window.clearTimeout(t));
    exitTimersRef.current = [];
  }, []);

  const scheduleAfterExit = useCallback((callback: () => void) => {
    const timer = window.setTimeout(() => {
      exitTimersRef.current = exitTimersRef.current.filter(t => t !== timer);
      callback();
    }, EXIT_DURATION);
    exitTimersRef.current.push(timer);
  }, []);

  return { exitingIds, removeWithCollapse, scheduleAfterExit };
}
