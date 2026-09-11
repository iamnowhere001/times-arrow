import { fileToBase64 } from '@/utils';
import { logger } from '@/lib/logger';

/** 分析结果：图片描述 + 标签 */
export interface ImageAnalysis {
  description: string;
  tags: string[];
}

/**
 * 走主进程代理调用 DeepSeek 视觉模型。
 * 渲染进程只负责提供 base64：API Key 保留在主进程，
 * 同时规避渲染进程直连第三方接口时的 CORS 限制。
 */
export const analyzeImageFromBase64 = async (
  base64Data: string,
  mimeType: string
): Promise<ImageAnalysis | null> => {
  const api = window.electronAPI;
  if (!api?.analyzeImage) {
    throw new Error('AI 分析依赖 Electron 主进程，当前环境不可用');
  }

  const { result, error } = await api.analyzeImage({ base64: base64Data, mimeType });
  if (error) {
    logger.error('DeepSeek 分析失败:', error);
    throw new Error(error);
  }
  if (!result) return null;

  return {
    description: result.description ?? '',
    tags: Array.isArray(result.tags) ? result.tags : [],
  };
};

/** 浏览器降级路径：以 File 对象输入（拖放且无磁盘路径时） */
export const analyzeImage = async (file: File): Promise<ImageAnalysis | null> => {
  const base64Data = await fileToBase64(file);
  return analyzeImageFromBase64(base64Data, file.type || 'image/jpeg');
};
