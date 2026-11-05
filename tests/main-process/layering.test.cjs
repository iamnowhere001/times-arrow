/**
 * 分层依赖守卫（B1）。
 *
 * 目的：把「谁可以 import 谁」从口头约定变成可执行断言。测试**只读源码、不启动 Electron**，
 * 因此能跑在 `test:main` 里，且失败信息直接给出 `文件:行号`。
 *
 * 当前 TypeScript 侧由 oxlint 检查（`npm run lint:ts`），JS/CJS 由 ESLint 检查
 * （见 README「工程配置」）。两层之外，这份守卫继续提供「依赖方向」这一机器约束。
 *
 * 关于 BASELINE：`src/components` 直连 `window.electronAPI` 是**既成事实**（B3 后仍剩 28 处），
 * 本轮只做零行为改动，不做搬迁。因此这条规则采用「棘轮」语义：**基线内允许、基线外一律失败**，
 * 修完一处后请下调对应数字。基线不是认可，只是还款计划。
 *
 * 还款记录：
 *  - 2026-11-05（B2）：`src/hooks` → `@/components` 的 14 处反向依赖（12 个文件）已全部清零，
 *    对应规则改为硬性断言（0 处）。类型下沉到 `@/types`（toast / grid），
 *    重复检测阈值下沉到 `@/lib/duplicate/constants`。
 *  - 2026-11-05（B3）：`src/components/grid/ThumbnailImage.tsx` 的 3 处 IPC 调用（4 处直接引用）
 *    已下沉到 `@/lib/cache/thumbCache`（32 → 28 处）。剩余 28 处分布如下，留待后续批次处理：
 *    DataAssetsModal ×10、DetailsPane ×6、ExportModal ×6、AiSettingsModal ×4、QuickLook ×2。
 *  - 2026-11-05（B5+）：`src/lib/contextMenuActions.ts` 的 `ContextMenuItem` 已迁到
 *    `@/types/contextMenu`，`src/lib → @/components` 降为 0 并改为硬性断言。
 *
 * 运行：npm run test:main
 */
const fs = require('fs');
const path = require('path');
const { createChecker, APP_ROOT } = require('./harness.cjs');

const { check, section, summary } = createChecker();

/** 递归收集文件（不依赖 glob 库） */
function walk(dir, ext, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, acc);
    else if (ext.test(entry.name)) acc.push(full);
  }
  return acc;
}

const rel = (p) => path.relative(APP_ROOT, p).split(path.sep).join('/');

/** 扫描一组文件，返回命中 pattern 的 { file, line, text } */
function scan(files, pattern) {
  const hits = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      pattern.lastIndex = 0;
      if (pattern.test(text)) hits.push({ file: rel(file), line: i + 1, text: text.trim() });
    });
  }
  return hits;
}

const hooksFiles = walk(path.join(APP_ROOT, 'src/hooks'), /\.ts$/);
const libFiles = walk(path.join(APP_ROOT, 'src/lib'), /\.ts$/);
const componentFiles = walk(path.join(APP_ROOT, 'src/components'), /\.tsx$/);
const mainModuleFiles = walk(path.join(APP_ROOT, 'electron/main'), /\.cjs$/);

/**
 * 基线：文件 → 允许的出现次数。
 * 只允许下调，不允许上调；新增文件不在基线内，出现即失败。
 */
const BASELINE = {
  componentsUseIpc: {
    'src/components/modal/DataAssetsModal.tsx': 10,
    'src/components/detail/DetailsPane.tsx': 6,
    'src/components/modal/ExportModal.tsx': 6,
    'src/components/detail/QuickLook.tsx': 2,
    'src/components/modal/AiSettingsModal.tsx': 4,
  },
};

/** 棘轮断言：基线内允许（且不得超过记录次数），基线外出现即失败 */
function checkRatchet(label, hits, baseline) {
  const counts = new Map();
  for (const hit of hits) counts.set(hit.file, (counts.get(hit.file) || 0) + 1);
  const offenders = [];
  for (const [file, count] of counts) {
    const allowed = baseline[file] || 0;
    if (count > allowed) offenders.push(`${file} ×${count}（基线 ${allowed}）`);
  }
  check(label, offenders.length === 0, offenders.join('；'));
  if (offenders.length) {
    for (const hit of hits) {
      if (!baseline[hit.file] || counts.get(hit.file) > baseline[hit.file]) {
        console.log(`        ${hit.file}:${hit.line}  ${hit.text}`);
      }
    }
  }
}

section('1. src/hooks 不得 import @/components（B2 已清零）');
const hooksToComponentsHits = scan(hooksFiles, /from ['"]@\/components/);
check(
  'hooks → components 为 0 处',
  hooksToComponentsHits.length === 0,
  hooksToComponentsHits.map((h) => `${h.file}:${h.line}`).join('；')
);
for (const hit of hooksToComponentsHits) console.log(`        ${hit.file}:${hit.line}  ${hit.text}`);

section('2. src/lib 不得 import 上层聚合 barrel @/utils');
const libBarrelHits = scan(libFiles, /from ['"]@\/utils['"]/);
check(
  'lib → @/utils 为 0 处',
  libBarrelHits.length === 0,
  libBarrelHits.map((h) => `${h.file}:${h.line}`).join('；')
);
for (const hit of libBarrelHits) console.log(`        ${hit.file}:${hit.line}  ${hit.text}`);

section('3. src/lib 不得 import @/components（类型也应下沉到 @/types 或 @/lib）');
const libToComponentsHits = scan(libFiles, /from ['"]@\/components/);
check(
  'lib → components 为 0 处',
  libToComponentsHits.length === 0,
  libToComponentsHits.map((h) => `${h.file}:${h.line}`).join('；')
);
for (const hit of libToComponentsHits) console.log(`        ${hit.file}:${hit.line}  ${hit.text}`);

section('4. src/components 不得直接调用 window.electronAPI（基线内允许，B3 清零）');
checkRatchet(
  'components 直连 IPC 无新增违规',
  scan(componentFiles, /window\.electronAPI/),
  BASELINE.componentsUseIpc
);

section('5. electron/main/*.cjs 不得反向 require 入口 main.js');
const backRefs = scan(mainModuleFiles, /require\(\s*[`'"][^`'"]*main\.js/);
check(
  '主进程模块无反向依赖',
  backRefs.length === 0,
  backRefs.map((h) => `${h.file}:${h.line}`).join('；')
);
for (const hit of backRefs) console.log(`        ${hit.file}:${hit.line}  ${hit.text}`);

section('6. 守卫自身有效（防止目录改名后静默通过）');
check(
  '已扫描到 hooks / lib / components / electron 模块',
  hooksFiles.length > 0 &&
    libFiles.length > 0 &&
    componentFiles.length > 0 &&
    mainModuleFiles.length > 0
);

process.exit(summary() === 0 ? 0 : 1);
