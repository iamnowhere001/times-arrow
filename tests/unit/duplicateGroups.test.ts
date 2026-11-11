import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Photo } from '@/types';
import {
  MAX_IGNORED_GROUPS,
  buildScanReport,
  EMPTY_SCAN_REPORT,
  filterIgnoredGroups,
  groupIdentityKey,
  isGroupIgnored,
  isGroupStable,
  normalizeIgnoredGroups,
  recordIgnoredGroup,
  releasableSizeOf,
  removeIgnoredGroup,
  stableIdentityOf,
} from '@/lib/duplicate/ignoredGroups';
import { makePhoto } from './fixtures';

/**
 * 「忽略此组」的不变式（v0.6.2 批次 3）。
 *
 * 守两件会直接伤到信任的事：
 *   1. 组的身份必须由**内容**决定 —— 改名、移动、组内重排都不该让忽略失效；
 *   2. 报告数字必须来自同一份结果 —— 顶栏与右栏不能各算各的。
 */

const photo = (id: string, fileId: string, size = 1024): Photo =>
  makePhoto({ id, fileId, name: `${id}.jpg`, size, path: `/库/相册/${id}.jpg` });

const pair = (): Photo[] => [photo('a', 'finger-a'), photo('b', 'finger-b')];

describe('组的稳定身份', () => {
  it('内容指纹优先于路径，改名 / 移动不改变身份', () => {
    expect(stableIdentityOf(photo('a', 'finger-a', 1024))).toBe('f:finger-a');
    const moved = photo('a', 'finger-a', 1024);
    moved.path = '/另一个盘/2026/a.jpg';
    expect(stableIdentityOf(moved)).toBe(stableIdentityOf(photo('a', 'finger-a')));
    expect(stableIdentityOf(makePhoto({ id: 'x', path: '/库/x.jpg' }))).toBe('p:/库/x.jpg');
  });

  it('组内顺序、id、文件名变化都不改变 key', () => {
    const [a, b] = pair();
    const reordered = [
      { ...b, id: '会话内新 id' },
      { ...a, name: '改名了.jpg' },
    ];
    expect(groupIdentityKey([a, b])).toBe(groupIdentityKey(reordered));
  });

  it('成员变化会让 key 改变（已记录并接受的失效边界）', () => {
    const [a, b] = pair();
    expect(groupIdentityKey([a, b])).not.toBe(groupIdentityKey([a, b, photo('c', 'finger-c')]));
  });

  it('路径含中文也能得到定长且稳定的 key', () => {
    const a = makePhoto({ id: 'a', path: '/照片/二〇二六年/春游.jpg' });
    const b = makePhoto({ id: 'b', path: '/照片/二〇二六年/春游-副本.jpg' });
    const key = groupIdentityKey([a, b]);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(key).toBe(groupIdentityKey([b, a]));
  });

  it('不足两张、或含无稳定标识的成员时，不允许持久化忽略', () => {
    const [a] = pair();
    expect(isGroupStable([a])).toBe(false);
    expect(groupIdentityKey([a])).toBe('');
    const degraded = makePhoto({ id: 'drag-1' }); // 拖放降级：既无 fileId 也无 path
    expect(isGroupStable([a, degraded])).toBe(false);
    expect(groupIdentityKey([a, degraded])).toBe('');
    expect(
      isGroupIgnored([a, degraded], [{ key: 'anything', memberCount: 2, label: '', ignoredAt: 0 }])
    ).toBe(false);
  });
});

describe('忽略集的记录与恢复', () => {
  it('记录后过滤命中，恢复后重新出现', () => {
    const group = pair();
    const first = recordIgnoredGroup([], group, 1000);
    expect(first).not.toBeNull();
    expect(first?.[0]).toMatchObject({ memberCount: 2, label: 'a.jpg', ignoredAt: 1000 });

    const ignored = first ?? [];
    expect(
      filterIgnoredGroups([group, [photo('c', 'finger-c'), photo('d', 'finger-d')]], ignored)
    ).toMatchObject({
      ignoredCount: 1,
    });
    const { visible, ignoredCount } = filterIgnoredGroups([group], ignored);
    expect(visible).toHaveLength(0);
    expect(ignoredCount).toBe(1);

    const restored = removeIgnoredGroup(ignored, groupIdentityKey(group));
    expect(restored).toHaveLength(0);
    expect(filterIgnoredGroups([group], restored).visible).toHaveLength(1);
  });

  it('重复记录返回 null，不产生第二条', () => {
    const group = pair();
    const once = recordIgnoredGroup([], group, 1000) ?? [];
    expect(recordIgnoredGroup(once, group, 2000)).toBeNull();
    expect(once).toHaveLength(1);
  });

  it('归入上限时淘汰最旧的记录，配置体积有界', () => {
    let ignored: ReturnType<typeof normalizeIgnoredGroups> = [];
    for (let i = 0; i < MAX_IGNORED_GROUPS + 5; i += 1) {
      const group = [photo(`a${i}`, `fa-${i}`), photo(`b${i}`, `fb-${i}`)];
      ignored = recordIgnoredGroup(ignored, group, 1000 + i) ?? ignored;
    }
    expect(ignored).toHaveLength(MAX_IGNORED_GROUPS);
    // 新的在前；最早那几条已被淘汰
    expect(ignored[0].ignoredAt).toBe(1000 + MAX_IGNORED_GROUPS + 4);
    expect(ignored.some((item) => item.ignoredAt === 1000)).toBe(false);
  });

  it('不稳定组不会被静默当成已记住', () => {
    const degraded = [photo('a', 'finger-a'), makePhoto({ id: 'drag-1' })];
    expect(recordIgnoredGroup([], degraded)).toBeNull();
  });
});

describe('配置里的忽略集容错', () => {
  it('旧配置缺字段 / 坏数据 / 重复 key 都能安全读出', () => {
    expect(normalizeIgnoredGroups(undefined)).toEqual([]);
    expect(normalizeIgnoredGroups('bad')).toEqual([]);
    const raw = [
      null,
      { key: '', memberCount: 2 },
      { key: 'k1', memberCount: 2, label: 'a.jpg', ignoredAt: 10 },
      { key: 'k1', memberCount: 9, label: '重复', ignoredAt: 20 },
      { key: 'k2' },
      42,
    ];
    expect(normalizeIgnoredGroups(raw)).toEqual([
      { key: 'k1', memberCount: 2, label: 'a.jpg', ignoredAt: 10 },
      { key: 'k2', memberCount: 0, label: '未命名照片', ignoredAt: 0 },
    ]);
  });

  it('超长配置按上限截断，避免一份坏文件撑爆内存', () => {
    const raw = Array.from({ length: MAX_IGNORED_GROUPS + 20 }, (_, i) => ({
      key: `k${i}`,
      memberCount: 2,
      label: 'a.jpg',
      ignoredAt: i,
    }));
    expect(normalizeIgnoredGroups(raw)).toHaveLength(MAX_IGNORED_GROUPS);
  });
});

describe('清理报告', () => {
  const groups: Photo[][] = [
    [
      { ...photo('a', 'fa', 1000), isRecommended: true },
      photo('b', 'fb', 300),
      photo('c', 'fc', 200),
    ],
    [{ ...photo('d', 'fd', 5000), isRecommended: true }, photo('e', 'fe', 4000)],
  ];

  it('可清理体积只算每组除原图之外的成员', () => {
    expect(releasableSizeOf(groups)).toEqual({ count: 3, bytes: 4500 });
    // 没有推荐标记时以第一张为原图，不把整组都算成可删
    expect(releasableSizeOf([[photo('a', 'fa', 100), photo('b', 'fb', 200)]])).toEqual({
      count: 1,
      bytes: 200,
    });
  });

  it('报告数字与分组、删除统计一致', () => {
    const report = buildScanReport({
      scanned: 120,
      groupsFound: 3,
      ignoredGroups: 1,
      groups,
      deletedCount: 2,
      deletedBytes: 500,
    });
    expect(report).toEqual({
      scanned: 120,
      groupsFound: 3,
      ignoredGroups: 1,
      visibleGroups: 2,
      releasableCount: 3,
      releasableBytes: 4500,
      deletedCount: 2,
      deletedBytes: 500,
    });
  });

  it('缺省与非法数值不会让报告出现负数或 NaN', () => {
    expect(
      buildScanReport({ scanned: -1, groupsFound: -2, ignoredGroups: -3, groups: [] })
    ).toMatchObject({
      ...EMPTY_SCAN_REPORT,
    });
  });
});

describe('持久化位置（静态断言）', () => {
  it('忽略集写 config 顶层，不塞进会被整体替换的 duplicate 偏好对象', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/hooks/useDuplicateDetection.ts'),
      'utf8'
    );
    expect(source).toContain('savePersistedConfig({ ignoredDuplicateGroups: next })');
    expect(source).not.toMatch(/duplicate:\s*\{[^}]*ignoredDuplicateGroups/);
  });
});
