import React, { useEffect, useState } from 'react';
import type { AiKeySource } from '@/types';

interface AiSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 通知回调（保存成功 / 测试结果等） */
  onNotify?: (message: string, type: 'success' | 'info' | 'error' | 'warning') => void;
}

const EyeIcon = ({ off }: { off?: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"></path>
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"></path>
    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"></path>
    {off && <line x1="1" y1="1" x2="23" y2="23"></line>}
  </svg>
);

/**
 * 把 IPC 异常转成可读提示。
 * 「No handler registered」只在主进程未加载对应 handler 时出现，
 * 典型场景是改完 electron/main.js 后只热更新了渲染层（Vite HMR 不重启主进程）。
 */
const describeIpcError = (error: unknown): string => {
  const message = (error as Error)?.message ?? '';
  if (/No handler registered/i.test(message)) {
    return '主进程未加载最新的 AI 设置接口，请重启应用后重试（结束当前进程并重新运行 npm run electron:dev）。';
  }
  return message || '操作失败';
};

/**
 * AI 分析设置：在应用内配置 DeepSeek 的 API Key / 接口地址 / 模型。
 * 配置保存在 userData/ai-config.json，只有 Electron 主进程读取，前端产物里不含密钥。
 * 留空的字段会回退到环境变量（.env.local / 系统环境变量 / userData/ai.env）或内置默认值。
 */
const AiSettingsModal: React.FC<AiSettingsModalProps> = ({ isOpen, onClose, onNotify }) => {
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [defaults, setDefaults] = useState({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' });
  const [keySource, setKeySource] = useState<AiKeySource>('none');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  /** 配置读取失败（通常是主进程未重启，IPC handler 还不存在） */
  const [loadError, setLoadError] = useState<string | null>(null);

  // 每次打开都重新拉取最新配置，避免回显上一次编辑的草稿
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setTestResult(null);
    setLoadError(null);
    setShowKey(false);

    const api = window.electronAPI;
    if (!api?.getAiConfig) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    api
      .getAiConfig()
      .then(response => {
        if (cancelled) return;
        if (!response.ok) {
          setLoadError(response.error);
          setIsLoading(false);
          return;
        }
        const config = response.data;
        setApiKey(config.apiKey ?? '');
        setBaseUrl(config.baseUrl ?? '');
        setModel(config.model ?? '');
        setKeySource(config.keySource);
        if (config.defaults) setDefaults(config.defaults);
        setIsLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(describeIpcError(error));
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const electronReady = Boolean(window.electronAPI?.getAiConfig);

  const handleTest = async () => {
    const api = window.electronAPI;
    if (!api?.testAiConfig) return;
    setIsTesting(true);
    setTestResult(null);
    try {
      const result = await api.testAiConfig({
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim(),
        model: model.trim(),
      });
      setTestResult(
        result.ok
          ? { ok: true, message: `连接成功，模型：${result.data.model || model.trim() || defaults.model}` }
          : { ok: false, message: result.error }
      );
    } catch (error) {
      setTestResult({ ok: false, message: describeIpcError(error) });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSave = async () => {
    const api = window.electronAPI;
    if (!api?.setAiConfig) return;
    setIsSaving(true);
    try {
      const result = await api.setAiConfig({
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim(),
        model: model.trim(),
      });
      if (result.ok) {
        setKeySource(result.data.keySource ?? 'none');
        onNotify?.('AI 设置已保存', 'success');
        onClose();
      } else {
        onNotify?.(result.error, 'error');
      }
    } catch (error) {
      onNotify?.(describeIpcError(error), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const statusStyles: Record<AiKeySource, string> = {
    settings: 'border-[rgba(var(--accent-green-rgb),0.3)] bg-[rgba(var(--accent-green-rgb),0.1)] text-[var(--accent-green)]',
    env: 'border-[rgba(var(--accent-blue-rgb),0.3)] bg-[rgba(var(--accent-blue-rgb),0.1)] text-[var(--accent-blue)]',
    none: 'border-[rgba(var(--accent-pink-rgb),0.3)] bg-[rgba(var(--accent-pink-rgb),0.1)] text-[var(--accent-pink)]',
  };
  const statusText: Record<AiKeySource, string> = {
    settings: '已保存到应用设置，优先于环境变量生效。',
    env: '当前使用 .env.local / 环境变量中的密钥；保存后将以这里填写的值为准。',
    none: '尚未配置 API Key，AI 分析不可用。',
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[rgba(0,0,0,0.7)] backdrop-blur-md animate-fadeIn">
      <div
        className="bg-[var(--bg-elevated)] backdrop-blur-xl rounded-2xl shadow-2xl w-[480px] max-w-[90vw] overflow-hidden border border-[var(--border-default)] animate-scaleIn flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label="AI 分析设置"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-[var(--border-subtle)]">
          <h3 className="text-lg font-semibold text-[var(--text-primary)]">AI 分析设置</h3>
          <p className="text-sm text-[var(--text-tertiary)] mt-1">
            配置 DeepSeek 视觉模型，用于生成图片描述与标签。
          </p>
        </div>

        <div className="p-6 space-y-5">
          {!electronReady && (
            <div className="rounded-xl border border-[rgba(var(--accent-pink-rgb),0.3)] bg-[rgba(var(--accent-pink-rgb),0.1)] px-4 py-3">
              <p className="text-xs leading-relaxed text-[var(--accent-pink)]">
                当前环境无法读写配置（仅 Electron 桌面端支持）。请通过 <code className="font-mono">.env.local</code> 配置 DEEPSEEK_API_KEY。
              </p>
            </div>
          )}

          {loadError && (
            <div className="rounded-xl border border-[rgba(var(--accent-pink-rgb),0.3)] bg-[rgba(var(--accent-pink-rgb),0.1)] px-4 py-3">
              <p className="text-xs leading-relaxed text-[var(--accent-pink)]">{loadError}</p>
            </div>
          )}

          {!loadError && (
            <div className={`rounded-xl border px-4 py-3 ${statusStyles[keySource]}`}>
              <p className="text-xs leading-relaxed">{statusText[keySource]}</p>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-[var(--text-tertiary)] mb-1.5">API Key</label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={isLoading ? '' : apiKey}
                disabled={!electronReady || isLoading}
                onChange={e => {
                  setApiKey(e.target.value);
                  setTestResult(null);
                }}
                placeholder={isLoading ? '读取中…' : 'sk-…'}
                autoComplete="off"
                spellCheck={false}
                className="w-full pl-4 pr-11 py-2.5 bg-[var(--bg-input)] border border-[var(--border-default)] rounded-xl text-sm font-mono text-[var(--text-primary)] placeholder-[var(--text-quaternary)] outline-hidden focus:border-[var(--accent-blue)] focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.25)] transition-all disabled:opacity-60"
              />
              <button
                type="button"
                onClick={() => setShowKey(v => !v)}
                title={showKey ? '隐藏密钥' : '显示密钥'}
                aria-label={showKey ? '隐藏密钥' : '显示密钥'}
                disabled={!electronReady}
                className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center justify-center w-7 h-7 rounded-lg text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] transition-all disabled:opacity-40"
              >
                <EyeIcon off={showKey} />
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-[var(--text-quaternary)]">
              留空表示沿用环境变量中的密钥；密钥只保存在本机，不会写入前端产物。
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--text-tertiary)] mb-1.5">接口地址</label>
            <input
              type="text"
              value={isLoading ? '' : baseUrl}
              disabled={!electronReady || isLoading}
              onChange={e => {
                setBaseUrl(e.target.value);
                setTestResult(null);
              }}
              placeholder={defaults.baseUrl}
              autoComplete="off"
              spellCheck={false}
              className="w-full px-4 py-2.5 bg-[var(--bg-input)] border border-[var(--border-default)] rounded-xl text-sm font-mono text-[var(--text-primary)] placeholder-[var(--text-quaternary)] outline-hidden focus:border-[var(--accent-blue)] focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.25)] transition-all disabled:opacity-60"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--text-tertiary)] mb-1.5">模型</label>
            <input
              type="text"
              value={isLoading ? '' : model}
              disabled={!electronReady || isLoading}
              onChange={e => {
                setModel(e.target.value);
                setTestResult(null);
              }}
              placeholder={defaults.model}
              autoComplete="off"
              spellCheck={false}
              className="w-full px-4 py-2.5 bg-[var(--bg-input)] border border-[var(--border-default)] rounded-xl text-sm font-mono text-[var(--text-primary)] placeholder-[var(--text-quaternary)] outline-hidden focus:border-[var(--accent-blue)] focus:ring-2 focus:ring-[rgba(var(--accent-blue-rgb),0.25)] transition-all disabled:opacity-60"
            />
            <p className="mt-1.5 text-[11px] text-[var(--text-quaternary)]">
              需要支持图像输入的模型，默认 {defaults.model}。
            </p>
          </div>

          {testResult && (
            <div
              className={`rounded-xl border px-4 py-2.5 text-xs leading-relaxed ${
                testResult.ok
                  ? 'border-[rgba(var(--accent-green-rgb),0.3)] bg-[rgba(var(--accent-green-rgb),0.1)] text-[var(--accent-green)]'
                  : 'border-[rgba(var(--accent-pink-rgb),0.3)] bg-[rgba(var(--accent-pink-rgb),0.1)] text-[var(--accent-pink)]'
              }`}
            >
              {testResult.message}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-[var(--border-subtle)] flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={handleTest}
            disabled={!electronReady || isTesting || isLoading || !apiKey.trim()}
            className="px-4 py-2.5 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-default)] hover:bg-[var(--bg-glass-hover)] rounded-xl transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isTesting && <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />}
            {isTesting ? '测试中…' : '测试连接'}
          </button>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-5 py-2.5 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] border border-[var(--border-default)] rounded-xl transition-all duration-200"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={!electronReady || isSaving || isLoading}
              className="px-6 py-2.5 text-sm font-semibold rounded-xl transition-all duration-200 text-[var(--accent-contrast)] bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-hover))] shadow-lg shadow-[rgba(var(--accent-blue-rgb),0.3)] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {isSaving && <span className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />}
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AiSettingsModal;
