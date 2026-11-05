'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
// dHash 算法本体的唯一定义处：与渲染层共用，避免同一算法两份实现互相漂移
const { dHashFromBGRA } = require('../lib/dhash.cjs');

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);

function createMediaPipeline({
  userDataDir,
  nativeImage,
  logger,
  authorizeRoot,
  isPathAuthorized,
  UNAUTHORIZED_ERROR,
}) {
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
    '.jpg',
    '.jpeg',
    '.png',
    '.gif',
    '.webp',
    '.svg',
    '.heic',
    '.heif',
    '.avif',
    '.bmp',
    '.tif',
    '.tiff',
  ]);

  // 常见视频容器。Chromium 原生可解码的主要是 mp4/m4v/mov(H.264)/webm/ogv，
  // 其余格式仍可导入与整理（重命名 / 删除 / 在访达中显示），能否播放取决于内置编解码器。
  const VIDEO_EXTENSIONS = new Set([
    '.mp4',
    '.m4v',
    '.mov',
    '.webm',
    '.ogv',
    '.ogg',
    '.mkv',
    '.avi',
    '.wmv',
    '.flv',
    '.3gp',
    '.3g2',
    '.mpeg',
    '.mpg',
    '.m2ts',
    '.mts',
    '.ts',
    '.asf',
    '.rm',
    '.rmvb',
    '.vob',
    '.f4v',
    '.divx',
    '.dv',
    '.mxf',
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
      thumbDir = path.join(userDataDir, 'thumbnails');
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
        entries.map((name) =>
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
        // 惰性加载：exifreader 体积不小，只在真的解析 EXIF 时才拉起来
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
          case 2:
            sx = width - 1 - x;
            sy = y;
            break;
          case 3:
            sx = width - 1 - x;
            sy = height - 1 - y;
            break;
          case 4:
            sx = x;
            sy = height - 1 - y;
            break;
          case 5:
            sx = y;
            sy = x;
            break;
          case 6:
            sx = y;
            sy = height - 1 - x;
            break;
          case 7:
            sx = width - 1 - y;
            sy = height - 1 - x;
            break;
          case 8:
            sx = width - 1 - y;
            sy = x;
            break;
          default:
            sx = x;
            sy = y;
            break;
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
      .update(
        `${THUMB_RENDER_VERSION}|${filePath}|${stats.size}|${Math.floor(stats.mtimeMs)}|${maxSize}`
      )
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
    // K1：无法读取的目录 / 文件不再静默吞掉，计数后随结果返回，
    // 渲染层据此区分「目录为空」与「部分内容无法读取」
    let failedDirs = 0;
    let failedFiles = 0;

    try {
      // 目录遍历本身是串行的：每层都要先 realpath 去重、再 readdir 才知道下一层。
      // 目录内的条目 stat 已经用 Promise.all 并发（见下方 pending），这里不必再并行。
      /* eslint-disable no-await-in-loop */
      while (stack.length > 0 && !isCancelled()) {
        const { dir, depth } = stack.pop();
        if (depth > MAX_SCAN_DEPTH) continue;

        let realDir;
        try {
          realDir = await fs.promises.realpath(dir);
        } catch {
          failedDirs += 1;
          continue;
        }
        if (visited.has(realDir)) continue;
        visited.add(realDir);

        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          failedDirs += 1;
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
                failedFiles += 1;
                return null;
              }
            })
          );
        }
      }
      /* eslint-enable no-await-in-loop */

      if (isCancelled()) return { files: [], cancelled: true };

      const settled = await Promise.all(pending);
      return {
        files: settled.filter(Boolean),
        ...(failedDirs > 0 ? { failedDirs } : null),
        ...(failedFiles > 0 ? { failedFiles } : null),
      };
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
      parts = raw.map((v) => (Array.isArray(v) ? v[0] / (v[1] || 1) : Number(v)));
    } else if (typeof raw === 'string') {
      parts = raw
        .split(/[^\d.]+/)
        .filter(Boolean)
        .map(Number);
    }

    if (!parts || parts.length < 2 || parts.some((n) => Number.isNaN(n))) return undefined;
    const [deg, min = 0, sec = 0] = parts;

    let decimal = deg + min / 60 + sec / 3600;
    if (ref === 'S' || ref === 'W') decimal = -decimal;
    return Number(decimal.toFixed(6));
  }

  function parseExifBuffer(buffer) {
    try {
      // 惰性加载：只在真的解析 EXIF 时才把 exifreader 拉起来
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

      const latitude = toDecimalGps(
        tags.GPSLatitude,
        tags.GPSLatitudeRef?.value ?? tags.GPSLatitudeRef
      );
      const longitude = toDecimalGps(
        tags.GPSLongitude,
        tags.GPSLongitudeRef?.value ?? tags.GPSLongitudeRef
      );
      const orientationValue = tags.Orientation ? Number(tags.Orientation.value) : undefined;

      return {
        dateTaken,
        // 原始方向值（1~8）：调用方据此换算「用户实际看到的宽高」
        orientationValue:
          orientationValue >= 1 && orientationValue <= 8 ? orientationValue : undefined,
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
            ? (COLOR_SPACE_LABELS[Number(tags.ColorSpace.value)] ?? tags.ColorSpace.description)
            : undefined,
          gps:
            latitude !== undefined && longitude !== undefined ? { latitude, longitude } : undefined,
        },
      };
    } catch {
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
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
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

  // ---------------------------------------------------------------------------
  // 感知哈希（dHash）：在主进程计算，避免渲染进程用 canvas 解码阻塞 UI
  // 算法本体在 ./lib/dhash.cjs —— 与渲染层共用同一份实现，避免两处漂移（见该文件注释）
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

  /**
   * 由 bitmap 计算 dHash。
   *
   * 算法本身已收敛到 ./lib/dhash.cjs，这里只是把 Electron 的 BGRA 排布转交过去。
   * 保留这个薄封装而不是让调用点直接用 dHashFromBGRA，是为了让「主进程用哪种排布」
   * 这个知识只出现在一处。
   */
  function dHashFromBitmap(bitmap, width, height) {
    return dHashFromBGRA(bitmap, width, height);
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

  function registerMediaPipelineIpc({ handle, ok, fail }) {
    // 扫描目录（递归，返回图片文件清单）
    // K1：根目录不可访问时明确报错，部分子项失败以 failedDirs / failedFiles 计数返回，
    // 不再吞错伪装成「空目录」，渲染层可区分「为空 / 无权限 / 部分失败」
    handle('scan-directory', async (event, dirPath, scanId) => {
      const rootStat = await stat(dirPath);
      if (!rootStat.isDirectory()) {
        return fail('路径不是文件夹', 'ENOTDIR');
      }
      // 扫描即授权：目录内容随后会经由 pm://file 与各文件类 IPC 访问
      authorizeRoot(dirPath);
      return ok(await scanDirectory(dirPath, scanId));
    });

    // 取消进行中的目录扫描（用户中途放弃添加时调用）
    handle('cancel-scan', async (event, scanId) => {
      if (typeof scanId === 'string' && scanId.length > 0) {
        activeScans.delete(scanId);
      }
      return ok(true);
    });

    // 生成/命中磁盘缩略图，返回 pm:// 地址
    handle('get-thumbnail', async (event, filePath, maxSize) => {
      if (!isPathAuthorized(filePath)) {
        return fail(UNAUTHORIZED_ERROR);
      }
      const url = await ensureThumbnail(filePath, maxSize || 320);
      // 视频首帧需由渲染进程抓取：pending 表示「暂无缓存，请生成后回写」
      if (!url) return ok({ url: null, pending: true });
      return ok({ url });
    });

    // 回写渲染进程抓取的视频首帧（key 与 get-thumbnail 一致，命中即永久复用）
    handle('cache-thumbnail', async (event, filePath, maxSize, base64) => {
      if (!filePath || typeof base64 !== 'string' || !base64) {
        return fail('无效的参数');
      }
      if (!isPathAuthorized(filePath)) {
        return fail(UNAUTHORIZED_ERROR);
      }
      const url = await cacheThumbnail(filePath, maxSize || 320, base64);
      return ok({ url });
    });

    // 一次读取同时返回尺寸 + EXIF + 拍摄时间
    handle('get-metadata', async (event, filePath) => {
      if (!isPathAuthorized(filePath)) {
        return fail(UNAUTHORIZED_ERROR);
      }
      return ok(await metaLimiter(() => readMetadata(filePath)));
    });

    // 批量计算感知哈希（主进程并发受控 + 内存缓存，不阻塞渲染进程）
    // 未授权的路径按「算不出」返回 null，与解码失败同一条降级路径（不额外暴露路径是否存在）
    handle('get-image-hashes', async (event, filePaths) => {
      const list = Array.isArray(filePaths) ? filePaths : [];
      const hashes = await Promise.all(
        list.map((filePath) =>
          isPathAuthorized(filePath) ? computeImageHash(filePath) : Promise.resolve(null)
        )
      );
      // 单项解码失败降级为 null，整体不失败 —— 哈希算不出来不该让整批重复检测停摆
      return ok(hashes);
    });
  }

  return {
    IMAGE_EXTENSIONS,
    VIDEO_EXTENSIONS,
    isHeicFile,
    isVideoFile,
    isMediaFile,
    mimeTypeFor,
    readHeicAsJpeg,
    getThumbDir,
    pruneThumbCache,
    loadThumbKeys,
    trimHashCache,
    scheduleThumbPrune,
    scanDirectory,
    ensureThumbnail,
    cacheThumbnail,
    readMetadata,
    computeImageHash,
    registerMediaPipelineIpc,
  };
}

module.exports = { createMediaPipeline };
