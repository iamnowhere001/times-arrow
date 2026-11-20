import React from 'react';
import { ChevronLeftIcon } from '@/components/icons';
import { ABOUT_CONTENT, LATEST_RELEASE } from '@/lib/about/aboutContent';
import { formatBytes, formatPublishedAt } from '@/lib/about/updateFormat';
import type { UpdateCheckResult, UpdateDownloadState } from '@/types';

/**
 * 「关于与更新」整页视图（v0.6.5）。
 *
 * 只消费注入的 props，不直接调用 Electron 暴露的接口：
 * 更新能力全部来自 App 里的 useUpdateChecker，这里只负责呈现与转发。
 * 左栏在此视图不渲染（与时光画廊 / 相似照片一致），所以顶栏固定为红绿灯留 78px。
 *
 * v0.6.5 交互优化：检查 → 发现版本 → 下载 → 打开磁盘映像全在本页完成，
 * 结果常驻可见。UpdateModal 只服务于菜单入口，不再是本页的中转站。
 */

interface AboutViewProps {
  /** 主进程回传的当前版本；首帧可能为空，用最近一条更新记录兜底 */
  currentVersion: string;
  autoCheck: boolean;
  isChecking: boolean;
  checkResult: UpdateCheckResult | null;
  error: string | null;
  download: UpdateDownloadState;
  onBack: () => void;
  /** 就地检查更新（不再打开面板） */
  onCheckUpdate: () => void;
  onToggleAutoCheck: (enabled: boolean) => void;
  onOpenRelease: () => void;
  onStartDownload: () => void;
  onCancelDownload: () => void;
  onOpenDownload: () => void;
  onRevealDownload: () => void;
}

const CARD = 'rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4';

/** 页内操作按钮：比弹窗里的按钮收一档，与本页卡片密度一致 */
const ACTION_PRIMARY =
  'inline-flex items-center justify-center gap-1.5 rounded-[10px] border border-[rgba(var(--accent-blue-rgb),0.32)] bg-[rgba(var(--accent-blue-rgb),0.14)] px-3 py-1.5 text-xs font-medium text-[var(--accent-blue)] transition-colors duration-150 hover:bg-[rgba(var(--accent-blue-rgb),0.22)] disabled:cursor-not-allowed disabled:opacity-50';
const ACTION_SECONDARY =
  'inline-flex items-center justify-center rounded-[10px] border border-[var(--border-default)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)]';

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
  checkResult,
  error,
  download,
  onBack,
  onCheckUpdate,
  onToggleAutoCheck,
  onOpenRelease,
  onStartDownload,
  onCancelDownload,
  onOpenDownload,
  onRevealDownload,
}) => {
  const version = currentVersion || LATEST_RELEASE.version;
  const isDownloading = download.state === 'downloading';
  const isDownloaded = download.state === 'done';
  const hasUpdate = checkResult?.status === 'available';
  const assetSize = formatBytes(checkResult?.asset?.size ?? 0);

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

          {/*
            版本与更新：把原先「整页按钮 → 弹窗」的两层流程收拢到本卡片。
            检查结果、下载进度、失败原因都常驻在这里，关掉页面再回来仍从 hook 恢复。
          */}
          <Section title="版本与更新" hint="检查、下载与安装都在此处完成">
            <div className={`${CARD} space-y-4`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] text-[var(--text-secondary)]">当前版本</span>
                    <span className="font-numeric tabular-nums text-[var(--text-primary)]">
                      v{version}
                    </span>
                    {hasUpdate && (
                      <span className="rounded-full border border-[rgba(var(--accent-blue-rgb),0.32)] bg-[rgba(var(--accent-blue-rgb),0.12)] px-2 py-0.5 text-xs text-[var(--accent-blue)]">
                        有新版本 v{checkResult?.latestVersion}
                      </span>
                    )}
                    {isDownloaded && (
                      <span className="rounded-full border border-[rgba(var(--accent-green-rgb),0.3)] bg-[rgba(var(--accent-green-rgb),0.12)] px-2 py-0.5 text-xs text-[var(--accent-green)]">
                        更新包已就绪
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[var(--text-tertiary)]">
                    {isChecking
                      ? '正在从 GitHub Releases 获取版本信息…'
                      : hasUpdate
                        ? '阅读更新说明后可直接下载，安装仍由你手动完成。'
                        : isDownloaded
                          ? '打开磁盘映像，把应用拖入「应用程序」即可完成安装。'
                          : '只读取 GitHub Releases，不上报任何使用信息。'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={onCheckUpdate}
                    disabled={isChecking || isDownloading}
                    className={ACTION_PRIMARY}
                  >
                    {isChecking && (
                      <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    )}
                    {isChecking ? '检查中…' : isDownloading ? '下载中' : '检查更新'}
                  </button>
                  <button type="button" onClick={onOpenRelease} className={ACTION_SECONDARY}>
                    打开发布页
                  </button>
                </div>
              </div>

              {/* 唯一的自动检查开关：菜单面板已不再重复这一项 */}
              <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--text-tertiary)]">
                <input
                  type="checkbox"
                  checked={autoCheck}
                  onChange={(event) => onToggleAutoCheck(event.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--accent-blue)]"
                />
                启动后自动检查一次（静默进行，只有发现新版本才提示）
              </label>

              {error && (
                <div className="rounded-xl border border-[rgba(var(--accent-pink-rgb),0.3)] bg-[rgba(var(--accent-pink-rgb),0.1)] px-4 py-3">
                  <p className="text-xs leading-relaxed text-[var(--accent-pink)]">{error}</p>
                </div>
              )}

              {isDownloading && (
                <div className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-input)] px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="text-[var(--text-secondary)]">
                      正在下载更新包
                      {download.version ? ` ${download.version}` : ''}
                    </span>
                    <span className="font-numeric tabular-nums text-[var(--text-tertiary)]">
                      {download.percent}%
                      {download.total > 0
                        ? ` · ${formatBytes(download.received)} / ${formatBytes(download.total)}`
                        : ''}
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-[var(--bg-elevated)]">
                    <div
                      className="h-full rounded-full bg-[var(--accent-blue)] transition-[width] duration-200"
                      style={{ width: `${Math.max(download.percent, 2)}%` }}
                    />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[11px] text-[var(--text-quaternary)]">
                      下载期间可以取消；已下载的部分会被清理，不会留下半截文件。
                    </p>
                    <button type="button" onClick={onCancelDownload} className={ACTION_SECONDARY}>
                      取消下载
                    </button>
                  </div>
                </div>
              )}

              {!isDownloading && isDownloaded && (
                <div className="space-y-2 rounded-xl border border-[rgba(var(--accent-green-rgb),0.3)] bg-[rgba(var(--accent-green-rgb),0.1)] px-4 py-3">
                  <p className="text-xs leading-relaxed text-[var(--accent-green)]">
                    更新包已下载完成。打开磁盘映像后，把「时光画框」拖入「应用程序」覆盖旧版本，
                    然后退出并重新打开即可。
                  </p>
                  {download.filePath && (
                    <p className="break-all font-mono text-xs leading-relaxed text-[var(--text-quaternary)]">
                      {download.filePath}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" onClick={onOpenDownload} className={ACTION_PRIMARY}>
                      打开磁盘映像
                    </button>
                    <button type="button" onClick={onRevealDownload} className={ACTION_SECONDARY}>
                      在访达中显示
                    </button>
                  </div>
                </div>
              )}

              {!isDownloading && !isDownloaded && hasUpdate && (
                <div className="space-y-3 rounded-xl border border-[rgba(var(--accent-blue-rgb),0.3)] bg-[rgba(var(--accent-blue-rgb),0.06)] px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-[13px] text-[var(--text-secondary)]">
                      发现新版本{' '}
                      <span className="font-mono text-[var(--text-primary)]">
                        {checkResult?.latestVersion}
                      </span>
                    </span>
                    <span className="text-[11px] text-[var(--text-quaternary)]">
                      {[formatPublishedAt(checkResult?.publishedAt), assetSize]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                  {checkResult?.releaseNotes ? (
                    <pre className="m-0 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-input)] px-4 py-3 font-sans text-xs leading-relaxed text-[var(--text-secondary)]">
                      {checkResult.releaseNotes}
                    </pre>
                  ) : (
                    <p className="text-xs text-[var(--text-quaternary)]">
                      该版本没有填写更新说明。
                    </p>
                  )}
                  {checkResult?.asset ? (
                    <button type="button" onClick={onStartDownload} className={ACTION_PRIMARY}>
                      下载更新包
                    </button>
                  ) : (
                    <p className="text-xs leading-relaxed text-[var(--accent-pink)]">
                      该版本没有提供 DMG 安装包，请通过「打开发布页」手动下载。
                    </p>
                  )}
                </div>
              )}

              {!isDownloading && !isDownloaded && !hasUpdate && !error && (
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-input)] px-4 py-3">
                  <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
                    {checkResult?.status === 'up-to-date'
                      ? '已是最新版本。'
                      : checkResult?.status === 'no-release'
                        ? 'GitHub 上还没有发布任何版本，暂时无法检查更新。'
                        : '尚未检查更新。点击「检查更新」获取最新版本信息。'}
                  </p>
                </div>
              )}

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
