import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { arePlacesLoaded, getPlaces, loadPlaces, Place } from '@/lib/geo/places';
import { findNearestPlace } from '@/lib/geo/placeIndex';

/**
 * P2-27 的验收测试：地名数据外置为 JSON 并按需加载。
 *
 * 改造前 `places.ts` 是 1767 行的单文件，1731 条城市数据以字符串常量内嵌在
 * 逻辑旁边。两个问题：
 *   1. 数据与代码同目录同格式 —— 改查询逻辑要承担误伤数据的心理成本；
 *   2. **静态导入会被 Rollup 内联进主 chunk** —— 从不打开地图的用户也要在
 *      启动时解析这 50KB。
 *
 * 这组用例守住三件事：
 *   1. 数据本身（places.data.json）的形状与完整性；
 *   2. 加载语义：幂等、未就绪时不缓存「空结果」；
 *   3. **静态断言**：数据没有被重新内联回 `.ts`，也没有被静态导入。
 *
 * 注意用例顺序有意义：前两个 describe 断言「加载前」的状态，
 * 必须在任何一次 `loadPlaces()` 之前执行（vitest 在同一文件内按声明顺序串行跑）。
 */

describe('加载前：模块求值不应触发加载', () => {
  it('仅 import 模块不会把数据拉进来（否则按需加载形同虚设）', () => {
    expect(arePlacesLoaded()).toBe(false);
    expect(getPlaces()).toEqual([]);
  });

  it('查询返回 null 而不是抛错（地图标签按「查不到就跳过」写）', () => {
    expect(findNearestPlace(22.55, 114.06)).toBeNull();
  });

  it('未就绪时的「空结果」不会被写进缓存', () => {
    // 同一坐标连查两次：若实现把 null 缓存下来，加载完成后这里会永远查不出城市
    expect(findNearestPlace(22.55, 114.06)).toBeNull();
    expect(findNearestPlace(22.55, 114.06)).toBeNull();
  });
});

describe('加载语义', () => {
  it('并发调用共用同一个 Promise，完成后返回同一份数组', async () => {
    const first = loadPlaces();
    const second = loadPlaces();
    expect(first).toBe(second);

    const places = await first;
    expect(places.length).toBeGreaterThan(1000);
    expect(arePlacesLoaded()).toBe(true);
    expect(getPlaces()).toBe(places);
    // 已加载后再调用：同步返回同一份，不会重新读一次
    expect(await loadPlaces()).toBe(places);
  });

  it('数据到位后，之前查过的坐标能正常查回城市', () => {
    // 这条是上一条「不缓存空结果」的正向验证：同一个坐标必须能查出来了
    const nearest = findNearestPlace(22.55, 114.06);
    expect(nearest?.place.name).toBe('深圳');
    expect(nearest!.distanceKm).toBeLessThan(1);
  });
});

describe('places.data.json 数据完整性', () => {
  const DATA_PATH = resolve(__dirname, '../../src/lib/geo/places.data.json');
  const raw = JSON.parse(readFileSync(DATA_PATH, 'utf8')) as {
    source: string;
    sourceUrl: string;
    encoding: string[];
    note: string;
    places: unknown[];
  };

  it('头部元信息齐备（数据是自描述的，不靠代码里的注释解释格式）', () => {
    expect(raw.source).toContain('Natural Earth');
    expect(raw.sourceUrl).toMatch(/^https:\/\//);
    expect(raw.encoding).toEqual(['longitude', 'latitude', 'name', 'sub', 'rank']);
    expect(raw.note.length).toBeGreaterThan(20);
  });

  it('条数与「中国城镇 425 条」的口径一致（数据被截断会立刻暴露）', () => {
    // 这是数据快照而非行为契约：数据若有意重新生成，同步改这两个数即可
    expect(raw.places.length).toBe(1731);
    const withSub = raw.places.filter(
      (row) => Array.isArray(row) && typeof row[3] === 'string' && row[3].length > 0
    );
    expect(withSub.length).toBe(425);
  });

  it('每行都是 [经度, 纬度, 名称, 上级, 层级] 五元组，且取值合法', () => {
    // 逐行收集而不是逐行断言：1731 行 × 9 条断言会产生上万次 expect 调用，
    // 收集后一次性比对既快得多，失败时也能一次看清所有问题行。
    const offenders: string[] = [];
    for (const [index, row] of raw.places.entries()) {
      const where = `第 ${index + 1} 行`;
      if (!Array.isArray(row)) {
        offenders.push(`${where} 不是数组`);
        continue;
      }
      const cells = row as unknown[];
      if (cells.length !== 5) {
        offenders.push(`${where} 不是 5 元组（实际 ${cells.length} 项）`);
        continue;
      }
      const [longitude, latitude, name, sub, rank] = cells;
      if (typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
        offenders.push(`${where} 经度非法: ${String(longitude)}`);
      }
      if (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90) {
        offenders.push(`${where} 纬度非法: ${String(latitude)}`);
      }
      if (typeof name !== 'string' || name.length === 0) {
        offenders.push(`${where} 名称为空`);
      }
      if (typeof sub !== 'string') {
        offenders.push(`${where} 上级不是字符串`);
      }
      if (rank !== 1 && rank !== 2 && rank !== 3) {
        offenders.push(`${where} 层级非法: ${String(rank)}`);
      }
    }
    expect(offenders, `数据行不合法：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('加载后的形状与文件逐条一致（加载器没有悄悄丢字段或改数值）', () => {
    const places: readonly Place[] = getPlaces();
    // 一次性比对 1731 行，而不是每行 5 次断言
    const projected = places.map((place) => [
      place.longitude,
      place.latitude,
      place.name,
      place.sub,
      place.rank,
    ]);
    expect(projected).toEqual(raw.places);
  });
});

describe('静态断言：数据不得重新内联或静态导入', () => {
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

  it('没有任何文件静态导入 places.data.json（静态导入会被内联进主 chunk）', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (/from\s+['"][^'"]*places\.data\.json['"]/.test(source)) {
        offenders.push(file.replace(SRC, 'src'));
      }
    }
    expect(
      offenders,
      `以下文件静态导入了地名数据，会让它重新回到主 bundle；请改用 @/lib/geo/places 的 loadPlaces()：\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('动态 import 只有一个入口（lib/geo/places.ts），避免多处各自加载', () => {
    const sites: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (/import\(\s*['"][^'"]*places\.data\.json['"]\s*\)/.test(source)) {
        sites.push(file.replace(SRC, 'src'));
      }
    }
    expect(sites).toEqual(['src/lib/geo/places.ts']);
  });

  it('没有任何文件把城市数据行抄回源码', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const line of source.split('\n')) {
        // 结构化行 [114.06,22.55,"深圳",...] 与旧的管道行 114.06|22.55|深圳
        if (
          /^\s*\[\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*,\s*['"]/.test(line) ||
          /-?\d{1,3}\.\d+\|-?\d{1,3}\.\d+\|/.test(line)
        ) {
          offenders.push(`${file.replace(SRC, 'src')}: ${line.trim()}`);
        }
      }
    }
    expect(
      offenders,
      `以下位置又内联了地名数据，请写进 places.data.json：\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});
