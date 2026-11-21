#!/usr/bin/env node
/**
 * 从 build/icon-source.svg 生成 build/icon.icns。
 *
 * 为什么要脚本而不是直接丢一个 icns 进仓库：
 * 图标是矢量绘制的，改配色 / 改构图只需要动 SVG；把 10 个尺寸的渲染与打包
 * 固化成一步，避免「改了 SVG 忘了重新导出某个尺寸」导致 Dock 与 Finder 不一致。
 *
 * 依赖（均为系统或 Homebrew 提供的命令行工具，不进 package.json）：
 *   - rsvg-convert：`brew install librsvg`
 *   - iconutil：macOS 自带
 *
 * 用法：npm run icon:build
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUILD_DIR = __dirname;
const SOURCE = path.join(BUILD_DIR, 'icon-source.svg');
const TARGET = path.join(BUILD_DIR, 'icon.icns');

// iconset 的文件名是 iconutil 的硬约定：逻辑尺寸 + @2x 各一份
const VARIANTS = [
  { file: 'icon_16x16.png', size: 16 },
  { file: 'icon_16x16@2x.png', size: 32 },
  { file: 'icon_32x32.png', size: 32 },
  { file: 'icon_32x32@2x.png', size: 64 },
  { file: 'icon_128x128.png', size: 128 },
  { file: 'icon_128x128@2x.png', size: 256 },
  { file: 'icon_256x256.png', size: 256 },
  { file: 'icon_256x256@2x.png', size: 512 },
  { file: 'icon_512x512.png', size: 512 },
  { file: 'icon_512x512@2x.png', size: 1024 },
];

function main() {
  if (!fs.existsSync(SOURCE)) {
    throw new Error(`找不到图标源文件：${SOURCE}`);
  }

  try {
    execFileSync('rsvg-convert', ['--version'], { stdio: 'pipe' });
  } catch {
    throw new Error('缺少 rsvg-convert，请先执行：brew install librsvg');
  }

  // 用临时目录渲染，避免把中间产物留进 build/
  const iconsetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'photominder-icon-'));
  const iconset = path.join(iconsetDir, 'icon.iconset');
  fs.mkdirSync(iconset);

  try {
    for (const { file, size } of VARIANTS) {
      execFileSync('rsvg-convert', [
        '-w',
        String(size),
        '-h',
        String(size),
        SOURCE,
        '-o',
        path.join(iconset, file),
      ]);
    }

    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', TARGET]);
    const sizeKb = Math.round(fs.statSync(TARGET).size / 1024);
    console.log(`[icon] 已生成 ${path.relative(process.cwd(), TARGET)}（${sizeKb} KB）`);
  } finally {
    fs.rmSync(iconsetDir, { recursive: true, force: true });
  }
}

main();
