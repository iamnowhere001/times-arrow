import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  photoTakenTime,
  photoOriginalTime,
  calendarDayKey,
  hasUsableTime,
} from '@/lib/media/photoTime';
import { makePhoto, localTime } from './fixtures';
import { compareByOriginalTime } from '@/utils';

/**
 * P2-18 的验收测试：照片时间语义必须只有一个入口。
 *
 * 改造前「取有效时间」的回退链在 12 处各自内联，且存在**两种不同定义**：
 *   2 级 `dateTaken → lastModified`        用于分组 / 筛选 / 排序 / 时间线
 *   3 级 `dateTaken → dateCreated → lastModified`  用于原图判定 / 日期修正
 *
 * 这组用例守住三件事：
 *   1. 两种语义各自的取值正确，且**差异是刻意的、被测试记录的**
 *   2. 日历日 key 用本地日界（不能用 UTC 日界）
 *   3. **静态断言**：源码里不再出现内联的回退链（防止日后重新长出来）
 */

describe('photoTakenTime（2 级：拍摄 → 修改）', () => {
  it('有拍摄时间时优先用拍摄时间', () => {
    expect(photoTakenTime(makePhoto({ id: 'a', dateTaken: 111, lastModified: 999 }))).toBe(111);
  });

  it('无拍摄时间时回退到修改时间', () => {
    expect(photoTakenTime(makePhoto({ id: 'a', dateTaken: 0, lastModified: 999 }))).toBe(999);
    expect(photoTakenTime(makePhoto({ id: 'a', lastModified: 999 }))).toBe(999);
  });

  it('两者都缺失时返回 0（调用方据此判定「无时间」）', () => {
    expect(photoTakenTime(makePhoto({ id: 'a', dateTaken: 0, lastModified: 0 }))).toBe(0);
  });

  it('刻意忽略 dateCreated —— 这是与 photoOriginalTime 的区别所在', () => {
    const photo = makePhoto({ id: 'a', dateCreated: 555, lastModified: 999 });
    expect(photoTakenTime(photo)).toBe(999);
    expect(photoOriginalTime(photo)).toBe(555);
  });
});

describe('photoOriginalTime（3 级：拍摄 → 创建 → 修改）', () => {
  it('按优先级依次回退', () => {
    expect(photoOriginalTime(makePhoto({ id: 'a', dateTaken: 1, dateCreated: 2, lastModified: 3 }))).toBe(1);
    expect(photoOriginalTime(makePhoto({ id: 'a', dateCreated: 2, lastModified: 3 }))).toBe(2);
    expect(photoOriginalTime(makePhoto({ id: 'a', lastModified: 3 }))).toBe(3);
    expect(photoOriginalTime(makePhoto({ id: 'a' }))).toBe(0);
  });

  /**
   * ⚠️ 这里记录一条**容易被误解**的限制（已在 CODE_REVIEW 附录 C 记录）：
   *
   * 回退链 `dateTaken || dateCreated || lastModified` **无法区分「共享 EXIF 拍摄时间的拷贝」** ——
   * 两张拷贝的拍摄时间相同，链式求值在第一步就返回了，`dateCreated` 根本没被用到。
   * 而「拷贝件会继承 EXIF 拍摄时间」正是重复检测里最典型的场景。
   *
   * 所以重复检测用的是**逐字段比较**的 `compareByOriginalTime`，而不是这个回退链。
   * 两者不等价，且这一条测试就是它们差异的实证。
   */
  it('回退链无法区分共享 EXIF 的拷贝 —— 这正是 compareByOriginalTime 存在的理由', () => {
    const original = makePhoto({ id: 'o', dateTaken: 1000, dateCreated: 2000, lastModified: 3000 });
    const copy = makePhoto({ id: 'c', dateTaken: 1000, dateCreated: 5000, lastModified: 6000 });

    // 2 级链：相同（拍摄时间一样）
    expect(photoTakenTime(original)).toBe(photoTakenTime(copy));
    // 3 级链：**也**相同 —— 回退链在第一步就返回了，走不到 dateCreated
    expect(photoOriginalTime(original)).toBe(photoOriginalTime(copy));

    // 只有逐字段比较才能区分
    expect(compareByOriginalTime(original, copy)).toBeLessThan(0);
  });

  it('回退链在「无拍摄时间」时确实会用到 dateCreated', () => {
    const a = makePhoto({ id: 'a', dateCreated: 2000, lastModified: 9000 });
    const b = makePhoto({ id: 'b', dateCreated: 5000, lastModified: 9000 });
    expect(photoOriginalTime(a)).toBe(2000);
    expect(photoOriginalTime(a)).toBeLessThan(photoOriginalTime(b));
    // 此时 2 级链会把两者都算成 9000（分不出先后）
    expect(photoTakenTime(a)).toBe(photoTakenTime(b));
  });
});

describe('两种语义的差异是刻意且可枚举的', () => {
  it('仅当「无拍摄时间、但有创建时间」时两者才不同', () => {
    const cases: Array<[string, Parameters<typeof makePhoto>[0], boolean]> = [
      ['有拍摄时间', { id: 'x', dateTaken: 1, dateCreated: 2, lastModified: 3 }, false],
      ['无拍摄有创建', { id: 'x', dateCreated: 2, lastModified: 3 }, true],
      ['无拍摄无创建', { id: 'x', lastModified: 3 }, false],
      ['全缺失', { id: 'x' }, false],
    ];
    for (const [label, overrides, shouldDiffer] of cases) {
      const photo = makePhoto(overrides);
      const differs = photoTakenTime(photo) !== photoOriginalTime(photo);
      expect(differs, `「${label}」的差异判断不符预期`).toBe(shouldDiffer);
    }
  });
});

describe('calendarDayKey（本地日历日）', () => {
  it('同一天的不同时刻得到同一个 key', () => {
    expect(calendarDayKey(localTime(2024, 5, 20, 0, 0, 1))).toBe(calendarDayKey(localTime(2024, 5, 20, 23, 59, 59)));
  });

  it('相邻两天得到不同 key', () => {
    expect(calendarDayKey(localTime(2024, 5, 20, 23))).not.toBe(calendarDayKey(localTime(2024, 5, 21, 1)));
  });

  it('用本地日界而不是 UTC 日界（东八区的经典陷阱）', () => {
    // 同一天 23:00 与次日 01:00：若用 floor(ts/86400000) 会落进同一个 UTC 日
    const late = localTime(2024, 3, 10, 23);
    const early = localTime(2024, 3, 11, 1);
    expect(Math.floor(late / 86400000)).toBe(Math.floor(early / 86400000)); // UTC 下确实同一天
    expect(calendarDayKey(late)).not.toBe(calendarDayKey(early)); // 本地日历日必须分开
  });

  it('key 是可比较的紧凑数字（yyyymmdd）', () => {
    expect(calendarDayKey(localTime(2024, 3, 5))).toBe(20240305);
    expect(calendarDayKey(localTime(2024, 12, 31))).toBe(20241231);
    // 时间上更晚 → key 更大，可直接比较
    expect(calendarDayKey(localTime(2024, 3, 5))).toBeLessThan(calendarDayKey(localTime(2024, 3, 6)));
  });
});

describe('hasUsableTime', () => {
  it('0 与 NaN 都视为不可用', () => {
    expect(hasUsableTime(0)).toBe(false);
    expect(hasUsableTime(NaN)).toBe(false);
  });

  it('正常时间戳可用', () => {
    expect(hasUsableTime(1)).toBe(true);
    expect(hasUsableTime(localTime(2024, 1, 1))).toBe(true);
  });

  it('不能只写 !ts —— NaN 会让它漏判', () => {
    // 这条钉住实现细节：`!NaN` 为 true，所以判断必须显式排除 NaN
    expect(!NaN).toBe(true);
    expect(hasUsableTime(NaN)).toBe(false);
  });
});

describe('静态断言：回退链不得在调用点重新内联', () => {
  /** 递归收集 src 下的 .ts/.tsx */
  function collectSourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) collectSourceFiles(full, acc);
      else if (/\.tsx?$/.test(entry)) acc.push(full);
    }
    return acc;
  }

  const SRC = resolve(__dirname, '../../src');
  const files = collectSourceFiles(SRC);

  it('扫描到了源码（否则断言会变成空转）', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('没有任何文件再内联 `dateTaken || lastModified` 这类回退链', () => {
    const offenders: string[] = [];
    for (const file of files) {
      // 允许 photoTime.ts 自己定义（它就是唯一入口）
      if (file.endsWith('photoTime.ts')) continue;
      const source = readFileSync(file, 'utf8');
      for (const line of source.split('\n')) {
        const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
        if (/dateTaken\s*\|\|\s*(?:photo\.)?(?:dateCreated\s*\|\|\s*)?lastModified/.test(code)) {
          offenders.push(`${file.replace(SRC, 'src')}: ${line.trim()}`);
        }
      }
    }
    expect(
      offenders,
      `以下位置又内联了时间回退链，请改用 @/lib/media/photoTime 的 photoTakenTime / photoOriginalTime：\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('photoGrouping 与 filters 都从 photoTime 取值（分组与筛选口径一致）', () => {
    for (const rel of ['lib/media/photoGrouping.ts', 'lib/filter/filters.ts']) {
      const source = readFileSync(join(SRC, rel), 'utf8');
      expect(source, `${rel} 应当从 photoTime 引入时间语义`).toMatch(
        /from '@\/lib\/media\/photoTime'/
      );
    }
  });
});
