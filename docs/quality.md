# 质量基线

> **一条命令证明没改坏：`npm run verify`。**
> 本文只写「怎么验证、验证什么、什么算完成」，不写会漂移的测试数量 —— 数字以命令输出为准。

---

## 1. 命令

| 命令 | 作用 | 什么时候跑 |
| --- | --- | --- |
| `npm run verify` | `typecheck` + `lint` + `format:check` + `test` | 每次提交前（默认） |
| `npm run verify:full` | `verify` + `build` | 改构建 / 打包 / 入口时 |
| `npm run verify:release` | `verify:full` + `test:smoke`（真沙箱） | 发版前；受限环境改用 `test:smoke:no-sandbox` |
| `npm run typecheck` | 三个 TS project：渲染 / node / tests | 改类型或导入时 |
| `npm run lint` | ESLint（JS/CJS）+ oxlint（TS/TSX，type-aware） | 改任何代码 |
| `npm run format:check` | Prettier 全量检查 | 提交前 |
| `npm run test` | `test:main` + `test:unit` | 改逻辑 / 主进程 |
| `npm run test:unit` | Vitest 纯函数单测 | 改 `src/lib` / `src/types` |
| `npm run test:main` | 打桩 electron 的主进程集成测试（自动发现） | 改 `electron/**` / IPC / 持久化 / 安全 |
| `npm run test:main -- updater` | 只跑文件名匹配的测试 | 调试单个主进程测试 |
| `npm run test:smoke` | 真启动 Electron 的端到端冒烟 | 改窗口 / 协议 / CSP / 启动路径 |
| `npm run test:smoke:no-sandbox` | 同上，关闭沙箱（受限环境） | 本机无法初始化 Chromium 沙箱时 |

### 为什么 lint 分两层

ESLint 只检查 JS/CJS（主进程、构建脚本），TS/TSX 交给 oxlint（type-aware）。
原因是 `typescript-eslint` 的 peer 范围与 TypeScript 7 不兼容。**不要把 TS 重新纳入 ESLint。**

---

## 2. 测试分层

| 层 | 位置 | 运行方式 | 适合测什么 | 不适合测什么 |
| --- | --- | --- | --- | --- |
| 纯函数单测 | `tests/unit/*.test.ts` | Vitest，自动发现 | 算法、筛选、时间语义、布局、格式化、静态断言 | DOM、IPC、文件系统 |
| 主进程集成 | `tests/main-process/*.test.cjs` | Node + 打桩 electron，自动发现 | IPC 契约、安全边界、存储、迁移、更新、崩溃 | 真实窗口、真实渲染 |
| 端到端冒烟 | `tests/smoke/electron-smoke.cjs` | 真启动 Electron | 启动、CSP、控制台错误、基本渲染 | 细粒度逻辑 |
| 静态守卫 | 混在上两层 | 读源码断言 | 分层、唯一入口、品牌、文档一致、设计令牌 | 运行时行为 |

### 自动发现

- **单测**：`vitest.config.mts` 的 `include: ['tests/unit/**/*.test.ts']`。
- **主进程**：`tests/main-process/run.cjs` 扫描同目录 `*.test.cjs`，按文件名排序逐个以独立进程运行。

新增测试**不需要改 `package.json`**。这是为了避免「加了测试但忘了挂进脚本」的基线漏洞。

### 主进程测试的三条硬约束

1. 用 `tests/main-process/harness.cjs` 的 `loadMainProcess()`，不要真启动 Electron。
2. 一个文件一个进程：harness 在同一进程里不能二次 `require(main.js)`。
3. 断言失败要给出可定位信息（文件:行号 / 实际 vs 期望），不要只写 `assert failed`。

---

## 3. 棘轮（ratchet）规则

有些历史债务无法一次清零，用「基线 + 只降不升」的棘轮管理：

- 基线写在守卫测试里（如 `layering.test.cjs` 的 `BASELINE`）。
- **基线内允许，基线外一律失败。**
- 修完一处后下调对应数字；**不允许上调**。
- 新增文件不在基线内，出现即失败。
- 基线不是认可，是还款计划；每笔都要在测试注释里记录日期与原因。

---

## 4. Definition of Done

- [ ] `npm run typecheck` 通过
- [ ] `npm run lint` 0 problems
- [ ] `npm run format:check` 通过
- [ ] `npm run test` 通过；改主进程必须跑 `test:main`
- [ ] 改构建 / 打包 / 入口 / 窗口 / 协议时 `npm run build` 通过，必要时跑 `test:smoke`
- [ ] 新增纯逻辑有单测；新增 IPC / 权限 / 迁移有主进程测试
- [ ] 新增 / 修改文档链接可解析（`docsConsistency.test.ts`）
- [ ] 手动验证相关路径：导入、选择、操作、失败、重启恢复
- [ ] 同步文档：行为 → `README.md`；任务 → `TODO.md`；用户可感知 → `CHANGELOG.md`；方向 → `ROADMAP.md`；技术结论 → `CODE_REVIEW.md`；架构 → `docs/architecture.md`

> 提交前最省事的顺序：`npm run verify` → 手动验证 → `npm run verify:full`（如涉及构建）。

---

## 5. 环境注意事项

| 事项 | 说明 |
| --- | --- |
| Node.js | 20.19+ 或 22.12+（`package.json` 的 `engines` 与 README 一致） |
| 端口 | `vite.config.mts` 的 `server.port` 与 `electron:dev` 的 `ELECTRON_START_URL` 必须一致（当前 3000） |
| 沙箱 | 本机可能无法初始化 Chromium 沙箱。开发用 `PHOTOMINDER_DISABLE_SANDBOX=1`；冒烟用 `test:smoke:no-sandbox`。**打包产物永远强制开启沙箱。** |
| 网络 | 主进程测试全部打桩，不联网；更新测试用注入的 `fetchImpl` |
| 构建 | 打包仅 macOS arm64；`electron:build` 会跑 `afterPack` 瘦身与 DMG 重压 |

---

## 6. 基线数字怎么查

不要在文档里写死测试数量。需要时直接看命令输出：

```bash
npm run test:unit   # Test Files / Tests
npm run test:main   # 每个文件的通过项与总计
```

历史文档里的数字（`CHANGELOG` / `CODE_REVIEW` / `TODO` 完成存档）是**当时快照**，保留不回改；
当前基线只认 `npm run verify` 的退出码与输出。

---

## 7. 为什么没有 CI

产品定位是个人自用、仅 macOS 本地运行，且本机 `npm install` 与 Electron 沙箱有环境限制。
当前策略是「一条命令可复现」而不是托管 CI。若将来改变定位，先补 CI 再谈对外分发。
