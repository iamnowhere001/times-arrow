/**
 * 可组合筛选（N3）。
 *
 * 把「关键词搜索 + 分类 / 媒体类型 + 日期 / 相机 / 格式 / 大小 / 时长」
 * 收敛成一份 `PhotoFilters` 与一组纯函数，供 App（结果集）与 UI（面板 / 条件条）共用，
 * 保证「面板里看到的」就是「列表里筛选出的」。
 */

import { DurationFilter, MediaFilter, Photo, PhotoFilters, SizeFilter } from '@/types';
import { extOfName, isVideoPhoto } from '@/utils';
import { isSelfiePhoto, isScreenshotPhoto } from '@/lib/media/mediaTypes';
// 时间语义统一入口：本文件原先内联了 `dateTaken || lastModified`
import { photoTakenTime } from '@/lib/media/photoTime';

/** 空筛选（默认视图：全部媒体、不限定任何条件） */
export const EMPTY_FILTERS: PhotoFilters = {
  favoritesOnly: false,
  hiddenOnly: false,
  mediaFilter: 'all',
  tags: [],
  dateFrom: null,
  dateTo: null,
  cameras: [],
  formats: [],
  sizeFilter: 'any',
  durationFilter: 'any',
};

/**
 * 生成一份全新的空筛选。
 * 数组字段必须各自新建，避免多次重置共享同一个数组引用后被意外改动。
 */
export const createEmptyFilters = (): PhotoFilters => ({
  ...EMPTY_FILTERS,
  tags: [],
  cameras: [],
  formats: [],
});

/**
 * 把（可能来自旧版本配置的）部分筛选补全成完整结构。
 * 智能相簿与配置都可能缺少新增字段，统一从这里兜底。
 */
export const normalizeFilters = (input?: Partial<PhotoFilters> | null): PhotoFilters => {
  const base = createEmptyFilters();
  if (!input) return base;

  return {
    favoritesOnly: input.favoritesOnly ?? base.favoritesOnly,
    hiddenOnly: input.hiddenOnly ?? base.hiddenOnly,
    mediaFilter: input.mediaFilter ?? base.mediaFilter,
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
    dateFrom: input.dateFrom ?? null,
    dateTo: input.dateTo ?? null,
    cameras: Array.isArray(input.cameras) ? [...input.cameras] : [],
    formats: Array.isArray(input.formats) ? [...input.formats] : [],
    sizeFilter: input.sizeFilter ?? base.sizeFilter,
    durationFilter: input.durationFilter ?? base.durationFilter,
  };
};

const sameList = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every(item => set.has(item));
};

/** 两组筛选是否等价：用于判断「当前视图是否就是某个智能相簿」 */
export const filtersEqual = (a: PhotoFilters, b: PhotoFilters): boolean =>
  a.favoritesOnly === b.favoritesOnly &&
  a.hiddenOnly === b.hiddenOnly &&
  a.mediaFilter === b.mediaFilter &&
  a.dateFrom === b.dateFrom &&
  a.dateTo === b.dateTo &&
  a.sizeFilter === b.sizeFilter &&
  a.durationFilter === b.durationFilter &&
  sameList(a.cameras, b.cameras) &&
  sameList(a.formats, b.formats) &&
  sameList(a.tags, b.tags);

export const SIZE_FILTER_OPTIONS: Array<{ value: SizeFilter; label: string }> = [
  { value: 'any', label: '不限' },
  { value: 'lt500k', label: '< 500 KB' },
  { value: '500k-2m', label: '500 KB – 2 MB' },
  { value: '2m-10m', label: '2 – 10 MB' },
  { value: 'gt10m', label: '> 10 MB' },
];

const KB = 1024;
const MB = 1024 * 1024;

const SIZE_RANGES: Record<SizeFilter, { min: number; max: number }> = {
  any: { min: 0, max: Number.POSITIVE_INFINITY },
  lt500k: { min: 0, max: 500 * KB },
  '500k-2m': { min: 500 * KB, max: 2 * MB },
  '2m-10m': { min: 2 * MB, max: 10 * MB },
  gt10m: { min: 10 * MB, max: Number.POSITIVE_INFINITY },
};

export const DURATION_FILTER_OPTIONS: Array<{ value: DurationFilter; label: string }> = [
  { value: 'any', label: '不限' },
  { value: 'lt10s', label: '< 10 秒' },
  { value: '10-60s', label: '10 – 60 秒' },
  { value: '1-5min', label: '1 – 5 分钟' },
  { value: 'gt5min', label: '> 5 分钟' },
];

/** 时长档位按秒计（`Photo.duration` 单位为秒） */
const DURATION_RANGES: Record<DurationFilter, { min: number; max: number }> = {
  any: { min: 0, max: Number.POSITIVE_INFINITY },
  lt10s: { min: 0, max: 10 },
  '10-60s': { min: 10, max: 60 },
  '1-5min': { min: 60, max: 300 },
  gt5min: { min: 300, max: Number.POSITIVE_INFINITY },
};

/**
 * 照片的相机标识：EXIF 厂商 + 机型。
 * 机型常已包含厂商（如 `Apple iPhone 15 Pro`），此时不再重复厂商。
 */
export const cameraKeyOf = (photo: Photo): string | null => {
  const make = photo.exif?.make?.trim() || '';
  const model = photo.exif?.model?.trim() || '';
  if (!make && !model) return null;
  if (make && model) {
    return model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`;
  }
  return make || model;
};

/** 从当前库提取可选的相机 / 格式清单（随元数据后台补齐而动态增长） */
export const buildFilterOptions = (photos: Photo[]): { cameras: string[]; formats: string[] } => {
  const cameras = new Set<string>();
  const formats = new Set<string>();
  for (const photo of photos) {
    const camera = cameraKeyOf(photo);
    if (camera) cameras.add(camera);
    const ext = extOfName(photo.name);
    if (ext) formats.add(ext);
  }
  return {
    cameras: [...cameras].sort((a, b) => a.localeCompare(b)),
    formats: [...formats].sort(),
  };
};

/** 高级筛选（日期 / 相机 / 格式 / 大小 / 时长）的启用项数：用于工具栏角标 */
export const countAdvancedFilters = (filters: PhotoFilters): number => {
  let count = 0;
  if (filters.tags.length > 0) count += 1;
  if (filters.dateFrom !== null || filters.dateTo !== null) count += 1;
  if (filters.cameras.length > 0) count += 1;
  if (filters.formats.length > 0) count += 1;
  if (filters.sizeFilter !== 'any') count += 1;
  if (filters.durationFilter !== 'any') count += 1;
  return count;
};

export const hasAdvancedFilters = (filters: PhotoFilters): boolean => countAdvancedFilters(filters) > 0;

/** 是否存在任何会改变结果集的筛选（不含关键词搜索） */
export const isFilterActive = (filters: PhotoFilters): boolean =>
  filters.favoritesOnly ||
  filters.hiddenOnly ||
  filters.mediaFilter !== 'all' ||
  hasAdvancedFilters(filters);

/** 从当前库提取全部用户标签，供筛选面板与自动补全使用 */
export const buildTagOptions = (photos: Photo[]): string[] => {
  const tags = new Set<string>();
  for (const photo of photos) {
    photo.tags?.forEach(tag => tags.add(tag));
  }
  return [...tags].sort((a, b) => a.localeCompare(b));
};

/**
 * 参与搜索的文本片段。
 *
 * 注意这里放的是 `cameraKeyOf(photo)` 的**计算结果**而不是 exif.make / exif.model 原值：
 * 相机标识可能是「厂商 + 机型」拼接出来的，拆开放进索引会让 `canon eos` 这类
 * 跨字段关键词匹配不到（`'…canon\u0000eos r5…'.includes('canon eos')` 为 false）。
 */
const searchParts = (photo: Photo): string[] => [
  photo.name,
  photo.type,
  cameraKeyOf(photo) ?? '',
  ...(photo.tags ?? []),
  ...(photo.aiTags ?? []),
  photo.aiDescription ?? '',
];

/**
 * 搜索索引缓存。
 *
 * 改造前每次按键都要对**每张照片**重新做一遍 `toLowerCase()`（文件名 / MIME / 相机 /
 * 每个标签 / AI 描述），一万张图就是每帧几万次字符串分配 —— 输入框因此明显发涩。
 *
 * 用 `WeakMap` 而不是普通 Map：照片对象被更新时是**整体替换**（`{...p, ...updates}`），
 * 旧对象失去引用后 WeakMap 条目会自动回收，不需要手工清理，也不会随编辑次数增长。
 *
 * 额外存一份指纹并逐次比对，是为了兜住「万一有人原地修改了 photo 字段」的情况 ——
 * 指纹与 haystack 都从同一份 `searchParts` 派生，因此两者不可能漂移。
 */
const searchIndexCache = new WeakMap<Photo, { fingerprint: string; haystack: string }>();

/** 取（或建立）照片的搜索用 haystack —— 已小写、可直接 includes */
const searchHaystack = (photo: Photo): string => {
  const fingerprint = searchParts(photo).join('\u0000');
  const cached = searchIndexCache.get(photo);
  if (cached && cached.fingerprint === fingerprint) return cached.haystack;

  const haystack = fingerprint.toLowerCase();
  searchIndexCache.set(photo, { fingerprint, haystack });
  return haystack;
};

/**
 * 关键词匹配：文件名 / MIME / 相机机型 / 用户标签 / AI 标签与描述。
 * AI 结果接入搜索后，「海边」「猫」这类语义词也能直接命中。
 */
export const matchesSearch = (photo: Photo, rawQuery: string): boolean => {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;
  return searchHaystack(photo).includes(query);
};

/** 媒体类型展示名（侧栏 / 筛选面板 / 条件条 / 空状态共用） */
export const MEDIA_FILTER_LABELS: Record<MediaFilter, string> = {
  all: '全部',
  image: '图片',
  video: '视频',
  selfie: '自拍',
  live: '实况照片',
  screenshot: '截屏',
};

/** 筛选面板里的媒体类型选项（数组顺序即展示顺序） */
export const MEDIA_FILTER_OPTIONS: MediaFilter[] = [
  'all',
  'image',
  'video',
  'selfie',
  'live',
  'screenshot',
];

/**
 * 筛选所需的额外上下文。
 * 实况照片依赖「同目录存在同名配对视频」，无法只看单张照片得出，故由调用方预计算。
 */
export interface FilterContext {
  livePhotoIds: ReadonlySet<string>;
}

const EMPTY_CONTEXT: FilterContext = { livePhotoIds: new Set() };

/** 单张照片是否满足全部筛选条件 */
export const matchesFilters = (
  photo: Photo,
  filters: PhotoFilters,
  context: FilterContext = EMPTY_CONTEXT
): boolean => {
  // 隐藏项默认不出现在任何视图里，只有「已隐藏」视图例外
  if (filters.hiddenOnly) {
    if (!photo.isHidden) return false;
  } else if (photo.isHidden) {
    return false;
  }

  if (filters.favoritesOnly && !photo.isFavorite) return false;

  if (filters.tags.length > 0) {
    const tags = photo.tags;
    if (!tags || tags.length === 0) return false;
    if (!tags.some(tag => filters.tags.includes(tag))) return false;
  }

  if (filters.mediaFilter !== 'all') {
    const media = filters.mediaFilter;
    const isVideo = isVideoPhoto(photo);
    if (media === 'image') {
      if (isVideo) return false;
    } else if (media === 'video') {
      if (!isVideo) return false;
    } else if (isVideo) {
      // 自拍 / 实况照片 / 截屏都属于图片类型
      return false;
    } else if (media === 'selfie') {
      if (!isSelfiePhoto(photo)) return false;
    } else if (media === 'screenshot') {
      if (!isScreenshotPhoto(photo)) return false;
    } else if (media === 'live') {
      if (!context.livePhotoIds.has(photo.id)) return false;
    }
  }

  if (filters.dateFrom !== null || filters.dateTo !== null) {
    // 与分组/排序共用同一个「拍摄时间」语义，否则筛选出的结果与列表头会自相矛盾
    const time = photoTakenTime(photo);
    if (!time) return false;
    if (filters.dateFrom !== null && time < filters.dateFrom) return false;
    if (filters.dateTo !== null && time > filters.dateTo) return false;
  }

  if (filters.cameras.length > 0) {
    const camera = cameraKeyOf(photo);
    if (!camera || !filters.cameras.includes(camera)) return false;
  }

  if (filters.formats.length > 0) {
    if (!filters.formats.includes(extOfName(photo.name))) return false;
  }

  if (filters.sizeFilter !== 'any') {
    const { min, max } = SIZE_RANGES[filters.sizeFilter];
    const size = photo.size || 0;
    if (size < min || size > max) return false;
  }

  if (filters.durationFilter !== 'any') {
    // 时长只有在视频元数据加载后才有值：按时长筛选即意味着只看视频
    if (typeof photo.duration !== 'number') return false;
    const { min, max } = DURATION_RANGES[filters.durationFilter];
    if (photo.duration < min || photo.duration > max) return false;
  }

  return true;
};

/** 先按条件筛选，再按关键词搜索 */
export const applyPhotoFilters = (
  photos: Photo[],
  filters: PhotoFilters,
  query: string,
  context: FilterContext = EMPTY_CONTEXT
): Photo[] =>
  photos.filter(photo => matchesFilters(photo, filters, context) && matchesSearch(photo, query));

// ---------------------------------------------------------------------------
// 日期范围：预设 + 输入框 <-> 时间戳
// ---------------------------------------------------------------------------

export type DatePreset = 'today' | '7d' | '30d' | 'year';

export const DATE_PRESET_OPTIONS: Array<{ value: DatePreset; label: string }> = [
  { value: 'today', label: '今天' },
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' },
  { value: 'year', label: '今年' },
];

/** 预设对应的起止时间戳（结束取当天 23:59:59.999，保证「今天」能被包含） */
export const datePresetRange = (preset: DatePreset): { from: number; to: number } => {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();

  switch (preset) {
    case 'today':
      return { from: startOfToday, to: endOfToday };
    case '7d': {
      const d = new Date(startOfToday);
      d.setDate(d.getDate() - 6);
      return { from: d.getTime(), to: endOfToday };
    }
    case '30d': {
      const d = new Date(startOfToday);
      d.setDate(d.getDate() - 29);
      return { from: d.getTime(), to: endOfToday };
    }
    case 'year':
      return { from: new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0).getTime(), to: endOfToday };
  }
};

/** 当前日期条件命中了哪个预设；都未命中（且非空）时返回 null（表示自定义区间） */
export const matchDatePreset = (filters: PhotoFilters): DatePreset | 'custom' | null => {
  if (filters.dateFrom === null && filters.dateTo === null) return null;
  for (const option of DATE_PRESET_OPTIONS) {
    const range = datePresetRange(option.value);
    if (filters.dateFrom === range.from && filters.dateTo === range.to) return option.value;
  }
  return 'custom';
};

const pad2 = (value: number) => String(value).padStart(2, '0');

/** 时间戳 → `<input type="date">` 的 yyyy-MM-dd */
export const toDateInputValue = (ts: number | null): string => {
  if (ts === null) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

const parseDateInput = (value: string): [number, number, number] | null => {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return null;
  return [y, m, d];
};

/** yyyy-MM-dd → 当天 00:00:00.000 */
export const startOfDayFromInput = (value: string): number | null => {
  const parsed = parseDateInput(value);
  if (!parsed) return null;
  const [y, m, d] = parsed;
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
};

/** yyyy-MM-dd → 当天 23:59:59.999 */
export const endOfDayFromInput = (value: string): number | null => {
  const parsed = parseDateInput(value);
  if (!parsed) return null;
  const [y, m, d] = parsed;
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
};

// ---------------------------------------------------------------------------
// 已启用条件 → 可清除的 chips
// ---------------------------------------------------------------------------

export interface FilterChip {
  key: string;
  label: string;
  /** 清除该条件需要打回的补丁 */
  patch: Partial<PhotoFilters>;
}

/** 把当前筛选拆成「一条一清除」的条件列表，供条件条渲染 */
export const buildFilterChips = (filters: PhotoFilters): FilterChip[] => {
  const chips: FilterChip[] = [];

  if (filters.favoritesOnly) {
    chips.push({ key: 'favorites', label: '仅收藏', patch: { favoritesOnly: false } });
  }

  if (filters.mediaFilter !== 'all') {
    chips.push({
      key: 'media',
      label: MEDIA_FILTER_LABELS[filters.mediaFilter],
      patch: { mediaFilter: 'all' },
    });
  }

  if (filters.dateFrom !== null || filters.dateTo !== null) {
    let label: string;
    if (filters.dateFrom !== null && filters.dateTo !== null) {
      label = `${toDateInputValue(filters.dateFrom)} 至 ${toDateInputValue(filters.dateTo)}`;
    } else if (filters.dateFrom !== null) {
      label = `${toDateInputValue(filters.dateFrom)} 起`;
    } else {
      label = `截至 ${toDateInputValue(filters.dateTo)}`;
    }
    chips.push({ key: 'date', label, patch: { dateFrom: null, dateTo: null } });
  }

  filters.cameras.forEach(camera =>
    chips.push({
      key: `camera:${camera}`,
      label: camera,
      patch: { cameras: filters.cameras.filter(item => item !== camera) },
    })
  );

  if (filters.hiddenOnly) {
    chips.push({ key: 'hidden', label: '已隐藏', patch: { hiddenOnly: false } });
  }

  filters.tags.forEach(tag =>
    chips.push({
      key: `tag:${tag}`,
      label: `#${tag}`,
      patch: { tags: filters.tags.filter(item => item !== tag) },
    })
  );

  filters.formats.forEach(format =>
    chips.push({
      key: `format:${format}`,
      label: format.toUpperCase(),
      patch: { formats: filters.formats.filter(item => item !== format) },
    })
  );

  if (filters.sizeFilter !== 'any') {
    const option = SIZE_FILTER_OPTIONS.find(item => item.value === filters.sizeFilter);
    chips.push({ key: 'size', label: `大小 ${option?.label ?? ''}`, patch: { sizeFilter: 'any' } });
  }

  if (filters.durationFilter !== 'any') {
    const option = DURATION_FILTER_OPTIONS.find(item => item.value === filters.durationFilter);
    chips.push({ key: 'duration', label: `时长 ${option?.label ?? ''}`, patch: { durationFilter: 'any' } });
  }

  return chips;
};

/** 在数组里追加 / 移除一个值（多选 chip 用） */
export const toggleInList = (list: string[], value: string): string[] =>
  list.includes(value) ? list.filter(item => item !== value) : [...list, value];
