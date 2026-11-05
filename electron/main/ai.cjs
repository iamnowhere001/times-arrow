'use strict';

const fs = require('fs');
const path = require('path');

function createAiService({ store, logger, appPath, userDataDir }) {
  const { STORE_AI_CONFIG, storeCache, mergeStore } = store;

  // ---------------------------------------------------------------------------
  // 环境变量：主进程不经过 Vite，需要自行加载 .env。
  // AI 密钥只保留在主进程（不再注入渲染进程 bundle），避免进入前端产物。
  // 优先级：已存在的 process.env > 应用根 .env.local / .env > 当前工作目录 > userData/ai.env
  // ---------------------------------------------------------------------------
  function loadEnvFile(filePath) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      return;
    }

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;

      const key = match[1];
      if (process.env[key] !== undefined) continue; // 真实环境变量优先
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }

  function loadEnvFiles() {
    const candidates = [
      path.join(appPath, '.env.local'),
      path.join(appPath, '.env'),
      path.join(process.cwd(), '.env.local'),
      path.join(process.cwd(), '.env'),
      path.join(userDataDir, 'ai.env'),
    ];

    const seen = new Set();
    for (const file of candidates) {
      if (seen.has(file)) continue;
      seen.add(file);
      loadEnvFile(file);
    }
  }

  try {
    loadEnvFiles();
  } catch (error) {
    logger.warn('Failed to load env files:', error.message);
  }

  // ---------------------------------------------------------------------------
  // AI 图片分析（DeepSeek 视觉模型）
  // 由主进程代理：渲染进程只发送 base64，API Key 不出主进程，
  // 同时规避渲染进程直连第三方接口时的 CORS 限制。
  // ---------------------------------------------------------------------------
  const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';
  const DEEPSEEK_DEFAULT_MODEL = 'deepseek-flash';
  /** 单次分析超时（毫秒） */
  const AI_REQUEST_TIMEOUT = 60_000;
  /** 「测试连接」的超时：只是校验密钥 / 地址，不必等满整轮分析 */
  const AI_TEST_TIMEOUT = 20_000;

  /**
   * 解析最终生效的 AI 配置。
   * 优先级：应用内「AI 设置」保存的值 > 环境变量（.env.local / 系统环境变量 / userData/ai.env）> 内置默认值。
   * 应用内设置为空时自动回退到环境变量，便于「只想改模型，密钥仍走 .env.local」。
   */
  function resolveAiConfig() {
    const stored = storeCache.get(STORE_AI_CONFIG) ?? {};
    const storedKey = typeof stored.apiKey === 'string' ? stored.apiKey.trim() : '';
    const envKey = (process.env.DEEPSEEK_API_KEY || '').trim();

    const storedBaseUrl = typeof stored.baseUrl === 'string' ? stored.baseUrl.trim() : '';
    const storedModel = typeof stored.model === 'string' ? stored.model.trim() : '';

    return {
      apiKey: storedKey || envKey,
      baseUrl: (
        storedBaseUrl ||
        process.env.DEEPSEEK_BASE_URL ||
        DEEPSEEK_DEFAULT_BASE_URL
      ).replace(/\/+$/, ''),
      model: storedModel || process.env.DEEPSEEK_MODEL || DEEPSEEK_DEFAULT_MODEL,
      /** 密钥来源：应用内设置 / 环境变量 / 未配置 */
      keySource: storedKey ? 'settings' : envKey ? 'env' : 'none',
    };
  }

  /**
   * 只把密钥尾号交给界面，用于「确认当前用的是哪一把」，绝不回传完整值。
   *
   * 为什么改：ai-config.json 里的密钥是明文的（自用定位下可接受，见 TODO X1），
   * 但过去「AI 设置」弹窗会直接读回整串填进输入框 —— 渲染进程因此能拿到完整密钥，
   * 与 README 里「渲染进程不接触密钥」的声明不符。改成只回掩码后，
   * 渲染层可以**写入**新密钥，但**读不回**已保存的旧值。
   */
  function maskApiKey(key) {
    if (!key) return '';
    // 太短时不暴露任何字符，避免掩码本身成为长度线索
    if (key.length <= 8) return '••••••••';
    return `••••••••${key.slice(-4)}`;
  }

  /** Prompt 必须包含 "json" 字样与格式示例，否则 json_object 模式可能不生效 */
  const AI_PROMPT = [
    'Analyze this image. Provide a concise description (max 2 sentences) and a list of 5 relevant tags.',
    'Respond with a JSON object only, following exactly this shape:',
    '{"description": "...", "tags": ["...", "...", "...", "...", "..."]}',
  ].join('\n');

  /** 从模型返回文本中提取描述与标签；宽容处理 ```json 围栏与多余前后缀 */
  function parseAnalysisContent(content) {
    let text = String(content ?? '').trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
    if (fenced) text = fenced[1].trim();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start < 0 || end <= start) return null;
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }

    const description =
      typeof parsed?.description === 'string' && parsed.description.trim()
        ? parsed.description.trim()
        : undefined;
    const tags = Array.isArray(parsed?.tags)
      ? parsed.tags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim())
      : undefined;

    if (!description && (!tags || tags.length === 0)) return null;
    return { description, tags };
  }

  async function analyzeImageWithDeepSeek(base64, mimeType) {
    const { apiKey, baseUrl, model } = resolveAiConfig();
    if (!apiKey) {
      throw new Error(
        '未配置 DeepSeek API Key。请在详情面板「AI 设置」中填写，或通过 .env.local / 系统环境变量配置。'
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: AI_PROMPT },
                {
                  type: 'image_url',
                  image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'low' },
                },
              ],
            },
          ],
          response_format: { type: 'json_object' },
          max_tokens: 512,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`DeepSeek 请求失败（${response.status}）：${detail.slice(0, 300)}`);
      }

      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      if (!content) throw new Error('DeepSeek 返回空内容');
      return parseAnalysisContent(content);
    } catch (error) {
      // 超时换成对用户更明确的文案，但保留原始错误作为 cause ——
      // 否则排查时只能看到「请求超时」，丢掉了是 AbortError 还是网络错误的线索
      if (error.name === 'AbortError') throw new Error('DeepSeek 请求超时', { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  // 渲染进程提交 base64，主进程完成请求并返回「描述 + 标签」
  /**
   * AI 分析单次上传上限（base64 字符数，约合 15MB 原图）。
   * 渲染层目前提交的是原图 base64，大图既会把主进程内存顶起来，
   * 也会被上游接口按体积拒绝 —— 在这里先拦下并给出可操作的提示，
   * 比让请求打到远端再失败更省时间、也更容易理解。
   */
  const MAX_AI_IMAGE_BASE64 = 20 * 1024 * 1024;

  function registerAiIpc({ handle, ok, fail }) {
    handle('ai-analyze', async (event, payload) => {
      const base64 = payload?.base64;
      const mimeType = payload?.mimeType;
      if (!base64 || typeof base64 !== 'string') {
        return fail('缺少图片数据');
      }
      if (base64.length > MAX_AI_IMAGE_BASE64) {
        const actualMb = (base64.length / 1024 / 1024).toFixed(1);
        const limitMb = (MAX_AI_IMAGE_BASE64 / 1024 / 1024).toFixed(0);
        return fail(
          `图片过大（约 ${actualMb}MB），AI 分析单次上限约 ${limitMb}MB。可先用「导出」转成较小的 JPEG 后再分析。`
        );
      }

      const result = await analyzeImageWithDeepSeek(
        base64,
        typeof mimeType === 'string' && mimeType ? mimeType : 'image/jpeg'
      );
      return ok(result);
    });

    // 读取当前生效的 AI 配置（供应用内「AI 设置」回显）
    // 密钥只回「是否已配置 + 尾号掩码」：渲染层能写入新值，但读不回旧值。
    handle('ai-config-get', async () => {
      const { apiKey, baseUrl, model, keySource } = resolveAiConfig();
      return ok({
        hasApiKey: Boolean(apiKey),
        maskedApiKey: maskApiKey(apiKey),
        baseUrl,
        model,
        keySource,
        defaults: { baseUrl: DEEPSEEK_DEFAULT_BASE_URL, model: DEEPSEEK_DEFAULT_MODEL },
      });
    });

    // 保存 AI 配置：只接受字符串字段，空串表示「清除该覆盖项，回退到环境变量 / 默认值」
    handle('ai-config-set', async (event, patch) => {
      const clean = {};
      if (patch && typeof patch.apiKey === 'string') clean.apiKey = patch.apiKey.trim();
      if (patch && typeof patch.baseUrl === 'string') clean.baseUrl = patch.baseUrl.trim();
      if (patch && typeof patch.model === 'string') clean.model = patch.model.trim();
      if (Object.keys(clean).length === 0) {
        return fail('没有可保存的内容');
      }

      await mergeStore(STORE_AI_CONFIG, clean);
      const { keySource } = resolveAiConfig();
      return ok({ keySource });
    });

    /**
     * 测试连接：用最省的一次对话请求校验「密钥 + 地址 + 模型」是否可用。
     * 支持传入尚未保存的草稿值，方便「先测通再保存」。
     */
    handle('ai-config-test', async (event, draft) => {
      const current = resolveAiConfig();
      const pick = (value, fallback) =>
        typeof value === 'string' && value.trim() ? value.trim() : fallback;

      const apiKey = pick(draft?.apiKey, current.apiKey);
      const baseUrl = pick(draft?.baseUrl, current.baseUrl).replace(/\/+$/, '');
      const model = pick(draft?.model, current.model);

      if (!apiKey) return fail('请先填写 API Key');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), AI_TEST_TIMEOUT);
      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
            stream: false,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          return fail(`请求失败（${response.status}）：${detail.slice(0, 300)}`);
        }
        return ok({ model });
      } catch (error) {
        if (error.name === 'AbortError') return fail('连接超时');
        return fail(error.message);
      } finally {
        clearTimeout(timer);
      }
    });
  }

  return { resolveAiConfig, registerAiIpc };
}

module.exports = { createAiService };
