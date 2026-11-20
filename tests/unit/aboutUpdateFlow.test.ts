import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatBytes, formatPublishedAt } from '@/lib/about/updateFormat';

/**
 * 「关于与更新」交互护栏（v0.6.5 优化）。
 *
 * 交互决策不能被无声回退：整页必须自己完成更新全流程，不能悄悄退回
 * 「点按钮 → 弹面板」；自动检查开关也只能有一处，否则两处 UI 表达同一份状态。
 */
const ROOT = resolve(import.meta.dirname, '../..');
const read = (relative: string) => readFileSync(resolve(ROOT, relative), 'utf8');

describe('更新信息格式化', () => {
  it('无效体积返回空串', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatBytes(value)).toBe('');
    }
  });

  it('小于 100MB 保留一位，其余取整', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB');
  });

  it('缺失或非法的发布时间返回空串', () => {
    expect(formatPublishedAt()).toBe('');
    expect(formatPublishedAt('')).toBe('');
    expect(formatPublishedAt('not-a-date')).toBe('');
  });

  it('合法发布时间按本地日期展示', () => {
    expect(formatPublishedAt('2026-11-20T00:00:00Z')).toBe(
      new Date('2026-11-20T00:00:00Z').toLocaleDateString('zh-CN')
    );
  });
});

describe('关于页更新流程护栏', () => {
  it('整页的「检查更新」就地检查，不再中转弹窗', () => {
    // about 的 props 装配已抽到 AppViews（App 只做状态装配），因此扫这两个文件；
    // 写法也容忍两种：JSX 属性 `onCheckUpdate={...}` 与对象字面量 `onCheckUpdate: ...`。
    const wiring = [read('src/App.tsx'), read('src/components/layout/AppViews.tsx')].join('\n');
    expect(wiring).toMatch(/onCheckUpdate\s*[:=]\s*\{?\s*updateChecker\.checkNow/);
    expect(wiring).not.toMatch(/onCheckUpdate\s*[:=]\s*\{?\s*updateChecker\.openPanel/);
  });

  it('整页具备完整的下载与安装操作', () => {
    const about = read('src/components/about/AboutView.tsx');
    for (const action of [
      'onStartDownload',
      'onCancelDownload',
      'onOpenDownload',
      'onRevealDownload',
    ]) {
      expect(about).toContain(action);
    }
  });

  it('自动检查开关只在整页出现，菜单面板不重复', () => {
    const modal = read('src/components/modal/UpdateModal.tsx');
    expect(modal).not.toContain('onToggleAutoCheck');
    expect(modal).not.toContain('type="checkbox"');
    expect(read('src/components/about/AboutView.tsx')).toContain('onToggleAutoCheck');
  });

  it('关于页在前台时抑制重复 Toast', () => {
    const app = read('src/App.tsx');
    expect(app).toContain("isAboutActive: mainView === 'about'");
  });
});
