
export interface ExifData {
  make?: string;
  model?: string;
  exposureTime?: string;
  fNumber?: string;
  iso?: string;
  focalLength?: string;
  lensModel?: string;
  /** EXIF 方向（已转成可读文案，如「顺时针旋转 90°」） */
  orientation?: string;
  /** 色彩空间（如 sRGB / 未校准） */
  colorSpace?: string;
  /** GPS 十进制度数坐标（只读展示） */
  gps?: { latitude: number; longitude: number };
}

export interface Photo {
  id: string;
  file?: File;
  fileHandle?: any; // FileSystemFileHandle
  name: string; // Mutable name for renaming
  url: string;
  thumbnail?: string; // Thumbnail URL for memory optimization
  path?: string; // Full path for Electron file operations
  size: number;
  type: string;
  lastModified: number; // File Modification Date
  dateCreated?: number; // File Creation Date from filesystem
  dateTaken?: number;   // EXIF Content Creation Date
  exif?: ExifData;      // Detailed EXIF metadata
  dimensions?: { width: number; height: number };
  aiDescription?: string;
  aiTags?: string[];
  isFavorite: boolean;
  isRecommended?: boolean; // Recommended photo to keep in duplicate group
  isCover?: boolean; // 图库封面：全库仅一张（持久化随状态层 M2 一并落地）
  /** 用户隐藏：默认从各视图排除，仅在「已隐藏」中可见 */
  isHidden?: boolean;
  /** 用户手动标签（与 AI 生成的 aiTags 分开维护，可编辑） */
  tags?: string[];
  /** 拍摄时间已被手动修正（详情面板据此提示，避免误解为相机原始信息） */
  dateAdjusted?: boolean;
  hash?: string; // Image hash for duplicate detection
  /** 媒体类型：图片 / 视频（旧数据缺省时按扩展名推断） */
  kind?: MediaKind;
  /** 视频时长（秒），仅在播放器加载元数据后可得 */
  duration?: number;
}

/** 条目类型：图片或视频 */
export type MediaKind = 'image' | 'video';

/**
 * 媒体类型筛选。
 * `image` / `video` 是基础类型；`selfie` / `live` / `screenshot` 为
 * 仿 macOS「照片」媒体类型的智能分类（识别规则见 `mediaTypes.ts`）。
 */
export type MediaFilter = 'all' | 'image' | 'video' | 'selfie' | 'live' | 'screenshot';

export type SortKey = 'name' | 'size' | 'dateModified' | 'dateCreated' | 'dateTaken';
export type SortDirection = 'asc' | 'desc';

/** 重复检测的比对范围：全库跨目录 / 仅同目录 */
export type DuplicateScope = 'all' | 'sameFolder';

export interface SortConfig {
  key: SortKey;
  direction: SortDirection;
}

export type ViewMode = 'grid' | 'list';

/** 文件大小筛选档位 */
export type SizeFilter = 'any' | 'lt500k' | '500k-2m' | '2m-10m' | 'gt10m';

/** 视频时长筛选档位 */
export type DurationFilter = 'any' | 'lt10s' | '10-60s' | '1-5min' | 'gt5min';

/**
 * 可组合的筛选条件（N3）。
 * 与搜索关键词、侧栏分类共同决定 `visiblePhotos`，是当前视图的唯一数据源。
 */
export interface PhotoFilters {
  /** 仅显示收藏 */
  favoritesOnly: boolean;
  /** 仅显示已隐藏项（否则隐藏项一律排除在各视图之外） */
  hiddenOnly: boolean;
  /** 媒体类型：全部 / 图片 / 视频 / 自拍 / 实况照片 / 截屏 */
  mediaFilter: MediaFilter;
  /** 选中的用户标签（多选，命中任意一个即算符合） */
  tags: string[];
  /** 拍摄（缺失时用修改）时间范围，含端点，毫秒时间戳 */
  dateFrom: number | null;
  dateTo: number | null;
  /** 选中的相机 / 机型（EXIF 厂商 + 机型组合键） */
  cameras: string[];
  /** 选中的扩展名（小写，不含点） */
  formats: string[];
  /** 文件大小档位 */
  sizeFilter: SizeFilter;
  /** 视频时长档位 */
  durationFilter: DurationFilter;
}

/**
 * 智能相簿：一组可复用的筛选条件。
 * 相簿只存条件、不存照片，每次打开都按当前图库实时求值，因此内容自动更新。
 */
export interface SmartAlbum {
  id: string;
  name: string;
  filters: PhotoFilters;
  createdAt: number;
}

/**
 * 视频元数据。
 * 主进程无法解码视频，因此时长 / 分辨率只能由渲染进程的播放器读取后上报；
 * 读取结果会缓存并持久化，避免每次启动都重新探测。
 */
export interface VideoMetaRecord {
  /** 时长（秒） */
  duration: number;
  width: number;
  height: number;
}

/**
 * 视图偏好：决定「重启后打开看到什么样」。
 * 与照片数据无关，全部是原始类型，直接写进 config.json。
 */
export interface ViewPreferences {
  /** 外观模式；'system' 表示跟随系统（加载端显式接受该值） */
  theme?: 'light' | 'dark' | 'system';
  viewMode?: ViewMode;
  sortKey?: SortKey;
  sortDirection?: SortDirection;
  /** 网格缩放 */
  scale?: number;
  /** 媒体类型筛选（只记这一项，日期 / 标签等高级条件不跨启动保留） */
  mediaFilter?: MediaFilter;
  leftPaneOpen?: boolean;
  detailsPaneOpen?: boolean;
}

/** 重复检测参数 */
export interface DuplicatePreferences {
  /** 相似度阈值（百分比 80–100） */
  similarity?: number;
  scope?: DuplicateScope;
}

/** AI 分析结果缓存条目 */
export interface AiCacheEntry {
  description?: string;
  tags?: string[];
}

/** 持久化到 `userData/ai-cache.json` 的 AI 分析结果（体量较大，单独成文件并限量） */
export interface PersistedAiCache {
  version?: number;
  entries?: Record<string, AiCacheEntry>;
}

/** 持久化到 `userData/config.json` 的数据（全部为可 JSON 序列化的原始类型） */
export interface PersistedConfig {
  /** 配置结构版本，便于日后迁移 */
  version?: number;
  /** 收藏项路径 */
  favorites?: string[];
  /** 已隐藏项路径 */
  hidden?: string[];
  /** 用户标签：路径 → 标签数组 */
  tags?: Record<string, string[]>;
  /** 拍摄时间修正：路径 → 毫秒时间戳 */
  dateOverrides?: Record<string, number>;
  /** 智能相簿 */
  albums?: SmartAlbum[];
  /** 视频元数据：路径 → 时长 / 分辨率 */
  videoMeta?: Record<string, VideoMetaRecord>;
  /** 图库封面路径（全库仅一张） */
  cover?: string;
  /** 视图偏好（主题 / 排序 / 缩放 / 面板开合…） */
  preferences?: ViewPreferences;
  /** 最近打开过的目录（新在前） */
  recentDirectories?: string[];
  /** 重复检测参数 */
  duplicate?: DuplicatePreferences;
  /** 窗口尺寸与位置（仅由主进程读写） */
  windowBounds?: { x?: number; y?: number; width: number; height: number };
  windowMaximized?: boolean;
}

export type RenameMode = 'sequence' | 'replace' | 'date' | 'repair';

/** 「乱码修复」模式的子选项 */
export interface RepairNameOptions {
  /** 尝试修复被错误解码的乱码字符（UTF-8 / GBK 被当作 Latin-1 读取） */
  fixMojibake: boolean;
  /** 去除 IMG_、DSC、mmexport、微信图片 等无意义前缀 */
  stripJunkPrefix: boolean;
  /** 去除「(1)」「副本」「copy」等重复标记 */
  stripCopyMarks: boolean;
  /** 清理后仍无意义时，改用拍摄时间命名 */
  fallbackToDate: boolean;
  dateFormat?: string;
  datePrefix?: string;
}

export interface RenameOptions {
  mode: RenameMode;
  prefix: string;
  startNumber: number;
  /** 编号补零位数（格式化名称模式），默认 3 */
  numberPadding?: number;
  findText: string;
  replaceText: string;
  useRegex: boolean;
  dateFormat?: string;
  /** 按拍摄时间命名时的前缀，默认 photo_ */
  datePrefix?: string;
  /** 「乱码修复」模式的子选项 */
  repair?: RepairNameOptions;
}
