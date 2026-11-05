const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  dialog,
  shell,
  protocol,
  nativeImage,
  clipboard,
  session,
} = require('electron');

// 沙箱默认开启 —— 这是 Electron 的默认值，也是渲染进程与操作系统之间的最后一道隔离。
// 这里不再无条件追加 no-sandbox / disable-setuid-sandbox / disable-gpu-sandbox：
// 那三个开关会整体关掉 Chromium 的进程沙箱，等于放弃隔离，一旦渲染层被注入，
// 攻击者就直接获得主进程级别的系统能力。
//
// 但确实存在一类受限环境（容器、部分 CI、无权限初始化 Chromium 沙箱的内核配置）
// 无法启动沙箱，表现为反复输出 "sandbox initialization failed: Operation not permitted"。
// 因此保留一个「必须主动打开」的逃生口，而不是把不安全配置写死进发布产物：
//   PHOTOMINDER_DISABLE_SANDBOX=1 npm run electron:dev
//
// 注意 !app.isPackaged 这一层：打包产物永远强制开启沙箱，
// 避免这个开关被用户机器上的环境变量静默关掉。
const SANDBOX_DISABLED = !app.isPackaged && process.env.PHOTOMINDER_DISABLE_SANDBOX === '1';
if (SANDBOX_DISABLED) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-setuid-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

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
const stat = promisify(fs.stat);
const logger = require('./lib/logger.cjs');
// CSP 策略的唯一定义处：主进程响应头与 vite 构建期注入的 meta 共用同一份字符串
const { policyFor } = require('./lib/csp.cjs');

const { createAuthorization } = require('./main/authorization.cjs');
const { createStore } = require('./main/store.cjs');
const { createMediaPipeline } = require('./main/media-pipeline.cjs');
const { createAiService } = require('./main/ai.cjs');
const { createDataAssets } = require('./main/data-assets.cjs');
const { migrateAllStores } = require('./main/migrations.cjs');

const { UNAUTHORIZED_ERROR, authorizeRoot, authorizePaths, isPathAuthorized } =
  createAuthorization();

const store = createStore({ userDataDir: app.getPath('userData'), logger });
const {
  STORE_CONFIG,
  STORE_AI_CONFIG,
  readStore,
  currentConfig,
  drainStorageNotices,
  withStoreLock,
  writeStore,
  registerStoreIpc,
  mergeStore,
} = store;

const media = createMediaPipeline({
  userDataDir: app.getPath('userData'),
  nativeImage,
  logger,
  authorizeRoot,
  isPathAuthorized,
  UNAUTHORIZED_ERROR,
});
const {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  isHeicFile,
  isMediaFile,
  mimeTypeFor,
  readHeicAsJpeg,
  getThumbDir,
  pruneThumbCache,
  loadThumbKeys,
  trimHashCache,
  scheduleThumbPrune,
  registerMediaPipelineIpc,
} = media;

// ---------------------------------------------------------------------------
// IPC 统一返回协议
// ---------------------------------------------------------------------------
// 改造前的问题：31 个 handler 各自返回 { error } / { success } / 裸值 / null 四种形态，
// 渲染层每调用一个 API 都要先猜「这次失败是以什么形式表达的」，漏判就会把错误当成数据。
// 更糟的是有的 handler 根本没有 try/catch，抛出的异常会以 Electron 包装过的
// rejected promise 形式到达渲染层，里面的消息既不稳定也不可读。
//
// 统一为：
//   { ok: true,  data: T }          —— 成功，业务数据在 data
//   { ok: false, error: string, code?: string } —— 失败，error 一定是可直接展示的中文文案
//
// 两条纪律：
//   1. 所有 handler 一律经 `handle()` 注册，由 wrapHandler 兜底捕获异常，
//      不允许直接调用 ipcMain.handle —— 否则就绕过了这层保障。
//   2. 业务性的失败（如「目标不是文件夹」）也走 fail()，不要既返回 ok:true 又带 error 字段。
//      这样渲染层只需判一个 ok 布尔值。
// ---------------------------------------------------------------------------

/** 成功结果 */
const ok = (data = null) => ({ ok: true, data });

/** 失败结果。message 直接面向用户，应当是中文且可操作 */
function fail(message, code) {
  const text = typeof message === 'string' && message ? message : String(message ?? '未知错误');
  return code ? { ok: false, error: text, code } : { ok: false, error: text };
}

/** 已注册的通道，用于防止重复注册（重复注册会让 Electron 直接抛错，且报错信息不指向调用点） */
const registeredChannels = new Set();

/**
 * 注册一个 IPC handler，自动获得：
 *  - 异常兜底：handler 抛错不会变成渲染层的 rejected promise，而是 { ok:false, error }
 *  - 统一日志：带通道名，便于定位是哪个接口出的问题
 *  - 重复注册检测
 */
function handle(channel, handler) {
  if (registeredChannels.has(channel)) {
    throw new Error(`IPC 通道重复注册: ${channel}`);
  }
  registeredChannels.add(channel);

  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (error) {
      logger.error(`[ipc:${channel}] handler threw:`, error);
      return fail(error?.message || String(error), error?.code);
    }
  });
}

const ai = createAiService({
  store,
  logger,
  appPath: app.getAppPath(),
  userDataDir: app.getPath('userData'),
});
const { registerAiIpc } = ai;

let mainWindow;

// ---------------------------------------------------------------------------
// 目录监听（N5）：轻量感知外部增删。
// macOS 下 fs.watch recursive 基于 FSEvents：rename 会同时产生 add+remove 对，
// 整目录拷入会形成事件风暴，因此主进程只做「过滤 + 防抖聚合」，
// 语义判定（新增 / 移除 / 回环防护）全部交给渲染层。
// ---------------------------------------------------------------------------
let dirWatcher = null;
let watchedDir = null;
/** absolutePath → 最近一次事件类型（Map 天然去重，同路径只保留一条） */
const pendingWatchEvents = new Map();
let watchFlushTimer = null;
let watchFlushMaxTimer = null;

/** 关闭当前 watcher 并清空全部聚合状态 */
function stopDirWatcher() {
  if (dirWatcher) {
    try {
      dirWatcher.close();
    } catch {
      // 已关闭 / 已失效时 close 可能抛错，忽略
    }
    dirWatcher = null;
  }
  watchedDir = null;
  pendingWatchEvents.clear();
  if (watchFlushTimer) {
    clearTimeout(watchFlushTimer);
    watchFlushTimer = null;
  }
  if (watchFlushMaxTimer) {
    clearTimeout(watchFlushMaxTimer);
    watchFlushMaxTimer = null;
  }
}

/** 防抖 flush：500ms 尾沿；事件持续到达时由 3s maxWait 强制截断 */
function scheduleWatchFlush() {
  if (watchFlushTimer) clearTimeout(watchFlushTimer);
  watchFlushTimer = setTimeout(() => {
    watchFlushTimer = null;
    flushWatchEvents();
  }, 500);
  if (!watchFlushMaxTimer) {
    watchFlushMaxTimer = setTimeout(() => {
      watchFlushMaxTimer = null;
      if (watchFlushTimer) {
        clearTimeout(watchFlushTimer);
        watchFlushTimer = null;
      }
      flushWatchEvents();
    }, 3000);
  }
}

/** 聚合分类后一次性发给渲染层：stat 成功的文件 → added；目录 → addedDirs；ENOENT → removed */
function flushWatchEvents() {
  if (!watchedDir || pendingWatchEvents.size === 0) return;

  const added = [];
  const addedDirs = [];
  const removed = [];
  const paths = [...pendingWatchEvents.keys()];
  pendingWatchEvents.clear();

  for (const filePath of paths) {
    try {
      const s = fs.statSync(filePath);
      if (s.isFile()) added.push(filePath);
      else if (s.isDirectory()) addedDirs.push(filePath); // 目录被拖入监听范围，交渲染层走扫描管线
    } catch (error) {
      if (error.code === 'ENOENT') removed.push(filePath);
      // EACCES 等无法判定的忽略，避免误删列表
    }
  }

  if (added.length === 0 && addedDirs.length === 0 && removed.length === 0) return;
  logger.debug(
    `[watch] ${watchedDir}: +${added.length} files, +${addedDirs.length} dirs, -${removed.length}`
  );
  mainWindow?.webContents?.send('directory-changed', {
    dir: watchedDir,
    added,
    addedDirs,
    removed,
  });
}

handle('watch-directory', async (event, dirPath) => {
  if (typeof dirPath !== 'string' || !dirPath) {
    return fail('无效的目录路径');
  }
  const resolved = path.resolve(dirPath);
  if (watchedDir === resolved && dirWatcher) {
    return ok({ already: true });
  }
  stopDirWatcher();
  try {
    const dirStat = await stat(dirPath);
    if (!dirStat.isDirectory()) {
      return fail('路径不是文件夹');
    }
    // 监听目录意味着它属于当前图库，一并授权
    authorizeRoot(dirPath);
    watchedDir = resolved;
    dirWatcher = fs.watch(resolved, { recursive: true }, (type, relPath) => {
      if (!watchedDir || !relPath) return;
      const base = path.basename(relPath);
      if (base.startsWith('.')) return; // .DS_Store / ._* / 临时文件
      const full = path.join(resolved, relPath);
      if (!isMediaFile(full)) return;
      pendingWatchEvents.set(full, type);
      scheduleWatchFlush();
    });
    // 目录被外部删除 / 卷被卸载时 macOS 多报 EPERM / ENOENT：停止监听并告知渲染层
    dirWatcher.on('error', (watchError) => {
      logger.warn(`[watch] watcher error on ${watchedDir}:`, watchError);
      const erroredDir = watchedDir;
      stopDirWatcher();
      mainWindow?.webContents?.send('directory-watch-error', {
        dir: erroredDir,
        code: watchError?.code,
      });
    });
    logger.debug(`[watch] watching ${resolved}`);
    return ok({ already: false });
  } catch (error) {
    logger.error('Error watching directory:', error);
    // 监听失败后必须清掉半初始化状态，否则下一次 watch 会因为 watchedDir 残留而误判为「已在监听」
    stopDirWatcher();
    throw error;
  }
});

handle('unwatch-directory', async () => {
  stopDirWatcher();
  return ok(true);
});

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
      // 渲染进程沙箱：preload 只用到 contextBridge / ipcRenderer / webUtils，
      // 这三者在沙箱下都可用，无需 Node 完整能力，因此默认开启。
      // 与上方 SANDBOX_DISABLED 联动，保证命令行开关与 webPreferences 口径一致。
      sandbox: !SANDBOX_DISABLED,
    },
  });

  if (shouldMaximize) mainWindow.maximize();

  // 加载React应用
  // 在开发模式下加载本地服务器，生产模式下加载build目录
  const startUrl =
    process.env.ELECTRON_START_URL || `file://${path.join(__dirname, '../dist/index.html')}`;
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
            // macOS 上关掉最后一个窗口后进程仍在运行（window-all-closed 不退出），
            // 此时从菜单导入会拿到 null 窗口；先重建窗口再投递结果
            if (picked) {
              if (!mainWindow) createWindow();
              mainWindow?.webContents?.send('import-paths', picked);
            }
          },
        },
        {
          type: 'separator',
        },
        {
          label: '数据资产…',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => {
            // 配置导出 / 导入、路径重连、操作日志与撤销、增量备份共用一个入口
            mainWindow?.webContents?.send('open-data-assets');
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

/** 同名文件的重试上限：超过这个数量说明不是正常场景（多半是逻辑出错），直接报错而不是空转 */
const UNIQUE_NAME_MAX_ATTEMPTS = 100;

/**
 * 原子地占用一个不冲突的目标路径，同名时依次追加 -1、-2 …
 * 用于「重命名」「移动」与「导出写盘」，绝不静默覆盖用户已有文件。
 *
 * 为什么不能用「existsSync 探测 + 再写」：那是典型的 TOCTOU ——
 * 探测与真正落盘之间存在窗口，并发的两次导出（或另一个进程）可能探测到同一个空闲名字，
 * 后落盘的一方就静默覆盖了先落盘的一方。照片导出最不能接受的就是静默丢数据。
 *
 * 这里改用 `open(candidate, 'wx')`：'wx' 的语义是「独占创建，已存在则失败」，
 * 由内核保证原子性。成功即代表这个名字归本次调用所有；EEXIST 说明被别人抢先，
 * 递增序号重试即可。其余错误（EACCES / ENOENT / EROFS）重试没有意义，直接抛出。
 *
 * 返回占用成功的完整路径。占位用的文件句柄在这里立即关闭 —— 名字一旦被内核判给
 * 本次调用，就不会再被别的进程抢走，后续用普通写入打开它是安全的。
 * 调用方**必须**负责：若最终决定不使用这个路径，调用 `discardReservedPath()` 清掉占位
 * 文件，否则会在用户目录里留下一个空文件。
 */
async function reserveUniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  for (let attempt = 0; attempt < UNIQUE_NAME_MAX_ATTEMPTS; attempt += 1) {
    const candidate = path.join(dir, attempt === 0 ? fileName : `${base}-${attempt}${ext}`);
    let handle;
    try {
      // eslint-disable-next-line no-await-in-loop
      handle = await fs.promises.open(candidate, 'wx');
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    // eslint-disable-next-line no-await-in-loop
    await handle.close();
    return candidate;
  }
  throw new Error(`同名文件过多，无法生成不冲突的文件名（已尝试 ${UNIQUE_NAME_MAX_ATTEMPTS} 次）`);
}

/** 丢弃一个已占位但最终没有使用的路径。best-effort：清理失败只记日志，不掩盖主流程的错误 */
async function discardReservedPath(reservedPath) {
  try {
    await fs.promises.unlink(reservedPath);
  } catch (error) {
    logger.warn(`Failed to clean up reserved placeholder ${reservedPath}:`, error.message);
  }
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
 *
 * 目标路径已由 reserveUniquePath 原子占位，因此这里用**普通** copyFile 覆写自己的
 * 占位文件即可 —— 不需要 COPYFILE_EXCL（那会因为占位文件已存在而必然失败），
 * 也不会与并发的另一次移动互相覆盖（名字已被我们独占）。
 *
 * K2：源文件删除失败（如只读卷）不再整体抛错——副本已落盘，返回 partial 中间态，
 * 由渲染层提示并可通过 priorTargets 幂等重试，绝不重复复制。
 */
async function moveAcrossDevices(srcPath, destPath) {
  await fs.promises.copyFile(srcPath, destPath);
  try {
    await fs.promises.unlink(srcPath);
  } catch (error) {
    return { to: destPath, partial: true, error: error.message };
  }
  return { to: destPath, partial: false };
}

/**
 * K2：补删跨卷移动残留的源文件（重试入口）。
 * 副本存在且与源体积一致才删源；任一 stat 失败或体积不一致返回 null（无法安全续删，
 * 走正常移动流程）；源已不存在视为移动已完成。
 */
async function resumePartialMove(srcPath, copiedPath) {
  let srcStat;
  let copiedStat;
  try {
    [srcStat, copiedStat] = await Promise.all([
      fs.promises.stat(srcPath),
      fs.promises.stat(copiedPath),
    ]);
  } catch {
    return null;
  }
  if (srcStat.size !== copiedStat.size) return null;
  try {
    await fs.promises.unlink(srcPath);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// 重命名：目标不存在直接改；目标已存在（且不是自身）时自动追加序号，绝不覆盖
handle('rename-file', async (event, oldPath, newPath) => {
  if (!oldPath || !newPath || typeof oldPath !== 'string' || typeof newPath !== 'string') {
    return fail('无效的文件路径');
  }
  // 源与目标都必须在已授权范围内：目标由 dirname(源) + 新文件名推出，
  // 正常路径必然通过；若渲染层传入越界的 newPath，则在此拦下。
  if (!isPathAuthorized(oldPath) || !isPathAuthorized(newPath)) {
    return fail(UNAUTHORIZED_ERROR);
  }

  // 目标就是源自身（仅大小写变化等）：无需任何落盘操作
  if (isSameFile(oldPath, newPath)) {
    return ok({ path: newPath, conflicted: false });
  }

  // 原子占位目标名：并发的两次重命名不会拿到同一个路径，也就不会互相覆盖。
  // 这里刻意不再用 existsSync 预判 —— 预判与 rename 之间的窗口正是竞态所在。
  const reservedPath = await reserveUniquePath(path.dirname(newPath), path.basename(newPath));
  const conflicted = reservedPath !== newPath;

  try {
    // POSIX 的 rename 会原子地替换已存在的目标 —— 而那个目标正是我们刚占下的占位文件，
    // 替换它是预期行为，不是覆盖用户数据。
    await rename(oldPath, reservedPath);
  } catch (error) {
    // 落盘失败：清掉占位文件，别在用户目录里留下空文件
    await discardReservedPath(reservedPath);
    throw error;
  }

  if (conflicted) {
    logger.debug(`Rename conflict: ${newPath} exists, using ${reservedPath}`);
  }
  logger.debug(`Renamed file: ${oldPath} -> ${reservedPath}`);
  await recordOperation({ type: 'rename', from: oldPath, to: reservedPath });
  return ok({ path: reservedPath, conflicted });
});

handle('delete-file', async (event, filePath) => {
  if (!filePath || typeof filePath !== 'string') {
    return fail('无效的文件路径');
  }
  if (!isPathAuthorized(filePath)) {
    return fail(UNAUTHORIZED_ERROR);
  }

  // 先记下体积与修改时间：撤销时要靠它们从 ~/.Trash 里认出同一份文件
  const stat = await fs.promises.stat(filePath).catch(() => null);
  // Electron 官方回收站 API：跨平台、无 shell 注入风险
  await shell.trashItem(filePath);
  await recordOperation({
    type: 'delete',
    from: filePath,
    size: stat?.size,
    mtime: stat?.mtimeMs,
  });
  return ok(true);
});

/**
 * 批量移动文件到指定文件夹（整理图库用）。
 * - 源文件已在目标目录 → 跳过（skipped + reason='same-directory'）
 * - 目标已存在同名文件 → 自动追加序号（conflicted=true），绝不覆盖
 * - 跨磁盘 / 跨卷 → 复制后删除源文件；删源失败返回 partial 中间态（K2），
 *   渲染层重试时回传 priorTargets（源路径 → 已落盘副本路径），只补删源、绝不重复复制
 * 逐个串行执行：前一个落盘后后一个才能探测同名，避免批内互相覆盖。
 * 返回整体错误 + 每个文件独立结果，失败项由渲染进程组织重试。
 */
handle('move-files', async (event, filePaths, targetDir, priorTargets) => {
  if (!Array.isArray(filePaths) || typeof targetDir !== 'string' || !targetDir) {
    return fail('无效的参数');
  }

  let targetStat;
  try {
    targetStat = await fs.promises.stat(targetDir);
  } catch {
    return fail('目标文件夹不存在');
  }
  if (!targetStat.isDirectory()) {
    return fail('目标位置不是文件夹');
  }
  // 目标目录必须已授权（来自「选择文件夹」对话框）；
  // 越界时整批拒绝，避免半批移动后才发现问题。
  if (!isPathAuthorized(targetDir)) {
    return fail(UNAUTHORIZED_ERROR);
  }

  const results = [];
  // 这个循环**必须**串行：每一项都要先原子占位、落盘之后，下一项才能正确探测同名。
  // 改成并发会让批内同名文件互相抢名字（也正是旧实现静默覆盖的成因之一）。
  /* eslint-disable no-await-in-loop */
  for (const srcPath of filePaths) {
    if (typeof srcPath !== 'string' || !srcPath) {
      results.push({ from: String(srcPath ?? ''), error: '无效的文件路径' });
      continue;
    }
    if (!isPathAuthorized(srcPath)) {
      results.push({ from: srcPath, error: UNAUTHORIZED_ERROR });
      continue;
    }

    // K2 重试幂等：上次「复制成功但删源失败」的残留副本优先补删源
    const priorTo = priorTargets && typeof priorTargets === 'object' ? priorTargets[srcPath] : null;
    if (typeof priorTo === 'string' && priorTo) {
      const resumed = await resumePartialMove(srcPath, priorTo);
      if (resumed) {
        if (resumed.ok) {
          logger.debug(`Resumed partial move: removed source ${srcPath}`);
          results.push({ from: srcPath, to: priorTo, success: true, resumed: true });
        } else {
          results.push({ from: srcPath, to: priorTo, partial: true, error: resumed.error });
        }
        continue;
      }
      // 副本缺失 / 体积不一致：残留副本不可信，回退正常移动流程
    }

    try {
      if (isSameDirectory(path.dirname(srcPath), targetDir)) {
        results.push({ from: srcPath, skipped: true, reason: 'same-directory' });
        continue;
      }

      const fileName = path.basename(srcPath);
      // 原子占位目标名：批内多个同名文件、或并发的另一次移动，都不会拿到同一路径。
      const destPath = await reserveUniquePath(targetDir, fileName);
      const conflicted = destPath !== path.join(targetDir, fileName);
      let finalDest = destPath;
      let partialMove = null;
      try {
        // 目标是我们刚占下的占位文件，POSIX rename 会原子替换它
        await rename(srcPath, destPath);
      } catch (err) {
        if (err.code === 'EXDEV') {
          // 跨卷：占位文件仍在，moveAcrossDevices 用普通 copyFile 覆写它
          partialMove = await moveAcrossDevices(srcPath, destPath);
          finalDest = partialMove.to;
        } else {
          // 其他失败：清掉占位文件，避免留下空文件
          await discardReservedPath(destPath);
          throw err;
        }
      }
      logger.debug(`Moved file: ${srcPath} -> ${finalDest}`);
      if (partialMove?.partial) {
        // 副本已落盘但源未删除：条目留在原位（源仍在），渲染层提示可重试
        results.push({ from: srcPath, to: finalDest, partial: true, error: partialMove.error });
        continue;
      }
      results.push({
        from: srcPath,
        to: finalDest,
        success: true,
        conflicted,
      });
    } catch (error) {
      logger.error('Error moving file:', error);
      results.push({ from: srcPath, error: error.message });
    }
  }
  /* eslint-enable no-await-in-loop */

  await Promise.all(
    results
      .filter((r) => r.success && r.to)
      .map((r) => recordOperation({ type: 'move', from: r.from, to: r.to }))
  );
  return ok({ results });
});

// 在访达 / 资源管理器中定位文件
handle('show-in-folder', async (event, filePath) => {
  if (!filePath || typeof filePath !== 'string') {
    return fail('无效的文件路径');
  }
  if (!isPathAuthorized(filePath)) {
    return fail(UNAUTHORIZED_ERROR);
  }
  shell.showItemInFolder(filePath);
  return ok(true);
});

// 复制图片到系统剪贴板（HEIC 先转 JPEG）
handle('copy-image', async (event, filePath) => {
  if (!filePath || typeof filePath !== 'string') {
    return fail('无效的文件路径');
  }
  if (!isPathAuthorized(filePath)) {
    return fail(UNAUTHORIZED_ERROR);
  }
  let image = nativeImage.createFromPath(filePath);
  if (image.isEmpty() && isHeicFile(filePath)) {
    image = nativeImage.createFromBuffer(await readHeicAsJpeg(filePath));
  }
  if (image.isEmpty()) {
    return fail('无法读取图片');
  }
  clipboard.writeImage(image);
  return ok(true);
});

// 复制纯文本（如文件路径）到系统剪贴板
handle('copy-text', async (event, text) => {
  if (!text || typeof text !== 'string') {
    return fail('无效的文本');
  }
  clipboard.writeText(text);
  return ok(true);
});

// 用系统默认应用 / 外部编辑器打开文件
handle('open-path', async (event, filePath) => {
  if (!filePath || typeof filePath !== 'string') {
    return fail('无效的文件路径');
  }
  if (!isPathAuthorized(filePath)) {
    return fail(UNAUTHORIZED_ERROR);
  }
  const openError = await shell.openPath(filePath);
  if (openError) {
    return fail(openError);
  }
  return ok(true);
});

// 写入二进制文件（base64）。同名冲突时自动追加序号，返回最终写入路径。
// 用于批量导出：渲染进程 canvas 完成格式转换后落盘。
handle('write-file-unique', async (event, targetDir, fileName, base64) => {
  if (!targetDir || !fileName || typeof base64 !== 'string') {
    return fail('无效的参数');
  }
  if (!isPathAuthorized(targetDir)) {
    return fail(UNAUTHORIZED_ERROR);
  }
  await fs.promises.access(targetDir);

  // 只取文件名部分：否则 ../ 前缀能让 path.join 把文件写到授权目录之外
  const safeName = path.basename(fileName);
  if (!safeName || safeName === '.' || safeName === '..') {
    return fail('无效的文件名');
  }

  // 原子占位：并发导出同名文件时不会互相覆盖（名字一旦占下就是本次调用独有的）
  const finalPath = await reserveUniquePath(targetDir, safeName);
  try {
    await writeFile(finalPath, Buffer.from(base64, 'base64'));
  } catch (error) {
    // 写入失败：清掉占位文件，否则用户会看到一个 0 字节的「导出成功」
    await discardReservedPath(finalPath);
    throw error;
  }
  await recordOperation({ type: 'export', to: finalPath });
  return ok({ path: finalPath });
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
  await Promise.all(
    result.filePaths.map(async (filePath) => {
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.isDirectory()) directories.push(filePath);
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
  const result = await dialog.showOpenDialog(mainWindow, {
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

/** read-file 单次读取上限：base64 会把体积放大约 1.33 倍并整块驻留内存，必须设闸门 */
const MAX_READ_FILE_BYTES = 64 * 1024 * 1024;
const formatMb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

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

        // 白名单：只允许本次会话中用户主动打开过的图库范围内文件。
        // 这是本协议最关键的一道闸门 —— 没有它，任意 base64 都能读到本机任意文件。
        if (!isPathAuthorized(filePath)) {
          logger.warn('[pm] blocked unauthorized file request');
          return new Response('Forbidden', { status: 403 });
        }

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

/**
 * 内容安全策略（CSP）。
 *
 * 为什么需要它：P0 把「主进程能读哪些文件」收紧了，但渲染层自身仍是一块可被注入的
 * 执行环境 —— 图库里任何一张图片都可能是精心构造的 SVG。CSP 是唯一能在渲染层内部
 * 收敛「注入之后还能做什么」的机制：即便有内容被当作脚本执行，也无法外联、无法加载
 * 远程代码、无法把数据 POST 出去。
 *
 * 两条注入路径，互为补充：
 *  1. `onHeadersReceived` —— 覆盖开发（http://127.0.0.1:3000）与生产（file://）两种加载方式，
 *     且能按环境下发不同策略（开发必须给 Vite 让路）；
 *  2. `index.html` 里的 `<meta http-equiv>` —— 由 Vite 在生产构建时注入，
 *     防止将来更换加载方式（改成 loadFile、自定义协议等）时头部策略被漏掉。
 *     两处同时存在时浏览器取交集（最严格者生效），所以 meta 只需覆盖生产场景。
 *
 * 策略本身定义在 `./lib/csp.cjs`，与 vite 构建期注入 meta 时用的是同一份字符串，
 * 避免两处各写一份导致的漂移。
 */
function setupContentSecurityPolicy() {
  const isDev = Boolean(process.env.ELECTRON_START_URL);
  const policy = policyFor(isDev);

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // 只给「文档本身」注入 CSP，不对 pm:// 返回的图片 / 视频重复注入 ——
    // 那些响应的 Content-Type 不是文档，注入头部既无意义也会干扰 Range 请求。
    const isDocument =
      details.resourceType === 'mainFrame' ||
      details.resourceType === 'subFrame' ||
      /text\/html/i.test(details.responseHeaders?.['Content-Type']?.[0] ?? '');
    if (!isDocument) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    });
  });

  logger.info(`[csp] ${isDev ? 'development' : 'production'} policy installed`);
}

// 媒体管线（扫描 / 缩略图 / 元数据 / 感知哈希）的通道注册仍在此同步执行
registerMediaPipelineIpc({ handle, ok, fail });

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

// 三个 JSON 存储的读写通道由 ./main/store.cjs 提供
registerStoreIpc({ handle, ok, fail });

/**
 * 取走「存储损坏并已备份」的通知（取走即清空）。
 *
 * 渲染进程在启动加载完配置后调用一次，非空时提示用户：
 * 「配置已重置，旧文件已备份到 xxx」。没有这条，用户只会发现相册/收藏消失，
 * 既不知道原因也不知道有备份可捞 —— 那才是真正让人恼火的地方。
 */
handle('storage-notices', async () => ok(drainStorageNotices()));

// AI 配置 / 分析 / 测试连接通道由 ./main/ai.cjs 提供
registerAiIpc({ handle, ok, fail });
const { recordOperation } = createDataAssets({
  handle,
  ok,
  fail,
  isPathAuthorized,
  logger,
  dialog,
  store,
  userDataDir: app.getPath('userData'),
  send: (channel, payload) => mainWindow?.webContents?.send(channel, payload),
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

  // 走同一把写锁：直接 writeStore 会与 mergeStore 的「读-改-写」交错，
  // 虽然唯一 tmp 名已保证文件不会写坏，但可能把同时落盘的收藏 / 标签覆盖掉
  void withStoreLock(STORE_CONFIG, () => writeStore(STORE_CONFIG)).catch((error) => {
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
  // CSP 必须在创建窗口之前装好：晚于首次导航就会漏掉第一个文档
  setupContentSecurityPolicy();
  pruneThumbCache().then(loadThumbKeys);
  createMenu();
  startMemoryWatchdog();
  // 配置里含窗口尺寸与最大化状态：先读完再建窗口，避免启动时窗口跳一下。
  // AI 配置也一并预读：resolveAiConfig 走内存缓存，首次分析时才不会漏掉应用内设置。
  Promise.all([
    readStore(STORE_CONFIG).catch(() => ({})),
    readStore(STORE_AI_CONFIG).catch(() => ({})),
  ])
    .then(async () => {
      // v1 → v2：标注资产从「路径」换成「内容指纹」。必须在建窗口前跑完，
      // 否则渲染层拿到的是旧结构。迁移失败不能卡住启动 —— 旧配置仍在磁盘上，
      // 且写盘前已轮转 .bak 留了副本。
      try {
        await migrateAllStores({ readStore, mergeStore, logger });
      } catch (error) {
        logger.error('[migrate] 配置结构升级失败:', error);
      }
    })
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
