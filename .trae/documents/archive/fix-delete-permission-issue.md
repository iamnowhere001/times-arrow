# 修复 macOS 删除图片功能计划

## 问题分析

用户想要将本地图片移入废纸篓，但遇到以下问题：

1. `shell.trashItem()` 导致 Electron 崩溃并显示诊断报告错误
2. `rm -f` 和 `mv` 命令提示 "Operation not permitted"

这是 macOS 权限问题，可能原因：

* Electron App Sandbox 权限限制

* 文件在受保护目录（如 iCloud Drive）

* SIP (System Integrity Protection) 限制

## 解决方案

### 步骤 1: 使用 AppleScript 移动文件到废纸篓

AppleScript 在 macOS 中有特殊权限，可以绕过很多限制。

```javascript
// 在 main.js 中使用 AppleScript
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

ipcMain.handle('delete-file', async (event, filePath) => {
  try {
    if (!filePath || typeof filePath !== 'string') {
      return { error: 'Invalid file path', success: false };
    }

    // 使用 AppleScript 移动到废纸篓
    const escapedPath = filePath.replace(/'/g, "'\\''");
    const script = `osascript -e 'tell application "Finder" to delete POSIX file "${escapedPath}"'`;

    await execPromise(script);
    return { success: true, error: null };
  } catch (error) {
    console.error('AppleScript error:', error);
    return { error: error.message, success: false };
  }
});
```

### 步骤 2: 修改 Electron 配置

在 `main.js` 中添加以下配置以获得完整权限：

```javascript
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-setuid-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('allow-file-access-from-files');
```

### 步骤 3: 修改 package.json 添加 macOS 特定配置

确保没有启用 App Sandbox，因为我们需要直接访问文件系统。

## 实施顺序

1. 首先尝试 AppleScript 方法（最可能成功）
2. 如果 AppleScript 失败，检查并调整 Electron 启动参数
3. 测试删除功能是否正常工作

## 预期结果

删除图片时应该能够：

* 使用 AppleScript 将文件移入废纸篓

* 不再出现诊断报告错误

* 不再出现 "Operation not permitted" 错误

