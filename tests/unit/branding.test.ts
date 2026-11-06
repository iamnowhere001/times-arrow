import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 品牌口径的静态断言（v0.6.2 · P0-4，2026-11-06 拍板）。
 *
 * 这组用例守的不是「文案好看」，而是两条会真实伤到用户的边界：
 *   1. 导出文件里的 `app: 'PhotoMinder'` 是**格式标识**，不是显示名。改了它，
 *      v0.6.1 及更早导出的备份会被 `import-config` 判成「不是本应用的文件」。
 *   2. `productName` / `appId` 决定 macOS 的 `.app` 名与
 *      `~/Library/Application Support/PhotoMinder/` 数据目录。改了它们，
 *      现有 config.json / 收藏 / 标签 / 相簿全部失联 —— 比品牌分裂严重得多。
 *
 * 所以「显示名统一为时光画框」只作用于用户看得见的文案，不碰这两个标识。
 */
const ROOT = resolve(import.meta.dirname, '../..');
const read = (relative: string) => readFileSync(resolve(ROOT, relative), 'utf8');

describe('品牌口径（P0-4）', () => {
  it('窗口标题与侧栏显示名统一为「时光画框」', () => {
    expect(read('index.html')).toContain('<title>时光画框</title>');
    expect(read('src/components/layout/Sidebar.tsx')).toContain('时光画框');
  });

  it('副标题改为「本地照片整理工作台」，不再承诺自动归档', () => {
    const sidebar = read('src/components/layout/Sidebar.tsx');
    expect(sidebar).toContain('本地照片整理工作台');
    expect(sidebar).not.toContain('按时间线自动归档');
  });

  it('配置导入导出对话框用显示名', () => {
    const dataAssets = read('electron/main/data-assets.cjs');
    expect(dataAssets).toContain("title: '导出时光画框配置'");
    expect(dataAssets).toContain("title: '导入时光画框配置'");
    expect(dataAssets).toContain("defaultPath: '时光画框-config.json'");
  });

  it('导出格式标识保持 PhotoMinder，旧备份仍可导入', () => {
    const dataAssets = read('electron/main/data-assets.cjs');
    expect(dataAssets).toContain("app: 'PhotoMinder'");
    expect(dataAssets).toContain("payload.app !== 'PhotoMinder'");
  });

  it('productName / appId 保持英文，避免 userData 目录迁移', () => {
    const pkg = JSON.parse(read('package.json')) as {
      build: { productName: string; appId: string };
    };
    expect(pkg.build.productName).toBe('PhotoMinder');
    expect(pkg.build.appId).toBe('com.photominder.app');
  });
});
