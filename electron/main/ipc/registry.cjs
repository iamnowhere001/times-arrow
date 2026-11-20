/**
 * IPC 注册器：统一返回协议 + 异常兜底 + 重复注册检测。
 *
 * ## 为什么要有这一层
 *
 * 改造前 31 个 handler 各自返回 `{ error }` / `{ success }` / 裸值 / `null` 四种形态，
 * 渲染层每调用一个 API 都要先猜「这次失败是以什么形式表达的」，漏判就会把错误当成数据。
 * 更糟的是有的 handler 根本没有 try/catch，抛出的异常会以 Electron 包装过的
 * rejected promise 形式到达渲染层，里面的消息既不稳定也不可读。
 *
 * 统一为：
 *   { ok: true,  data: T }                       —— 成功，业务数据在 data
 *   { ok: false, error: string, code?: string }  —— 失败，error 一定是可直接展示的中文文案
 *
 * ## 两条纪律
 *
 * 1. 所有 handler 一律经 `handle()` 注册，由这里兜底捕获异常；
 *    **不允许直接调用 `ipcMain.handle`** —— 否则就绕过了这层保障。
 * 2. 业务性的失败（如「目标不是文件夹」）也走 `fail()`，不要既返回 ok:true 又带 error 字段。
 *    这样渲染层只需判一个 ok 布尔值。
 *
 * 注册器是**每个进程一份**：`registeredChannels` 的重复检测依赖同一实例，
 * 因此由组合根（`electron/main.js`）创建后注入各域模块，不要各自 `createIpcRegistry()`。
 */

/** @param {{ ipcMain: object, logger: { error: Function } }} deps */
function createIpcRegistry({ ipcMain, logger }) {
  /** 已注册的通道，用于防止重复注册（重复注册会让 Electron 直接抛错，且报错信息不指向调用点） */
  const registeredChannels = new Set();

  /** 成功结果。缺省 data 为 null，对应「用户取消」这类正常但无数据的业务结果 */
  const ok = (data = null) => ({ ok: true, data });

  /** 失败结果。message 直接面向用户，应当是中文且可操作 */
  function fail(message, code) {
    const text = typeof message === 'string' && message ? message : String(message ?? '未知错误');
    return code ? { ok: false, error: text, code } : { ok: false, error: text };
  }

  /**
   * 注册一个 IPC handler，自动获得：
   *  - 异常兜底：handler 抛错不会变成渲染层的 rejected promise，而是 { ok:false, error }
   *  - 统一日志：带通道名，便于定位是哪个接口出的问题
   *  - 重复注册检测
   */
  function handle(channel, handler) {
    if (registeredChannels.has(channel)) {
      throw new Error(`IPC 通道重复注册: ${channel}`);
    }
    registeredChannels.add(channel);

    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return await handler(event, ...args);
      } catch (error) {
        logger.error(`[ipc:${channel}] handler threw:`, error);
        return fail(error?.message || String(error), error?.code);
      }
    });
  }

  return { ok, fail, handle, registeredChannels };
}

module.exports = { createIpcRegistry };
