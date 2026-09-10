/**
 * 智能媒体类型识别（仿 macOS「照片」的媒体类型：视频 / 自拍 / 实况照片 / 截屏）。
 *
 * 全部为**本地启发式**，不依赖任何网络或额外依赖：
 * - 截屏：文件名关键词，或「PNG + 无相机 EXIF + 精确命中常见屏幕分辨率」；
 * - 自拍：文件名关键词，或前置镜头型号（iPhone 等 EXIF 会写明 front camera）；
 * - 实况照片：同目录下存在主干名相同的图片 + 视频配对（iOS 的 HEIC + MOV）。
 *
 * 命中不了的条目只是「不归类」，不会影响导入、浏览与管理。
 */

import { Photo } from './types';
import { extOfName, isVideoPhoto } from './utils';

/** 文件名中明确指代截屏的关键词（中英 + 常见截图工具） */
const SCREENSHOT_NAME = /(screenshot|screen[\s_-]?shot|snipaste|截屏|截图|屏幕快照)/i;
/** 文件名中明确指代自拍的关键词 */
const SELFIE_NAME = /(selfie|自拍)/i;
/** EXIF 镜头型号里指向前置摄像头的关键词 */
const FRONT_LENS = /(front|前置)/i;

/**
 * 常见屏幕分辨率（宽x高，横竖两种朝向都列出）。
 * 仅当「PNG + 无相机 EXIF + 精确命中」三条同时成立时才判定为截屏：
 * 单看文件名会漏掉 iOS 这类以 IMG_xxxx 命名的截屏，
 * 单看分辨率又会误伤恰好在同尺寸导出的图片，组合起来才足够可靠。
 */
const SCREEN_RESOLUTIONS = new Set<string>([
  // 手机
  '1080x1920', '1920x1080',
  '1170x2532', '2532x1170',
  '1179x2556', '2556x1179',
  '1284x2778', '2778x1284',
  '1290x2796', '2796x1290',
  '1440x2560', '2560x1440',
  '1440x3200', '3200x1440',
  '1242x2688', '2688x1242',
  '828x1792', '1792x828',
  // 平板
  '1536x2048', '2048x1536',
  '1668x2388', '2388x1668',
  '1620x2160', '2160x1620',
  '2048x2732', '2732x2048',
  // 桌面
  '2560x1600', '1600x2560',
  '2880x1800', '1800x2880',
  '3024x1964', '1964x3024',
  '3456x2234', '2234x3456',
  '3840x2160', '2160x3840',
  '5120x2880', '2880x5120',
]);

/** 去掉扩展名，只保留主干名 */
const stemOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
};

/** 是否为截屏（仅图片） */
export const isScreenshotPhoto = (photo: Photo): boolean => {
  if (isVideoPhoto(photo)) return false;

  if (SCREENSHOT_NAME.test(stemOf(photo.name))) return true;

  // 次级判定：PNG + 无相机信息 + 精确屏幕分辨率
  if (extOfName(photo.name) !== 'png') return false;
  if (photo.exif?.make || photo.exif?.model) return false;
  const dim = photo.dimensions;
  if (!dim) return false;
  return SCREEN_RESOLUTIONS.has(`${dim.width}x${dim.height}`);
};

/** 是否为自拍（仅图片，尽力识别） */
export const isSelfiePhoto = (photo: Photo): boolean => {
  if (isVideoPhoto(photo)) return false;

  if (SELFIE_NAME.test(stemOf(photo.name))) return true;

  const lens = photo.exif?.lensModel;
  return !!lens && FRONT_LENS.test(lens);
};

/**
 * 配对键：目录 + 主干名（小写）。
 * iOS 实况照片即 `IMG_1234.HEIC` + `IMG_1234.MOV`，两者目录与主干名完全一致。
 */
const pairKeyOf = (photo: Photo): string | null => {
  const filePath = photo.path;
  if (!filePath) return null;

  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const dir = slash > 0 ? filePath.slice(0, slash) : '';
  const fileName = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  return `${dir}\u0000${stemOf(fileName).toLowerCase()}`;
};

/**
 * 识别实况照片：同目录存在同名配对的图片 + 视频。
 * 返回应标记为「实况照片」的图片 id 集合。
 *
 * 注意：只有配对视频也已导入时才识别得到；配对视频本身仍会作为普通视频出现。
 */
export const buildLivePhotoIds = (photos: Photo[]): Set<string> => {
  const videoKeys = new Set<string>();
  for (const photo of photos) {
    if (!isVideoPhoto(photo)) continue;
    const key = pairKeyOf(photo);
    if (key) videoKeys.add(key);
  }

  const ids = new Set<string>();
  if (videoKeys.size === 0) return ids;

  for (const photo of photos) {
    if (isVideoPhoto(photo)) continue;
    const key = pairKeyOf(photo);
    if (key && videoKeys.has(key)) ids.add(photo.id);
  }
  return ids;
};
