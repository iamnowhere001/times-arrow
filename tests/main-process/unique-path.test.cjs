/**
 * 唯一路径占位的原子性测试（P1-7 / C1）。
 *
 * 核心断言不是「函数返回了不冲突的名字」，而是「并发落盘时没有一个文件被覆盖」——
 * 旧的 existsSync 探测 + 再写实现在第 1 组用例下必然失败，新实现必须全绿。
 *
 * 运行：npm run test:main
 */
const fs = require('fs');
const path = require('path');
const { loadMainProcess, createChecker, tempDir } = require('./harness.cjs');

const { call } = loadMainProcess();
const { check, section, summary } = createChecker();

(async () => {
  const dir = tempDir('pm-atomic-');
  await call('authorize-paths', [dir]);

  section('1. 并发导出同名文件：必须全部落盘且互不覆盖');
  const N = 12;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      call('write-file-unique', dir, 'photo.jpg', Buffer.from(`CONTENT-${i}`).toString('base64'))
    )
  );
  const okResults = results.filter((r) => r && r.ok);
  check(`全部 ${N} 次写入成功`, okResults.length === N, `实际 ${okResults.length}`);
  const paths = okResults.map((r) => r.data.path);
  check('返回的路径互不相同', new Set(paths).size === N, `去重后 ${new Set(paths).size}`);
  const onDisk = fs.readdirSync(dir);
  check(
    `磁盘上恰好 ${N} 个文件（无覆盖、无多余占位）`,
    onDisk.length === N,
    `实际 ${onDisk.length}`
  );
  const contents = new Set(onDisk.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')));
  check('每个文件内容都保留下来了（无内容丢失）', contents.size === N, `去重后 ${contents.size}`);
  const empty = onDisk.filter((f) => fs.statSync(path.join(dir, f)).size === 0);
  check('没有遗留 0 字节的占位文件', empty.length === 0, empty.join(', '));

  section('2. 重命名冲突：追加序号而不是覆盖');
  const src = path.join(dir, 'rename-src.jpg');
  fs.writeFileSync(src, 'SRC');
  const taken = path.join(dir, 'rename-target.jpg');
  fs.writeFileSync(taken, 'ORIGINAL-MUST-SURVIVE');
  await call('authorize-paths', [src]);
  const rn = await call('rename-file', src, taken);
  check('重命名返回成功', rn.ok === true, JSON.stringify(rn));
  check('标记为发生冲突', rn.ok && rn.data.conflicted === true, JSON.stringify(rn));
  check(
    '占用了 -1 结尾的新名字',
    rn.ok && /-1\.jpg$/.test(rn.data.path || ''),
    rn.ok && rn.data.path
  );
  check('原文件内容未被覆盖', fs.readFileSync(taken, 'utf8') === 'ORIGINAL-MUST-SURVIVE');
  check('源文件已改名', rn.ok && !fs.existsSync(src) && fs.existsSync(rn.data.path));

  section('3. 重命名到「尚不存在」的目标：不应被判为未授权');
  // 回归用例：canonicalize 曾对不存在的路径退化成 path.resolve，
  // 在 macOS（/var → /private/var 软链）上会与授权根的规范形式对不上，导致合法重命名失败。
  const src2 = path.join(dir, 'plain-src.jpg');
  fs.writeFileSync(src2, 'PLAIN');
  const rn2 = await call('rename-file', src2, path.join(dir, 'plain-target.jpg'));
  check('无冲突时返回成功（不是「未授权」）', rn2.ok === true, JSON.stringify(rn2));
  check(
    '无冲突时 conflicted 为 false',
    rn2.ok && rn2.data.conflicted === false,
    JSON.stringify(rn2)
  );
  check(
    '目标路径就是请求的路径',
    rn2.ok && rn2.data.path === path.join(dir, 'plain-target.jpg'),
    rn2.ok && rn2.data.path
  );
  check('内容正确', rn2.ok && fs.readFileSync(rn2.data.path, 'utf8') === 'PLAIN');

  section('4. 重命名到自身（仅大小写变化）不应误判为冲突');
  const caseFile = path.join(dir, 'CaseTest.jpg');
  fs.writeFileSync(caseFile, 'CASE');
  const rn3 = await call('rename-file', caseFile, caseFile);
  check(
    '重命名到自身返回成功且不冲突',
    rn3.ok === true && rn3.data.conflicted === false,
    JSON.stringify(rn3)
  );
  check(
    '文件仍在且内容完好',
    fs.existsSync(caseFile) && fs.readFileSync(caseFile, 'utf8') === 'CASE'
  );

  section('5. 批量移动同名文件：不互相覆盖');
  const srcDir = tempDir('pm-movesrc-');
  const dstDir = tempDir('pm-movedst-');
  const movers = [];
  for (let i = 0; i < 5; i += 1) {
    const p = path.join(srcDir, `sub${i}`, 'same.jpg');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `MOVED-${i}`);
    movers.push(p);
  }
  await call('authorize-paths', [srcDir, dstDir]);
  const mv = await call('move-files', movers, dstDir);
  check('整体返回成功', mv.ok === true, JSON.stringify(mv).slice(0, 200));
  const mvOk = mv.ok ? mv.data.results.filter((r) => r.success) : [];
  check('5 个文件全部移动成功', mvOk.length === 5, JSON.stringify(mv.ok ? mv.data.results : mv));
  const dstFiles = fs.readdirSync(dstDir);
  check('目标目录恰好 5 个文件', dstFiles.length === 5, dstFiles.join(', '));
  const dstContents = new Set(dstFiles.map((f) => fs.readFileSync(path.join(dstDir, f), 'utf8')));
  check('5 份内容都在（无覆盖）', dstContents.size === 5, [...dstContents].join(' | '));

  section('6. 单次写入不产生多余文件');
  const before = fs.readdirSync(dir).length;
  const w = await call('write-file-unique', dir, 'single.jpg', Buffer.from('X').toString('base64'));
  check('单次写入成功', w.ok === true, JSON.stringify(w));
  check('文件数只 +1', fs.readdirSync(dir).length === before + 1);

  process.exit(summary() === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
