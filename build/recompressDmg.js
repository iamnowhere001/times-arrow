#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * 用 lzma（ULMO）重压 DMG。
 *
 * electron-builder 的 dmg.format 只允许到 ULFO/UDZO/ULDBZ 等，不支持 lzma，
 * 而 Electron Framework 主体是一个 ~190MB 的 Mach-O 二进制，lzma 对它的压缩率
 * 明显优于 zlib（实测同一份采样：zlib 49.8% / lzfse 48.9% / bzip2 45.1% / lzma 31.8%）。
 * 因此在 electron-builder 产出 UDZO 之后，再用 hdiutil convert 转成 ULMO。
 *
 * hdiutil convert 是「整卷」转换，会保留 App、/Applications 替身与 .DS_Store
 * 里记录的窗口布局，不会破坏 DMG 的拖拽安装体验。
 *
 * 失败时保留原 DMG 并以 0 退出 —— 压缩只是优化，不能让发布流程中断。
 */
const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const TARGET_FORMAT = 'ULMO';

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

function pickDmg() {
  if (!fs.existsSync(RELEASE_DIR)) return null;

  const { version } = require(path.join(ROOT, 'package.json'));
  const versionTag = String(version);
  const files = fs
    .readdirSync(RELEASE_DIR)
    .filter((name) => name.endsWith('.dmg') && !name.startsWith('.'))
    .map((name) => {
      const file = path.join(RELEASE_DIR, name);
      return { name, file, mtime: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) return null;
  // 只处理本次构建产出的包，避免误改 release/ 里的历史产物
  return files.find((f) => f.name.includes(versionTag)) || files[0];
}

function imageFormat(file) {
  const info = execFileSync('hdiutil', ['imageinfo', file], { encoding: 'utf8' });
  const match = /^Format:\s*(\S+)$/m.exec(info);
  return match ? match[1] : null;
}

function main() {
  if (process.platform !== 'darwin') {
    console.log(`[recompress-dmg] 非 macOS，跳过（当前：${process.platform}）`);
    return;
  }

  const target = pickDmg();
  if (!target) {
    console.log('[recompress-dmg] 未在 release/ 找到 DMG，跳过');
    return;
  }

  const before = fs.statSync(target.file).size;

  if (imageFormat(target.file) === TARGET_FORMAT) {
    console.log(`[recompress-dmg] ${target.name} 已是 ${TARGET_FORMAT}，跳过`);
    return;
  }

  const tmpDmg = path.join(os.tmpdir(), `photominder-${TARGET_FORMAT}-${process.pid}.dmg`);
  try {
    execFileSync(
      'hdiutil',
      ['convert', target.file, '-format', TARGET_FORMAT, '-o', tmpDmg, '-ov'],
      { stdio: 'pipe' }
    );

    const after = fs.statSync(tmpDmg).size;
    if (after >= before) {
      console.log(`[recompress-dmg] ${TARGET_FORMAT} 未带来收益（${mb(before)} → ${mb(after)}），保留原 DMG`);
      return;
    }

    fs.copyFileSync(tmpDmg, target.file);

    // blockmap 记录的是旧 DMG 的分块校验和，文件被替换后已失效，必须删掉，
    // 否则将来接入自动更新时会按错误的校验和下载。
    const blockmap = `${target.file}.blockmap`;
    if (fs.existsSync(blockmap)) fs.rmSync(blockmap);

    console.log(`[recompress-dmg] ${target.name}: ${mb(before)} → ${mb(after)}（-${(100 - (after / before) * 100).toFixed(1)}%）`);
  } catch (error) {
    console.warn(`[recompress-dmg] 压缩失败，保留原 DMG：${error.message}`);
  } finally {
    fs.rmSync(tmpDmg, { force: true });
  }
}

main();
