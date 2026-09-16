import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as utils from '@/utils';

/**
 * P2-16 的验收测试：`@/utils` 必须只是一个**再导出**出口。
 *
 * 它原先是一个 1024 行的「什么都往里放」的文件。拆分之后，既有 `from '@/utils'`
 * 的引用一行都没改 —— 代价是这个 barrel 变成了一个隐式契约：一旦有人从里面
 * 删掉一个导出，或者顺手往里加一段实现，拆分就悄悄退化了。
 *
 * 这组用例守住两件事：
 *   1. 公开 API 集合完整（删导出会立刻失败）；
 *   2. barrel 里没有实现代码（只允许 import / export 语句与注释）。
 */

/** 拆分前 `@/utils` 对外暴露的全部符号 —— 迁移零破坏的底线 */
const EXPECTED_EXPORTS = [
  // 路径与文件名
  'folderOfPath',
  'extOfName',
  'pmFileUrl',
  // 媒体类型
  'IMAGE_EXTENSIONS',
  'VIDEO_EXTENSIONS',
  'isVideoName',
  'isImageName',
  'mediaKindOf',
  'mediaMimeType',
  'isVideoPhoto',
  'isVideoPlaybackUncertain',
  // 格式化
  'formatBytes',
  'formatDate',
  'formatVideoDuration',
  'formatDateForNaming',
  // 时间语义
  'photoOriginalTime',
  'photoTakenTime',
  'compareByOriginalTime',
  // 感知哈希
  'getImageHash',
  'getImageHashFast',
  'hammingDistance',
  'clearImageHashCache',
  'hashKeyOf',
  'getHashWithCache',
  // 文件名清理
  'looksLikeMojibake',
  'fixMojibakeOnce',
  'fixMojibake',
  'repairFileName',
  // 并发
  'mapWithConcurrency',
  // 重复检测
  'clusterBySize',
  'markRecommended',
  'findDuplicatePhotos',
  'isDuplicateScanAbort',
  'DuplicateScanAbortError',
  // File → base64
  'fileToBase64',
];

describe('@/utils 的公开 API 完整性', () => {
  it.each(EXPECTED_EXPORTS)('导出 %s', (name) => {
    expect(utils, `@/utils 不再导出 ${name}，拆分后的再导出漏了它`).toHaveProperty(name);
  });

  it('没有把内部实现误导出（如私有缓存对象）', () => {
    // 这些是模块内部状态，不该出现在公开 API 里
    for (const internal of ['imageHashCache', 'dateKeyCache', 'UnionFind']) {
      expect(utils, `${internal} 不该从 @/utils 暴露`).not.toHaveProperty(internal);
    }
  });

  it('函数类导出都是可调用的', () => {
    const fnNames = EXPECTED_EXPORTS.filter(
      (name) => !/^[A-Z_]+$/.test(name) && !name.endsWith('Error') && name !== 'DuplicateScanAbortError'
    ).filter((name) => typeof (utils as Record<string, unknown>)[name] === 'function');
    // 常量（Set / 正则等）不是函数，这里只要求「是函数的那些确实可调用」
    expect(fnNames.length).toBeGreaterThan(20);
    for (const name of fnNames) {
      expect(typeof (utils as Record<string, unknown>)[name]).toBe('function');
    }
  });
});

describe('@/utils 只做再导出', () => {
  const source = readFileSync(resolve(__dirname, '../../src/utils/index.ts'), 'utf8');

  it('文件里没有函数 / 类 / 常量的实现', () => {
    // 允许：import、export ... from、注释、空行。
    // 不允许：function 声明、class 声明、箭头函数赋值、const/let 定义。
    expect(source, 'barrel 里出现了函数实现').not.toMatch(/^\s*(?:export\s+)?function\s/m);
    expect(source, 'barrel 里出现了类实现').not.toMatch(/^\s*(?:export\s+)?class\s/m);
    expect(source, 'barrel 里出现了箭头函数实现').not.toMatch(/^\s*(?:export\s+)?const\s+\w+\s*=\s*(?:async\s*)?\(/m);
    expect(source, 'barrel 里出现了常量定义').not.toMatch(/^\s*(?:export\s+)?const\s+\w+\s*=\s*[^;]*;/m);
  });

  it('每一段语句都是 import 或 export', () => {
    // 按 `;` 切分而不是按行 —— 多行 `export { a, b } from '...'` 的成员行
    // 并不以 export 开头，逐行判断会把它们误判成实现代码。
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const statements = withoutComments
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);

    const offenders = statements.filter((statement) => !/^(?:import|export)\b/.test(statement));
    expect(offenders, `以下语句不是 import/export：\n${offenders.join('\n---\n')}`).toEqual([]);
  });

  it('文件规模回到合理区间（拆分前是 1024 行）', () => {
    const lines = source.split('\n').length;
    expect(lines, `barrel 又长到 ${lines} 行，可能有人往里加实现了`).toBeLessThan(120);
  });
});
