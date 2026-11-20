/**
 * 主窗口：创建、尺寸记忆、跨域事件投递。
 *
 * ## 为什么单独一个模块
 *
 * `mainWindow` 原本是 `main.js` 里的模块级变量，被菜单、目录监听、内存看门狗、
 * 更新器、数据资产等多处直接引用。这让「谁在什么时候重建窗口」变成隐式知识，
 * 也让 main.js 无法只做装配。这里把窗口收成一个受控对象：
 * 外部只能通过 `send()` 投递事件、通过 `get()` 读取当前窗口，不能直接改它。
 *
 * ## 尺寸记忆的两个坑
 *
 * 1. **多屏**：显示器拔掉后旧坐标可能落在屏幕外，此时只保留尺寸、位置交给系统默认，
 *    否则窗口会开在看不见的地方（用户表现为「应用启动后没有窗口」）。
 * 2. **最大化**：最大化 / 全屏时不能把最大化尺寸写进 `windowBounds`，否则退出最大化后
 *    窗口回不到原来的大小。只记一个 `windowMaximized` 标记。
 */
const { BrowserWindow, screen } = require('electron');
const path = require('path');

const DEFAULT_WINDOW_SIZE = { width: 1240, height: 820 };
const MIN_WINDOW_SIZE = { width: 940, height: 620 };
/** 判定「窗口在某个显示器上可见」所需的最小重叠面积 */
const MIN_VISIBLE_OVERLAP = { x: 120, y: 90 };
/** 位置 / 尺寸变化的落盘防抖：拖拽期间不写盘 */
const BOUNDS_SAVE_DELAY = 600;
const PRELOAD_PATH = path.join(__dirname, '..', 'preload.js');
const RENDERER_ENTRY = path.join(__dirname, '..', '..', 'dist', 'index.html');

/**
 * @param {object} deps
 * @param {object} deps.logger
 * @param {boolean} deps.sandboxDisabled 与主进程命令行开关同源，保证两处口径一致
 * @param {() => object} deps.currentConfig 读取当前 config（含 windowBounds / windowMaximized）
 * @param {string} deps.configStoreKey 配置存储的 key
 * @param {(key: string) => Promise<void>} deps.withStoreLock
 * @param {(key: string) => Promise<unknown>} deps.writeStore
 */
function createWindowManager({
  logger,
  sandboxDisabled,
  currentConfig,
  configStoreKey,
  withStoreLock,
  writeStore,
}) {
  /** @type {import('electron').BrowserWindow | null} */
  let mainWindow = null;
  let boundsSaveTimer = null;

  function isVisibleOnSomeDisplay(bounds) {
    try {
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

  /** 记录当前窗口状态；最大化时只记「已最大化」，不用最大化尺寸覆盖常规尺寸 */
  function persistBounds() {
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
    void withStoreLock(configStoreKey, () => writeStore(configStoreKey)).catch((error) => {
      logger.warn('Failed to persist window bounds:', error.message);
    });
  }

  function schedulePersistBounds() {
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => {
      boundsSaveTimer = null;
      persistBounds();
    }, BOUNDS_SAVE_DELAY);
    boundsSaveTimer.unref?.();
  }

  function create() {
    const bounds = savedWindowBounds();
    const shouldMaximize = currentConfig().windowMaximized === true;

    mainWindow = new BrowserWindow({
      width: bounds?.width ?? DEFAULT_WINDOW_SIZE.width,
      height: bounds?.height ?? DEFAULT_WINDOW_SIZE.height,
      // v0.6.2：低于这个尺寸情境条与批量操作按钮会互相挤压甚至被裁切。
      // 用 minWidth/minHeight 让系统替我们守住布局底线，而不是给每个控件写断点。
      minWidth: 960,
      minHeight: 640,
      ...(bounds?.x !== undefined && bounds?.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
      // macOS：隐藏原生标题栏（含标题文字），仅保留内缩的红绿灯按钮，
      // 窗口拖动由渲染进程中的 -webkit-app-region: drag 区域承担。
      ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
      webPreferences: {
        preload: PRELOAD_PATH,
        nodeIntegration: false,
        contextIsolation: true,
        // 渲染进程沙箱：preload 只用到 contextBridge / ipcRenderer / webUtils，
        // 这三者在沙箱下都可用，无需 Node 完整能力，因此默认开启。
        // 与主进程命令行开关联动，保证两处口径一致。
        sandbox: !sandboxDisabled,
      },
    });

    if (shouldMaximize) mainWindow.maximize();

    // 加载 React 应用：开发模式加载本地服务器，生产模式加载构建产物
    const startUrl = process.env.ELECTRON_START_URL || `file://${path.join(RENDERER_ENTRY)}`;
    mainWindow.loadURL(startUrl);

    // 开发模式下打开开发者工具
    if (process.env.ELECTRON_START_URL) {
      mainWindow.webContents.openDevTools();
    }

    // 位置 / 尺寸变化后延迟落盘（拖拽期间不写），关闭时立即写一次
    mainWindow.on('resize', schedulePersistBounds);
    mainWindow.on('move', schedulePersistBounds);
    mainWindow.on('close', () => {
      if (boundsSaveTimer) {
        clearTimeout(boundsSaveTimer);
        boundsSaveTimer = null;
      }
      persistBounds();
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    return mainWindow;
  }

  /** 当前窗口；已关闭或从未创建时为 null */
  function get() {
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  }

  /** 向渲染层投递事件。窗口不在时静默丢弃 —— 事件是「顺带通知」，不该让调用方处理空窗口 */
  function send(channel, payload) {
    try {
      get()?.webContents?.send(channel, payload);
    } catch {
      /* 窗口已销毁 */
    }
  }

  return { create, get, send, persistBounds, schedulePersistBounds };
}

module.exports = { createWindowManager, DEFAULT_WINDOW_SIZE, MIN_WINDOW_SIZE };
