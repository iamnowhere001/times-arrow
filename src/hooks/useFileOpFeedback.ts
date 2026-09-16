/**
 * 批量文件操作的统一反馈 Hook（从 App 抽出，对应 K19）。
 *
 * 重命名 / 删除 / 移动都要等一段时间，此前除导出外都没有反馈，用户容易以为
 * 卡死而重复点击。约定：
 *   beginFileOp  同步置 busy（弹层按钮置灰），超过 320ms 才升起遮罩
 *                —— 小批量瞬间完成就不闪；
 *   reportFileOp 逐项回报进度（主进程一次性完成的移动用不确定态）；
 *   endFileOp    收起遮罩并复位 busy。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** 超过该时长才升起遮罩：小批量瞬间完成不闪一下 */
const OVERLAY_DELAY = 320;

export interface FileOpOverlay {
  title: string;
  hint: string;
  total: number;
  done: number;
  file: string;
}

export interface FileOpFeedbackResult {
  /** 同步置位：弹层主按钮据此置灰 */
  isFileOpBusy: boolean;
  /** 延迟升起的遮罩内容；null 表示未展示 */
  fileOpOverlay: FileOpOverlay | null;
  beginFileOp: (title: string, hint: string, total: number) => void;
  reportFileOp: (done: number, file: string) => void;
  endFileOp: () => void;
}

export function useFileOpFeedback(): FileOpFeedbackResult {
  const [isFileOpBusy, setIsFileOpBusy] = useState(false);
  const [fileOpOverlay, setFileOpOverlay] = useState<FileOpOverlay | null>(null);
  const fileOpTimerRef = useRef<number | null>(null);
  const fileOpLatestRef = useRef({ done: 0, file: '' });

  const beginFileOp = useCallback((title: string, hint: string, total: number) => {
    setIsFileOpBusy(true);
    fileOpLatestRef.current = { done: 0, file: '' };
    if (fileOpTimerRef.current !== null) window.clearTimeout(fileOpTimerRef.current);
    fileOpTimerRef.current = window.setTimeout(() => {
      fileOpTimerRef.current = null;
      setFileOpOverlay({
        title,
        hint,
        total,
        done: fileOpLatestRef.current.done,
        file: fileOpLatestRef.current.file,
      });
    }, OVERLAY_DELAY);
  }, []);

  const reportFileOp = useCallback((done: number, file: string) => {
    fileOpLatestRef.current = { done, file };
    setFileOpOverlay(prev => (prev ? { ...prev, done, file } : prev));
  }, []);

  const endFileOp = useCallback(() => {
    if (fileOpTimerRef.current !== null) {
      window.clearTimeout(fileOpTimerRef.current);
      fileOpTimerRef.current = null;
    }
    setIsFileOpBusy(false);
    setFileOpOverlay(null);
  }, []);

  useEffect(() => () => {
    if (fileOpTimerRef.current !== null) window.clearTimeout(fileOpTimerRef.current);
  }, []);

  return { isFileOpBusy, fileOpOverlay, beginFileOp, reportFileOp, endFileOp };
}
