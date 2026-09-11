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
 */
export const savePersistedConfig = async (patch: Partial<PersistedConfig>): Promise<void> => {
  const api = window.electronAPI;
  if (!api?.saveConfig) return;

  try {
    await api.saveConfig({ ...patch, version: CONFIG_VERSION });
  } catch (error) {
    logger.warn('写入配置失败:', error);
  }
};
