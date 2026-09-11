const { app, BrowserWindow, Menu, ipcMain, dialog, shell, protocol, nativeImage, clipboard } = require('electron');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-setuid-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');

// 自定义协议：向渲染进程以流的方式提供「原图」与「磁盘缩略图」，
// 避免把整张图片以 base64 常驻在渲染进程内存中（这是 OOM 的根因）。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pm',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: true,
      stream: true,
    },
  },
]);

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const { Readable } = require('stream');

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const rename = promisify(fs.rename);
const unlink = promisify(fs.unlink);
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const crypto = require('crypto');
const logger = require('./lib/logger.cjs');

// ---------------------------------------------------------------------------
// 环境变量：主进程不经过 Vite，需要自行加载 .env。
// AI 密钥只保留在主进程（不再注入渲染进程 bundle），避免进入前端产物。
// 优先级：已存在的 process.env > 应用根 .env.local / .env > 当前工作目录 > userData/ai.env
// ---------------------------------------------------------------------------
function loadEnvFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const key = match[1];
    if (process.env[key] !== undefined) continue; // 真实环境变量优先
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function loadEnvFiles() {
  const appPath = app.getAppPath();
  const candidates = [
    path.join(appPath, '.env.local'),
    path.join(appPath, '.env'),
    path.join(process.cwd(), '.env.local'),
    path.join(process.cwd(), '.env'),
    path.join(app.getPath('userData'), 'ai.env'),
  ];

  const seen = new Set();
  for (const file of candidates) {
    if (seen.has(file)) continue;
    seen.add(file);
    loadEnvFile(file);
  }
}

try {
  loadEnvFiles();
} catch (error) {
  logger.warn('Failed to load env files:', error.message);
}

let mainWindow;

// ---------------------------------------------------------------------------
// 并发控制：所有磁盘/解码密集型任务都必须限流，避免 EMFILE 与内存尖峰
// ---------------------------------------------------------------------------
function createLimiter(concurrency) {
  let active = 0;
  const queue = [];

  const pump = () => {
    while (active < concurrency && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pump();
    });
}

const thumbLimiter = createLimiter(8);
const metaLimiter = createLimiter(8);
// HEIC 解码非常吃 CPU 与内存，必须严格限制并发
const heicLimiter = createLimiter(2);
const hashLimiter = createLimiter(4);
const statLimiter = createLimiter(16);

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.heic', '.heif', '.avif', '.bmp', '.tif', '.tiff',
]);

// 常见视频容器。Chromium 原生可解码的主要是 mp4/m4v/mov(H.264)/webm/ogv，
// 其余格式仍可导入与整理（重命名 / 删除 / 在访达中显示），能否播放取决于内置编解码器。
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.mov', '.webm', '.ogv', '.ogg', '.mkv', '.avi', '.wmv', '.flv',
  '.3gp', '.3g2', '.mpeg', '.mpg', '.m2ts', '.mts', '.ts', '.asf', '.rm', '.rmvb',
  '.vob', '.f4v', '.divx', '.dv', '.mxf',
]);

const MAX_SCAN_DEPTH = 12;
const THUMB_CACHE_LIMIT = 20000;

/**
 * 缩略图渲染管线版本。
 * 改变像素处理方式（例如 EXIF 方向校正、缩放算法）时必须自增：
 * 旧版本的落盘缓存 key 不再匹配，会被自然淘汰并按需重新生成。
 */
const THUMB_RENDER_VERSION = 2;

const isHeicFile = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.heic' || ext === '.heif';
};

const isVideoFile = (filePath) => VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
const isMediaFile = (filePath) =>
  IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ||
  VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());

const VIDEO_MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.m2ts': 'video/mp2t',
  '.mts': 'video/mp2t',
  '.ts': 'video/mp2t',
  '.asf': 'video/x-ms-asf',
  '.vob': 'video/dvd',
  '.f4v': 'video/x-f4v',
  '.mxf': 'application/mxf',
};

const mimeTypeFor = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (VIDEO_MIME_TYPES[ext]) return VIDEO_MIME_TYPES[ext];
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.avif':
      return 'image/avif';
    case '.bmp':
      return 'image/bmp';
    case '.tif':
    case '.tiff':
      return 'image/tiff';
    case '.heic':
    case '.heif':
      return 'image/heic';
    default:
      return 'application/octet-stream';
  }
};

// ---------------------------------------------------------------------------
// 缩略图：生成一次后落到 userData/thumbnails，之后命中即返回，重启后仍可复用
// ---------------------------------------------------------------------------
let thumbDir = null;

function getThumbDir() {
  if (!thumbDir) {
    thumbDir = path.join(app.getPath('userData'), 'thumbnails');
    fs.mkdirSync(thumbDir, { recursive: true });
  }
  return thumbDir;
}

// 注意：必须使用 pm://<host>/... 形式。
// pm:///thumb/x 这类「空 host」写法会被 Chromium 折叠成 host=thumb，导致路径解析错位。
const thumbUrlForKey = (key) => `pm://local/thumb/${key}.jpg`;

async function pruneThumbCache() {
  try {
    const dir = getThumbDir();
    const entries = await readdir(dir);
    if (entries.length <= THUMB_CACHE_LIMIT) return;
    const withStat = await Promise.all(
      entries.map(name =>
        statLimiter(async () => {
          try {
            const s = await stat(path.join(dir, name));
            return { name, atime: s.atimeMs };
          } catch {
            return null;
          }
        })
      )
    );
    const sorted = withStat.filter(Boolean).sort((a, b) => a.atime - b.atime);
    const toDelete = sorted.slice(0, Math.floor(sorted.length / 2));
    await Promise.all(toDelete.map((e) => unlink(path.join(dir, e.name)).catch(() => {})));
  } catch (error) {
    logger.warn('Failed to prune thumbnail cache:', error.message);
  }
}

/**
 * 读取 HEIC/HEIF 并转成 JPEG，转换结果落盘缓存。
 * HEIC 解码成本极高，没有缓存时每次打开大图都要重新转一次。
 */
async function readHeicAsJpeg(filePath) {
  const stats = await stat(filePath);
  const key = `full-${crypto
    .createHash('sha1')
    .update(`${filePath}|${stats.size}|${Math.floor(stats.mtimeMs)}`)
    .digest('hex')}`;
  const cachePath = path.join(getThumbDir(), `${key}.jpg`);

  const readCache = async () => {
    try {
      return await readFile(cachePath);
    } catch {
      return null;
    }
  };

  const cached = await readCache();
  if (cached) return cached;

  return heicLimiter(async () => {
    // 排队期间可能已被其它任务转换完成
    const hit = await readCache();
    if (hit) return hit;

    const raw = await readFile(filePath);
    const convert = require('heic-convert');
    const converted = await convert({ buffer: raw, format: 'JPEG', quality: 0.92 });
    const buffer = Buffer.from(converted);
    await writeFile(cachePath, buffer);
    return buffer;
  });
}

/**
 * 读取 EXIF 原始方向值（1~8）。
 * 只读文件头部（EXIF 集中在开头），解析失败 / 无标记时返回 1（正常）。
 * HEIC 直接返回 1：libheif 解码时已经应用了 irot/imir 旋转，再按 EXIF 转一次会转错。
 */
async function readExifOrientation(filePath) {
  if (isHeicFile(filePath)) return 1;
  try {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const { size } = await handle.stat();
      const chunk = Buffer.alloc(Math.min(256 * 1024, size));
      await handle.read(chunk, 0, chunk.length, 0);
      // eslint-disable-next-line global-require
      const ExifReader = require('exifreader');
      const tags = ExifReader.load(chunk) || {};
      const value = Number(tags.Orientation?.value);
      return value >= 1 && value <= 8 ? value : 1;
    } finally {
      await handle.close();
    }
  } catch {
    return 1;
  }
}

/**
 * 把 EXIF 方向「烙」进像素。
 *
 * nativeImage 不提供旋转 API，且 toJPEG() 会丢弃 EXIF —— 若不在这里纠正，
 * 竖拍人像在网格里就会横过来（右侧大图走原文件、由 Chromium 套用 EXIF，所以是正的，
 * 两者会明显不一致）。这里按 EXIF 标准把 BGRA 位图重排到正确朝向。
 *
 * 方向语义（sx/sy 为源坐标，width/height 为旋转前的尺寸）：
 *   1 正常  2 水平镜像  3 旋转 180°  4 垂直镜像
 *   5 转置   6 顺时针 90°  7 反转置  8 逆时针 90°
 * 5~8 需要交换输出宽高。
 */
function applyExifOrientation(image, orientation) {
  if (!orientation || orientation < 2 || orientation > 8) return image;

  const { width, height } = image.getSize();
  if (!width || !height) return image;

  let bitmap;
  try {
    bitmap = image.toBitmap();
  } catch {
    return image;
  }
  if (!bitmap || bitmap.length < width * height * 4) return image;

  const swapped = orientation >= 5;
  const outWidth = swapped ? height : width;
  const outHeight = swapped ? width : height;
  const out = Buffer.allocUnsafe(width * height * 4);

  for (let y = 0; y < outHeight; y += 1) {
    const outRow = y * outWidth;
    for (let x = 0; x < outWidth; x += 1) {
      let sx;
      let sy;
      switch (orientation) {
        case 2: sx = width - 1 - x; sy = y; break;
        case 3: sx = width - 1 - x; sy = height - 1 - y; break;
        case 4: sx = x; sy = height - 1 - y; break;
        case 5: sx = y; sy = x; break;
        case 6: sx = y; sy = height - 1 - x; break;
        case 7: sx = width - 1 - y; sy = height - 1 - x; break;
        case 8: sx = width - 1 - y; sy = x; break;
        default: sx = x; sy = y; break;
      }
      const src = (sy * width + sx) * 4;
      const dst = (outRow + x) * 4;
      out[dst] = bitmap[src];
      out[dst + 1] = bitmap[src + 1];
      out[dst + 2] = bitmap[src + 2];
      out[dst + 3] = bitmap[src + 3];
    }
  }

  try {
    const rotated = nativeImage.createFromBitmap(out, { width: outWidth, height: outHeight });
    return rotated.isEmpty() ? image : rotated;
  } catch {
    // 平台位图格式不兼容时退回原图：宁可方向不对，也不要整张缩略图丢失
    return image;
  }
}

async function buildThumbBuffer(filePath, maxSize) {
  let image = nativeImage.createFromPath(filePath);
  // 记录是否由 nativeImage 原生解码：只有这条路径才需要自行套用 EXIF 方向
  const nativelyDecoded = !image.isEmpty();

  // HEIC/HEIF 等 nativeImage 无法直接解码的格式，先转成 JPEG（带缓存）
  if (!nativelyDecoded && isHeicFile(filePath)) {
    image = nativeImage.createFromBuffer(await readHeicAsJpeg(filePath));
  }

  if (image.isEmpty()) {
    throw new Error(`Unsupported image: ${filePath}`);
  }

  const { width, height } = image.getSize();
  if (!width || !height) {
    throw new Error(`Invalid image size: ${filePath}`);
  }

  const ratio = Math.min(1, maxSize / Math.max(width, height));
  let resized =
    ratio < 1
      ? image.resize({
          width: Math.max(1, Math.round(width * ratio)),
          height: Math.max(1, Math.round(height * ratio)),
          quality: 'good',
        })
      : image;

  // 先缩放再旋转：位图小、代价低，且最长边与方向无关，缩放比例不受影响
  if (nativelyDecoded) {
    resized = applyExifOrientation(resized, await readExifOrientation(filePath));
  }

  return resized.toJPEG(80);
}

/** 缩略图缓存的 key（与 ensureThumbnail / 感知哈希复用同一套命名） */
function thumbCacheKey(filePath, stats, maxSize) {
  return crypto
    .createHash('sha1')
    .update(`${THUMB_RENDER_VERSION}|${filePath}|${stats.size}|${Math.floor(stats.mtimeMs)}|${maxSize}`)
    .digest('hex');
}

/**
 * 已落盘的缩略图 key 集合。
 * 感知哈希优先复用这些小图，避免为检测重复项再解码一次整张原图；
 * 也用于 HEIC 这类解码成本极高的格式。
 */
const thumbKeySet = new Set();
const THUMB_SIZE_STEPS = [320, 480, 640, 800, 960, 1120, 1280];
/**
 * key 集合的上限。它只是「某个 key 是否已落盘」的索引，
 * 每个 key 约 40 字节，但长会话里反复切换缩略图尺寸会让它单调增长，必须封顶。
 */
const THUMB_KEY_LIMIT = 150000;

async function loadThumbKeys() {
  try {
    const entries = await readdir(getThumbDir());
    for (const name of entries) {
      if (name.endsWith('.jpg')) thumbKeySet.add(name.slice(0, -4));
    }
  } catch {
    /* 目录不可读时退化为不使用缩略图 */
  }
}

/** 记录一个已落盘的 key；超过上限时按磁盘实际内容重建（而不是无上限增长） */
function rememberThumbKey(key) {
  thumbKeySet.add(key);
  if (thumbKeySet.size <= THUMB_KEY_LIMIT) return;
  thumbKeySet.clear();
  loadThumbKeys().catch(() => {});
}

async function ensureThumbnail(filePath, maxSize = 320) {
  const stats = await stat(filePath);
  const key = thumbCacheKey(filePath, stats, maxSize);
  const outPath = path.join(getThumbDir(), `${key}.jpg`);

  const exists = async () => {
    try {
      await fs.promises.access(outPath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  };

  if (await exists()) {
    rememberThumbKey(key);
    return thumbUrlForKey(key);
  }

  // 视频无法用 nativeImage 解码：由渲染进程用 <video> 抓首帧后调用 cache-thumbnail 回写。
  // 这里返回 null 表示「尚未缓存，请渲染进程生成」。
  if (isVideoFile(filePath)) return null;

  return thumbLimiter(async () => {
    // 排队期间可能已被其它任务生成
    if (await exists()) {
      rememberThumbKey(key);
      return thumbUrlForKey(key);
    }
    const buffer = await buildThumbBuffer(filePath, maxSize);
    await writeFile(outPath, buffer);
    rememberThumbKey(key);
    noteThumbWrite();
    return thumbUrlForKey(key);
  });
}

/**
 * 磁盘缩略图目录的运行期清理。
 * 原先只在 app.on('ready') 时清理一次，长会话里连续导入多个大目录会让磁盘缓存只增不减；
 * 改为每写入一批就检查一次，且清理后重建 key 索引。
 */
let thumbPruneTimer = null;
let thumbWritesSincePrune = 0;
const THUMB_WRITES_PER_PRUNE = 500;

function scheduleThumbPrune() {
  if (thumbPruneTimer) return;
  thumbPruneTimer = setTimeout(async () => {
    thumbPruneTimer = null;
    await pruneThumbCache();
    await loadThumbKeys();
  }, 1500);
  thumbPruneTimer.unref?.();
}

function noteThumbWrite() {
  thumbWritesSincePrune += 1;
  if (thumbWritesSincePrune >= THUMB_WRITES_PER_PRUNE) {
    thumbWritesSincePrune = 0;
    scheduleThumbPrune();
  }
}

/**
 * 回写渲染进程抓取的视频首帧。
 * key 与 ensureThumbnail 完全一致，因此下一次打开图库会直接命中磁盘缓存。
 */
async function cacheThumbnail(filePath, maxSize, base64) {
  const stats = await stat(filePath);
  const key = thumbCacheKey(filePath, stats, maxSize);
  const outPath = path.join(getThumbDir(), `${key}.jpg`);
  await writeFile(outPath, Buffer.from(base64, 'base64'));
  rememberThumbKey(key);
  noteThumbWrite();
  return thumbUrlForKey(key);
}

// ---------------------------------------------------------------------------
// 目录扫描：主进程一次性完成递归，避免渲染进程多趟遍历；带真实路径去重防符号链接环
// 支持按 scanId 取消：大型目录扫描到一半用户可以中断，避免白等
// ---------------------------------------------------------------------------
const activeScans = new Set();

async function scanDirectory(rootPath, scanId) {
  const tracked = typeof scanId === 'string' && scanId.length > 0;
  if (tracked) activeScans.add(scanId);
  const isCancelled = () => tracked && !activeScans.has(scanId);

  const pending = [];
  const visited = new Set();
  const stack = [{ dir: rootPath, depth: 0 }];

  try {
    while (stack.length > 0 && !isCancelled()) {
      const { dir, depth } = stack.pop();
      if (depth > MAX_SCAN_DEPTH) continue;

      let realDir;
      try {
        realDir = await fs.promises.realpath(dir);
      } catch {
        continue;
      }
      if (visited.has(realDir)) continue;
      visited.add(realDir);

      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (isCancelled()) break;
        if (entry.name.startsWith('.')) continue;
        if (entry.isSymbolicLink()) continue;

        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push({ dir: full, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        const entryExt = path.extname(entry.name).toLowerCase();
        if (!IMAGE_EXTENSIONS.has(entryExt) && !VIDEO_EXTENSIONS.has(entryExt)) continue;

        // stat 并发受控，避免一次性打开上万个文件句柄
        pending.push(
          statLimiter(async () => {
            try {
              const s = await stat(full);
              return {
                name: entry.name,
                path: full,
                size: s.size,
                mtime: s.mtimeMs,
                created: s.birthtimeMs || s.ctimeMs || 0,
              };
            } catch {
              return null;
            }
          })
        );
      }
    }

    if (isCancelled()) return [];

    const settled = await Promise.all(pending);
    return settled.filter(Boolean);
  } finally {
    if (tracked) activeScans.delete(scanId);
  }
}

// ---------------------------------------------------------------------------
// EXIF：在主进程解析（渲染进程不再做 atob 逐字节转换，避免主线程长任务）
// ---------------------------------------------------------------------------
/** EXIF 方向值 → 中文说明 */
const ORIENTATION_LABELS = {
  1: '正常',
  2: '水平镜像',
  3: '旋转 180°',
  4: '垂直镜像',
  5: '镜像并旋转 90°',
  6: '顺时针旋转 90°',
  7: '镜像并旋转 270°',
  8: '逆时针旋转 90°',
};

/** EXIF 色彩空间值 → 名称 */
const COLOR_SPACE_LABELS = { 1: 'sRGB', 65535: '未校准' };

/**
 * 把 EXIF GPS 坐标（度分秒 + 南北/东西）换算为十进制度数。
 * ExifReader 的 value 可能是 [[分子,分母],[...],[...]] 或字符串，两种都兼容。
 */
function toDecimalGps(coord, ref) {
  if (!coord) return undefined;

  const raw = coord.value ?? coord.description;
  let parts;
  if (Array.isArray(raw)) {
    parts = raw.map(v => (Array.isArray(v) ? v[0] / (v[1] || 1) : Number(v)));
  } else if (typeof raw === 'string') {
    parts = raw.split(/[^\d.]+/).filter(Boolean).map(Number);
  }

  if (!parts || parts.length < 2 || parts.some(n => Number.isNaN(n))) return undefined;
  const [deg, min = 0, sec = 0] = parts;

  let decimal = deg + min / 60 + sec / 3600;
  if (ref === 'S' || ref === 'W') decimal = -decimal;
  return Number(decimal.toFixed(6));
}

function parseExifBuffer(buffer) {
  try {
    // eslint-disable-next-line global-require
    const ExifReader = require('exifreader');
    const tags = ExifReader.load(buffer) || {};

    let dateTaken;
    const dateOriginal = tags.DateTimeOriginal?.description || tags.DateTime?.description;
    if (dateOriginal) {
      const parts = String(dateOriginal).split(/[: ]/);
      if (parts.length >= 6) {
        const [y, m, d, h, min, s] = parts;
        const parsed = new Date(
          parseInt(y, 10),
          parseInt(m, 10) - 1,
          parseInt(d, 10),
          parseInt(h, 10),
          parseInt(min, 10),
          parseInt(s, 10)
        );
        if (!Number.isNaN(parsed.getTime())) dateTaken = parsed.getTime();
      }
    }

    const latitude = toDecimalGps(tags.GPSLatitude, tags.GPSLatitudeRef?.value ?? tags.GPSLatitudeRef);
    const longitude = toDecimalGps(tags.GPSLongitude, tags.GPSLongitudeRef?.value ?? tags.GPSLongitudeRef);
    const orientationValue = tags.Orientation ? Number(tags.Orientation.value) : undefined;

    return {
      dateTaken,
      // 原始方向值（1~8）：调用方据此换算「用户实际看到的宽高」
      orientationValue: orientationValue >= 1 && orientationValue <= 8 ? orientationValue : undefined,
      exif: {
        make: tags.Make?.description,
        model: tags.Model?.description,
        exposureTime: tags.ExposureTime?.description,
        fNumber: tags.FNumber?.description,
        iso: tags.ISOSpeedRatings?.description,
        focalLength: tags.FocalLength?.description,
        lensModel: tags.LensModel?.description,
        orientation:
          orientationValue >= 1 && orientationValue <= 8
            ? ORIENTATION_LABELS[orientationValue]
            : undefined,
        colorSpace: tags.ColorSpace
          ? COLOR_SPACE_LABELS[Number(tags.ColorSpace.value)] ?? tags.ColorSpace.description
          : undefined,
        gps: latitude !== undefined && longitude !== undefined ? { latitude, longitude } : undefined,
      },
    };
  } catch (error) {
    return { dateTaken: undefined, exif: undefined };
  }
}

/** WebP（VP8 / VP8L / VP8X）尺寸解析 */
function readWebpSize(buffer) {
  const format = buffer.toString('ascii', 12, 16);
  if (format === 'VP8 ') {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (format === 'VP8L') {
    const b0 = buffer[21];
    const b1 = buffer[22];
    const b2 = buffer[23];
    const b3 = buffer[24];
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  if (format === 'VP8X') {
    return {
      width: 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)),
      height: 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)),
    };
  }
  return null;
}

/** JPEG：定位 SOFn 段读取宽高（跳过其它段） */
function readJpegSize(buffer) {
  let offset = 2; // 跳过 SOI
  const len = buffer.length;
  while (offset + 9 < len) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // 无长度字段：TEM / RSTn / SOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    const size = buffer.readUInt16BE(offset + 2);
    // SOF0..SOF15，排除 DHT(C4) / JPG(C8) / DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    if (size < 2) return null;
    offset += 2 + size;
  }
  return null;
}

/**
 * 只从文件头解析图片尺寸。
 * 相比 nativeImage.createFromPath（会完整解码），这让元数据读取快了 1~2 个数量级，
 * 几万张的图库里这是能否流畅补齐 metadata 的关键。
 * 解析不到（HEIC / TIFF 等）时由调用方退回解码一次。
 */
function readImageSize(buffer) {
  if (!buffer || buffer.length < 30) return null;
  try {
    // PNG
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    // GIF
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    // BMP
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
      return {
        width: Math.abs(buffer.readInt32LE(18)),
        height: Math.abs(buffer.readInt32LE(22)),
      };
    }
    // WebP
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
      return readWebpSize(buffer);
    }
    // JPEG
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      return readJpegSize(buffer);
    }
  } catch {
    /* 解析失败交由调用方兜底 */
  }
  return null;
}

async function readMetadata(filePath) {
  // 视频不做图片式元数据解析：nativeImage 解不了，还要白读一大块文件头
  if (isVideoFile(filePath)) {
    return { dimensions: undefined, dateTaken: undefined, exif: undefined };
  }

  let dimensions;
  // EXIF 通常位于文件头部，先只读前 512KB；失败再退回完整读取
  let meta = { dateTaken: undefined, exif: undefined };
  try {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const { size } = await handle.stat();
      const chunk = Buffer.alloc(Math.min(512 * 1024, size));
      await handle.read(chunk, 0, chunk.length, 0);
      dimensions = readImageSize(chunk) || undefined;
      meta = parseExifBuffer(chunk);
    } finally {
      await handle.close();
    }
    if (!meta.dateTaken && !meta.exif) {
      const full = await readFile(filePath);
      if (!dimensions) dimensions = readImageSize(full) || undefined;
      meta = parseExifBuffer(full);
    }
  } catch {
    /* 忽略 */
  }

  // 头部无法解析尺寸（HEIC / TIFF 等）时，才退回完整解码一次
  if (!dimensions) {
    try {
      const image = nativeImage.createFromPath(filePath);
      dimensions = image.isEmpty() ? undefined : image.getSize();
    } catch {
      /* 忽略 */
    }
  }

  // 竖拍照片的「文件存储宽高」与「用户实际看到的宽高」相差 90°。
  // 这里统一换算成显示尺寸：网格 / 时间线的卡片比例才能与已校正方向的缩略图对齐。
  const orientation = Number(meta.orientationValue);
  if (dimensions && orientation >= 5 && orientation <= 8) {
    dimensions = { width: dimensions.height, height: dimensions.width };
  }

  return { dimensions, dateTaken: meta.dateTaken, exif: meta.exif };
}

function createWindow() {
  const bounds = savedWindowBounds();
  const shouldMaximize = currentConfig().windowMaximized === true;

  mainWindow = new BrowserWindow({
    width: bounds?.width ?? DEFAULT_WINDOW_SIZE.width,
    height: bounds?.height ?? DEFAULT_WINDOW_SIZE.height,
    ...(bounds?.x !== undefined && bounds?.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    // macOS：隐藏原生标题栏（含标题文字），仅保留内缩的红绿灯按钮，
    // 窗口拖动由渲染进程中的 -webkit-app-region: drag 区域承担。
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  if (shouldMaximize) mainWindow.maximize();

  // 加载React应用
  // 在开发模式下加载本地服务器，生产模式下加载build目录
  const startUrl = process.env.ELECTRON_START_URL || `file://${path.join(__dirname, '../dist/index.html')}`;
  mainWindow.loadURL(startUrl);

  // 开发模式下打开开发者工具
  if (process.env.ELECTRON_START_URL) {
    mainWindow.webContents.openDevTools();
  }

  // 位置 / 尺寸变化后延迟落盘（拖拽期间不写），关闭时立即写一次
  mainWindow.on('resize', schedulePersistWindowBounds);
  mainWindow.on('move', schedulePersistWindowBounds);
  mainWindow.on('close', () => {
    if (boundsSaveTimer) {
      clearTimeout(boundsSaveTimer);
      boundsSaveTimer = null;
    }
    persistWindowBounds();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 配置应用菜单
function createMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '导入图片或文件夹…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const picked = await openImportDialog();
            if (picked) mainWindow.webContents.send('import-paths', picked);
          },
        },
        {
          type: 'separator',
        },
        {
          label: '退出',
          accelerator: 'CmdOrCtrl+Q',
          click: () => app.quit(),
        },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: '重做', accelerator: 'Shift+CmdOrCtrl+Z', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: '复制', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: '粘贴', accelerator: 'CmdOrCtrl+V', role: 'paste' },
        { label: '全选', accelerator: 'CmdOrCtrl+A', role: 'selectall' },
      ],
    },
    {
      label: '设置',
      submenu: [
        {
          label: 'AI 分析设置…',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            // 由渲染进程弹出「AI 设置」弹窗（应用内配置 API Key 等）
            mainWindow?.webContents?.send('ai-open-settings');
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

/**
 * 在目录下构造不冲突的文件名：同名时依次追加 -1、-2 …
 * 用于「重命名」与「导出写盘」，绝不静默覆盖用户已有文件。
 */
function buildUniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = path.join(dir, fileName);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${counter}${ext}`);
    counter += 1;
  }
  return candidate;
}

/**
 * 两个路径是否指向同一个文件（比较 inode）。
 * 用于区分「仅修改大小写」的重命名与真正的同名冲突
 * （macOS 默认大小写不敏感，仅比较字符串会误判为冲突）。
 */
function isSameFile(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/**
 * 两个路径是否指向同一个目录（比较 inode）。
 * 用于「移动到文件夹」时识别源文件已在目标目录中（stat 跟随符号链接，
 * /var 与 /private/var 这类差异也能正确判同）。
 */
function isSameDirectory(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.isDirectory() && sb.isDirectory() && sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/**
 * 跨磁盘 / 跨卷移动：rename 抛 EXDEV 时退化为「复制成功后再删源文件」。
 * COPYFILE_EXCL 兜底保证绝不覆盖（正常路径已由 buildUniquePath 保证）。
 */
async function moveAcrossDevices(srcPath, destPath) {
  await fs.promises.copyFile(srcPath, destPath, fs.constants.COPYFILE_EXCL);
  await fs.promises.unlink(srcPath);
}

// 重命名：目标不存在直接改；目标已存在（且不是自身）时自动追加序号，绝不覆盖
ipcMain.handle('rename-file', async (event, oldPath, newPath) => {
  try {
    if (!oldPath || !newPath || typeof oldPath !== 'string' || typeof newPath !== 'string') {
      return { error: 'Invalid file path', success: false };
    }

    if (fs.existsSync(newPath) && !isSameFile(oldPath, newPath)) {
      const uniquePath = buildUniquePath(path.dirname(newPath), path.basename(newPath));
      logger.debug(`Rename conflict: ${newPath} exists, using ${uniquePath}`);
      await rename(oldPath, uniquePath);
      return { success: true, path: uniquePath, conflicted: true };
    }

    await rename(oldPath, newPath);
    logger.debug(`Renamed file: ${oldPath} -> ${newPath}`);
    return { success: true, path: newPath, conflicted: false };
  } catch (error) {
    logger.error('Error renaming file:', error);
    return { error: error.message, success: false };
  }
});

ipcMain.handle('delete-file', async (event, filePath) => {
  try {
    if (!filePath || typeof filePath !== 'string') {
      return { error: 'Invalid file path', success: false };
    }

    // Electron 官方回收站 API：跨平台、无 shell 注入风险
    await shell.trashItem(filePath);
    return { success: true, error: null };
  } catch (error) {
    logger.error('Error moving file to trash:', error);
    return { error: error.message, success: false };
  }
});

/**
 * 批量移动文件到指定文件夹（整理图库用）。
 * - 源文件已在目标目录 → 跳过（skipped + reason='same-directory'）
 * - 目标已存在同名文件 → 自动追加序号（conflicted=true），绝不覆盖
 * - 跨磁盘 / 跨卷 → 复制后删除源文件
 * 逐个串行执行：前一个落盘后后一个才能探测同名，避免批内互相覆盖。
 * 返回整体错误 + 每个文件独立结果，失败项由渲染进程组织重试。
 */
ipcMain.handle('move-files', async (event, filePaths, targetDir) => {
  if (!Array.isArray(filePaths) || typeof targetDir !== 'string' || !targetDir) {
    return { error: 'Invalid arguments', results: [] };
  }

  let targetStat;
  try {
    targetStat = await fs.promises.stat(targetDir);
  } catch {
    return { error: '目标文件夹不存在', results: [] };
  }
  if (!targetStat.isDirectory()) {
    return { error: '目标位置不是文件夹', results: [] };
  }

  const results = [];
  for (const srcPath of filePaths) {
    if (typeof srcPath !== 'string' || !srcPath) {
      results.push({ from: String(srcPath ?? ''), error: '无效的文件路径' });
      continue;
    }

    try {
      if (isSameDirectory(path.dirname(srcPath), targetDir)) {
        results.push({ from: srcPath, skipped: true, reason: 'same-directory' });
        continue;
      }

      const fileName = path.basename(srcPath);
      const destPath = buildUniquePath(targetDir, fileName);
      try {
        await rename(srcPath, destPath);
      } catch (err) {
        if (err.code === 'EXDEV') {
          await moveAcrossDevices(srcPath, destPath);
        } else {
          throw err;
        }
      }
      logger.debug(`Moved file: ${srcPath} -> ${destPath}`);
      results.push({
        from: srcPath,
        to: destPath,
        success: true,
        conflicted: destPath !== path.join(targetDir, fileName),
      });
    } catch (error) {
      logger.error('Error moving file:', error);
      results.push({ from: srcPath, error: error.message });
    }
  }

  return { success: true, results };
});

// 在访达 / 资源管理器中定位文件
ipcMain.handle('show-in-folder', async (event, filePath) => {
  try {
    if (!filePath || typeof filePath !== 'string') {
      return { error: 'Invalid file path', success: false };
    }
    shell.showItemInFolder(filePath);
    return { success: true };
  } catch (error) {
    return { error: error.message, success: false };
  }
});

// 复制图片到系统剪贴板（HEIC 先转 JPEG）
ipcMain.handle('copy-image', async (event, filePath) => {
  try {
    let image = nativeImage.createFromPath(filePath);
    if (image.isEmpty() && isHeicFile(filePath)) {
      image = nativeImage.createFromBuffer(await readHeicAsJpeg(filePath));
    }
    if (image.isEmpty()) {
      return { error: '无法读取图片', success: false };
    }
    clipboard.writeImage(image);
    return { success: true };
  } catch (error) {
    return { error: error.message, success: false };
  }
});

// 复制纯文本（如文件路径）到系统剪贴板
ipcMain.handle('copy-text', async (event, text) => {
  try {
    if (!text || typeof text !== 'string') {
      return { error: 'Invalid text', success: false };
    }
    clipboard.writeText(text);
    return { success: true };
  } catch (error) {
    return { error: error.message, success: false };
  }
});

// 用系统默认应用 / 外部编辑器打开文件
ipcMain.handle('open-path', async (event, filePath) => {
  try {
    if (!filePath || typeof filePath !== 'string') {
      return { error: 'Invalid file path', success: false };
    }
    const error = await shell.openPath(filePath);
    if (error) {
      return { error, success: false };
    }
    return { success: true };
  } catch (error) {
    return { error: error.message, success: false };
  }
});

// 写入二进制文件（base64）。同名冲突时自动追加序号，返回最终写入路径。
// 用于批量导出：渲染进程 canvas 完成格式转换后落盘。
ipcMain.handle('write-file-unique', async (event, targetDir, fileName, base64) => {
  try {
    if (!targetDir || !fileName || typeof base64 !== 'string') {
      return { error: 'Invalid arguments', success: false };
    }
    await fs.promises.access(targetDir);

    const finalPath = buildUniquePath(targetDir, fileName);
    await writeFile(finalPath, Buffer.from(base64, 'base64'));
    return { success: true, path: finalPath };
  } catch (error) {
    logger.error('Error writing file:', error);
    return { error: error.message, success: false };
  }
});

/**
 * 统一导入对话框：macOS 下 openFile + openDirectory 可同时生效，
 * 用户能在同一个面板里多选「文件 + 文件夹」。
 * openDirectory 生效时系统面板会忽略扩展名过滤，因此这里再按扩展名
 * 对直接选中的文件做一次媒体过滤；文件夹内容交给 scanDirectory 递归过滤。
 * 返回 { files, directories, ignored }；取消返回 null。
 */
async function openImportDialog() {
  const imageExts = [...IMAGE_EXTENSIONS].map((e) => e.slice(1));
  const videoExts = [...VIDEO_EXTENSIONS].map((e) => e.slice(1));
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入图片、视频或文件夹',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [
      { name: '媒体文件', extensions: [...imageExts, ...videoExts] },
      { name: '图片', extensions: imageExts },
      { name: '视频', extensions: videoExts },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  const files = [];
  const directories = [];
  let ignored = 0;
  await Promise.all(result.filePaths.map(async (filePath) => {
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.isDirectory()) directories.push(filePath);
      else if (isMediaFile(filePath)) files.push(filePath);
      else ignored += 1;
    } catch {
      ignored += 1;
    }
  }));

  return { files, directories, ignored };
}

ipcMain.handle('select-paths', async () => {
  try {
    return await openImportDialog();
  } catch (error) {
    logger.error('Error selecting paths:', error);
    return null;
  }
});

/**
 * 选择单个目标目录（与「导入」是不同语义，保持纯目录面板）。
 * options.allowCreate：macOS 下面板内允许直接「新建文件夹」（移动整理用）；
 * Windows 的目录选择器自带新建按钮，无需额外属性。
 */
ipcMain.handle('choose-directory', async (event, options) => {
  try {
    const properties = ['openDirectory'];
    if (options?.allowCreate && process.platform === 'darwin') {
      properties.push('createDirectory');
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options?.allowCreate ? '移动到文件夹' : '选择目标文件夹',
      properties,
    });
    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0];
    }
    return null;
  } catch (error) {
    logger.error('Error choosing directory:', error);
    return null;
  }
});

// 读取文件为 base64（供 AI 分析与「原格式」导出使用）。
// HEIC/HEIF 与缩略图 / pm:// 协议共用同一份带缓存的转换，避免重复解码。
ipcMain.handle('read-file', async (event, filePath) => {
  try {
    if (!filePath || typeof filePath !== 'string') {
      return { error: 'Invalid file path' };
    }
    if (isHeicFile(filePath)) {
      const jpeg = await readHeicAsJpeg(filePath);
      return { data: jpeg.toString('base64') };
    }
    const data = await readFile(filePath);
    return { data: data.toString('base64') };
  } catch (error) {
    return { error: error.message };
  }
});

// ---------------------------------------------------------------------------
// 感知哈希（dHash）：在主进程计算，避免渲染进程用 canvas 解码阻塞 UI
// ---------------------------------------------------------------------------
const imageHashCache = new Map();
const HASH_CACHE_LIMIT = 50000;
/** 触发清理后保留的比例：逐项淘汰最久未用的，而不是整表清空（整表清空会造成一次明显的卡顿尖峰） */
const HASH_CACHE_KEEP_RATIO = 0.7;

/** 读取并刷新为最近使用（Map 迭代顺序 = 插入顺序） */
function hashCacheGet(key) {
  if (!imageHashCache.has(key)) return undefined;
  const value = imageHashCache.get(key);
  imageHashCache.delete(key);
  imageHashCache.set(key, value);
  return value;
}

function hashCacheSet(key, value) {
  imageHashCache.set(key, value);
  if (imageHashCache.size <= HASH_CACHE_LIMIT) return;
  const keep = Math.floor(HASH_CACHE_LIMIT * HASH_CACHE_KEEP_RATIO);
  const it = imageHashCache.keys();
  while (imageHashCache.size > keep) {
    const next = it.next();
    if (next.done) break;
    imageHashCache.delete(next.value);
  }
}

/** 内存吃紧时由看门狗调用：大幅裁剪指纹缓存 */
function trimHashCache(keepRatio = 0.25) {
  const keep = Math.floor(imageHashCache.size * keepRatio);
  const it = imageHashCache.keys();
  while (imageHashCache.size > keep) {
    const next = it.next();
    if (next.done) break;
    imageHashCache.delete(next.value);
  }
}

/** bitmap 为 BGRA 排列；返回 64 bit 十六进制哈希 */
function dHashFromBitmap(bitmap, width, height) {
  const expected = width * height * 4;
  if (!bitmap || bitmap.length < expected) return null;

  const gray = new Float64Array(width * height);
  for (let i = 0, p = 0; i < expected; i += 4, p += 1) {
    gray[p] = 0.299 * bitmap[i + 2] + 0.587 * bitmap[i + 1] + 0.114 * bitmap[i];
  }

  const bits = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const idx = y * width + x;
      bits.push(gray[idx] > gray[idx + 1] ? 1 : 0);
    }
  }

  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += (bits[i] * 8 + bits[i + 1] * 4 + bits[i + 2] * 2 + bits[i + 3]).toString(16);
  }
  return hex;
}

async function computeImageHash(filePath) {
  // 重复检测只针对图片：视频逐帧比对既慢又无意义
  if (isVideoFile(filePath)) return null;

  let stats;
  try {
    stats = await stat(filePath);
  } catch {
    return null;
  }

  const cacheKey = `${filePath}|${stats.size}|${Math.floor(stats.mtimeMs)}`;
  if (imageHashCache.has(cacheKey)) return hashCacheGet(cacheKey);

  return hashLimiter(async () => {
    if (imageHashCache.has(cacheKey)) return hashCacheGet(cacheKey);

    try {
      // 优先用已落盘的缩略图（解码成本远低于整张原图，HEIC 尤其明显）
      let image = null;
      for (const size of THUMB_SIZE_STEPS) {
        const thumbKey = thumbCacheKey(filePath, stats, size);
        if (!thumbKeySet.has(thumbKey)) continue;
        const candidate = nativeImage.createFromPath(path.join(getThumbDir(), `${thumbKey}.jpg`));
        if (!candidate.isEmpty()) {
          image = candidate;
          break;
        }
      }

      if (!image) {
        image = nativeImage.createFromPath(filePath);
        if (image.isEmpty() && isHeicFile(filePath)) {
          image = nativeImage.createFromBuffer(await readHeicAsJpeg(filePath));
        }
      }
      if (image.isEmpty()) return null;

      // 9x8 → 每行 8 次相邻比较 → 64 bit
      const resized = image.resize({ width: 9, height: 8, quality: 'good' });
      const hash = dHashFromBitmap(resized.toBitmap(), 9, 8);
      if (hash) hashCacheSet(cacheKey, hash);
      return hash;
    } catch {
      return null;
    }
  });
}

// ---------------------------------------------------------------------------
// pm:// 协议：thumb = 磁盘缩略图，file = 原图 / 原视频（HEIC 自动转 JPEG）
// ---------------------------------------------------------------------------

/**
 * 以「流」的方式返回磁盘文件，并实现 HTTP Range 语义。
 * <video> 依赖 206 Partial Content 才能拖动进度条 / 边下边播，
 * 直接把整个视频读进内存既无法 seek，也会让大文件撑爆主进程。
 */
async function streamFileResponse(request, filePath) {
  const stats = await stat(filePath);
  const total = stats.size;
  const baseHeaders = {
    'Content-Type': mimeTypeFor(filePath),
    'Cache-Control': 'max-age=3600',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    'Accept-Ranges': 'bytes',
  };

  const rangeHeader = request.headers.get('range');
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
    if (match) {
      let start = match[1] === '' ? null : Number(match[1]);
      let end = match[2] === '' ? null : Number(match[2]);

      if (start === null && end === null) {
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${total}` },
        });
      }

      if (start === null) {
        // 后缀区间：最后 N 字节
        const suffix = Math.min(end, total);
        start = total - suffix;
        end = total - 1;
      } else if (end === null || end >= total) {
        end = total - 1;
      }

      if (start > end || start >= total || start < 0) {
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${total}` },
        });
      }

      const stream = fs.createReadStream(filePath, { start, end });
      return new Response(Readable.toWeb(stream), {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': String(end - start + 1),
        },
      });
    }
  }

  const stream = fs.createReadStream(filePath);
  return new Response(Readable.toWeb(stream), {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(total) },
  });
}

function setupProtocol() {
  protocol.handle('pm', async (request) => {
    try {
      const url = new URL(request.url);
      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const [kind, payload] = segments;

      if (kind === 'thumb' && payload) {
        const filePath = path.join(getThumbDir(), path.basename(payload));
        const data = await readFile(filePath);
        return new Response(data, {
          headers: {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'max-age=31536000, immutable',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      if (kind === 'file' && payload) {
        const filePath = Buffer.from(payload, 'base64url').toString('utf8');

        // HEIC 走转换缓存，避免每次打开大图都重新解码
        if (isHeicFile(filePath)) {
          const jpeg = await readHeicAsJpeg(filePath);
          return new Response(jpeg, {
            headers: {
              'Content-Type': 'image/jpeg',
              'Cache-Control': 'max-age=3600',
              'Access-Control-Allow-Origin': '*',
            },
          });
        }

        return await streamFileResponse(request, filePath);
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      return new Response(String(error && error.message ? error.message : error), { status: 500 });
    }
  });
}

// 扫描目录（递归，返回图片文件清单）
ipcMain.handle('scan-directory', async (event, dirPath, scanId) => {
  try {
    return await scanDirectory(dirPath, scanId);
  } catch (error) {
    logger.error('Error scanning directory:', error);
    return [];
  }
});

// 取消进行中的目录扫描（用户中途放弃添加时调用）
ipcMain.handle('cancel-scan', async (event, scanId) => {
  if (typeof scanId === 'string' && scanId.length > 0) {
    activeScans.delete(scanId);
  }
  return true;
});

// 生成/命中磁盘缩略图，返回 pm:// 地址
ipcMain.handle('get-thumbnail', async (event, filePath, maxSize) => {
  try {
    const url = await ensureThumbnail(filePath, maxSize || 320);
    // 视频首帧需由渲染进程抓取：pending 表示「暂无缓存，请生成后回写」
    if (!url) return { url: null, pending: true };
    return { url };
  } catch (error) {
    return { error: error.message };
  }
});

// 回写渲染进程抓取的视频首帧（key 与 get-thumbnail 一致，命中即永久复用）
ipcMain.handle('cache-thumbnail', async (event, filePath, maxSize, base64) => {
  try {
    if (!filePath || typeof base64 !== 'string' || !base64) {
      return { error: 'Invalid arguments' };
    }
    const url = await cacheThumbnail(filePath, maxSize || 320, base64);
    return { url };
  } catch (error) {
    return { error: error.message };
  }
});

// 一次读取同时返回尺寸 + EXIF + 拍摄时间
ipcMain.handle('get-metadata', async (event, filePath) => {
  try {
    return await metaLimiter(() => readMetadata(filePath));
  } catch (error) {
    return { error: error.message };
  }
});

// 批量计算感知哈希（主进程并发受控 + 内存缓存，不阻塞渲染进程）
ipcMain.handle('get-image-hashes', async (event, filePaths) => {
  const list = Array.isArray(filePaths) ? filePaths : [];
  try {
    return await Promise.all(list.map(filePath => computeImageHash(filePath)));
  } catch (error) {
    return list.map(() => null);
  }
});

// 批量获取文件信息（用于拖放/单文件选择时补齐 size/mtime）
ipcMain.handle('stat-files', async (event, filePaths) => {
  try {
    const list = Array.isArray(filePaths) ? filePaths : [];
    const result = await Promise.all(
      list.map(async (filePath) => {
        try {
          const s = await stat(filePath);
          return {
            path: filePath,
            name: path.basename(filePath),
            size: s.size,
            mtime: s.mtimeMs,
            created: s.birthtimeMs || s.ctimeMs || 0,
          };
        } catch {
          return null;
        }
      })
    );
    return result.filter(Boolean);
  } catch (error) {
    return [];
  }
});

// ---------------------------------------------------------------------------
// 本地 JSON 存储
// - config.json：收藏 / 隐藏 / 标签 / 时间修正 / 智能相簿 / 视图偏好 / 窗口尺寸
// - ai-cache.json：AI 分析结果（体量较大，单独成文件便于限量与清理）
// - ai-config.json：AI 服务配置（API Key / Base URL / 模型），由应用内「AI 设置」写入
// 都先写临时文件再 rename（原子替换），避免写入中途被打断而损坏整个文件。
// ---------------------------------------------------------------------------
const STORE_CONFIG = 'config.json';
const STORE_AI_CACHE = 'ai-cache.json';
const STORE_AI_CONFIG = 'ai-config.json';

/** fileName → 解析后的对象（内存缓存，避免每次读盘） */
const storeCache = new Map();

function storePath(fileName) {
  return path.join(app.getPath('userData'), fileName);
}

async function readStore(fileName) {
  if (storeCache.has(fileName)) return storeCache.get(fileName);

  let data = {};
  try {
    const raw = await readFile(storePath(fileName), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') data = parsed;
  } catch {
    // 首次运行或文件损坏：从空存储开始，不阻塞启动
  }
  storeCache.set(fileName, data);
  return data;
}

async function writeStore(fileName) {
  const target = storePath(fileName);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(storeCache.get(fileName) ?? {}, null, 2), 'utf8');
  await rename(tmp, target);
}

async function mergeStore(fileName, patch) {
  if (!patch || typeof patch !== 'object') return false;
  const store = await readStore(fileName);
  Object.assign(store, patch);
  await writeStore(fileName);
  return true;
}

/** 同步读取已加载的配置（窗口尺寸等主进程内部数据用） */
function currentConfig() {
  return storeCache.get(STORE_CONFIG) ?? {};
}

ipcMain.handle('load-config', async () => {
  try {
    return await readStore(STORE_CONFIG);
  } catch (error) {
    logger.warn('Failed to load config:', error.message);
    return {};
  }
});

// 每次保存都直接落盘：写入量很小，但「改完就退出」不应丢数据
ipcMain.handle('save-config', async (event, patch) => {
  try {
    return await mergeStore(STORE_CONFIG, patch);
  } catch (error) {
    logger.warn('Failed to persist config:', error.message);
    return false;
  }
});

ipcMain.handle('load-ai-cache', async () => {
  try {
    return await readStore(STORE_AI_CACHE);
  } catch (error) {
    logger.warn('Failed to load AI cache:', error.message);
    return {};
  }
});

// AI 结果由渲染进程整体维护（含条数上限），这里直接替换 entries
ipcMain.handle('save-ai-cache', async (event, entries) => {
  try {
    return await mergeStore(STORE_AI_CACHE, { version: 1, entries });
  } catch (error) {
    logger.warn('Failed to persist AI cache:', error.message);
    return false;
  }
});

// ---------------------------------------------------------------------------
// AI 图片分析（DeepSeek 视觉模型）
// 由主进程代理：渲染进程只发送 base64，API Key 不出主进程，
// 同时规避渲染进程直连第三方接口时的 CORS 限制。
// ---------------------------------------------------------------------------
const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-flash';
/** 单次分析超时（毫秒） */
const AI_REQUEST_TIMEOUT = 60_000;
/** 「测试连接」的超时：只是校验密钥 / 地址，不必等满整轮分析 */
const AI_TEST_TIMEOUT = 20_000;

/**
 * 解析最终生效的 AI 配置。
 * 优先级：应用内「AI 设置」保存的值 > 环境变量（.env.local / 系统环境变量 / userData/ai.env）> 内置默认值。
 * 应用内设置为空时自动回退到环境变量，便于「只想改模型，密钥仍走 .env.local」。
 */
function resolveAiConfig() {
  const stored = storeCache.get(STORE_AI_CONFIG) ?? {};
  const storedKey = typeof stored.apiKey === 'string' ? stored.apiKey.trim() : '';
  const envKey = (process.env.DEEPSEEK_API_KEY || '').trim();

  const storedBaseUrl = typeof stored.baseUrl === 'string' ? stored.baseUrl.trim() : '';
  const storedModel = typeof stored.model === 'string' ? stored.model.trim() : '';

  return {
    apiKey: storedKey || envKey,
    baseUrl: (storedBaseUrl || process.env.DEEPSEEK_BASE_URL || DEEPSEEK_DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: storedModel || process.env.DEEPSEEK_MODEL || DEEPSEEK_DEFAULT_MODEL,
    /** 密钥来源：应用内设置 / 环境变量 / 未配置 */
    keySource: storedKey ? 'settings' : envKey ? 'env' : 'none',
  };
}

/** Prompt 必须包含 "json" 字样与格式示例，否则 json_object 模式可能不生效 */
const AI_PROMPT = [
  'Analyze this image. Provide a concise description (max 2 sentences) and a list of 5 relevant tags.',
  'Respond with a JSON object only, following exactly this shape:',
  '{"description": "...", "tags": ["...", "...", "...", "...", "..."]}',
].join('\n');

/** 从模型返回文本中提取描述与标签；宽容处理 ```json 围栏与多余前后缀 */
function parseAnalysisContent(content) {
  let text = String(content ?? '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced) text = fenced[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  const description =
    typeof parsed?.description === 'string' && parsed.description.trim()
      ? parsed.description.trim()
      : undefined;
  const tags = Array.isArray(parsed?.tags)
    ? parsed.tags
        .filter((tag) => typeof tag === 'string' && tag.trim())
        .map((tag) => tag.trim())
    : undefined;

  if (!description && (!tags || tags.length === 0)) return null;
  return { description, tags };
}

async function analyzeImageWithDeepSeek(base64, mimeType) {
  const { apiKey, baseUrl, model } = resolveAiConfig();
  if (!apiKey) {
    throw new Error('未配置 DeepSeek API Key。请在详情面板「AI 设置」中填写，或通过 .env.local / 系统环境变量配置。');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: AI_PROMPT },
              {
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'low' },
              },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 512,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`DeepSeek 请求失败（${response.status}）：${detail.slice(0, 300)}`);
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) throw new Error('DeepSeek 返回空内容');
    return parseAnalysisContent(content);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('DeepSeek 请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// 渲染进程提交 base64，主进程完成请求并返回「描述 + 标签」
ipcMain.handle('ai-analyze', async (event, payload) => {
  const base64 = payload?.base64;
  const mimeType = payload?.mimeType;
  if (!base64 || typeof base64 !== 'string') {
    return { error: '缺少图片数据' };
  }

  try {
    const result = await analyzeImageWithDeepSeek(
      base64,
      typeof mimeType === 'string' && mimeType ? mimeType : 'image/jpeg'
    );
    return { result };
  } catch (error) {
    logger.error('DeepSeek analysis failed:', error);
    return { error: error.message };
  }
});

// 读取当前生效的 AI 配置（供应用内「AI 设置」回显）
ipcMain.handle('ai-config-get', async () => {
  const { apiKey, baseUrl, model, keySource } = resolveAiConfig();
  return {
    apiKey,
    baseUrl,
    model,
    keySource,
    defaults: { baseUrl: DEEPSEEK_DEFAULT_BASE_URL, model: DEEPSEEK_DEFAULT_MODEL },
  };
});

// 保存 AI 配置：只接受字符串字段，空串表示「清除该覆盖项，回退到环境变量 / 默认值」
ipcMain.handle('ai-config-set', async (event, patch) => {
  try {
    const clean = {};
    if (patch && typeof patch.apiKey === 'string') clean.apiKey = patch.apiKey.trim();
    if (patch && typeof patch.baseUrl === 'string') clean.baseUrl = patch.baseUrl.trim();
    if (patch && typeof patch.model === 'string') clean.model = patch.model.trim();
    if (Object.keys(clean).length === 0) return { success: false, error: '没有可保存的内容' };

    await mergeStore(STORE_AI_CONFIG, clean);
    const { keySource } = resolveAiConfig();
    return { success: true, keySource };
  } catch (error) {
    logger.warn('Failed to persist AI config:', error.message);
    return { success: false, error: error.message };
  }
});

/**
 * 测试连接：用最省的一次对话请求校验「密钥 + 地址 + 模型」是否可用。
 * 支持传入尚未保存的草稿值，方便「先测通再保存」。
 */
ipcMain.handle('ai-config-test', async (event, draft) => {
  const current = resolveAiConfig();
  const pick = (value, fallback) =>
    typeof value === 'string' && value.trim() ? value.trim() : fallback;

  const apiKey = pick(draft?.apiKey, current.apiKey);
  const baseUrl = pick(draft?.baseUrl, current.baseUrl).replace(/\/+$/, '');
  const model = pick(draft?.model, current.model);

  if (!apiKey) return { ok: false, error: '请先填写 API Key' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TEST_TIMEOUT);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        ok: false,
        error: `请求失败（${response.status}）：${detail.slice(0, 300)}`,
      };
    }
    return { ok: true, model };
  } catch (error) {
    if (error.name === 'AbortError') return { ok: false, error: '连接超时' };
    return { ok: false, error: error.message };
  } finally {
    clearTimeout(timer);
  }
});

// ---------------------------------------------------------------------------
// 窗口尺寸记忆：下次启动回到上次的位置与大小
// 多屏保护：显示器拔掉后旧坐标可能落在屏幕外，此时只保留尺寸、位置交给系统默认。
// ---------------------------------------------------------------------------
const DEFAULT_WINDOW_SIZE = { width: 1240, height: 820 };
const MIN_WINDOW_SIZE = { width: 940, height: 620 };
/** 判定「窗口在某个显示器上可见」所需的最小重叠面积 */
const MIN_VISIBLE_OVERLAP = { x: 120, y: 90 };

function savedWindowBounds() {
  const saved = currentConfig().windowBounds;
  if (!saved || typeof saved !== 'object') return null;

  const width = Number(saved.width);
  const height = Number(saved.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;

  const bounds = {
    width: Math.max(MIN_WINDOW_SIZE.width, Math.round(width)),
    height: Math.max(MIN_WINDOW_SIZE.height, Math.round(height)),
  };

  const x = Number(saved.x);
  const y = Number(saved.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return bounds;
  if (!isVisibleOnSomeDisplay({ x, y, ...bounds })) return bounds;

  return { ...bounds, x: Math.round(x), y: Math.round(y) };
}

function isVisibleOnSomeDisplay(bounds) {
  try {
    const { screen } = require('electron');
    return screen.getAllDisplays().some((display) => {
      const area = display.workArea;
      const overlapX = Math.max(
        0,
        Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
      );
      const overlapY = Math.max(
        0,
        Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y)
      );
      return overlapX >= MIN_VISIBLE_OVERLAP.x && overlapY >= MIN_VISIBLE_OVERLAP.y;
    });
  } catch {
    // 拿不到显示器信息时不做判断，避免误丢弃用户的位置
    return true;
  }
}

let boundsSaveTimer = null;

/** 记录当前窗口状态；最大化时只记「已最大化」，不用最大化尺寸覆盖常规尺寸 */
function persistWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const config = currentConfig();
  if (mainWindow.isMaximized() || mainWindow.isFullScreen()) {
    config.windowMaximized = true;
  } else {
    config.windowBounds = mainWindow.getBounds();
    config.windowMaximized = false;
  }

  void writeStore(STORE_CONFIG).catch((error) => {
    logger.warn('Failed to persist window bounds:', error.message);
  });
}

function schedulePersistWindowBounds() {
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(() => {
    boundsSaveTimer = null;
    persistWindowBounds();
  }, 600);
  boundsSaveTimer.unref?.();
}

// ---------------------------------------------------------------------------
// 内存看门狗
// 主进程持有磁盘缩略图与感知哈希，通常比渲染进程更早感知到整机内存吃紧。
// 触发时先自行裁剪常驻缓存，再广播给渲染进程做统一释放。
// ---------------------------------------------------------------------------
const MEMORY_WATCH_INTERVAL = 60_000;
/** 1.2GB 起软性回收（裁缓存），2GB 起硬性回收（清空易失缓存） */
const MEMORY_SOFT_RSS = 1.2 * 1024 * 1024 * 1024;
const MEMORY_HARD_RSS = 2 * 1024 * 1024 * 1024;
/** 广播冷却：避免高压期间每 60s 都打断渲染进程 */
const MEMORY_NOTIFY_COOLDOWN = 120_000;
let lastMemoryNotifyAt = 0;

function startMemoryWatchdog() {
  const timer = setInterval(() => {
    let usage;
    try {
      usage = process.memoryUsage();
    } catch {
      return;
    }

    const rss = usage.rss || 0;
    if (rss < MEMORY_SOFT_RSS) return;

    const level = rss >= MEMORY_HARD_RSS ? 'hard' : 'soft';
    // 先自己瘦身：感知哈希是主进程里最容易只增不减的常驻缓存
    trimHashCache(level === 'hard' ? 0.25 : 0.6);
    if (level === 'hard') scheduleThumbPrune();

    const now = Date.now();
    if (now - lastMemoryNotifyAt < MEMORY_NOTIFY_COOLDOWN) return;
    lastMemoryNotifyAt = now;

    logger.warn(`[memory] pressure(${level}) rss=${Math.round(rss / 1048576)}MB`);
    try {
      mainWindow?.webContents?.send('memory-pressure', level);
    } catch {
      /* 窗口已关闭 */
    }
  }, MEMORY_WATCH_INTERVAL);
  timer.unref?.();
  return timer;
}

app.on('ready', () => {
  setupProtocol();
  pruneThumbCache().then(loadThumbKeys);
  createMenu();
  startMemoryWatchdog();
  // 配置里含窗口尺寸与最大化状态：先读完再建窗口，避免启动时窗口跳一下。
  // AI 配置也一并预读：resolveAiConfig 走内存缓存，首次分析时才不会漏掉应用内设置。
  Promise.all([
    readStore(STORE_CONFIG).catch(() => ({})),
    readStore(STORE_AI_CONFIG).catch(() => ({})),
  ]).then(() => createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
