/**
 * 对话框与路径类 IPC：导入、选择目录、路径授权、stat、读文件。
 *
 * ## 这个模块真正的职责是「授权入口」
 *
 * 会话级白名单只有 6 个入口能产生授权，其中 4 个在这里：
 * 导入对话框、选择目录、监听目录（在 watch.cjs）、路径探测（`check-paths`）、
 * 拖放授权（`authorize-paths`）。另外两个是扫描目录与拖放后补 stat。
 *
 * 因此**新增任何「接收路径」的入口前先想清楚**：它是不是又一个隐式信任源。
 * 每多一个，安全边界就薄一层（见 docs/decisions.md ADR-004）。
 *
 * ## read-file 的闸门为什么放在读取之前
 *
 * base64 会把体积再放大约 1.33 倍并整块驻留内存。等读完再判断「太大了」，
 * 内存已经付出去了 —— 必须先 `stat`。
 */
const { dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const readFile = promisify(fs.readFile);
const stat = promisify(fs.stat);

/** read-file 单次读取上限：base64 会把体积放大约 1.33 倍并整块驻留内存，必须设闸门 */
const MAX_READ_FILE_BYTES = 64 * 1024 * 1024;
const formatMb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

/**
 * @param {object} deps
 * @param {(channel: string, handler: Function) => void} deps.handle
 * @param {(data?: unknown) => object} deps.ok
 * @param {(message: unknown, code?: string) => object} deps.fail
 * @param {object} deps.logger
 * @param {{ get: Function }} deps.win
 * @param {Set<string>} deps.imageExtensions 含点，如 '.jpg'
 * @param {Set<string>} deps.videoExtensions 含点
 * @param {(p: string) => boolean} deps.isMediaFile
 * @param {(p: string) => boolean} deps.isHeicFile
 * @param {(p: string) => Promise<Buffer>} deps.readHeicAsJpeg
 * @param {(dir: string) => void} deps.authorizeRoot
 * @param {(paths: string[]) => void} deps.authorizePaths
 * @param {(p: string) => boolean} deps.isPathAuthorized
 * @param {string} deps.UNAUTHORIZED_ERROR
 */
function createDialogIpc({
  handle,
  ok,
  fail,
  win,
  imageExtensions,
  videoExtensions,
  isMediaFile,
  isHeicFile,
  readHeicAsJpeg,
  authorizeRoot,
  authorizePaths,
  isPathAuthorized,
  UNAUTHORIZED_ERROR,
}) {
  /**
   * 统一导入对话框：macOS 下 openFile + openDirectory 可同时生效，
   * 用户能在同一个面板里多选「文件 + 文件夹」。
   * openDirectory 生效时系统面板会忽略扩展名过滤，因此这里再按扩展名
   * 对直接选中的文件做一次媒体过滤；文件夹内容交给 scanDirectory 递归过滤。
   * 返回 { files, directories, ignored }；取消返回 null。
   */
  async function openImportDialog() {
    const imageExts = [...imageExtensions].map((e) => e.slice(1));
    const videoExts = [...videoExtensions].map((e) => e.slice(1));
    const result = await dialog.showOpenDialog(win.get(), {
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
    await Promise.all(
      result.filePaths.map(async (filePath) => {
        try {
          const fileStat = await fs.promises.stat(filePath);
          if (fileStat.isDirectory()) directories.push(filePath);
          else if (isMediaFile(filePath)) files.push(filePath);
          else ignored += 1;
        } catch {
          ignored += 1;
        }
      })
    );

    // 用户主动选择的路径 → 授权本次会话可访问（后续 pm://file 与文件类 IPC 依赖它）
    authorizePaths([...files, ...directories]);

    return { files, directories, ignored };
  }

  handle('select-paths', async () => {
    // 取消选择是正常的业务结果，不是错误：ok(null) 让渲染层只需判 data 是否为空
    return ok(await openImportDialog());
  });

  /**
   * 选择单个目标目录（与「导入」是不同语义，保持纯目录面板）。
   * options.allowCreate：macOS 下面板内允许直接「新建文件夹」（移动整理用）；
   * Windows 的目录选择器自带新建按钮，无需额外属性。
   */
  handle('choose-directory', async (event, options) => {
    const properties = ['openDirectory'];
    if (options?.allowCreate && process.platform === 'darwin') {
      properties.push('createDirectory');
    }
    const result = await dialog.showOpenDialog(win.get(), {
      title: options?.allowCreate ? '移动到文件夹' : '选择目标文件夹',
      properties,
    });
    if (!result.canceled && result.filePaths.length > 0) {
      // 用户主动选定的目录 → 授权（导出 / 移动整理的目标目录依赖它）
      authorizeRoot(result.filePaths[0]);
      return ok(result.filePaths[0]);
    }
    return ok(null);
  });

  // 读取文件为 base64（供 AI 分析与「原格式」导出使用）。
  // HEIC/HEIF 与缩略图 / pm:// 协议共用同一份带缓存的转换，避免重复解码。
  handle('read-file', async (event, filePath) => {
    if (!filePath || typeof filePath !== 'string') {
      return fail('无效的文件路径');
    }
    if (!isPathAuthorized(filePath)) {
      return fail(UNAUTHORIZED_ERROR);
    }

    // 先按源文件体积设闸门：等 base64 已经进了内存再判断就晚了
    let sourceSize;
    try {
      sourceSize = (await stat(filePath)).size;
    } catch {
      return fail('文件不存在或无法访问');
    }
    if (sourceSize > MAX_READ_FILE_BYTES) {
      return fail(
        `文件过大（${formatMb(sourceSize)}），超过 ${formatMb(MAX_READ_FILE_BYTES)} 的单次读取上限`
      );
    }

    if (isHeicFile(filePath)) {
      const jpeg = await readHeicAsJpeg(filePath);
      // 转码后可能显著变大（HEIC 压缩率高），对产物再判一次
      if (jpeg.length > MAX_READ_FILE_BYTES) {
        return fail(`转码后体积过大（${formatMb(jpeg.length)}），超过单次读取上限`);
      }
      return ok(jpeg.toString('base64'));
    }
    const buffer = await readFile(filePath);
    return ok(buffer.toString('base64'));
  });

  // 批量检查路径是否存在（N8：启动时标注「不可用来源」——目录被挪走 / 卷未挂载）。
  // 只做一次 stat，不递归；返回 { 路径: 是否存在 }，缺失的路径显式返回 false。
  // 这些路径来自应用自己持久化的图库来源（用户此前主动选过），因此存在的就地授权，
  // 保证「重启后恢复图库」这条链路无需再次弹窗。
  handle('check-paths', async (event, paths) => {
    const list = Array.isArray(paths)
      ? paths.filter((p) => typeof p === 'string' && p.length > 0)
      : [];
    const settled = await Promise.all(
      list.map(async (target) => {
        try {
          await stat(target);
          return [target, true];
        } catch {
          return [target, false];
        }
      })
    );
    authorizePaths(settled.filter(([, exists]) => exists).map(([target]) => target));
    return ok(Object.fromEntries(settled));
  });

  // 显式授权一批路径。用于「拖放进窗口」——拖放不经过系统对话框，
  // 是除对话框之外的另一个用户主动选择入口。只授权实际存在的路径。
  handle('authorize-paths', async (event, paths) => {
    if (!Array.isArray(paths)) {
      return fail('无效的参数');
    }
    const existing = [];
    for (const target of paths) {
      if (typeof target !== 'string' || !target) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await stat(target);
        existing.push(target);
      } catch {
        // 不存在（拖入后立即被移走等）不授权，也不报错
      }
    }
    authorizePaths(existing);
    return ok({ count: existing.length });
  });

  // 批量获取文件信息（用于拖放/单文件选择时补齐 size/mtime）
  // K1：单项失败不再过滤丢弃，路径进 failedPaths 返回，渲染层可提示跳过数量并重试
  // 未授权的路径同样进 failedPaths —— 对调用方而言「拿不到信息」，不区分原因。
  handle('stat-files', async (event, filePaths) => {
    const list = Array.isArray(filePaths) ? filePaths : [];
    const settled = await Promise.all(
      list.map(async (filePath) => {
        if (!isPathAuthorized(filePath)) return null;
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
    return ok({
      infos: settled.filter(Boolean),
      failedPaths: settled
        .map((item, index) => (item ? null : list[index]))
        .filter((p) => typeof p === 'string'),
    });
  });

  return { openImportDialog };
}

module.exports = { createDialogIpc };
