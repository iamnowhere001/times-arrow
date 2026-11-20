/**
 * 应用菜单。
 *
 * 菜单只做一件事：把用户点击翻译成「窗口事件」或「调用一个已存在的函数」。
 * 业务逻辑一律留在渲染层或对应域模块 —— 菜单项里塞逻辑，会让「同一个动作
 * 从快捷键走」「从按钮走」两条路径各自演化。
 *
 * 两个容易踩的点：
 * 1. macOS 上关掉最后一个窗口后进程仍在运行（`window-all-closed` 不退出），
 *    此时从菜单导入会拿到空窗口 —— 必须先重建窗口再投递。
 * 2. `⌘Z` 留给 Chromium 原生文本撤销、`⇧⌘Z` 是 `role:'redo'`，
 *    因此「撤销上次文件操作」另配 `Alt+⌘Z`，不劫持输入框。
 */
const { Menu, app } = require('electron');

/**
 * @param {object} deps
 * @param {{ send: Function, get: Function, create: Function }} deps.win 窗口管理器
 * @param {() => Promise<object | null>} deps.openImportDialog 统一导入对话框
 */
function createMenu({ win, openImportDialog }) {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '导入图片或文件夹…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const picked = await openImportDialog();
            // 窗口可能已被关闭（macOS 进程仍在），先重建再投递结果
            if (picked) {
              if (!win.get()) win.create();
              win.send('import-paths', picked);
            }
          },
        },
        {
          type: 'separator',
        },
        {
          label: '数据资产…',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => {
            // 配置导出 / 导入、路径重连、操作日志与撤销、增量备份共用一个入口
            win.send('open-data-assets');
          },
        },
        {
          type: 'separator',
        },
        {
          label: '退出',
          accelerator: 'CmdOrCtrl+Q',
          click: () => app.quit(),
        },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: '重做', accelerator: 'Shift+CmdOrCtrl+Z', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: '复制', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: '粘贴', accelerator: 'CmdOrCtrl+V', role: 'paste' },
        { label: '全选', accelerator: 'CmdOrCtrl+A', role: 'selectall' },
        { type: 'separator' },
        {
          label: '撤销上次文件操作',
          // ⌘Z 与 ⇧⌘Z 已被上面的原生撤销 / 重做占用，这条另配不冲突的快捷键
          accelerator: 'Alt+CmdOrCtrl+Z',
          click: () => {
            win.send('undo-last-operation');
          },
        },
      ],
    },
    {
      label: '设置',
      submenu: [
        {
          label: 'AI 分析设置…',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            // 由渲染进程弹出「AI 设置」弹窗（应用内配置 API Key 等）
            win.send('ai-open-settings');
          },
        },
        {
          label: '检查更新…',
          click: () => {
            // 由渲染进程弹出更新面板：查看版本、更新说明与下载进度
            win.send('update-open-panel');
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { createMenu };
