/**
 * AI 配置密钥边界回归测试（2026-11-05）。
 *
 * 背景：`ai-config-get` 过去把明文 apiKey 回传给「AI 设置」弹窗供回显，
 * 与 README「渲染进程不接触密钥」的声明不符。现在读取方向只返回
 * `hasApiKey` + `maskedApiKey`（尾号 4 位），渲染层可以写入新值但读不回旧值。
 *
 * ⚠️ 独立成一个文件 / 一个进程：harness 的 `loadMainProcess()` 在同一进程里
 * 不能二次调用（Node 模块缓存会拿不到第二次注册的 handler）。
 * 另外明文配置必须在 require(main.js) **之前**放好 —— `app.on('ready')`
 * 会预读 ai-config.json 进 storeCache。
 *
 * 运行：npm run test:main
 */
const fs = require('fs');
const path = require('path');
const { loadMainProcess, createChecker, tempDir } = require('./harness.cjs');

const { check, section, summary } = createChecker();
const SECRET = 'sk-photominder-test-secret-ABCD';

const userData = tempDir('pm-userdata-ai-key-');

// 把环境变量钉成空串（不是 undefined）：loadEnvFile() 见到已定义就会跳过，
// 避免项目根真实存在的 .env.local 被读进来，干扰「响应里没有任何完整密钥」的断言。
process.env.DEEPSEEK_API_KEY = '';
fs.writeFileSync(
  path.join(userData, 'ai-config.json'),
  JSON.stringify({ apiKey: SECRET, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' })
);

const { call } = loadMainProcess({ userData });
const settleStartup = () => new Promise((resolve) => setTimeout(resolve, 80));

(async () => {
  await settleStartup();

  section('1. 读取配置不得回传明文密钥');
  const res = await call('ai-config-get');
  const data = res.data ?? {};
  const serialized = JSON.stringify(res);
  check('ai-config-get 返回成功', res.ok === true);
  check('响应里没有 apiKey 字段', !('apiKey' in data), Object.keys(data).join(','));
  check('hasApiKey 为 true', data.hasApiKey === true);
  check('掩码只带尾号 4 位', data.maskedApiKey === '••••••••ABCD', data.maskedApiKey);
  check('整个响应不含完整密钥', !serialized.includes(SECRET));
  check('keySource 为 settings', data.keySource === 'settings', data.keySource);
  check(
    '地址与模型仍可回显',
    data.baseUrl === 'https://api.deepseek.com' && data.model === 'deepseek-flash'
  );

  section('2. 写入新密钥后，读取仍不泄露');
  const NEW_SECRET = 'sk-rotated-key-WXYZ';
  const setRes = await call('ai-config-set', { apiKey: NEW_SECRET });
  check('保存新密钥成功', setRes.ok === true);
  const after = await call('ai-config-get');
  const afterText = JSON.stringify(after);
  check('新密钥的 hasApiKey 为 true', after.data.hasApiKey === true);
  check('新密钥掩码只带尾号', after.data.maskedApiKey === '••••••••WXYZ', after.data.maskedApiKey);
  check('响应不含新密钥明文', !afterText.includes(NEW_SECRET));
  check('响应也不含旧密钥明文', !afterText.includes(SECRET));

  section('3. 清除密钥后状态归零');
  const clearRes = await call('ai-config-set', { apiKey: '' });
  check('清除成功', clearRes.ok === true);
  const cleared = await call('ai-config-get');
  check('hasApiKey 为 false', cleared.data.hasApiKey === false);
  check('maskedApiKey 为空串', cleared.data.maskedApiKey === '');
  check('keySource 为 none', cleared.data.keySource === 'none', cleared.data.keySource);

  process.exit(summary() ? 1 : 0);
})();
