/**
 * 渲染进程侧的配置持久化薄封装。
 *
 * 真正的读写由主进程负责（`userData/config.json`，原子替换写入）。
 * 这里只做：类型收窄、缺省值兜底、失败时不打断用户操作。
 */

import { PersistedConfig } from '@/types';
import { logger } from '@/lib/logger';

/** 当前配置结构版本 */
export const CONFIG_VERSION = 1;

/**
 * 落盘失败的通知出口。
 *
 * 收藏 / 标签 / 相簿这类操作改的是内存状态，界面立刻就变了；如果写盘失败却不提示，
 * 用户会以为已经保存，直到下次启动发现「收藏全没了」才知道出了事。
 * 由 App 在启动时注册成 Toast，避免这里反向依赖 UI。
 */
type PersistenceErrorHandler = (message: string) => void;

let notifyPersistenceError: PersistenceErrorHandler | null = null;

export const setPersistenceErrorHandler = (handler: PersistenceErrorHandler | null): void => {
  notifyPersistenceError = handler;
};

/** 供同层模块（如 AI 缓存）复用同一个失败出口 */
export const reportPersistenceError = (message: string): void => {
  logger.warn(message);
  notifyPersistenceError?.(message);
};

/** 读取配置；不可用（Web 环境 / 读取失败）时返回空配置 */
export const loadPersistedConfig = async (): Promise<PersistedConfig> => {
  const api = window.electronAPI;
  if (!api?.loadConfig) return {};

  try {
    const config = await api.loadConfig();
    if (!config || typeof config !== 'object') return {};
    return config;
  } catch (error) {
    logger.warn('读取配置失败:', error);
    return {};
  }
};

/**
 * 合并写入配置片段。
 * 写入失败只记日志、不抛错：收藏 / 标签这类操作不应因为落盘失败而回滚界面。
 * 但必须让用户知道没存上 —— 否则「以为存了、重启后空了」是最难排查的一类问题。
 * @returns 是否成功落盘
 */
export const savePersistedConfig = async (patch: Partial<PersistedConfig>): Promise<boolean> => {
  const api = window.electronAPI;
  if (!api?.saveConfig) return false;

  try {
    const ok = await api.saveConfig({ ...patch, version: CONFIG_VERSION });
    if (ok === false) {
      logger.warn('写入配置失败：主进程返回失败');
      notifyPersistenceError?.('配置未能保存到磁盘，重启后可能丢失');
      return false;
    }
    return true;
  } catch (error) {
    logger.warn('写入配置失败:', error);
    notifyPersistenceError?.('配置未能保存到磁盘，重启后可能丢失');
    return false;
  }
};
