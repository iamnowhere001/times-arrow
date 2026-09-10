import { GoogleGenAI, Type } from "@google/genai";
import { fileToBase64 } from '../utils';
import { logger } from '../logger';

// Initialize Gemini
// Note: In a real production app, you might proxy this request to keep the key secure.
// For this client-side demo, we use the injected process.env.API_KEY.
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

/** 分析结果：图片描述 + 标签 */
export interface ImageAnalysis {
  description: string;
  tags: string[];
}

/**
 * Electron 路径：照片以磁盘路径表示（Photo.file 已不再填充），
 * 由调用方通过 IPC 读出 base64 后走此入口。
 */
export const analyzeImageFromBase64 = async (
  base64Data: string,
  mimeType: string
): Promise<ImageAnalysis | null> => {
  try {
    // We want a JSON response with a description and tags
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType,
              data: base64Data
            }
          },
          {
            text: "Analyze this image. Provide a concise description (max 2 sentences) and a list of 5 relevant tags."
          }
        ]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            description: { type: Type.STRING },
            tags: { 
              type: Type.ARRAY,
              items: { type: Type.STRING }
            }
          }
        }
      }
    });

    const text = response.text;
    if (!text) return null;
    return JSON.parse(text) as ImageAnalysis;

  } catch (error) {
    logger.error("Gemini analysis failed:", error);
    throw error;
  }
};

/** 浏览器降级路径：仍以 File 对象输入（拖放且无磁盘路径时） */
export const analyzeImage = async (file: File): Promise<ImageAnalysis | null> => {
  const base64Data = await fileToBase64(file);
  return analyzeImageFromBase64(base64Data, file.type);
};
