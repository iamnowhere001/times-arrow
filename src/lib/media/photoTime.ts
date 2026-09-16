/**
 * 照片时间语义的**唯一入口**。
 *
 * ## 为什么需要单独一个模块
 *
 * 改造前「取照片的有效时间」这条回退链在 12 处被各自内联，且存在**两种不同定义**：
 *
 * | 链 | 出现位置 | 语义 |
 * |---|---|---|
 * | `dateTaken → lastModified`（2 级） | 分组 / 筛选 / 排序 / 时间线 / 重命名预览 | 「这张照片是什么时候拍的」 |
 * | `dateTaken → dateCreated → lastModified`（3 级） | 原图判定 / 日期修正弹窗 | 「这张照片的原始时间基准」 |
 *
 * 对「有文件创建时间但没有 EXIF 拍摄时间」的照片，两者会给出**不同的时间**。
 * 这本身是有意为之（下面分别说明），但散落成十几份内联表达式之后，
 * 就再也看不出哪些地方是刻意不同、哪些是抄漏了 —— 而抄漏的后果是
 * 网格分组与时间线导航对同一张照片给出不同归属。
 *
 * 因此这里把两种语义各自命名、各自说明适用场景，调用方按语义选函数，
 * 而不是各自手写一遍回退链。
 */

import type { Photo } from '@/types';

/**
 * 照片的「拍摄时间」：EXIF 拍摄时间优先，缺失时回退文件修改时间。
 *
 * 这是**面向展示**的语义 —— 用户问「这张是什么时候的」时想看的是拍摄时刻；
 * 没有 EXIF 时用文件修改时间作近似，总比显示「未知」有用。
 *
 * 适用：日期分组、时间线年/月分组、日期范围筛选、按拍摄时间排序、重命名预览。
 *
 * 注意返回值可能是 0（两者都缺失），调用方需自行判断「无时间」的情况。
 */
export const photoTakenTime = (photo: Photo): number => photo.dateTaken || photo.lastModified || 0;

/**
 * 照片的「原始时间」：EXIF 拍摄时间 > 文件创建时间 > 文件修改时间。
 *
 * 这是**面向判定**的语义 —— 重复组里要挑出「哪一份是原图」。
 * 与 `photoTakenTime` 的区别在于插入的 `dateCreated`：
 * 拷贝件会继承 EXIF 拍摄时间，所以真正能区分原图与拷贝的是**文件创建时间**。
 * 如果这里也用 2 级链，同一批拷贝的「原始时间」会全部相同，挑不出原图。
 *
 * 适用：重复检测的原图推荐、日期修正弹窗的初值。
 */
export const photoOriginalTime = (photo: Photo): number =>
  photo.dateTaken || photo.dateCreated || photo.lastModified || 0;

/**
 * 本地日历日的紧凑 key（yyyymmdd）。
 *
 * 为什么不能用 `Math.floor(ts / 86400000)`：那是 **UTC 日界**。
 * 在东八区，同一天 23:00 与次日 01:00 会落进同一个 UTC 日，
 * 于是「昨天」和「今天」被错误地合并成一组。
 *
 * 用本地年月日拼 key 才能让分组与用户看到的日历一致。
 */
export const calendarDayKey = (timestamp: number): number => {
  const date = new Date(timestamp);
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
};

/**
 * 时间戳是否可用于分组/排序。
 * `0` 与 `NaN` 都视为「无时间」—— 注意 `!NaN` 为真，所以不能只写 `!ts`。
 */
export const hasUsableTime = (timestamp: number): boolean =>
  Boolean(timestamp) && !Number.isNaN(timestamp);

/** 单个时间字段的比较：早的在前，缺失的排最后 */
const compareTimeField = (a?: number, b?: number): number => {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a - b;
};

/**
 * 比较两张照片谁更「原始」（越小越原始）。
 * 依次比较：拍摄时间 → 文件创建时间 → 文件修改时间；
 * 完全相同时保留文件更大的那份（通常质量更高）。
 *
 * 拷贝件会继承 EXIF 拍摄时间，所以真正区分原图与拷贝的是创建时间。
 *
 * ## ⚠️ 与 `photoOriginalTime` 做减法排序**不等价**
 *
 * 本函数是**逐字段比优先级** —— 只要有 EXIF 拍摄时间，就一定排在「只有创建时间」的前面；
 * 而 `photoOriginalTime(a) - photoOriginalTime(b)` 会先走回退链，
 * 把「无 EXIF、但创建时间很早」的排到前面。
 *
 * 更关键的是：**回退链区分不了共享 EXIF 拍摄时间的拷贝** ——
 * 两张拷贝拍摄时间相同，链式求值在第一步就返回了，`dateCreated` 根本没被用到，
 * 于是两者完全并列、排不出先后。而「拷贝继承 EXIF」正是重复检测里最典型的场景。
 * 这就是重复检测必须用本函数而不是减法排序的原因。
 *
 * 目前 `LocationMap` 仍用减法排序，在同组共享 EXIF 时全是并列，
 * 与重复检测的判断可能不一致（属已知不一致，见 CODE_REVIEW 附录 C）。
 */
export const compareByOriginalTime = (a: Photo, b: Photo): number => {
  return (
    compareTimeField(a.dateTaken, b.dateTaken) ||
    compareTimeField(a.dateCreated, b.dateCreated) ||
    compareTimeField(a.lastModified, b.lastModified) ||
    (b.size || 0) - (a.size || 0)
  );
};
