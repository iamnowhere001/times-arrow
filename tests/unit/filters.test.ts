import { describe, it, expect } from 'vitest';
import {
  createEmptyFilters,
  normalizeFilters,
  filtersEqual,
  cameraKeyOf,
  buildFilterOptions,
  buildTagOptions,
  countAdvancedFilters,
  isFilterActive,
  matchesSearch,
  matchesFilters,
  applyPhotoFilters,
  datePresetRange,
  matchDatePreset,
  toDateInputValue,
  startOfDayFromInput,
  endOfDayFromInput,
  toggleInList,
  buildFilterChips,
  type FilterContext,
} from '@/lib/filter/filters';
import { makePhoto, localTime } from './fixtures';

const KB = 1024;
const MB = 1024 * 1024;
const noLive: FilterContext = { livePhotoIds: new Set() };

describe('createEmptyFilters / normalizeFilters', () => {
  it('每次生成的数组字段都是新引用（避免重置后共享同一数组）', () => {
    const a = createEmptyFilters();
    const b = createEmptyFilters();
    expect(a.tags).not.toBe(b.tags);
    expect(a.cameras).not.toBe(b.cameras);
    expect(a.formats).not.toBe(b.formats);
  });

  it('undefined / null 补全为完整结构', () => {
    expect(normalizeFilters(undefined)).toEqual(createEmptyFilters());
    expect(normalizeFilters(null)).toEqual(createEmptyFilters());
  });

  it('旧版本配置缺字段时逐项兜底（智能相簿升级场景）', () => {
    const legacy = { favoritesOnly: true, tags: ['海边'] } as never;
    const out = normalizeFilters(legacy);
    expect(out.favoritesOnly).toBe(true);
    expect(out.tags).toEqual(['海边']);
    expect(out.mediaFilter).toBe('all');
    expect(out.dateFrom).toBeNull();
    expect(out.sizeFilter).toBe('any');
  });

  it('数组字段拷贝而非引用（改结果不会污染输入）', () => {
    const input = { tags: ['a'] };
    const out = normalizeFilters(input);
    out.tags.push('b');
    expect(input.tags).toEqual(['a']);
  });

  it('非法类型的数组字段退化为空数组，不抛错', () => {
    const out = normalizeFilters({ tags: 'not-an-array', cameras: 123 } as never);
    expect(out.tags).toEqual([]);
    expect(out.cameras).toEqual([]);
  });
});

describe('filtersEqual', () => {
  it('数组顺序不同视为相等（集合语义）', () => {
    const a = { ...createEmptyFilters(), tags: ['x', 'y'] };
    const b = { ...createEmptyFilters(), tags: ['y', 'x'] };
    expect(filtersEqual(a, b)).toBe(true);
  });

  it('元素不同视为不等', () => {
    const a = { ...createEmptyFilters(), tags: ['x'] };
    const b = { ...createEmptyFilters(), tags: ['y'] };
    expect(filtersEqual(a, b)).toBe(false);
  });

  it('长度不同视为不等', () => {
    const a = { ...createEmptyFilters(), tags: ['x'] };
    const b = { ...createEmptyFilters(), tags: ['x', 'y'] };
    expect(filtersEqual(a, b)).toBe(false);
  });
});

describe('cameraKeyOf', () => {
  it('无 EXIF 时返回 null', () => {
    expect(cameraKeyOf(makePhoto({ id: 'a' }))).toBeNull();
    expect(cameraKeyOf(makePhoto({ id: 'a', exif: { make: '  ', model: '' } }))).toBeNull();
  });

  it('机型已含厂商时不再重复厂商', () => {
    expect(
      cameraKeyOf(makePhoto({ id: 'a', exif: { make: 'Apple', model: 'Apple iPhone 15 Pro' } }))
    ).toBe('Apple iPhone 15 Pro');
  });

  it('机型不含厂商时拼接', () => {
    expect(cameraKeyOf(makePhoto({ id: 'a', exif: { make: 'Canon', model: 'EOS R5' } }))).toBe(
      'Canon EOS R5'
    );
  });

  it('只有其一时用其一', () => {
    expect(cameraKeyOf(makePhoto({ id: 'a', exif: { make: 'Nikon' } }))).toBe('Nikon');
    expect(cameraKeyOf(makePhoto({ id: 'a', exif: { model: 'X-T5' } }))).toBe('X-T5');
  });
});

describe('buildFilterOptions / buildTagOptions', () => {
  it('去重并排序；无扩展名的条目不计入 formats', () => {
    const photos = [
      makePhoto({ id: 'a', name: 'a.JPG', exif: { make: 'Apple', model: 'iPhone' } }),
      makePhoto({ id: 'b', name: 'b.jpg', exif: { make: 'Apple', model: 'iPhone' } }),
      makePhoto({ id: 'c', name: 'noext' }),
    ];
    const { cameras, formats } = buildFilterOptions(photos);
    expect(cameras).toEqual(['Apple iPhone']);
    expect(formats).toEqual(['jpg']);
  });

  it('标签去重并排序', () => {
    const photos = [
      makePhoto({ id: 'a', tags: ['海边', '猫'] }),
      makePhoto({ id: 'b', tags: ['猫'] }),
      makePhoto({ id: 'c' }),
    ];
    expect(buildTagOptions(photos)).toEqual(['猫', '海边'].sort((x, y) => x.localeCompare(y)));
  });
});

describe('countAdvancedFilters / isFilterActive', () => {
  it('空筛选：高级项为 0，整体不活跃', () => {
    const f = createEmptyFilters();
    expect(countAdvancedFilters(f)).toBe(0);
    expect(isFilterActive(f)).toBe(false);
  });

  it('每启用一类记 1 项；日期范围算 1 项而不是 2 项', () => {
    const f = {
      ...createEmptyFilters(),
      dateFrom: 1,
      dateTo: 2,
      tags: ['a'],
      sizeFilter: 'gt10m' as const,
    };
    expect(countAdvancedFilters(f)).toBe(3);
  });

  it('favoritesOnly / hiddenOnly / mediaFilter 不计入「高级」但会让整体活跃', () => {
    const f = { ...createEmptyFilters(), favoritesOnly: true };
    expect(countAdvancedFilters(f)).toBe(0);
    expect(isFilterActive(f)).toBe(true);
  });
});

describe('matchesSearch（含索引缓存）', () => {
  const photo = makePhoto({
    id: 'a',
    name: 'Beach Sunset.JPG',
    type: 'image/jpeg',
    exif: { make: 'Canon', model: 'EOS R5' },
    tags: ['旅行'],
    aiTags: ['海边', '夕阳'],
    aiDescription: 'A calm sea at dusk',
  });

  it('空关键词一律通过', () => {
    expect(matchesSearch(photo, '')).toBe(true);
    expect(matchesSearch(photo, '   ')).toBe(true);
  });

  it('命中文件名 / MIME / 相机 / 用户标签 / AI 标签 / AI 描述', () => {
    expect(matchesSearch(photo, 'beach')).toBe(true);
    expect(matchesSearch(photo, 'jpeg')).toBe(true);
    expect(matchesSearch(photo, 'canon')).toBe(true);
    expect(matchesSearch(photo, '旅行')).toBe(true);
    expect(matchesSearch(photo, '海边')).toBe(true);
    expect(matchesSearch(photo, 'dusk')).toBe(true);
  });

  it('大小写不敏感', () => {
    expect(matchesSearch(photo, 'BEACH')).toBe(true);
    expect(matchesSearch(photo, 'CaNoN')).toBe(true);
  });

  it('不命中时返回 false', () => {
    expect(matchesSearch(photo, '不存在的词')).toBe(false);
  });

  /**
   * 回归用例：索引把「相机标识」作为**一个整体**放进去，而不是拆成厂商与机型两段。
   * 若拆开放入，`canon eos` 这种跨字段关键词就会匹配不到 ——
   * 因为拼接后的 haystack 里厂商与机型之间夹着分隔符。
   */
  it('跨厂商与机型的组合关键词仍能命中（相机标识必须整体入索引）', () => {
    expect(matchesSearch(photo, 'canon eos')).toBe(true);
    expect(matchesSearch(photo, 'EOS R5')).toBe(true);
  });

  it('机型已含厂商时不会重复拼接导致匹配失败', () => {
    const apple = makePhoto({
      id: 'b',
      name: 'x.heic',
      exif: { make: 'Apple', model: 'Apple iPhone 15 Pro' },
    });
    expect(matchesSearch(apple, 'apple iphone')).toBe(true);
    expect(matchesSearch(apple, 'iphone 15 pro')).toBe(true);
  });

  it('同一对象重复查询结果稳定（缓存不应改变语义）', () => {
    for (let i = 0; i < 5; i += 1) {
      expect(matchesSearch(photo, 'beach')).toBe(true);
      expect(matchesSearch(photo, 'nope')).toBe(false);
    }
  });

  it('照片被整体替换（不可变更新）后按新内容匹配', () => {
    const updated = { ...photo, name: 'Mountain View.JPG' };
    expect(matchesSearch(updated, 'mountain')).toBe(true);
    expect(matchesSearch(updated, 'beach')).toBe(false);
    // 原对象不受影响
    expect(matchesSearch(photo, 'beach')).toBe(true);
  });

  it('字段被原地修改时指纹能让缓存失效（兜底路径）', () => {
    const mutable = makePhoto({ id: 'c', name: 'a.jpg' });
    expect(matchesSearch(mutable, 'renamed')).toBe(false);
    mutable.name = 'renamed.jpg';
    expect(matchesSearch(mutable, 'renamed')).toBe(true);
  });

  it('原地新增标签同样能被搜到', () => {
    const mutable = makePhoto({ id: 'd', name: 'a.jpg' });
    expect(matchesSearch(mutable, '海边')).toBe(false);
    mutable.tags = ['海边'];
    expect(matchesSearch(mutable, '海边')).toBe(true);
  });

  it('标签与 AI 描述更新后，旧关键词不再命中', () => {
    const mutable = makePhoto({ id: 'e', name: 'a.jpg', aiDescription: 'cat on a sofa' });
    expect(matchesSearch(mutable, 'cat')).toBe(true);
    mutable.aiDescription = 'dog on a sofa';
    expect(matchesSearch(mutable, 'cat')).toBe(false);
    expect(matchesSearch(mutable, 'dog')).toBe(true);
  });
});

describe('matchesFilters', () => {
  const visible = makePhoto({ id: 'v', size: 3 * MB, name: 'v.jpg' });
  const hidden = makePhoto({ id: 'h', isHidden: true });
  const favorite = makePhoto({ id: 'f', isFavorite: true });
  const video = makePhoto({ id: 'vid', name: 'v.mp4', type: 'video/mp4', duration: 30 });

  it('隐藏项默认排除，仅「已隐藏」视图可见', () => {
    expect(matchesFilters(hidden, createEmptyFilters(), noLive)).toBe(false);
    expect(matchesFilters(hidden, { ...createEmptyFilters(), hiddenOnly: true }, noLive)).toBe(
      true
    );
    expect(matchesFilters(visible, { ...createEmptyFilters(), hiddenOnly: true }, noLive)).toBe(
      false
    );
  });

  it('仅收藏', () => {
    const f = { ...createEmptyFilters(), favoritesOnly: true };
    expect(matchesFilters(favorite, f, noLive)).toBe(true);
    expect(matchesFilters(visible, f, noLive)).toBe(false);
  });

  it('媒体类型：图片 / 视频', () => {
    expect(matchesFilters(video, { ...createEmptyFilters(), mediaFilter: 'video' }, noLive)).toBe(
      true
    );
    expect(matchesFilters(visible, { ...createEmptyFilters(), mediaFilter: 'video' }, noLive)).toBe(
      false
    );
    expect(matchesFilters(visible, { ...createEmptyFilters(), mediaFilter: 'image' }, noLive)).toBe(
      true
    );
    expect(matchesFilters(video, { ...createEmptyFilters(), mediaFilter: 'image' }, noLive)).toBe(
      false
    );
  });

  it('自拍 / 实况 / 截屏只对图片生效，视频一律排除', () => {
    for (const media of ['selfie', 'live', 'screenshot'] as const) {
      expect(matchesFilters(video, { ...createEmptyFilters(), mediaFilter: media }, noLive)).toBe(
        false
      );
    }
  });

  it('实况照片依赖外部传入的配对集合', () => {
    const f = { ...createEmptyFilters(), mediaFilter: 'live' as const };
    expect(matchesFilters(visible, f, noLive)).toBe(false);
    expect(matchesFilters(visible, f, { livePhotoIds: new Set(['v']) })).toBe(true);
  });

  it('日期范围含端点', () => {
    const from = localTime(2024, 1, 1);
    const to = localTime(2024, 12, 31);
    const p = makePhoto({ id: 'p', dateTaken: localTime(2024, 6, 15) });
    const f = { ...createEmptyFilters(), dateFrom: from, dateTo: to };
    expect(matchesFilters(p, f, noLive)).toBe(true);
    expect(matchesFilters(makePhoto({ id: 'x', dateTaken: from }), f, noLive)).toBe(true);
    expect(matchesFilters(makePhoto({ id: 'x', dateTaken: to }), f, noLive)).toBe(true);
    expect(
      matchesFilters(makePhoto({ id: 'x', dateTaken: localTime(2023, 12, 31) }), f, noLive)
    ).toBe(false);
  });

  it('日期范围下无时间戳的条目被排除', () => {
    const f = { ...createEmptyFilters(), dateFrom: 1, dateTo: 2 };
    expect(matchesFilters(makePhoto({ id: 'p', dateTaken: 0, lastModified: 0 }), f, noLive)).toBe(
      false
    );
  });

  it('大小档位边界：500KB 属于哪一档由 min 闭区间决定', () => {
    const p500 = makePhoto({ id: 'p', size: 500 * KB });
    expect(matchesFilters(p500, { ...createEmptyFilters(), sizeFilter: 'lt500k' }, noLive)).toBe(
      true
    );
    expect(matchesFilters(p500, { ...createEmptyFilters(), sizeFilter: '500k-2m' }, noLive)).toBe(
      true
    );
    expect(
      matchesFilters(
        makePhoto({ id: 'p', size: 501 * KB }),
        { ...createEmptyFilters(), sizeFilter: 'lt500k' },
        noLive
      )
    ).toBe(false);
  });

  it('时长筛选隐含「只看视频」：无 duration 的条目一律排除', () => {
    const f = { ...createEmptyFilters(), durationFilter: '10-60s' as const };
    expect(matchesFilters(video, f, noLive)).toBe(true);
    expect(matchesFilters(visible, f, noLive)).toBe(false);
  });

  it('标签为多选、命中任意一个即通过', () => {
    const p = makePhoto({ id: 'p', tags: ['猫'] });
    const f = { ...createEmptyFilters(), tags: ['狗', '猫'] };
    expect(matchesFilters(p, f, noLive)).toBe(true);
    expect(matchesFilters(makePhoto({ id: 'q', tags: ['鸟'] }), f, noLive)).toBe(false);
    expect(matchesFilters(makePhoto({ id: 'r' }), f, noLive)).toBe(false);
  });
});

describe('applyPhotoFilters', () => {
  it('先筛选再搜索，且不改动入参', () => {
    const photos = [
      makePhoto({ id: 'a', name: 'cat.jpg', isFavorite: true }),
      makePhoto({ id: 'b', name: 'cat2.jpg', isFavorite: false }),
      makePhoto({ id: 'c', name: 'dog.jpg', isFavorite: true }),
    ];
    const out = applyPhotoFilters(
      photos,
      { ...createEmptyFilters(), favoritesOnly: true },
      'cat',
      noLive
    );
    expect(out.map((p) => p.id)).toEqual(['a']);
    expect(photos).toHaveLength(3);
  });
});

describe('日期范围与预设', () => {
  it('预设区间包含当天最后一毫秒', () => {
    const { to } = datePresetRange('today');
    expect(new Date(to).getHours()).toBe(23);
    expect(new Date(to).getMinutes()).toBe(59);
    expect(new Date(to).getSeconds()).toBe(59);
  });

  it('「最近 7 天」跨度为 7 个自然日（含今天）', () => {
    const { from, to } = datePresetRange('7d');
    const days = Math.round((to - from) / 86400000);
    expect(days).toBe(7);
  });

  it('「今年」从 1 月 1 日 0 点开始', () => {
    const { from } = datePresetRange('year');
    const d = new Date(from);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(1);
    expect(d.getHours()).toBe(0);
  });

  it('matchDatePreset 能识别预设，空区间返回 null，其它返回 custom', () => {
    expect(matchDatePreset(createEmptyFilters())).toBeNull();
    const today = datePresetRange('today');
    expect(
      matchDatePreset({ ...createEmptyFilters(), dateFrom: today.from, dateTo: today.to })
    ).toBe('today');
    expect(matchDatePreset({ ...createEmptyFilters(), dateFrom: 1, dateTo: 2 })).toBe('custom');
  });

  it('时间戳 <-> date input 值互转', () => {
    const ts = localTime(2024, 3, 5, 15, 30);
    expect(toDateInputValue(ts)).toBe('2024-03-05');
    expect(toDateInputValue(null)).toBe('');
    expect(toDateInputValue(NaN)).toBe('');
  });

  it('date input 值 <-> 当天起止时间戳', () => {
    const start = startOfDayFromInput('2024-03-05');
    const end = endOfDayFromInput('2024-03-05');
    expect(toDateInputValue(start!)).toBe('2024-03-05');
    expect(toDateInputValue(end!)).toBe('2024-03-05');
    expect(start!).toBeLessThan(end!);
    expect(new Date(start!).getHours()).toBe(0);
    expect(new Date(end!).getHours()).toBe(23);
  });

  it('非法日期字符串返回 null 而不是 NaN 时间戳', () => {
    expect(startOfDayFromInput('')).toBeNull();
    expect(startOfDayFromInput('not-a-date')).toBeNull();
  });
});

describe('toggleInList', () => {
  it('存在则移除，不存在则追加（不改动原数组）', () => {
    const list = ['a', 'b'];
    expect(toggleInList(list, 'a')).toEqual(['b']);
    expect(toggleInList(list, 'c')).toEqual(['a', 'b', 'c']);
    expect(list).toEqual(['a', 'b']);
  });
});

describe('buildFilterChips', () => {
  it('空筛选不产出任何条件条', () => {
    expect(buildFilterChips(createEmptyFilters())).toEqual([]);
  });

  it('每个启用的条件各产出一条可移除的 chip', () => {
    const chips = buildFilterChips({
      ...createEmptyFilters(),
      favoritesOnly: true,
      mediaFilter: 'video',
      tags: ['海边'],
    });
    const keys = chips.map((c) => c.key);
    expect(keys).toEqual(['favorites', 'media', 'tag:海边']);
    // 每条 chip 都要带可读文案与「移除后应变成什么」的信息，UI 才能渲染
    for (const chip of chips) {
      expect(typeof chip.label).toBe('string');
      expect(chip.label.length).toBeGreaterThan(0);
    }
  });
});
