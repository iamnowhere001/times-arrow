/**
 * 主进程集成测试的共用脚手架。
 *
 * 思路：用 `Module._load` 拦截 `require('electron')` 返回桩对象，
 * 捕获 `ipcMain.handle` / `protocol.handle` 注册的 handler，直接调用它们断言行为 ——
 * **全程不启动 Electron**。因此这套测试能在无显示服务、无法初始化 Chromium 沙箱、
 * 甚至 `ELECTRON_RUN_AS_NODE` 被注入的环境里跑。
 *
 * 三个必须处理的坑（都已在下面处理）：
 *  1. `setupProtocol()` 注册在 `app.on('ready')` 回调里，桩必须收集回调并手动触发，
 *     否则 `protocolHandlers` 永远是空的。
 *  2. `app.getAppPath` 也要桩，否则启动时会打印 env 加载警告，掩盖真实输出。
 *  3. `session.defaultSession.webRequest.onHeadersReceived` 要桩（CSP 装在这里）。
 */
const Module = require('module');
const os = require('os');
const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(APP_ROOT, 'electron/main.js');

/**
 * 加载真实 main.js，返回捕获到的 handler 与调用工具。
 *
 * @param {object} [options]
 * @param {string} [options.userData] 指定 userData 目录（默认新建临时目录）
 * @param {(userData: string) => void} [options.beforeRequire]
 *   在 `require(main.js)` **之前**执行。存储类测试必须走这个钩子 ——
 *   `app.on('ready')` 会预读 config.json / ai-config.json 并进 storeCache，
 *   加载之后再往目录里放损坏文件是不会被重读的。
 */
function loadMainProcess(options = {}) {
  const handlers = {};
  const protocolHandlers = {};
  const readyCallbacks = [];
  const trashCalls = [];
  const openPathCalls = [];
  const userData = options.userData ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pm-userdata-'));

  const fakeElectron = {
    app: {
      commandLine: { appendSwitch() {} },
      on: (event, fn) => {
        if (event === 'ready') readyCallbacks.push(fn);
      },
      getPath: () => userData,
      getAppPath: () => APP_ROOT,
      isPackaged: false,
      quit() {},
      dock: { setIcon() {} },
      getVersion: () => '0.0.0-test',
      setName() {},
    },
    BrowserWindow: class {
      constructor() {
        this.webContents = { send() {}, openDevTools() {}, on() {} };
      }
      loadURL() {}
      on() {}
      maximize() {}
      isMaximized() {
        return false;
      }
      getBounds() {
        return { x: 0, y: 0, width: 1200, height: 800 };
      }
    },
    Menu: { buildFromTemplate: () => ({}), setApplicationMenu() {} },
    ipcMain: {
      handle: (name, fn) => {
        handlers[name] = fn;
      },
      on() {},
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: {
      trashItem: async (p) => {
        trashCalls.push(p);
      },
      showItemInFolder() {},
      openPath: async (p) => {
        openPathCalls.push(p);
        return '';
      },
    },
    protocol: {
      registerSchemesAsPrivileged() {},
      handle: (scheme, fn) => {
        protocolHandlers[scheme] = fn;
      },
    },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    clipboard: { writeImage() {}, writeText() {} },
    session: { defaultSession: { webRequest: { onHeadersReceived() {} } } },
  };

  // 允许调用方在加载前布置磁盘状态（见 options.beforeRequire 的说明）
  options.beforeRequire?.(userData);

  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return fakeElectron;
    return originalLoad.apply(this, arguments);
  };

  try {
    require(MAIN_ENTRY);
  } finally {
    Module._load = originalLoad;
  }

  // ready 回调必须手动触发（见文件头坑 1）
  for (const fn of readyCallbacks) {
    try {
      fn();
    } catch (e) {
      console.log('[ready 回调异常]', e.message);
    }
  }

  /** 调用一个 IPC handler。fakeEvent 用最小可用对象即可 */
  const call = (name, ...args) => {
    const fn = handlers[name];
    if (!fn) throw new Error('未注册的 handler: ' + name);
    return fn({ sender: { send() {} } }, ...args);
  };

  /** 构造一个 pm:// 请求，喂给协议 handler */
  const pmFetch = (filePath) =>
    protocolHandlers.pm({
      url: 'pm://local/file/' + Buffer.from(filePath, 'utf8').toString('base64url'),
      headers: { get: () => null },
      method: 'GET',
    });

  return {
    handlers,
    protocolHandlers,
    call,
    pmFetch,
    trashCalls,
    openPathCalls,
    /** 桩出来的 userData 目录：存储类测试要往这里放损坏文件 */
    userData,
    APP_ROOT,
    MAIN_ENTRY,
  };
}

/** 极简断言器：打印 PASS/FAIL 并累计计数 */
function createChecker() {
  let pass = 0;
  let fail = 0;
  return {
    check(label, cond, extra) {
      if (cond) {
        pass++;
        console.log('  PASS  ' + label);
      } else {
        fail++;
        console.log('  FAIL  ' + label + (extra ? '  → ' + extra : ''));
      }
    },
    section(title) {
      console.log('\n=== ' + title + ' ===');
    },
    summary() {
      console.log('\n' + '='.repeat(40));
      console.log(`通过 ${pass} 项，失败 ${fail} 项`);
      console.log('='.repeat(40));
      return fail;
    },
  };
}

/** 造一个临时目录 */
const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

module.exports = { loadMainProcess, createChecker, tempDir, APP_ROOT, MAIN_ENTRY };
