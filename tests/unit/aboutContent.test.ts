import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ABOUT_CONTENT, LATEST_RELEASE } from '@/lib/about/aboutContent';

/**
 * 「关于与更新」页的内容护栏（v0.6.5）。
 *
 * 内容是以静态 TS 打包进 dist 的摘要（md 不在 build.files 白名单里，运行时读不到），
 * 所以最容易出的事故是「发了新版但忘了补更新记录」——这里用 package.json 的版本号守住。
 */
const ROOT = resolve(import.meta.dirname, '../..');
const read = (relative: string) => readFileSync(resolve(ROOT, relative), 'utf8');
const pkg = JSON.parse(read('package.json')) as { version: string };

const compare = (a: string, b: string): number => {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

describe('关于页内容', () => {
  it('更新记录第一条与 package.json 版本一致', () => {
    expect(LATEST_RELEASE.version).toBe(pkg.version);
  });

  it('更新记录按版本降序且不重复', () => {
    const versions = ABOUT_CONTENT.releases.map((item) => item.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (let i = 1; i < versions.length; i += 1) {
      expect(compare(versions[i - 1], versions[i])).toBeGreaterThan(0);
    }
  });

  it('每条更新记录都有日期与至少一条要点', () => {
    for (const release of ABOUT_CONTENT.releases) {
      expect(release.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(release.highlights.length).toBeGreaterThan(0);
      for (const line of release.highlights) expect(line.trim().length).toBeGreaterThan(0);
    }
  });

  it('迭代计划的状态合法且字段完整', () => {
    expect(ABOUT_CONTENT.roadmap.length).toBeGreaterThan(0);
    for (const item of ABOUT_CONTENT.roadmap) {
      expect(['已完成', '进行中', '计划中']).toContain(item.status);
      expect(item.version).toMatch(/^v\d+\.\d+(\.\d+)?$/);
      expect(item.theme.trim().length).toBeGreaterThan(0);
      expect(item.summary.trim().length).toBeGreaterThan(0);
    }
  });

  it('功能 / 特色 / 技巧 / 承诺都有标题与说明', () => {
    for (const group of [
      ABOUT_CONTENT.promises,
      ABOUT_CONTENT.features,
      ABOUT_CONTENT.highlights,
      ABOUT_CONTENT.tips,
    ]) {
      expect(group.length).toBeGreaterThan(0);
      for (const entry of group) {
        expect(entry.title.trim().length).toBeGreaterThan(0);
        expect(entry.description.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('关于页不直连 IPC，颜色只用语义令牌', () => {
    const source = read('src/components/about/AboutView.tsx');
    expect(source).not.toContain('window.electronAPI');
    // 十六进制色值会绕开主题令牌，深浅主题切换时必然穿帮
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
