/**
 * K11：重命名预览的只读预演（probe-rename-targets）。
 *
 * 最重要的断言是最后一节：**预演给出的最终文件名，必须等于真正 rename-file 落盘后的名字**。
 * 预览与落盘过去各有一套重名规则（_1 vs -1），这条链路断了，用户就会看到
 * 「预览 照片_001.jpg、实际 照片_001-1.jpg」。
 *
 * 同时守住安全边界：新增的接收路径 IPC 必须做白名单校验，且只读、不产生占位文件。
 *
 * 运行：npm run test:main
 */
const fs = require('fs');
const path = require('path');
const { loadMainProcess, createChecker, tempDir } = require('./harness.cjs');

const { call } = loadMainProcess();
const { check, section, summary } = createChecker();

(async () => {
  const dir = tempDir('pm-rename-probe-');
  const outside = tempDir('pm-rename-outside-');
  await call('authorize-paths', [dir]);

  const mk = (name, content = 'x') => {
    const full = path.join(dir, name);
    fs.writeFileSync(full, content);
    return full;
  };
  const want = (name) => path.join(dir, name);

  section('1. 无冲突 / 目标就是源自身');
  const src = mk('a.jpg');
  let r = await call('probe-rename-targets', [{ oldPath: src, desiredPath: want('照片_001.jpg') }]);
  check('返回成功且条数对齐', r.ok === true && r.data.length === 1, JSON.stringify(r));
  check('原名可用', r.ok && r.data[0].finalName === '照片_001.jpg' && !r.data[0].conflicted);

  const self = mk('self.jpg');
  r = await call('probe-rename-targets', [{ oldPath: self, desiredPath: self }]);
  check('改名到自身不算冲突', r.ok && r.data[0].finalName === 'self.jpg' && !r.data[0].conflicted);

  section('2. 磁盘上已被占用的名字按 -N 递进');
  mk('照片_002.jpg');
  r = await call('probe-rename-targets', [
    { oldPath: mk('b.jpg'), desiredPath: want('照片_002.jpg') },
  ]);
  check(
    '占用一次得到 -1',
    r.ok && r.data[0].finalName === '照片_002-1.jpg',
    JSON.stringify(r.data)
  );
  check('标记为冲突', r.ok && r.data[0].conflicted === true);

  mk('照片_003.jpg');
  mk('照片_003-1.jpg');
  r = await call('probe-rename-targets', [
    { oldPath: mk('c.jpg'), desiredPath: want('照片_003.jpg') },
  ]);
  check(
    '连续占用得到 -2',
    r.ok && r.data[0].finalName === '照片_003-2.jpg',
    JSON.stringify(r.data)
  );

  section('3. 批内占用与顺序语义');
  const c1 = mk('c1.jpg');
  const c2 = mk('c2.jpg');
  r = await call('probe-rename-targets', [
    { oldPath: c1, desiredPath: want('batch.jpg') },
    { oldPath: c2, desiredPath: want('batch.jpg') },
  ]);
  check(
    '同批两个相同目标，第二个加 -1',
    r.ok && r.data[0].finalName === 'batch.jpg' && r.data[1].finalName === 'batch-1.jpg',
    JSON.stringify(r.data)
  );

  const chainA = mk('chain-a.jpg');
  const chainB = mk('chain-b.jpg');
  r = await call('probe-rename-targets', [
    { oldPath: chainA, desiredPath: want('chain-new.jpg') },
    { oldPath: chainB, desiredPath: chainA },
  ]);
  check(
    '前一条改名后旧路径腾空，后一条不误加 -1',
    r.ok && r.data[1].finalName === 'chain-a.jpg' && !r.data[1].conflicted,
    JSON.stringify(r.data)
  );

  section('4. 只读：不写盘、不留占位文件');
  const before = fs.readdirSync(dir).length;
  await call('probe-rename-targets', [
    { oldPath: src, desiredPath: want('照片_002.jpg') },
    { oldPath: c1, desiredPath: want('new-name.jpg') },
  ]);
  check('探测前后目录条目数不变', fs.readdirSync(dir).length === before);
  check(
    '没有生成 0 字节占位文件',
    fs.readdirSync(dir).every((f) => fs.statSync(path.join(dir, f)).size > 0)
  );

  section('5. 路径白名单与参数校验');
  const outFile = path.join(outside, 'x.jpg');
  fs.writeFileSync(outFile, 'x');
  r = await call('probe-rename-targets', [
    { oldPath: src, desiredPath: want('ok.jpg') },
    { oldPath: outFile, desiredPath: path.join(outside, 'y.jpg') },
  ]);
  check('任一路径越界则整体失败', r.ok === false, JSON.stringify(r));
  check('不返回部分结果', r.data === undefined || r.data === null);

  r = await call('probe-rename-targets', [{ oldPath: src }]);
  check('缺字段被拒绝', r.ok === false, JSON.stringify(r));
  r = await call('probe-rename-targets', 'not-an-array');
  check('非数组被拒绝', r.ok === false);
  r = await call('probe-rename-targets', []);
  check('空数组返回空结果', r.ok === true && Array.isArray(r.data) && r.data.length === 0);
  const tooMany = Array.from({ length: 501 }, () => ({ oldPath: src, desiredPath: want('x.jpg') }));
  r = await call('probe-rename-targets', tooMany);
  check('超过 500 条被拒绝', r.ok === false, JSON.stringify(r));

  section('6. 预览 = 落盘（K11 的核心承诺）');
  mk('final.jpg', 'MUST-SURVIVE');
  const source = mk('source.jpg');
  const desired = want('final.jpg');
  const probe = await call('probe-rename-targets', [{ oldPath: source, desiredPath: desired }]);
  const renamed = await call('rename-file', source, desired);
  check('预演成功', probe.ok === true, JSON.stringify(probe));
  check('落盘成功', renamed.ok === true, JSON.stringify(renamed));
  check(
    '预演的最终文件名 === 真实落盘的文件名',
    probe.ok && renamed.ok && path.basename(renamed.data.path) === probe.data[0].finalName,
    `${probe.ok ? probe.data[0].finalName : '-'} vs ${renamed.ok ? path.basename(renamed.data.path) : '-'}`
  );
  check('原同名文件内容未被覆盖', fs.readFileSync(desired, 'utf8') === 'MUST-SURVIVE');

  summary();
})();
