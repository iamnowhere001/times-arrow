# 外部依赖与网络边界

> **最后更新**：2026-11-21 · **适用版本**：0.6.6
> **事实源**：`package.json`（依赖清单）、`electron/main/ai.cjs`、`electron/main/updater.cjs`、`electron/main/face/model-store.cjs`、`electron/lib/csp.cjs`

## 本文负责什么

- 这个应用允许碰哪些外部世界，为什么只有这些。
- 每个外部面的触发条件、限额、失败语义。
- 新增依赖或网络能力时的判断清单。

**本文不回答**：版本号与依赖全表（读 `package.json`）。文档不记版本，因为它每个依赖升级都会漂移。

---

## 1. 总原则

**默认零网络。** 除用户显式触发的 AI 分析、可关闭的更新检查、人像页首次使用时的模型下载外，不存在任何出站请求：不上报、不拉远程配置、不接第三方 SDK、不做遥测与崩溃上报、不做云同步。

这条不是洁癖，是产品定位（[`decisions.md`](./decisions.md) ADR-001）：数据全在本机，用户才敢把照片交给它整理。任何新增网络能力都会削弱这个承诺。

---

## 2. 四个外部面

| 面 | 触发 | 出站目标 | 限额 / 约束 | 失败语义 | 落点 |
| --- | --- | --- | --- | --- | --- |
| AI 分析 | 用户点击「分析图片」/ 配置测试 | DeepSeek API（默认 `https://api.deepseek.com`，可配 Base URL） | 主进程代理；密钥只在主进程；`ai-analyze` 20MB base64 闸门 | 逐张报错，不阻塞图库；缓存成功结果 | `electron/main/ai.cjs` |
| 更新检查 | 启动后静默一次 + 手动检查 | GitHub Releases API | 只读 Release 元数据；下载 URL 必须来自 API 且 host 白名单内 | 失败静默（手动检查时提示）；不视为应用错误 | `electron/main/updater.cjs` |
| 人脸模型下载 | 首次进入「人像」页并确认 | GitHub 加速镜像（`ghproxy.net` / `ghfast.top`）→ InsightFace 官方 Release 回落 | 仅主进程；大小上限 80MB，30 秒空闲超时；无论哪条线路都必须通过写死的 SHA256 才解压 | 可取消；某条线路失败自动换下一条；全部失败时显示中文提示并可重试 | `electron/main/face/model-store.cjs` |
| 本地系统能力 | 用户操作 | 无网络（`shell.trashItem`、访达定位、剪贴板） | — | 逐项报错可重试 | 主进程各模块 |

**AI 密钥的边界**：落盘是明文（`ai-config.json`），这是「个人自用、单机」定位下的既定取舍（TODO X1），不是遗漏。已收紧的是读取方向——渲染层只能写入新值，读回只有 `hasApiKey` + 尾号掩码。不要把它改成「渲染层可以读」，也不要顺手接入 `safeStorage` 之外的第三方密钥托管。

**更新下载的三条硬约束**：

1. 下载地址必须来自 API 响应，且 host 在 `github.com` / `objects.githubusercontent.com` / `release-assets.githubusercontent.com` 白名单内。
2. 只下载 DMG，由用户确认安装，**不静默覆盖** `/Applications`。
3. 渲染层不得直连 GitHub——所有请求经主进程。

---

## 3. 运行时依赖

生产环境只允许「本地处理必需、且无替代」的依赖。当前运行时的四项（清单以 `package.json` 的 `dependencies` 为准）：

| 依赖 | 为什么允许 | 边界 |
| --- | --- | --- |
| `exifreader` | 读 EXIF / GPS / 尺寸，自己实现不现实 | 只在主进程用，只读文件前 512KB |
| `heic-convert` | macOS 照片常见 HEIC，渲染层无法直接解码 | 只在主进程转码，结果落盘缓存 |
| `onnxruntime-node` | 相册量大时原生推理比 JS 后端更快更稳；模型本身不打进 DMG | 只在主进程用；原生库进 `asarUnpack`；非 macOS 二进制与冗余 dylib 在打包时裁掉 |
| `adm-zip` | 模型 zip 解压需要；避免为此引更重的归档库 | 只解压校验过 SHA256 的模型包，目标目录限定在 `userData/models/` 临时目录 |

其余全部是构建期 devDependencies，不进产物。打包体积的收敛手段见 `package.json` 的 `build` 字段与 `build/afterPack.js`（不在本文重复参数）。

**明确不引入**：图像编辑库、视频转码（依赖 ffmpeg，体积与复杂度陡增）、地图 SDK（离线底图已够用）、任何分析 / 上报 SDK。

---

## 4. 新增依赖或网络能力前

按顺序自问，任一为「否」就停：

1. 现有实现真的做不到吗？（先搜 `src/lib` 与 `electron/lib`）
2. 它会在运行时联网吗？会破坏「纯本地」承诺吗？
3. 它会显著增大 DMG 吗？（当前体积基线见 `README.md` 打包一节）
4. 它需要在渲染进程运行吗？（能放主进程就放主进程）
5. 出问题时用户能看懂吗？（失败必须可解释、可重试）

涉及新增网络能力的改动属于 [`AGENTS.md`](../AGENTS.md) §9「先问维护者」清单。

## 5. 守卫

| 测试 / 配置 | 锁住什么 |
| --- | --- |
| `tests/main-process/ai-config-privacy.test.cjs` | 读取不回明文 |
| `tests/main-process/updater.test.cjs` | 版本比较、资产 host 白名单、下载校验、取消 |
| `tests/main-process/face-algorithms.test.cjs` | 检测解码 / 对齐 / 归一化 / 聚类不依赖外部模型包 |
| `electron/lib/csp.cjs` | 生产 `script-src` 不含 `unsafe-inline`，构建期与响应头共用 |
| `tests/smoke/electron-smoke.cjs` | 启动后 CSP 违规与控制台错误为 0 |
