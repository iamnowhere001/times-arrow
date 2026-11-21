const { app, ipcMain, dialog, shell, nativeImage } = require('electron');

// 协议特权标记必须在 app ready 之前注册，因此协议模块要在顶层立即加载。
const { registerPmScheme, createPmProtocol } = require('./main/protocol.cjs');
const { createCspInstaller } = require('./main/security.cjs');

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
// 特权标记（standard / secure / stream）必须在 app ready 之前注册。
registerPmScheme();

const fs = require('fs');
const path = require('path');
const logger = require('./lib/logger.cjs');

const { createAuthorization } = require('./main/authorization.cjs');
const { createStore } = require('./main/store.cjs');
const { createMediaPipeline } = require('./main/media-pipeline.cjs');
const { createAiService } = require('./main/ai.cjs');
const { createUpdater } = require('./main/updater.cjs');
const { createDataAssets } = require('./main/data-assets.cjs');
const { createFileIpc } = require('./main/ipc/files.cjs');
const { createFaceService } = require('./main/face/service.cjs');
const { createWindowManager } = require('./main/window.cjs');
const { createMenu: installAppMenu } = require('./main/menu.cjs');
const { createDirWatcher } = require('./main/watch.cjs');
const { createDialogIpc } = require('./main/ipc/dialog.cjs');
const { startMemoryWatchdog } = require('./main/memory-watchdog.cjs');
const { migrateAllStores } = require('./main/migrations.cjs');
const { createCrashReporter } = require('./main/crash-report.cjs');
const { createHealthCheck, writeMigrationReport } = require('./main/health.cjs');
const { createIpcRegistry } = require('./main/ipc/registry.cjs');

const { UNAUTHORIZED_ERROR, authorizeRoot, authorizePaths, isPathAuthorized } =
  createAuthorization();

/**
 * 崩溃记录器要在 process.on 注册之前可用：异常可能发生在模块求值期间，
 * 而 handler 里引用的是这个绑定本身，事件触发时它已经初始化完成。
 */
const crashReporter = createCrashReporter({
  userDataDir: app.getPath('userData'),
  logger,
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  // 同步落盘 + 下次启动提示：DMG 用户没有终端，只打日志等于「悄悄坏了」（K4）
  crashReporter.record('uncaught-exception', error);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  crashReporter.record('unhandled-rejection', reason);
});

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
  THUMB_CACHE_LIMIT,
  isHeicFile,
  isMediaFile,
  mimeTypeFor,
  readHeicAsJpeg,
  getThumbDir,
  ensureThumbnail,
  pruneThumbCache,
  loadThumbKeys,
  trimHashCache,
  scheduleThumbPrune,
  registerMediaPipelineIpc,
} = media;

// pm:// 协议与 CSP 都依赖媒体管线的能力（缩略图目录 / HEIC 转换 / MIME 判定），
// 因此在 media 装配完成后创建；两者都只在 app ready 之后才真正生效。
const pmProtocol = createPmProtocol({
  logger,
  getThumbDir,
  // 人像封面目录由人像服务创建，但协议注册早于服务装配，这里只做路径推导
  getFaceDir: () => path.join(app.getPath('userData'), 'faces', 'covers'),
  isPathAuthorized,
  isHeicFile,
  readHeicAsJpeg,
  mimeTypeFor,
});
const cspInstaller = createCspInstaller({ logger });

// ---------------------------------------------------------------------------
// IPC 统一返回协议
// ---------------------------------------------------------------------------
// 实现与「为什么统一」的论证见 ./main/ipc/registry.cjs。
// 注册器必须全进程唯一：各域模块共用这一个实例，重复注册检测才有意义。
const { ok, fail, handle } = createIpcRegistry({ ipcMain, logger });

const ai = createAiService({
  store,
  logger,
  appPath: app.getAppPath(),
  userDataDir: app.getPath('userData'),
});
const { registerAiIpc } = ai;

// 窗口是跨域共享资源（菜单 / 目录监听 / 内存看门狗 / 更新器都要投递事件），
// 收进 window.cjs 统一管理：外部只能 send / get / create，不能直接改引用。
// 这也让「窗口被关掉后从菜单导入」这条路径有唯一的重建入口。
const win = createWindowManager({
  logger,
  sandboxDisabled: SANDBOX_DISABLED,
  currentConfig,
  configStoreKey: STORE_CONFIG,
  withStoreLock,
  writeStore,
});

// 目录监听（过滤 + 防抖聚合）见 ./main/watch.cjs。
createDirWatcher({ handle, ok, fail, logger, authorizeRoot, isMediaFile, win });

// 路径类通道（导入对话框 / 选择目录 / 授权 / stat / 读文件）见 ./main/ipc/dialog.cjs。
// 这里把返回的 openImportDialog 交给菜单复用：菜单导入与工具栏导入必须是同一个对话框，
// 否则「扩展名过滤 / 授权范围」会在两条入口上分叉。
const { openImportDialog } = createDialogIpc({
  handle,
  ok,
  fail,
  win,
  imageExtensions: IMAGE_EXTENSIONS,
  videoExtensions: VIDEO_EXTENSIONS,
  isMediaFile,
  isHeicFile,
  readHeicAsJpeg,
  authorizeRoot,
  authorizePaths,
  isPathAuthorized,
  UNAUTHORIZED_ERROR,
});

// 媒体管线（扫描 / 缩略图 / 元数据 / 感知哈希）的通道注册仍在此同步执行
registerMediaPipelineIpc({ handle, ok, fail });

// 三个 JSON 存储的读写通道由 ./main/store.cjs 提供
registerStoreIpc({ handle, ok, fail });

// 人像识别：ONNX 运行时与模型只在用户进入「人像」页时才加载，
// 扫描结果按 fileId 存入 faces.json（与收藏 / 标签同一套身份口径）。
const faces = createFaceService({
  userDataDir: app.getPath('userData'),
  nativeImage,
  store,
  ensureThumbnail,
  getThumbDir,
  isPathAuthorized,
  unauthorizedError: UNAUTHORIZED_ERROR,
  send: (channel, payload) => win.send(channel, payload),
  logger,
});
faces.registerIpc({ handle, ok, fail });

/**
 * 取走「存储损坏并已备份」的通知（取走即清空）。
 *
 * 渲染进程在启动加载完配置后调用一次，非空时提示用户：
 * 「配置已重置，旧文件已备份到 xxx」。没有这条，用户只会发现相册/收藏消失，
 * 既不知道原因也不知道有备份可捞 —— 那才是真正让人恼火的地方。
 */
handle('storage-notices', async () => ok(drainStorageNotices()));

/**
 * 取走「上次运行崩溃」的通知（取走即清空）。
 * 与存储损坏通知同一语义：只提示一次，避免每次启动都变成噪音。
 */
handle('crash-notices', async () => ok(crashReporter.drain()));

/** 打开崩溃日志：路径由主进程决定，渲染层不传任何路径（因此不需要路径授权） */
handle('open-crash-log', async () => {
  if (!fs.existsSync(crashReporter.logPath)) {
    return fail('还没有崩溃日志可打开');
  }
  const error = await shell.openPath(crashReporter.logPath);
  return error ? fail(`无法打开日志：${error}`) : ok(true);
});

// 数据健康检查：只读统计，不上传任何内容
const health = createHealthCheck({
  store,
  media,
  userDataDir: app.getPath('userData'),
  crashReporter,
  logger,
  thumbCacheLimit: THUMB_CACHE_LIMIT,
});
health.registerIpc({ handle, ok, fail });

// AI 配置 / 分析 / 测试连接通道由 ./main/ai.cjs 提供
registerAiIpc({ handle, ok, fail });

// 更新检查 / 更新包下载由 ./main/updater.cjs 提供。
// 网络请求全部在主进程发出；IPC 不接收渲染层路径，下载目录与文件名由主进程决定。
const updater = createUpdater({
  app,
  shell,
  logger,
  send: (channel, payload) => win.send(channel, payload),
});
updater.registerUpdaterIpc({ handle, ok });
const { recordOperation } = createDataAssets({
  handle,
  ok,
  fail,
  isPathAuthorized,
  logger,
  dialog,
  store,
  userDataDir: app.getPath('userData'),
  send: (channel, payload) => win.send(channel, payload),
});

// 文件类通道必须在操作日志装配之后注册：重命名 / 删除 / 移动 / 导出都要写
// recordOperation，否则「撤销上一次操作」会拿到空日志。
createFileIpc({
  handle,
  ok,
  fail,
  logger,
  isPathAuthorized,
  UNAUTHORIZED_ERROR,
  recordOperation,
  isHeicFile,
  readHeicAsJpeg,
});

app.on('ready', () => {
  pmProtocol.register();
  // CSP 必须在创建窗口之前装好：晚于首次导航就会漏掉第一个文档
  cspInstaller.install();
  pruneThumbCache().then(loadThumbKeys);
  installAppMenu({ win, openImportDialog });
  startMemoryWatchdog({ logger, win, trimHashCache, scheduleThumbPrune });
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
      const startedAt = Date.now();
      try {
        const result = await migrateAllStores({ readStore, mergeStore, logger });
        await writeMigrationReport(app.getPath('userData'), {
          at: startedAt,
          changed: result.changed,
          stats: result.stats,
        });
      } catch (error) {
        logger.error('[migrate] 配置结构升级失败:', error);
        // 失败也要留证据：下次启动的「数据健康检查」会显示这条记录，
        // 崩溃提示里也能看到，用户至少知道该去 check .bak。
        crashReporter.record('migration', error);
        await writeMigrationReport(app.getPath('userData'), {
          at: startedAt,
          changed: false,
          stats: null,
          error: error?.message || String(error),
        });
      }
    })
    .then(() => win.create());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 退出前中止未完成的更新包下载，避免在下载目录留下 .download 半截文件
app.on('before-quit', () => {
  void updater.dispose();
});

// 渲染进程崩溃（OOM、GPU 进程连带退出等）同样要留证据：
// 用户看到的是「窗口白了一下」，重启后却没有任何记录可查。
app.on('render-process-gone', (event, webContents, details) => {
  logger.error('Render process gone:', details);
  crashReporter.record(
    'render-process-gone',
    new Error(`渲染进程退出：${details.reason}（exitCode ${details.exitCode}）`)
  );
});

app.on('activate', () => {
  if (!win.get()) {
    win.create();
  }
});
