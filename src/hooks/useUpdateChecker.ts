/**
 * 更新检查与应用内下载（v0.6.3）。
 *
 * 职责边界：
 *  - 检查 / 下载 / 打开 DMG 全部由主进程执行，这里只维护界面状态；
 *  - 启动后 5s 静默检查一次（可在面板关闭），有新版本才提示；
 *  - 下载进度通过主进程事件推送，面板关掉再打开也能从 update-status 恢复。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadPersistedConfig, savePersistedConfig } from '@/lib/persistence/persistence';
import { logger } from '@/lib/logger';
import type { ToastAction, ToastType } from '@/types/toast';
import type { UpdateCheckResult, UpdateDownloadState, UpdateProgress } from '@/types';

const EMPTY_DOWNLOAD: UpdateDownloadState = {
  state: 'idle',
  version: null,
  percent: 0,
  received: 0,
  total: 0,
};

/** 启动后延迟多久做静默检查：避开首屏导入与缩略图生成的高峰 */
const SILENT_CHECK_DELAY = 5_000;

export interface UseUpdateCheckerParams {
  showToast: (message: string, type?: ToastType, action?: ToastAction) => void;
  /**
   * 「关于与更新」整页是否在前台。
   * 整页会就地展示检查结果，此时再弹「发现新版本 / 查看更新」Toast 属于重复打扰，
   * 点进去还会再开一次面板 —— 用 ref 跟踪，避免视图切换重建 runCheck。
   */
  isAboutActive?: boolean;
}

export interface UseUpdateCheckerResult {
  isOpen: boolean;
  openPanel: () => void;
  closePanel: () => void;
  currentVersion: string;
  checkResult: UpdateCheckResult | null;
  isChecking: boolean;
  error: string | null;
  download: UpdateDownloadState;
  autoCheck: boolean;
  checkNow: () => void;
  startDownload: () => void;
  cancelDownload: () => void;
  openDownloaded: () => void;
  revealDownloaded: () => void;
  openReleasePage: () => void;
  setAutoCheck: (enabled: boolean) => void;
}

export function useUpdateChecker({
  showToast,
  isAboutActive = false,
}: UseUpdateCheckerParams): UseUpdateCheckerResult {
  const [isOpen, setIsOpen] = useState(false);
  const [currentVersion, setCurrentVersion] = useState('');
  const [checkResult, setCheckResult] = useState<UpdateCheckResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [download, setDownload] = useState<UpdateDownloadState>(EMPTY_DOWNLOAD);
  const [autoCheck, setAutoCheckState] = useState(true);

  /** 事件回调里判断「面板是否打开」，避免把已经显示在面板里的错误重复弹 Toast */
  const isOpenRef = useRef(false);
  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);
  /** 关于页在前台时检查结果就地可见，静默检查与手动检查都不再叠 Toast */
  const isAboutActiveRef = useRef(isAboutActive);
  useEffect(() => {
    isAboutActiveRef.current = isAboutActive;
  }, [isAboutActive]);

  const runCheck = useCallback(
    async (silent: boolean) => {
      const api = window.electronAPI;
      if (!api?.updateCheck) {
        if (!silent) setError('当前环境不支持更新检查（仅 Electron 桌面端可用）');
        return;
      }

      setIsChecking(true);
      setError(null);
      try {
        const response = await api.updateCheck();
        if (!response.ok) {
          if (silent) {
            logger.warn('静默检查更新失败:', response.error);
          } else {
            setError(response.error);
            if (!isOpenRef.current && !isAboutActiveRef.current) showToast(response.error, 'error');
          }
          return;
        }

        setCheckResult(response.data);
        setCurrentVersion(response.data.currentVersion);
        if (response.data.status === 'available') {
          // 面板或关于页已打开时结果就在眼前，不再叠 Toast
          if (!isOpenRef.current && !isAboutActiveRef.current) {
            showToast(`发现新版本 ${response.data.latestVersion}`, 'info', {
              label: '查看更新',
              onClick: () => setIsOpen(true),
            });
          }
        } else if (!silent && !isOpenRef.current && !isAboutActiveRef.current) {
          showToast(
            response.data.status === 'up-to-date' ? '已是最新版本' : 'GitHub 上还没有发布版本',
            'info'
          );
        }
      } catch (err) {
        const message = (err as Error)?.message || '检查更新失败';
        if (silent) {
          logger.warn('静默检查更新失败:', message);
        } else {
          setError(message);
          if (!isOpenRef.current && !isAboutActiveRef.current) showToast(message, 'error');
        }
      } finally {
        setIsChecking(false);
      }
    },
    [showToast]
  );

  // 启动：恢复主进程的下载状态、读取自动检查偏好并安排一次静默检查
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    void (async () => {
      const status = await window.electronAPI?.updateStatus?.();
      if (cancelled) return;
      if (status?.ok) {
        setCurrentVersion(status.data.currentVersion);
        setDownload(status.data.download);
        if (status.data.latest) setCheckResult(status.data.latest);
        if (status.data.download.state === 'error' && status.data.download.error) {
          setError(status.data.download.error);
        }
      }

      const config = await loadPersistedConfig();
      if (cancelled) return;
      const enabled = config.updatePrefs?.autoCheck !== false;
      setAutoCheckState(enabled);
      if (!enabled) return;

      timer = window.setTimeout(() => {
        void runCheck(true);
      }, SILENT_CHECK_DELAY);
    })();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [runCheck]);

  // 主进程 → 渲染层：菜单入口与下载进度
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const offPanel = api.onOpenUpdatePanel?.(() => {
      setIsOpen(true);
      void runCheck(false);
    });

    const offProgress = api.onUpdateDownloadProgress?.((progress: UpdateProgress) => {
      if (progress.phase === 'downloading') {
        setDownload({
          state: 'downloading',
          version: progress.version,
          percent: progress.percent,
          received: progress.received,
          total: progress.total,
        });
        return;
      }

      if (progress.phase === 'done') {
        setDownload({
          state: 'done',
          version: progress.version,
          percent: 100,
          received: progress.received,
          total: progress.total,
          filePath: progress.filePath,
        });
        setError(null);
        showToast('更新包已下载，可打开磁盘映像完成安装', 'success', {
          label: '打开磁盘映像',
          onClick: () => {
            void api.updateOpenDownload?.().then((res) => {
              if (res && !res.ok) showToast(res.error, 'error');
            });
          },
        });
        return;
      }

      if (progress.phase === 'cancelled') {
        setDownload((prev) => ({ ...prev, state: 'idle', percent: 0, received: 0 }));
        return;
      }

      const message = progress.message || '下载更新包失败';
      setError(message);
      setDownload({
        state: 'error',
        version: progress.version,
        percent: 0,
        received: progress.received,
        total: progress.total,
        error: message,
      });
      // 面板或关于页里已经能看到错误时不再叠一条 Toast
      if (!isOpenRef.current && !isAboutActiveRef.current) showToast(message, 'error');
    });

    return () => {
      offPanel?.();
      offProgress?.();
    };
  }, [runCheck, showToast]);

  const openPanel = useCallback(() => {
    setIsOpen(true);
    // 已经从静默检查拿到「有新版本」时直接展示，避免重复请求
    if (checkResult?.status !== 'available') void runCheck(false);
  }, [checkResult, runCheck]);

  const closePanel = useCallback(() => setIsOpen(false), []);

  const checkNow = useCallback(() => {
    void runCheck(false);
  }, [runCheck]);

  const startDownload = useCallback(() => {
    void (async () => {
      const api = window.electronAPI;
      if (!api?.updateDownload) return;
      setError(null);
      const response = await api.updateDownload();
      if (!response.ok) {
        setError(response.error);
        showToast(response.error, 'error');
        return;
      }
      setDownload({
        state: 'downloading',
        version: checkResult?.latestVersion ?? null,
        percent: 0,
        received: 0,
        total: checkResult?.asset?.size ?? 0,
      });
    })();
  }, [checkResult, showToast]);

  const cancelDownload = useCallback(() => {
    void (async () => {
      const response = await window.electronAPI?.updateCancelDownload?.();
      if (response && !response.ok) showToast(response.error, 'error');
    })();
  }, [showToast]);

  const openDownloaded = useCallback(() => {
    void (async () => {
      const response = await window.electronAPI?.updateOpenDownload?.();
      if (response && !response.ok) showToast(response.error, 'error');
    })();
  }, [showToast]);

  const revealDownloaded = useCallback(() => {
    void (async () => {
      const response = await window.electronAPI?.updateRevealDownload?.();
      if (response && !response.ok) showToast(response.error, 'error');
    })();
  }, [showToast]);

  const openReleasePage = useCallback(() => {
    void (async () => {
      const response = await window.electronAPI?.updateOpenRelease?.();
      if (response && !response.ok) showToast(response.error, 'error');
    })();
  }, [showToast]);

  const setAutoCheck = useCallback((enabled: boolean) => {
    setAutoCheckState(enabled);
    void savePersistedConfig({ updatePrefs: { autoCheck: enabled } });
  }, []);

  return {
    isOpen,
    openPanel,
    closePanel,
    currentVersion,
    checkResult,
    isChecking,
    error,
    download,
    autoCheck,
    checkNow,
    startDownload,
    cancelDownload,
    openDownloaded,
    revealDownloaded,
    openReleasePage,
    setAutoCheck,
  };
}
