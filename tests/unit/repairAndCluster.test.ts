import { describe, it, expect } from 'vitest';
import {
  repairFileName,
  clusterBySize,
  formatDateForNaming,
  looksLikeMojibake,
  fixMojibake,
  fixMojibakeOnce,
  extOfName,
  type HashedEntry,
} from '@/utils';
import type { RepairNameOptions } from '@/types';
import { makePhoto, localTime } from './fixtures';

const ALL_ON: RepairNameOptions = {
  fixMojibake: true,
  stripJunkPrefix: true,
  stripCopyMarks: true,
  fallbackToDate: true,
  datePrefix: 'photo_',
  dateFormat: 'yyyy-MM-dd_HHmmss',
};

const ALL_OFF: RepairNameOptions = {
  fixMojibake: false,
  stripJunkPrefix: false,
  stripCopyMarks: false,
  fallbackToDate: false,
};

describe('formatDateForNaming', () => {
  it('替换全部占位符', () => {
    const d = new Date(2024, 2, 5, 9, 7, 3); // 2024-03-05 09:07:03
    expect(formatDateForNaming(d, 'yyyy-MM-dd_HHmmss')).toBe('2024-03-05_090703');
    expect(formatDateForNaming(d, 'yyyyMMdd')).toBe('20240305');
  });

  it('不认识的占位符原样保留', () => {
    const d = new Date(2024, 0, 1);
    expect(formatDateForNaming(d, 'yyyy_QQ')).toBe('2024_QQ');
  });

  it('月份与日期补零', () => {
    const d = new Date(2024, 0, 1, 0, 0, 0);
    expect(formatDateForNaming(d, 'MM-dd HH:mm:ss')).toBe('01-01 00:00:00');
  });
});

describe('extOfName', () => {
  it('返回小写扩展名（不含点）', () => {
    expect(extOfName('a.JPG')).toBe('jpg');
    expect(extOfName('a.tar.gz')).toBe('gz');
  });

  it('无扩展名返回空串', () => {
    expect(extOfName('noext')).toBe('');
  });

  it('隐藏文件（以点开头）把点后的整段当作扩展名', () => {
    // 记录实际行为：extOfName('.gitignore') 得到 'gitignore' 而不是 ''。
    // 对照片库没有影响 —— 扫描阶段就跳过了所有以点开头的条目（.DS_Store / ._* 等）。
    expect(extOfName('.gitignore')).toBe('gitignore');
  });
});

describe('looksLikeMojibake / fixMojibake', () => {
  it('含替换字符 U+FFFD 判定为乱码', () => {
    expect(looksLikeMojibake('abc\uFFFDdef')).toBe(true);
  });

  it('正常中文 / 英文不判定为乱码', () => {
    expect(looksLikeMojibake('海边日落')).toBe(false);
    expect(looksLikeMojibake('beach sunset')).toBe(false);
    expect(looksLikeMojibake('')).toBe(false);
  });

  it('UTF-8 被当 Latin-1 读出的乱码可被还原', () => {
    // 「海滨」的 UTF-8 字节按 Latin-1 解释后就是 æµ·æ»¨
    // （海 = E6 B5 B7 → æµ·，滨 = E6 BB A8 → æ»¨）
    const mojibake = 'æµ·æ»¨';
    expect(looksLikeMojibake(mojibake)).toBe(true);
    expect(fixMojibake(mojibake)).toBe('海滨');
  });

  it('已经正常的中文不会被「修」坏', () => {
    expect(fixMojibakeOnce('海边')).toBeNull();
    expect(fixMojibake('海边')).toBeNull();
  });

  it('无法修复时返回 null 而不是抛错', () => {
    expect(() => fixMojibake('ããããã')).not.toThrow();
  });
});

describe('repairFileName', () => {
  it('开关全关时只做空白归一化', () => {
    // 连续空白折叠成一个空格；`[\s_-]{2,}` 只处理「两个及以上」，
    // 因此单个空格被保留而不是变成下划线。
    expect(repairFileName('my  photo.jpg', ALL_OFF).name).toBe('my photo.jpg');
    expect(repairFileName('my___photo.jpg', ALL_OFF).name).toBe('my_photo.jpg');
  });

  it('保留扩展名，但扩展名会被转成小写', () => {
    // 记录实际行为：extOfName 返回小写，因此 `photo.JPG` → `photo.jpg`。
    // 大小写不敏感的文件系统（macOS 默认）上这是同一条目，影响仅限于显示。
    expect(repairFileName('beach.JPG', ALL_OFF).name).toBe('beach.jpg');
    expect(repairFileName('noext', ALL_OFF).name).toBe('noext');
  });

  it('剥离无意义前缀', () => {
    const out = repairFileName('mmexport1712345678901_海边.jpg', ALL_ON);
    expect(out.name).toBe('海边.jpg');
    expect(out.notes).toContain('去掉无意义前缀');
  });

  it('剥离重复标记（含叠加的多层）', () => {
    expect(repairFileName('海边 (1).jpg', ALL_ON).name).toBe('海边.jpg');
    expect(repairFileName('海边 - 副本.jpg', ALL_ON).name).toBe('海边.jpg');
    expect(repairFileName('海边 copy 2.jpg', ALL_ON).name).toBe('海边.jpg');
    expect(repairFileName('海边 (1) - 副本.jpg', ALL_ON).name).toBe('海边.jpg');
  });

  it('修复乱码并记录说明', () => {
    const out = repairFileName('æµ·æ»¨.jpg', ALL_ON);
    expect(out.name).toBe('海滨.jpg');
    expect(out.notes).toContain('乱码已修复');
  });

  it('纯自动命名（IMG_2639 / 纯数字 / 哈希 / UUID）判定为无意义', () => {
    // 注意必须开启 stripJunkPrefix，「无意义」判定挂在该开关下：
    // 关掉它时 meaningful 只反映「有没有可读字符」，IMG_2639 会被算作有意义。
    const opts = { ...ALL_ON, fallbackToDate: false };
    for (const name of [
      'IMG_2639.jpg',
      'DSC01234.jpg',
      '12345.jpg',
      'a3f9c2b1d4e5f607.jpg',
      '550e8400-e29b-41d4-a716-446655440000.jpg',
      '微信图片_20240101.jpg',
    ]) {
      expect(repairFileName(name, opts).meaningful, `${name} 应判定为无意义`).toBe(false);
    }
  });

  it('fallbackToDate 开启时改用拍摄时间命名（秒级精度）', () => {
    const when = localTime(2024, 3, 5, 9, 7, 3);
    const out = repairFileName('IMG_2639.jpg', ALL_ON, when);
    expect(out.name).toBe('photo_2024-03-05_090703.jpg');
    expect(out.meaningful).toBe(true);
    expect(out.notes).toContain('名称无意义，改用拍摄时间');
  });

  it('fallbackToDate 关闭时保持原样并说明', () => {
    const out = repairFileName('IMG_2639.jpg', { ...ALL_OFF, fallbackToDate: false });
    expect(out.name).toBe('IMG_2639.jpg');
    expect(out.changed).toBe(false);
  });

  it('有意义的名称不被误判为无意义', () => {
    for (const name of ['海边日落.jpg', 'beach-2024.jpg', '生日派对.mp4', 'picnic.jpg']) {
      expect(repairFileName(name, ALL_ON).meaningful, `${name} 被误判为无意义`).toBe(true);
    }
  });

  it('不误伤 picnic / photos 这类含前缀词的正常名称', () => {
    expect(repairFileName('picnic.jpg', ALL_ON).name).toBe('picnic.jpg');
    expect(repairFileName('photos.jpg', ALL_ON).name).toBe('photos.jpg');
  });

  it('changed 标记与实际名称变化一致', () => {
    for (const name of ['海边.jpg', 'IMG_2639.jpg', '海边 (1).jpg', 'a  b.jpg']) {
      const out = repairFileName(name, ALL_ON, localTime(2024, 1, 1));
      expect(out.changed).toBe(out.name !== name);
    }
  });

  it('名称永远不会变成空串（否则重命名会产出非法路径）', () => {
    for (const name of ['(1).jpg', '-.jpg', '  .jpg', '副本.jpg']) {
      expect(repairFileName(name, ALL_ON, localTime(2024, 1, 1)).name.length).toBeGreaterThan(0);
    }
  });
});

describe('clusterBySize', () => {
  const entry = (id: string, size: number): HashedEntry => ({
    photo: makePhoto({ id, size }),
    hash: `hash-${id}`,
  });

  it('空输入返回空数组', () => {
    expect(clusterBySize([])).toEqual([]);
  });

  it('单条输入返回单个簇', () => {
    expect(clusterBySize([entry('a', 100)])).toHaveLength(1);
  });

  it('簇内体积差不超过锚点的 10% 时归入同一簇', () => {
    const clusters = clusterBySize([entry('a', 1000), entry('b', 1050), entry('c', 980)]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(3);
  });

  it('超出锚点 10% 时切开成新簇', () => {
    const clusters = clusterBySize([entry('a', 1000), entry('b', 1200)]);
    expect(clusters).toHaveLength(2);
  });

  /**
   * ⚠️ 实现语义与注释措辞有出入（已在 CODE_REVIEW 记录）：
   * 注释写的是「按文件大小聚类（±10%）」，但实现是**以簇内最小体积为锚点**做
   * `|size - anchor| / anchor <= 0.1`，因此实际可容纳区间是 `[anchor, anchor × 1.1]` ——
   * **上界只有 +10%，下界是 0**（不可能有比锚点更小的，因为先排了序），是不对称的。
   *
   * 本用例把这条真实语义钉住：950 与 1040 相差 9.5% 同簇，
   * 1140 相对锚点 950 已超 10%（虽然相对 1040 只差 9.6%）→ 必须切簇。
   * 若实现改成「与上一个元素比较」，这条会失败 —— 那正是我们要防的回归。
   */
  it('以簇内最小体积为锚点，而不是与上一个元素链式比较', () => {
    const clusters = clusterBySize([entry('a', 950), entry('b', 1040), entry('c', 1140)]);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].map((e) => e.photo.id)).toEqual(['a', 'b']);
    expect(clusters[1].map((e) => e.photo.id)).toEqual(['c']);
  });

  it('簇内按体积升序排列（输入乱序也一样）', () => {
    const clusters = clusterBySize([entry('c', 1040), entry('a', 950), entry('b', 1000)]);
    expect(clusters[0].map((e) => e.photo.size)).toEqual([950, 1000, 1040]);
  });

  it('不丢条目：各簇长度之和等于输入数', () => {
    const entries = Array.from({ length: 37 }, (_, i) => entry(`p${i}`, 100 + i * 137));
    const clusters = clusterBySize(entries);
    expect(clusters.reduce((sum, c) => sum + c.length, 0)).toBe(entries.length);
  });

  it('体积缺失（0）的条目不会被丢弃，也不会产生 NaN 锚点', () => {
    const clusters = clusterBySize([entry('zero', 0), entry('a', 1000)]);
    expect(clusters.reduce((sum, c) => sum + c.length, 0)).toBe(2);
  });
});
