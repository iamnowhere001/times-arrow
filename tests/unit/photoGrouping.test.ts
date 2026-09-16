import { describe, it, expect } from 'vitest';
import {
  getDateGroupKey,
  sortPhotos,
  groupPhotos,
  sortPhotosByTimeline,
} from '@/lib/media/photoGrouping';
import { makePhoto, localTime, todayAt, yesterdayAt } from './fixtures';

const todayKey = new Date().toDateString();
const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);
const yesterdayKey = yesterday.toDateString();

describe('getDateGroupKey', () => {
  it('今天 / 昨天走专用标签', () => {
    expect(getDateGroupKey(todayAt(9), todayKey, yesterdayKey)).toBe('Today');
    expect(getDateGroupKey(yesterdayAt(23), todayKey, yesterdayKey)).toBe('Yesterday');
  });

  it('缺失或非法时间戳归入 Unknown Date，而不是抛错', () => {
    expect(getDateGroupKey(0, todayKey, yesterdayKey)).toBe('Unknown Date');
    expect(getDateGroupKey(NaN, todayKey, yesterdayKey)).toBe('Unknown Date');
  });

  it('用本地日历日切分，不能用 UTC 日界', () => {
    // 东八区的 23:00 与次日 01:00 在 UTC 下同属一天，但本地是两天。
    // 若实现用 floor(ts / 86400000) 分组，这两条会拿到同一个 key。
    const a = localTime(2024, 3, 10, 23, 0);
    const b = localTime(2024, 3, 11, 1, 0);
    const keyA = getDateGroupKey(a, todayKey, yesterdayKey);
    const keyB = getDateGroupKey(b, todayKey, yesterdayKey);
    expect(keyA).not.toBe(keyB);
  });

  it('同一天的不同时刻拿到同一个 key（缓存命中也应一致）', () => {
    const morning = getDateGroupKey(localTime(2024, 5, 20, 8), todayKey, yesterdayKey);
    const evening = getDateGroupKey(localTime(2024, 5, 20, 20), todayKey, yesterdayKey);
    expect(morning).toBe(evening);
  });

  it('跨天时缓存失效：昨天的条目今天不再被认成 Yesterday', () => {
    const ts = localTime(2024, 7, 1, 12);
    // 第一次：假设「今天」就是 2024-07-01
    const asToday = getDateGroupKey(
      ts,
      new Date(2024, 6, 1).toDateString(),
      new Date(2024, 5, 30).toDateString()
    );
    expect(asToday).toBe('Today');
    // 换一个「今天」：同一个时间戳必须重新求值，不能吃上一次的缓存
    const asOlder = getDateGroupKey(
      ts,
      new Date(2024, 6, 5).toDateString(),
      new Date(2024, 6, 4).toDateString()
    );
    expect(asOlder).not.toBe('Today');
  });
});

describe('sortPhotos', () => {
  const a = makePhoto({ id: 'a', name: 'b.jpg', size: 300, lastModified: 3000, dateTaken: 100 });
  const b = makePhoto({ id: 'b', name: 'a.jpg', size: 100, lastModified: 1000, dateTaken: 300 });
  const c = makePhoto({ id: 'c', name: 'c.jpg', size: 200, lastModified: 2000, dateTaken: 200 });

  it('不修改入参数组', () => {
    const input = [a, b, c];
    const snapshot = input.map((p) => p.id);
    sortPhotos(input, { key: 'size', direction: 'asc' });
    expect(input.map((p) => p.id)).toEqual(snapshot);
  });

  it('按名称排序（升/降）', () => {
    expect(sortPhotos([a, b, c], { key: 'name', direction: 'asc' }).map((p) => p.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
    expect(sortPhotos([a, b, c], { key: 'name', direction: 'desc' }).map((p) => p.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('按体积排序', () => {
    expect(sortPhotos([a, b, c], { key: 'size', direction: 'asc' }).map((p) => p.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
    expect(sortPhotos([a, b, c], { key: 'size', direction: 'desc' }).map((p) => p.id)).toEqual([
      'a',
      'c',
      'b',
    ]);
  });

  it('「修改时间」只看 lastModified —— 与拍摄时间不能排出同一个顺序', () => {
    const byModified = sortPhotos([a, b, c], { key: 'dateModified', direction: 'asc' }).map(
      (p) => p.id
    );
    const byTaken = sortPhotos([a, b, c], { key: 'dateTaken', direction: 'asc' }).map((p) => p.id);
    expect(byModified).toEqual(['b', 'c', 'a']);
    expect(byTaken).toEqual(['a', 'c', 'b']);
    expect(byModified).not.toEqual(byTaken);
  });

  it('拍摄时间缺失时回退到修改时间', () => {
    const noTaken = makePhoto({ id: 'n', lastModified: 500 });
    const sorted = sortPhotos([a, noTaken], { key: 'dateTaken', direction: 'asc' });
    expect(sorted.map((p) => p.id)).toEqual(['a', 'n']); // a.dateTaken=100 < 500
  });

  it('创建时间缺失时回退到修改时间', () => {
    const x = makePhoto({ id: 'x', lastModified: 900 });
    const y = makePhoto({ id: 'y', lastModified: 100, dateCreated: 2000 });
    expect(sortPhotos([x, y], { key: 'dateCreated', direction: 'asc' }).map((p) => p.id)).toEqual([
      'x',
      'y',
    ]);
  });
});

describe('groupPhotos', () => {
  it('非时间排序时返回单个 all 组', () => {
    const photos = [makePhoto({ id: 'a' }), makePhoto({ id: 'b' })];
    for (const key of ['name', 'size', 'dateCreated'] as const) {
      const groups = groupPhotos(photos, { key, direction: 'asc' });
      expect(groups).toHaveLength(1);
      expect(groups[0].key).toBe('all');
    }
  });

  it('按时间排序时切分成日期分组，组内保持排序', () => {
    const photos = [
      makePhoto({ id: 't1', dateTaken: todayAt(9) }),
      makePhoto({ id: 't2', dateTaken: todayAt(18) }),
      makePhoto({ id: 'y1', dateTaken: yesterdayAt(10) }),
    ];
    const groups = groupPhotos(photos, { key: 'dateTaken', direction: 'desc' });
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g.photos.map((p) => p.id)]));
    expect(byKey.Today).toEqual(['t2', 't1']); // 降序：18 点在前
    expect(byKey.Yesterday).toEqual(['y1']);
  });

  it('分组键与排序键保持一致：按修改时间排序时按修改时间切组', () => {
    // 拍摄时间是今天，修改时间是昨天 —— 若分组用错了字段，这条会落进 Today
    const photo = makePhoto({ id: 'p', dateTaken: todayAt(10), lastModified: yesterdayAt(10) });
    const groups = groupPhotos([photo], { key: 'dateModified', direction: 'desc' });
    expect(groups.map((g) => g.key)).toContain('Yesterday');
    expect(groups.map((g) => g.key)).not.toContain('Today');
  });

  it('无时间戳的条目归入 Unknown Date 而不是被丢弃', () => {
    const photo = makePhoto({ id: 'p', lastModified: 0, dateTaken: 0 });
    const groups = groupPhotos([photo], { key: 'dateTaken', direction: 'desc' });
    expect(groups.flatMap((g) => g.photos).map((p) => p.id)).toEqual(['p']);
  });

  it('分组不丢照片：各组条目数之和等于输入数', () => {
    const photos = Array.from({ length: 17 }, (_, i) =>
      makePhoto({ id: `p${i}`, dateTaken: localTime(2024, (i % 12) + 1, (i % 27) + 1) })
    );
    const groups = groupPhotos(photos, { key: 'dateTaken', direction: 'asc' });
    expect(groups.reduce((sum, g) => sum + g.photos.length, 0)).toBe(photos.length);
  });
});

describe('sortPhotosByTimeline', () => {
  it('按拍摄时间升序', () => {
    const photos = [
      makePhoto({ id: 'later', dateTaken: 3000 }),
      makePhoto({ id: 'early', dateTaken: 1000 }),
    ];
    expect(sortPhotosByTimeline(photos).map((p) => p.id)).toEqual(['early', 'later']);
  });

  /**
   * ⚠️ 文档与实现不一致（已在 CODE_REVIEW 记录，待产品决定）：
   * 函数注释写的是「缺失时间戳的条目排到末尾」，但实现用 `dateTaken || lastModified || 0`，
   * 缺失时取 0（= 1970-01-01），升序下会排到**最前**。
   *
   * 本用例断言的是**实际行为**，不是注释承诺的行为 —— 目的是把这个差异钉在测试里，
   * 而不是悄悄把某一边当成正确。修的时候改代码或改注释都行，但必须让这条用例同步更新。
   */
  it('缺失时间戳的条目实际排在最前（与注释所述相反）', () => {
    const photos = [
      makePhoto({ id: 'later', dateTaken: 3000 }),
      makePhoto({ id: 'none', dateTaken: 0, lastModified: 0 }),
      makePhoto({ id: 'early', dateTaken: 1000 }),
    ];
    expect(sortPhotosByTimeline(photos).map((p) => p.id)).toEqual(['none', 'early', 'later']);
  });

  it('不修改入参', () => {
    const photos = [makePhoto({ id: 'a', dateTaken: 2 }), makePhoto({ id: 'b', dateTaken: 1 })];
    sortPhotosByTimeline(photos);
    expect(photos.map((p) => p.id)).toEqual(['a', 'b']);
  });
});
