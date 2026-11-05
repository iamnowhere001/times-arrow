import type { Photo } from '@/types';

/**
 * 标注资产主键的**唯一入口**。
 *
 * 收藏 / 隐藏 / 用户标签 / 拍摄时间修正 / 视频元数据 / AI 分析结果都用它作 key。
 * 优先用内容指纹 `fileId`：文件重命名、移动、删除后重新导入，标注会自动续上，
 * 不需要任何「路径迁移」补丁；指纹不可得（文件读取失败 / 拖放降级预览）时
 * 才退回到路径，最后退到会话内 id。
 *
 * 不要在调用点另写一份 `photo.path || photo.id` —— 那正是这套主键要消灭的东西。
 */
export const assetKeyOf = (
  photo: Pick<Photo, 'id' | 'path' | 'fileId'>
): string => photo.fileId || photo.path || photo.id;
