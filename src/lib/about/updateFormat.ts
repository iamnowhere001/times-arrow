/**
 * 「关于与更新」两处入口共用的展示格式化。
 *
 * 整页 AboutView 与菜单入口的 UpdateModal 展示同一份检查结果，
 * 单位换算 / 日期格式各写一份会在改动时漂移，因此收在这里。
 */

/** 字节数转可读体积；无有效大小时返回空串，由调用点决定是否展示 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

/** ISO 时间转本地日期；Release 的 publishedAt 可能缺失或非法 */
export function formatPublishedAt(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('zh-CN');
}
