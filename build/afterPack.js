const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * 打包后瘦身（macOS）。
 *
 * 1) Electron 默认携带 80+ 套本地化资源（约 40MB），实际只用得到简体中文与英文；
 * 2) Chromium 的 Vulkan 软件渲染后端 SwiftShader（约 16MB）在本应用中不会被用到 ——
 *    渲染只走 Canvas 2D 与系统视频解码，没有 WebGL / 3D 场景。
 *
 * 若将来接入 WebGL，把 REMOVE_FRAMEWORK_FILES 清空即可恢复。
 *
 * 瘦身会删掉 Electron Framework 内部文件，破坏它自带的 ad-hoc 签名；
 * 未签名 + 浏览器下载带的隔离属性会让 Gatekeeper 直接报「已损坏」（右键打开也无效），
 * 而不是提示「无法验证开发者」。因此瘦身后必须重新做一次 ad-hoc 签名。
 * ad-hoc 不需要证书，不改变「不签名 / 不公证」的定位，只是让包重新变成合法签名。
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

  // 必须在瘦身之后重签：删除框架内文件会让原有签名失效
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'pipe' });
    console.log('[afterPack] 已重新进行 ad-hoc 签名');
  } catch (error) {
    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    throw new Error(`[afterPack] ad-hoc 重签失败：${detail}`, { cause: error });
  }
};
