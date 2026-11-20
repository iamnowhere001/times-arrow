# 跨进程契约（IPC）

> **最后更新**：2026-11-20 · **适用版本**：0.6.5
> **事实源**：`electron/preload.js`（暴露面）、`src/types/global.d.ts`（类型）、主进程 `handle()` 注册、`tests/main-process/ipc-contract.test.cjs` 的 `CHANNELS` 冻结清单

## 本文负责什么

- 一个通道为什么必须五处同步，漏一处会出什么故障。
- 返回值的统一语义（尤其「用户取消」）。
- 哪些通道必须做路径授权。
- 新增通道的完整步骤。

**本文不回答**：通道名全表、参数与返回类型。**通道清单的唯一源是 `ipc-contract.test.cjs` 的 `CHANNELS`**——文档复制一份必然漂移，所以这里不复制。想知道有哪些通道，去读那份清单。

---

## 1. 一个通道 = 五处

| 位置 | 作用 | 漏改的后果 |
| --- | --- | --- |
| `electron/preload.js` | 暴露 `window.electronAPI.xxx` | 渲染层拿不到方法，调用即 undefined |
| `src/types/global.d.ts` | 类型声明 | 类型层看不见，`any` 悄悄渗入 |
| 主进程 `handle('channel', …)` | 真实实现 | 调用无响应（挂起而不是报错） |
| `tests/main-process/ipc-contract.test.cjs` 的 `CHANNELS` | 冻结清单 | 测试失败——这是刻意的变更成本，不是麻烦 |
| 调用点 `src/**` | 实际使用 | 白加了通道 |

**历史教训**：`moveFiles` 的 `priorTargets` 曾在 preload 漏传。后果不是报错，而是跨卷移动失败后点重试会**静默产生重复副本**。所以现在有专门的形参数量断言。

---

## 2. 返回值语义

统一 `IpcResult<T>`：

```text
{ ok: true, data: T }        // 成功
{ ok: false, error, code? }  // 失败，error 必须可读、可展示
```

两条容易搞错的地方：

1. **「用户取消」是成功**：返回 `{ ok: true, data: null }`，不是 `ok: false`。把取消当失败会让 UI 弹出无意义的错误。
2. **异常必须有兜底**：注册走项目封装的 `handle()`，不要直接 `ipcMain.handle`。封装提供异常捕获与重复注册检测。

---

## 3. 路径授权

任何**接收渲染层路径**的 handler，入口第一件事是 `isPathAuthorized()`；未授权直接拒绝，不要「先试试能不能读」。

只有 6 个入口能产生授权（这六项的列举由 [`AGENTS.md`](../AGENTS.md) §4.2 作为规则本体维护，此处不重复展开）。新增「隐式信任」的入口等于在安全边界上开洞——具体面见 [`architecture.md`](./architecture.md) §4.6 与 [`decisions.md`](./decisions.md) ADR-004。

`update-*` 类通道是例外：它们**不接收**渲染层路径，下载目录与文件名由主进程决定，因此不走授权链。不要为了「方便」给它们加 path 参数。

---

## 4. 两种方向，别混

| 方向 | 机制 | 契约位置 |
| --- | --- | --- |
| 渲染 → 主（请求 / 响应） | `ipcRenderer.invoke` ↔ `handle()` | 上面五处 |
| 主 → 渲染（事件推送） | `webContents.send` ↔ `ipcRenderer.on` | main 发送 / preload 转发 / `global.d.ts` 声明 / 调用点订阅，**同样四处对齐** |

事件不进入 `CHANNELS` 清单，但漏改同样是「菜单点了没反应且没有任何测试报错」。现有链路（如撤销上次操作）在 `ipc-contract.test.cjs` 里有逐点断言，新增事件请照抄那个写法。

---

## 5. 新增一个通道

1. `electron/preload.js` 暴露方法。
2. `src/types/global.d.ts` 声明方法（含参数与返回类型）。
3. `electron/main.js` 或 `electron/main/*.cjs` 用 `handle('channel', …)` 注册。
4. `tests/main-process/ipc-contract.test.cjs` 的 `CHANNELS` 加通道名。
5. 调用点接入。

**文件类通道额外要求**：入口 `isPathAuthorized()`；失败返回带可读 `error`；取消返回 `ok:true, data:null`。

---

## 6. 守卫

| 测试 | 锁住什么 |
| --- | --- |
| `tests/main-process/ipc-contract.test.cjs` | preload / d.ts / 调用点 / 注册四处一致，通道数与冻结清单相同，`pm` handler 唯一 |
| `tests/main-process/ipc-security.test.cjs` | 未授权路径被拒、`pm://` 403、六条授权链路、体积闸门 |
| `tests/unit/devServerConfig.test.ts` | dev server 只监听回环（IPC 的前置面：渲染层不该被外部页面加载） |
