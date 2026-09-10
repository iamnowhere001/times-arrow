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
const logger = require('./logger.cjs');

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

const isHeicFile = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.heic' || ext === '.heif';
};

const isVideoFile = (filePath) => VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());

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

async function buildThumbBuffer(filePath, maxSize) {
  let image = nativeImage.createFromPath(filePath);

  // HEIC/HEIF 等 nativeImage 无法直接解码的格式，先转成 JPEG（带缓存）
  if (image.isEmpty() && isHeicFile(filePath)) {
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
  const resized =
    ratio < 1
      ? image.resize({
          width: Math.max(1, Math.round(width * ratio)),
          height: Math.max(1, Math.round(height * ratio)),
          quality: 'good',
        })
      : image;

  return resized.toJPEG(80);
}

/** 缩略图缓存的 key（与 ensureThumbnail / 感知哈希复用同一套命名） */
function thumbCacheKey(filePath, stats, maxSize) {
  return crypto
    .createHash('sha1')
    .update(`${filePath}|${stats.size}|${Math.floor(stats.mtimeMs)}|${maxSize}`)
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

    return {
      dateTaken,
      exif: {
        make: tags.Make?.description,
        model: tags.Model?.description,
        exposureTime: tags.ExposureTime?.description,
        fNumber: tags.FNumber?.description,
        iso: tags.ISOSpeedRatings?.description,
        focalLength: tags.FocalLength?.description,
        lensModel: tags.LensModel?.description,
        orientation: tags.Orientation ? ORIENTATION_LABELS[Number(tags.Orientation.value)] : undefined,
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

  return { dimensions, dateTaken: meta.dateTaken, exif: meta.exif };
}

function createWindow() {
  const bounds = savedWindowBounds();
  const shouldMaximize = currentConfig().windowMaximized === true;

  mainWindow = new BrowserWindow({
    width: bounds?.width ?? DEFAULT_WINDOW_SIZE.width,
    height: bounds?.height ?? DEFAULT_WINDOW_SIZE.height,
    ...(bounds?.x !== undefined && bounds?.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
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
  const startUrl = process.env.ELECTRON_START_URL || `file://${path.join(__dirname, '/dist/index.html')}`;
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
          label: '打开目录',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              properties: ['openDirectory'],
            });
            if (!result.canceled && result.filePaths.length > 0) {
              mainWindow.webContents.send('directory-selected', result.filePaths[0]);
            }
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

ipcMain.handle('select-directory', async (event) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'multiSelections'],
    });
    
    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths;
    }
    return null;
  } catch (error) {
    logger.error('Error selecting directory:', error);
    return null;
  }
});

ipcMain.handle('select-files', async (event) => {
  try {
    const imageExts = [...IMAGE_EXTENSIONS].map((e) => e.slice(1));
    const videoExts = [...VIDEO_EXTENSIONS].map((e) => e.slice(1));
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '媒体文件', extensions: [...imageExts, ...videoExts] },
        { name: '图片', extensions: imageExts },
        { name: '视频', extensions: videoExts },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    
    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths;
    }
    return null;
  } catch (error) {
    logger.error('Error selecting files:', error);
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
// 两者都先写临时文件再 rename（原子替换），避免写入中途被打断而损坏整个文件。
// ---------------------------------------------------------------------------
const STORE_CONFIG = 'config.json';
const STORE_AI_CACHE = 'ai-cache.json';

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
  // 配置里含窗口尺寸与最大化状态：先读完再建窗口，避免启动时窗口跳一下
  readStore(STORE_CONFIG)
    .catch(() => ({}))
    .then(() => createWindow());
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
