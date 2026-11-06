/**
 * IPC 契约守卫（B4）。
 *
 * 同一份契约此前散落在三处：`electron/preload.js`（实现）、`src/types/global.d.ts`
 * （类型）、`src/**`（实际调用），再加主进程的 `ipcMain.handle` 注册。任何一处漂移
 * 都不会被现有测试发现（历史上 `moveFiles` 的 `priorTargets` 就曾在 preload 漏掉）。
 *
 * 本测试**静态解析源码、不启动 Electron**，断言四件事：
 *   1. preload 暴露的方法 ⊇ d.ts 声明 ⊇ src 实际调用（双向都查，防止声明了却未暴露）
 *   2. invoke 通道集合与冻结清单一致，且每个通道只注册一次
 *   3. `pm` 协议 handler 恰好一个
 *   4. 已知缺口 `moveFiles` 的形参数量被钉住（修复后本断言会失败，提醒同步更新）
 *
 * 新增 / 删除通道时必须同步修改 CHANNELS 清单 —— 这是刻意的变更成本。
 *
 * 运行：npm run test:main
 */
const fs = require('fs');
const path = require('path');
const { createChecker, APP_ROOT } = require('./harness.cjs');

const { check, section, summary } = createChecker();

function walk(dir, ext, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, acc);
    else if (ext.test(entry.name)) acc.push(full);
  }
  return acc;
}

const read = (p) => fs.readFileSync(path.join(APP_ROOT, p), 'utf8');

/** preload 暴露面：exposeInMainWorld 对象里缩进 2 空格的方法名 */
function preloadMethods() {
  const src = read('electron/preload.js');
  const start = src.indexOf('exposeInMainWorld');
  const body = src.slice(start, src.indexOf('\n});', start));
  return new Set([...body.matchAll(/^\s{2}([A-Za-z][\w]*)\s*:/gm)].map((m) => m[1]));
}

/** d.ts 声明：interface Window 内、缩进 6 空格的方法名 */
function declaredMethods() {
  const src = read('src/types/global.d.ts');
  const start = src.indexOf('interface Window');
  const region = src.slice(start, src.indexOf('\n  }', start));
  return new Set([...region.matchAll(/^ {6}([A-Za-z][\w]*)\s*(?:<|[?]?[:(])/gm)].map((m) => m[1]));
}

/** src 实际调用：window.electronAPI?.method / window.electronAPI.method */
function usedMethods() {
  const files = walk(path.join(APP_ROOT, 'src'), /\.(ts|tsx)$/);
  const used = new Map();
  for (const file of files) {
    for (const m of fs
      .readFileSync(file, 'utf8')
      .matchAll(/window\.electronAPI\??\.([A-Za-z][\w]*)/g)) {
      if (!used.has(m[1])) used.set(m[1], path.relative(APP_ROOT, file).split(path.sep).join('/'));
    }
  }
  return used;
}

/** 主进程注册的 invoke 通道（命令式 `handle('x')` 包装；排除 pm 协议） */
function invokeChannels() {
  const files = [
    path.join(APP_ROOT, 'electron/main.js'),
    ...walk(path.join(APP_ROOT, 'electron/main'), /\.cjs$/),
  ];
  const all = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  return [...all.matchAll(/\bhandle\(\s*'([^']+)'/g)]
    .map((m) => m[1])
    .filter((name) => name !== 'pm');
}

const diff = (a, b) => [...a].filter((x) => !b.has(x)).sort();

/** 冻结清单：与当前实现一致；增删通道需显式修改此处 */
const CHANNELS = [
  'ai-analyze',
  'ai-config-get',
  'ai-config-set',
  'ai-config-test',
  'authorize-paths',
  'cache-thumbnail',
  'cancel-backup',
  'cancel-scan',
  'check-paths',
  'choose-directory',
  'compute-file-ids',
  'copy-image',
  'copy-text',
  'delete-file',
  'export-config',
  'get-image-hashes',
  'get-metadata',
  'get-operation-log',
  'get-relink-candidates',
  'get-thumbnail',
  'import-config',
  'load-ai-cache',
  'load-config',
  'move-files',
  'open-path',
  'read-file',
  'relink-source',
  'rename-file',
  'save-ai-cache',
  'save-config',
  'scan-directory',
  'select-paths',
  'show-in-folder',
  'start-backup',
  'stat-files',
  'storage-notices',
  'undo-operation',
  'unwatch-directory',
  'watch-directory',
  'write-file-unique',
];

const preload = preloadMethods();
const declared = declaredMethods();
const used = usedMethods();
const channels = invokeChannels();

section('1. preload ⊇ d.ts ⊇ src（双向差集为空）');
const missingInPreload = diff(declared, preload);
check(
  'd.ts 声明的每个方法 preload 都已暴露',
  missingInPreload.length === 0,
  missingInPreload.map((m) => `${m}（d.ts 有、preload 无）`).join('；')
);
const missingInTypes = diff(preload, declared);
check(
  'preload 暴露的每个方法 d.ts 都已声明',
  missingInTypes.length === 0,
  missingInTypes.map((m) => `${m}（preload 有、d.ts 无）`).join('；')
);
const missingInPreloadFromSrc = diff(new Set(used.keys()), preload);
check(
  'src 调用的每个方法 preload 都存在',
  missingInPreloadFromSrc.length === 0,
  missingInPreloadFromSrc.map((m) => `${m}（src 有调用、preload 无）`).join('；')
);

section('2. 通道集合与冻结清单一致，且每个只注册一次');
const uniqueChannels = new Set(channels);
check(
  '通道无重复注册',
  channels.length === uniqueChannels.size,
  `注册 ${channels.length} 次 / ${uniqueChannels.size} 个`
);
const unexpected = [...uniqueChannels].filter((c) => !CHANNELS.includes(c)).sort();
const absent = CHANNELS.filter((c) => !uniqueChannels.has(c));
check('无清单外的新通道', unexpected.length === 0, unexpected.join('；'));
check('清单内通道都已注册', absent.length === 0, absent.join('；'));
check(
  `通道数为 ${CHANNELS.length}`,
  uniqueChannels.size === CHANNELS.length,
  `实际 ${uniqueChannels.size}`
);

section('3. pm:// 协议 handler 恰好一个');
const mainSrc = read('electron/main.js');
const pmHandlers = [...mainSrc.matchAll(/protocol\.handle\(\s*'pm'/g)].length;
check("protocol.handle('pm') 仅出现一次", pmHandlers === 1, `实际 ${pmHandlers}`);

section('4. 已知缺口登记（修复后请更新本断言）');
const firstGroup = (match) => (match ? match[1] : '');
const preloadArity = firstGroup(read('electron/preload.js').match(/moveFiles:\s*\(([^)]*)\)/))
  .split(',')
  .filter((s) => s.trim()).length;
const dtsArity =
  firstGroup(read('src/types/global.d.ts').match(/moveFiles:\s*\(\s*([\s\S]*?)\n {6}\)/)).match(
    /^\s*([A-Za-z_]\w*)\??:/gm
  )?.length ?? 0;
check(
  'moveFiles：preload 形参 2 个、d.ts 形参 3 个（priorTargets 未透传，属已知缺口）',
  preloadArity === 2 && dtsArity === 3,
  `preload ${preloadArity} / d.ts ${dtsArity}；若已修复请同步更新本断言与文档`
);

section('5. 主进程 → 渲染层事件契约（v0.6.2 批次 2）');
// 新增事件不是 invoke 通道，不进 CHANNELS，但同样要四处对齐，否则菜单点了没反应
// 却没有任何测试会发现。这里钉住 v0.6.2 新增的「撤销上次文件操作」链路。
const undoEvent = {
  main: read('electron/main.js'),
  preload: read('electron/preload.js'),
  types: read('src/types/global.d.ts'),
  app: read('src/App.tsx'),
};
check(
  'undo-last-operation：main 发送 / preload 转发 / d.ts 声明 / App 订阅 四处齐全',
  undoEvent.main.includes("send('undo-last-operation')") &&
    undoEvent.preload.includes("ipcRenderer.on('undo-last-operation'") &&
    undoEvent.types.includes('onUndoLastOperation') &&
    undoEvent.app.includes('onUndoLastOperation'),
  JSON.stringify({
    main: undoEvent.main.includes("send('undo-last-operation')"),
    preload: undoEvent.preload.includes("ipcRenderer.on('undo-last-operation'"),
    types: undoEvent.types.includes('onUndoLastOperation'),
    app: undoEvent.app.includes('onUndoLastOperation'),
  })
);

process.exit(summary() === 0 ? 0 : 1);
