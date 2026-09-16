/**
 * 展示层格式化：字节、时间、视频时长、文件名用日期。
 *
 * 全是纯函数，无副作用、无外部依赖，因此可以放心在任何层（含主进程思路的复用）
 * 调用与测试。
 *
 * 这一组原先散在 `utils/index.ts` 里与「媒体判定 / 重复检测」混放 ——
 * 一个 1000 行的文件同时装着哈希算法和 `formatBytes`，改动风险与阅读成本都偏高。
 */

/** 字节 → 「1.5 MB」；无效输入返回 `0 Bytes` */
export const formatBytes = (bytes: number, decimals = 2) => {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

/** 时间戳 → 本地化的「2024年3月5日 14:30」；缺失时返回 `-` */
export const formatDate = (timestamp: number) => {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

/** 秒 → 「1:23」/「1:02:03」；未知或无效时返回空串 */
export const formatVideoDuration = (seconds?: number): string => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
};

/**
 * 按指定占位符格式把日期转成可用于文件名的字符串。
 * 支持：yyyy / MM / dd / HH / mm / ss。
 *
 * 渲染端（RenameModal 预览）与执行端（App 批量重命名）共用同一实现 ——
 * 这是「预览即所得」的一部分：两边各自格式化就会出现预览与实际文件名不一致。
 */
export const formatDateForNaming = (date: Date, format: string): string => {
  const map: Record<string, string> = {
    yyyy: String(date.getFullYear()),
    MM: String(date.getMonth() + 1).padStart(2, '0'),
    dd: String(date.getDate()).padStart(2, '0'),
    HH: String(date.getHours()).padStart(2, '0'),
    mm: String(date.getMinutes()).padStart(2, '0'),
    ss: String(date.getSeconds()).padStart(2, '0'),
  };
  return format.replace(/yyyy|MM|dd|HH|mm|ss/g, (token) => map[token]);
};
