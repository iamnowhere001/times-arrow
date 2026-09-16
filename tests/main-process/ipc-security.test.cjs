/**
 * 主进程安全边界与 IPC 协议的回归测试。
 *
 * 覆盖：
 *  1. 未授权路径在全部文件类 IPC 上被拒绝（P0 的路径白名单）
 *  2. pm:// 协议对未授权文件返回 403（P0）
 *  3. 六条授权链路确实生效（扫描 / 拖放 / 恢复来源 …）
 *  4. 体积闸门（P0）
 *  5. 文件名穿越防护（P0 + P1）
 *  6. 沙箱开关的静态断言（P0）
 *  7. **IPC 统一返回协议**：所有 handler 都返回 { ok } 形态，且异常被兜底（P1-8）
 *
 * 运行：npm run test:main
 */
const fs = require('fs');
const path = require('path');
const { loadMainProcess, createChecker, tempDir } = require('./harness.cjs');

const { call, pmFetch, trashCalls, openPathCalls, MAIN_ENTRY } = loadMainProcess();
const { check, section, summary } = createChecker();

// ---------------------------------------------------------------- 测试数据
const root = tempDir('pm-lib-');
const libDir = path.join(root, '图库');
fs.mkdirSync(libDir, { recursive: true });
const inside = path.join(libDir, 'a.jpg');
fs.writeFileSync(inside, 'JPEGDATA');
const nestedFile = path.join(libDir, 'sub', 'b.jpg');
fs.mkdirSync(path.dirname(nestedFile), { recursive: true });
fs.writeFileSync(nestedFile, 'NESTED');

// 未授权的「敏感」文件
const outsideDir = tempDir('pm-outside-');
const secret = path.join(outsideDir, 'secret.txt');
fs.writeFileSync(secret, 'TOP-SECRET-CONTENT');

// 超大文件（稀疏创建，不占实际空间）
const huge = path.join(outsideDir, 'huge.bin');
fs.writeFileSync(huge, '');
fs.truncateSync(huge, 65 * 1024 * 1024);

// 未授权目录里的图片（验证 pm:// 拦截）
const evilDir = tempDir('pm-evil-');
const evilImg = path.join(evilDir, 'evil.jpg');
fs.writeFileSync(evilImg, 'EVIL');

/** 断言一个返回体符合 IpcResult 协议 */
function isResult(r) {
  if (!r || typeof r !== 'object') return false;
  if (typeof r.ok !== 'boolean') return false;
  if (r.ok) return 'data' in r;
  return typeof r.error === 'string' && r.error.length > 0;
}

(async () => {
  section('0. IPC 统一返回协议：每个 handler 都返回 IpcResult');
  // 用「参数明显非法」的方式触发所有 handler，检查返回体形态而不是业务语义
  const probes = [
    ['read-file', []],
    ['delete-file', []],
    ['rename-file', []],
    ['move-files', []],
    ['show-in-folder', []],
    ['copy-image', []],
    ['copy-text', []],
    ['open-path', []],
    ['write-file-unique', []],
    ['scan-directory', []],
    ['get-thumbnail', []],
    ['cache-thumbnail', []],
    ['get-metadata', []],
    ['get-image-hashes', []],
    ['stat-files', []],
    ['check-paths', []],
    ['authorize-paths', []],
    ['watch-directory', []],
    ['select-paths', []],
    ['choose-directory', []],
    ['load-config', []],
    ['save-config', []],
    ['load-ai-cache', []],
    ['save-ai-cache', []],
    ['ai-analyze', []],
    ['ai-config-get', []],
    ['ai-config-set', []],
    ['ai-config-test', []],
    ['cancel-scan', []],
    ['unwatch-directory', []],
  ];
  let allResult = true;
  // 逐个 await 是刻意的：要按 handler 名归因，并发调用会让失败无法定位到具体通道
  /* eslint-disable no-await-in-loop */
  for (const [name, args] of probes) {
    let r;
    try {
      r = await call(name, ...args);
    } catch (e) {
      allResult = false;
      console.log(`    ${name} 抛出了异常（wrapHandler 未生效）: ${e.message}`);
      continue;
    }
    if (!isResult(r)) {
      allResult = false;
      console.log(`    ${name} 返回形态不符合 IpcResult: ${JSON.stringify(r).slice(0, 120)}`);
    }
  }
  /* eslint-enable no-await-in-loop */
  check(`${probes.length} 个 handler 全部返回 { ok } 形态`, allResult);

  section('1. 未授权路径：读 / 写 / 删 / 打开 全部拒绝');
  let r = await call('read-file', secret);
  check('read-file 拒绝未授权路径', !r.ok && /未授权/.test(r.error), JSON.stringify(r));
  check('read-file 未泄露内容', !(r.data || '').includes('TOP-SECRET'));

  r = await call('delete-file', secret);
  check('delete-file 拒绝未授权路径', !r.ok && /未授权/.test(r.error));
  check(
    'delete-file 未真正执行回收站操作',
    trashCalls.length === 0,
    'trashCalls=' + trashCalls.length
  );

  r = await call('open-path', secret);
  check('open-path 拒绝未授权路径', !r.ok && /未授权/.test(r.error));
  check('open-path 未真正调用 shell.openPath', openPathCalls.length === 0);

  r = await call('show-in-folder', secret);
  check('show-in-folder 拒绝未授权路径', !r.ok && /未授权/.test(r.error));

  r = await call('copy-image', secret);
  check('copy-image 拒绝未授权路径', !r.ok && /未授权/.test(r.error));

  r = await call('write-file-unique', outsideDir, 'x.txt', 'AAAA');
  check('write-file-unique 拒绝未授权目录', !r.ok && /未授权/.test(r.error));

  r = await call('get-metadata', secret);
  check('get-metadata 拒绝未授权路径', !r.ok && /未授权/.test(r.error));

  r = await call('get-thumbnail', secret, 320);
  check('get-thumbnail 拒绝未授权路径', !r.ok && /未授权/.test(r.error));

  r = await call('stat-files', [secret]);
  check(
    'stat-files 把未授权路径归入 failedPaths',
    r.ok && r.data.failedPaths.includes(secret),
    JSON.stringify(r)
  );

  r = await call('get-image-hashes', [secret]);
  check('get-image-hashes 对未授权路径返回 null', r.ok && r.data[0] === null, JSON.stringify(r));

  r = await call('rename-file', secret, path.join(outsideDir, 'renamed.txt'));
  check('rename-file 拒绝未授权源', !r.ok && /未授权/.test(r.error));

  r = await call('move-files', [secret], outsideDir);
  check(
    'move-files 拒绝未授权目标目录（整批拒绝）',
    !r.ok && /未授权/.test(r.error),
    JSON.stringify(r)
  );

  // 目标目录已授权、源未授权 → 只拒绝该条，其余不受影响
  const okTarget = tempDir('pm-target-');
  await call('authorize-paths', [okTarget]);
  await call('authorize-paths', [libDir]); // 合法源所在目录（本段早于第 3 节，需先授权）
  const okSource = path.join(libDir, 'movable.jpg');
  fs.writeFileSync(okSource, 'MOVABLE');
  r = await call('move-files', [secret, okSource], okTarget);
  check(
    'move-files 逐条拒绝未授权源',
    r.ok && /未授权/.test((r.data.results[0] || {}).error || ''),
    JSON.stringify(r)
  );
  check(
    'move-files 同批内的合法源仍然成功',
    r.ok && (r.data.results[1] || {}).success === true,
    JSON.stringify(r)
  );

  section('2. pm:// 协议：未授权文件被 403 拦截');
  let resp = await pmFetch(evilImg);
  check('pm://file 未授权返回 403', resp.status === 403, 'status=' + resp.status);
  resp = await pmFetch(secret);
  check('pm://file 未授权（敏感文件）返回 403', resp.status === 403, 'status=' + resp.status);

  section('3. 扫描即授权：授权后的目录可正常访问');
  const scan = await call('scan-directory', libDir, 'test-scan');
  check(
    'scan-directory 成功且 data.files 是数组',
    scan.ok && Array.isArray(scan.data.files),
    JSON.stringify(scan).slice(0, 200)
  );

  r = await call('read-file', inside);
  check('授权目录内文件可读', r.ok && !!r.data, JSON.stringify(r).slice(0, 160));

  resp = await pmFetch(inside);
  check('pm://file 授权文件返回 200', resp.status === 200, 'status=' + resp.status);

  r = await call('stat-files', [inside, nestedFile]);
  check(
    '授权目录内文件 stat 成功',
    r.ok && r.data.infos.length === 2,
    JSON.stringify(r).slice(0, 200)
  );

  r = await call('get-thumbnail', inside, 64);
  check(
    '授权目录内文件可取缩略图（不再因未授权被拒）',
    r.ok || !/未授权/.test(r.error),
    JSON.stringify(r).slice(0, 160)
  );

  section('4. 拖放授权入口');
  r = await call('authorize-paths', [nestedFile]);
  check('authorize-paths 返回成功', r.ok === true, JSON.stringify(r));
  r = await call('read-file', nestedFile);
  check('拖放授权后可读', r.ok && !!r.data, JSON.stringify(r).slice(0, 160));

  section('5. check-paths 授权（重启恢复图库链路）');
  const restored = path.join(root, '恢复的图库');
  fs.mkdirSync(restored, { recursive: true });
  const restoredFile = path.join(restored, 'c.jpg');
  fs.writeFileSync(restoredFile, 'RESTORED');
  const cp = await call('check-paths', [restored]);
  check('check-paths 报告存在', cp.ok && cp.data[restored] === true, JSON.stringify(cp));
  r = await call('read-file', restoredFile);
  check('恢复来源授权后可读', r.ok && !!r.data, JSON.stringify(r).slice(0, 160));

  section('6. 体积闸门');
  // 先授权 huge 所在目录，确保拦截原因是「体积」而不是「未授权」
  await call('authorize-paths', [outsideDir]);
  r = await call('read-file', huge);
  check('read-file 拒绝超大文件', !r.ok && /过大/.test(r.error), JSON.stringify(r).slice(0, 200));

  const bigBase64 = 'A'.repeat(21 * 1024 * 1024);
  r = await call('ai-analyze', { base64: bigBase64, mimeType: 'image/jpeg' });
  check(
    'ai-analyze 拒绝超大 payload',
    !r.ok && /过大/.test(r.error),
    JSON.stringify(r).slice(0, 200)
  );

  section('7. 文件名穿越防护');
  const wDir = tempDir('pm-write-');
  await call('authorize-paths', [wDir]);
  r = await call('write-file-unique', wDir, '../../escape.txt', 'AAAA');
  check(
    'write-file-unique 成功但被限制在目标目录内',
    r.ok && path.dirname(r.data.path) === wDir,
    'path=' + (r.data && r.data.path)
  );
  check('未在上级目录生成 escape.txt', !fs.existsSync(path.join(path.dirname(wDir), 'escape.txt')));

  section('8. 沙箱开关（静态断言）');
  const src = fs.readFileSync(MAIN_ENTRY, 'utf8');
  for (const flag of ['no-sandbox', 'disable-setuid-sandbox', 'disable-gpu-sandbox']) {
    // 用 ^ 锚定「顶格」= 无条件调用；缩进的（在 SANDBOX_DISABLED 分支内）不算
    check(
      `不存在无条件的 ${flag}`,
      !new RegExp(`^app\\.commandLine\\.appendSwitch\\('${flag}'\\);`, 'm').test(src)
    );
  }
  const guarded = (
    src.match(
      /app\.commandLine\.appendSwitch\('(?:no-sandbox|disable-setuid-sandbox|disable-gpu-sandbox)'\);/g
    ) || []
  ).length;
  check('三个开关都收敛在条件分支内（计数 3）', guarded === 3, '实际 ' + guarded);
  check('存在 PHOTOMINDER_DISABLE_SANDBOX 逃生口', /PHOTOMINDER_DISABLE_SANDBOX/.test(src));
  check('webPreferences.sandbox 与开关联动', /sandbox:\s*!SANDBOX_DISABLED/.test(src));

  section('9. IPC 注册纪律（静态断言）');
  // 只允许 wrapHandler 内部调用 ipcMain.handle，其余一律走 handle()
  const rawCalls = src.match(/^\s*ipcMain\.handle\(/gm) || [];
  check(
    '除 wrapHandler 外没有直接调用 ipcMain.handle',
    rawCalls.length === 1,
    '实际 ' + rawCalls.length + ' 处'
  );
  check('所有 handler 都经 handle() 注册', /function handle\(channel, handler\)/.test(src));
  check(
    'wrapHandler 捕获异常并转成 fail()',
    /catch \(error\) \{[\s\S]{0,200}?return fail\(/.test(src)
  );

  section('10. CSP 已装（静态断言）');
  check('主进程安装了 onHeadersReceived CSP', /onHeadersReceived/.test(src));
  // 注意要比的是**调用点**而不是定义点：`function setupContentSecurityPolicy() {` 里
  // 也含有 `setupContentSecurityPolicy()`，直接 indexOf 会比到函数定义上。
  // 另外源码注释里也出现过 "app.on('ready')"，因此必须锚定到真正的注册语句。
  const readyStart = src.indexOf("app.on('ready', () => {");
  const readyBlock = src.slice(readyStart, src.indexOf('\n});', readyStart));
  const cspCallAt = readyBlock.indexOf('\n  setupContentSecurityPolicy();');
  const windowCallAt = readyBlock.indexOf('createWindow()');
  check(
    'CSP 在创建窗口之前安装（同一 ready 回调内）',
    cspCallAt >= 0 && windowCallAt >= 0 && cspCallAt < windowCallAt,
    `readyStart=${readyStart} csp@${cspCallAt} window@${windowCallAt}`
  );
  const csp = require(path.join(path.dirname(MAIN_ENTRY), 'lib/csp.cjs'));
  check('生产策略不含 unsafe-inline 脚本', !/script-src[^;]*unsafe-inline/.test(csp.CSP_PROD));
  check('开发策略放行内联脚本（Vite 需要）', /script-src[^;]*unsafe-inline/.test(csp.CSP_DEV));
  check('meta 变体已剔除 frame-ancestors', !csp.CSP_PROD_META.includes('frame-ancestors'));

  section('11. 存储恢复通知的默认状态');
  // 真正「启动时已损坏」的场景见 storage-recovery.test.cjs ——
  // 那里必须在 require(main.js) 之前就把损坏文件放好，否则会被 ready 的预读缓存吃掉。
  const notices = await call('storage-notices');
  check('正常启动时不产生损坏通知', notices.ok && notices.data.length === 0, JSON.stringify(notices));

  process.exit(summary() === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
