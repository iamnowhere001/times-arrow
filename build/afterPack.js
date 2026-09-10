const fs = require('fs');
const path = require('path');

/**
 * 打包后瘦身（macOS）。
 *
 * 1) Electron 默认携带 80+ 套本地化资源（约 40MB），实际只用得到简体中文与英文；
 * 2) Chromium 的 Vulkan 软件渲染后端 SwiftShader（约 16MB）在本应用中不会被用到 ——
 *    渲染只走 Canvas 2D 与系统视频解码，没有 WebGL / 3D 场景。
 *
 * 若将来接入 WebGL，把 REMOVE_FRAMEWORK_FILES 清空即可恢复。
 */
const KEEP_LOCALES = new Set(['en.lproj', 'zh_CN.lproj']);
const REMOVE_FRAMEWORK_FILES = ['libvk_swiftshader.dylib', 'vk_swiftshader_icd.json'];

exports.default = async (context) => {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const frameworkRoot = path.join(
    appPath,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Versions',
    'A'
  );
  const resourcesDir = path.join(frameworkRoot, 'Resources');
  const librariesDir = path.join(frameworkRoot, 'Libraries');

  let removedLocales = 0;
  try {
    for (const entry of fs.readdirSync(resourcesDir)) {
      if (entry.endsWith('.lproj') && !KEEP_LOCALES.has(entry)) {
        fs.rmSync(path.join(resourcesDir, entry), { recursive: true, force: true });
        removedLocales += 1;
      }
    }
  } catch (error) {
    console.warn(`[afterPack] 清理语言包失败: ${error.message}`);
  }

  for (const name of REMOVE_FRAMEWORK_FILES) {
    fs.rmSync(path.join(librariesDir, name), { force: true });
  }

  console.log(`[afterPack] 已移除 ${removedLocales} 套无用语言包与 SwiftShader`);
};
