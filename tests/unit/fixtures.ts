import type { Photo } from '@/types';

/**
 * 造一张测试用照片。
 * 只填必填字段，其余按需覆盖 —— 这样测试里能一眼看出「这条用例真正关心哪几个字段」。
 */
export function makePhoto(overrides: Partial<Photo> & { id: string }): Photo {
  return {
    name: 'photo.jpg',
    url: 'pm://local/file/x',
    size: 1024,
    type: 'image/jpeg',
    lastModified: 0,
    isFavorite: false,
    ...overrides,
  };
}

/** 造一个本地时间的毫秒时间戳（避免测试受时区影响） */
export function localTime(
  year: number,
  month: number,
  day: number,
  hour = 12,
  minute = 0,
  second = 0
): number {
  return new Date(year, month - 1, day, hour, minute, second, 0).getTime();
}

/** 今天的某个时刻 */
export function todayAt(hour: number, minute = 0): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0).getTime();
}

/** 昨天的某个时刻 */
export function yesterdayAt(hour: number, minute = 0): number {
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 1,
    hour,
    minute,
    0,
    0
  ).getTime();
}
