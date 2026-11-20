import React from 'react';
import { ChevronLeftIcon } from '@/components/icons';
import { ABOUT_CONTENT, LATEST_RELEASE } from '@/lib/about/aboutContent';

/**
 * 「关于与更新」整页视图（v0.6.5）。
 *
 * 只消费注入的 props，不直接调用 Electron 暴露的接口：
 * 版本号与更新动作都来自 App 里的 useUpdateChecker，这里只负责呈现。
 * 左栏在此视图不渲染（与时光画廊 / 相似照片一致），所以顶栏固定为红绿灯留 78px。
 */

interface AboutViewProps {
  /** 主进程回传的当前版本；首帧可能为空，用最近一条更新记录兜底 */
  currentVersion: string;
  autoCheck: boolean;
  isChecking: boolean;
  onBack: () => void;
  /** 打开更新面板（内部会在没有可用结果时自动发起检查） */
  onCheckUpdate: () => void;
  onToggleAutoCheck: (enabled: boolean) => void;
  onOpenRelease: () => void;
}

const CARD = 'rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4';

const Section: React.FC<{ title: string; hint?: string; children: React.ReactNode }> = ({
  title,
  hint,
  children,
}) => (
  <section className="space-y-3">
    <div className="flex items-baseline gap-2">
      <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">{title}</h2>
      {hint && <span className="text-xs text-[var(--text-tertiary)]">{hint}</span>}
    </div>
    {children}
  </section>
);

const STATUS_CLASS: Record<string, string> = {
  进行中:
    'border-[rgba(var(--accent-blue-rgb),0.32)] bg-[rgba(var(--accent-blue-rgb),0.12)] text-[var(--accent-blue)]',
  已完成:
    'border-[rgba(var(--accent-green-rgb),0.3)] bg-[rgba(var(--accent-green-rgb),0.12)] text-[var(--accent-green)]',
  计划中: 'border-[var(--border-default)] text-[var(--text-tertiary)]',
};

const AboutView: React.FC<AboutViewProps> = ({
  currentVersion,
  autoCheck,
  isChecking,
  onBack,
  onCheckUpdate,
  onToggleAutoCheck,
  onOpenRelease,
}) => {
  const version = currentVersion || LATEST_RELEASE.version;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header
        className="app-drag z-20 shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] pl-[78px] pr-4 backdrop-blur-xl"
        aria-label="关于与更新"
      >
        <div className="app-no-drag flex h-[52px] items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            title="返回图库（Esc）"
            aria-label="返回图库"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[var(--text-secondary)] transition-all duration-200 hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] active:scale-[0.98]"
          >
            <ChevronLeftIcon />
          </button>
          <h1 className="truncate text-[17px] font-semibold text-[var(--text-primary)]">
            关于与更新
          </h1>
          <span className="text-xs font-numeric tabular-nums text-[var(--text-tertiary)]">
            v{version}
          </span>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
        <div className="mx-auto w-full max-w-[880px] space-y-10 px-8 py-8">
          {/* 概览 */}
          <section className="space-y-4">
            <div className="space-y-1.5">
              <h2 className="text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
                {ABOUT_CONTENT.appName}
              </h2>
              <p className="text-sm text-[var(--text-secondary)]">{ABOUT_CONTENT.subtitle}</p>
            </div>
            <p className="max-w-[62ch] text-sm leading-relaxed text-[var(--text-tertiary)]">
              {ABOUT_CONTENT.tagline}
            </p>
            <div className="grid gap-2.5 sm:grid-cols-3">
              {ABOUT_CONTENT.promises.map((item) => (
                <div key={item.title} className={CARD}>
                  <div className="text-[13px] font-semibold text-[var(--text-primary)]">
                    {item.title}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--text-tertiary)]">
                    {item.description}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <Section title="主要功能" hint={`${ABOUT_CONTENT.features.length} 项`}>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {ABOUT_CONTENT.features.map((item, index) => (
                <div key={item.title} className={CARD}>
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-numeric tabular-nums text-[var(--text-quaternary)]">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="text-[13px] font-semibold text-[var(--text-primary)]">
                      {item.title}
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-[var(--text-tertiary)]">
                    {item.description}
                  </p>
                </div>
              ))}
            </div>
          </Section>

          <Section title="特色">
            <div className="grid gap-2.5 sm:grid-cols-2">
              {ABOUT_CONTENT.highlights.map((item) => (
                <div key={item.title} className={CARD}>
                  <div className="text-[13px] font-semibold text-[var(--text-primary)]">
                    {item.title}
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-[var(--text-tertiary)]">
                    {item.description}
                  </p>
                </div>
              ))}
            </div>
          </Section>

          <Section title="操作技巧">
            <ul className={`${CARD} divide-y divide-[var(--border-subtle)] p-0`}>
              {ABOUT_CONTENT.tips.map((item) => (
                <li key={item.title} className="flex gap-3 px-4 py-3">
                  <span className="w-28 shrink-0 text-[13px] font-medium text-[var(--text-secondary)]">
                    {item.title}
                  </span>
                  <span className="text-xs leading-relaxed text-[var(--text-tertiary)]">
                    {item.description}
                  </span>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="迭代计划" hint="方向以 ROADMAP 为准">
            <ul className="space-y-2.5">
              {ABOUT_CONTENT.roadmap.map((item) => (
                <li key={item.version} className={CARD}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold text-[var(--text-primary)]">
                      {item.version} · {item.theme}
                    </span>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_CLASS[item.status] ?? STATUS_CLASS['计划中']}`}
                    >
                      {item.status}
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-[var(--text-tertiary)]">
                    {item.summary}
                  </p>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="更新记录" hint="最近 5 个版本">
            <ol className="space-y-2.5">
              {ABOUT_CONTENT.releases.map((release) => (
                <li key={release.version} className={CARD}>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-[13px] font-semibold font-numeric tabular-nums text-[var(--text-primary)]">
                      v{release.version}
                    </span>
                    <span className="text-xs font-numeric tabular-nums text-[var(--text-quaternary)]">
                      {release.date}
                    </span>
                    {release.version === version && (
                      <span className="rounded-full border border-[rgba(var(--accent-green-rgb),0.3)] bg-[rgba(var(--accent-green-rgb),0.12)] px-2 py-0.5 text-xs text-[var(--accent-green)]">
                        当前版本
                      </span>
                    )}
                  </div>
                  <ul className="mt-1.5 space-y-1">
                    {release.highlights.map((line) => (
                      <li
                        key={line}
                        className="text-xs leading-relaxed text-[var(--text-tertiary)]"
                      >
                        {line}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </Section>

          <Section title="版本与更新">
            <div className={`${CARD} space-y-3`}>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-[13px] text-[var(--text-secondary)]">
                  当前版本
                  <span className="ml-2 font-numeric tabular-nums text-[var(--text-primary)]">
                    v{version}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={onCheckUpdate}
                  disabled={isChecking}
                  className="rounded-[10px] border border-[rgba(var(--accent-blue-rgb),0.32)] bg-[rgba(var(--accent-blue-rgb),0.14)] px-3 py-1.5 text-xs font-medium text-[var(--accent-blue)] transition-colors duration-150 hover:bg-[rgba(var(--accent-blue-rgb),0.22)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isChecking ? '检查中…' : '检查更新'}
                </button>
                <button
                  type="button"
                  onClick={onOpenRelease}
                  className="rounded-[10px] border border-[var(--border-default)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)]"
                >
                  打开发布页
                </button>
              </div>

              <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--text-tertiary)]">
                <input
                  type="checkbox"
                  checked={autoCheck}
                  onChange={(event) => onToggleAutoCheck(event.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--accent-blue)]"
                />
                启动后自动检查一次（只请求 GitHub Releases，不上报任何使用信息）
              </label>

              <p className="text-xs leading-relaxed text-[var(--text-quaternary)]">
                更新包未签名、未公证：下载后需打开磁盘映像并把应用拖入「应用程序」，首次启动如被
                Gatekeeper 拦截，请在应用上右键选择「打开」。
              </p>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
};

export default AboutView;
