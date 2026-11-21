import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 品牌口径的静态断言（v0.6.2 · P0-4，2026-11-06 拍板；v0.6.7 扩展）。
 *
 * 这组用例守的不是「文案好看」，而是几条会真实伤到用户的边界：
 *   1. 导出文件里的 `app: 'PhotoMinder'` 是**格式标识**，不是显示名。改了它，
 *      v0.6.1 及更早导出的备份会被 `import-config` 判成「不是本应用的文件」。
 *   2. `productName` / `appId` 保持英文：前者决定 `.app` 文件名与 `userData` 的
 *      默认取值，后者决定 LaunchServices 的升级身份。
 *   3. `userData` 必须在主进程里**显式钉死**为英文路径 —— 显示名改成中文后
 *      `app.name` 会跟着变，若不钉死，数据目录会迁到 `Application Support/时光画框/`，
 *      既有 config.json / 收藏 / 标签 / 人脸特征全部失联。
 *   4. 图标由 `build/icon-source.svg` 单一源生成，`icon.icns` 不手改。
 *
 * 分工：显示名（含 Finder / Dock 下的中文名）走 `CFBundleDisplayName`，
 * 存储与包名走英文。两者由第 3 条断言强制解耦。
 */
const ROOT = resolve(import.meta.dirname, '../..');
const read = (relative: string) => readFileSync(resolve(ROOT, relative), 'utf8');

describe('品牌口径（P0-4）', () => {
  it('窗口标题与侧栏显示名统一为「时光画框」', () => {
    expect(read('index.html')).toContain('<title>时光画框</title>');
    expect(read('src/components/layout/Sidebar.tsx')).toContain('时光画框');
  });

  it('副标题「本地照片整理工作台」归到「关于与更新」，左栏只留名称', () => {
    // 2026-11-21：左栏顶带不再重复定位说明，副标题只在关于页出现一次。
    expect(read('src/lib/about/aboutContent.ts')).toContain("subtitle: '本地照片整理工作台'");
    const sidebar = read('src/components/layout/Sidebar.tsx');
    expect(sidebar).not.toContain('本地照片整理工作台');
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

  it('productName / appId 保持英文，避免包名与升级身份漂移', () => {
    const pkg = JSON.parse(read('package.json')) as {
      build: { productName: string; appId: string };
    };
    expect(pkg.build.productName).toBe('PhotoMinder');
    expect(pkg.build.appId).toBe('com.photominder.app');
  });

  it('Finder / Dock 下的显示名走 CFBundleDisplayName，且不碰 CFBundleName', () => {
    const pkg = JSON.parse(read('package.json')) as {
      build: { mac?: { extendInfo?: Record<string, string> } };
    };
    const info = pkg.build.mac?.extendInfo ?? {};
    expect(info.CFBundleDisplayName).toBe('时光画框');
    // CFBundleName 不能改：Electron 用它拼出自己的 Helper 进程名（`<CFBundleName> Helper.app`）。
    // 改成中文后会去找「时光画框 Helper.app」，而实际文件是「PhotoMinder Helper.app」，
    // 启动即 FATAL: Unable to find helper app（2026-11-21 实测崩溃过一次）。
    expect(info.CFBundleName).toBeUndefined();
  });

  it('userData 在主进程里显式钉死为英文路径，与显示名解耦', () => {
    const main = read('electron/main.js');
    expect(main).toContain(
      "app.setPath('userData', path.join(app.getPath('appData'), 'PhotoMinder'))"
    );
    // 钉死必须发生在第一次 getPath('userData') 之前，否则前面已经读到中文目录了
    expect(main.indexOf("app.setPath('userData'")).toBeLessThan(
      main.indexOf("app.getPath('userData')")
    );
  });

  it('图标以 build/icon-source.svg 为唯一源，产物是 build/icon.icns', () => {
    const pkg = JSON.parse(read('package.json')) as { build: { mac?: { icon?: string } } };
    expect(pkg.build.mac?.icon).toBe('build/icon.icns');
    expect(read('build/icon-source.svg')).toContain('viewBox="0 0 1024 1024"');
    expect(read('build/make-icon.cjs')).toContain("path.join(BUILD_DIR, 'icon-source.svg')");
  });
});
