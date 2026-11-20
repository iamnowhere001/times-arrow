/**
 * 「检查更新」面板。
 *
 * 只做展示与转发：真正的检查、下载、打开 DMG 都在主进程完成。
 * Release 说明按纯文本渲染（不使用 dangerouslySetInnerHTML），
 * 因为 Release 正文来自网络，不能当作 HTML 信任。
 */

import type { UpdateCheckResult, UpdateDownloadState } from '@/types';
import ModalShell from '@/components/common/ModalShell';

interface UpdateModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentVersion: string;
  checkResult: UpdateCheckResult | null;
  isChecking: boolean;
  error: string | null;
  download: UpdateDownloadState;
  autoCheck: boolean;
  onCheck: () => void;
  onDownload: () => void;
  onCancelDownload: () => void;
  onOpenDownload: () => void;
  onRevealDownload: () => void;
  onOpenRelease: () => void;
  onToggleAutoCheck: (enabled: boolean) => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

function formatPublishedAt(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('zh-CN');
}

const primaryButtonClass =
  'px-5 py-2.5 text-sm font-semibold rounded-xl transition-all duration-200 text-[var(--accent-contrast)] bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-hover))] shadow-lg shadow-[rgba(var(--accent-blue-rgb),0.3)] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2';

const secondaryButtonClass =
  'px-5 py-2.5 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-default)] hover:bg-[var(--bg-glass-hover)] rounded-xl transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2';

export function UpdateModal({
  isOpen,
  onClose,
  currentVersion,
  checkResult,
  isChecking,
  error,
  download,
  autoCheck,
  onCheck,
  onDownload,
  onCancelDownload,
  onOpenDownload,
  onRevealDownload,
  onOpenRelease,
  onToggleAutoCheck,
}: UpdateModalProps) {
  const isDownloading = download.state === 'downloading';
  const isDownloaded = download.state === 'done';
  const hasUpdate = checkResult?.status === 'available';
  const assetSize = formatBytes(checkResult?.asset?.size ?? 0);

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      zIndex={80}
      a11yDisabled={isDownloading}
      ariaLabel="检查更新"
      panelClassName="bg-[var(--bg-elevated)] backdrop-blur-xl rounded-2xl shadow-2xl w-[520px] max-w-[90vw] overflow-hidden border border-[var(--border-default)] animate-scaleIn flex flex-col"
    >
      <div className="px-6 py-5 border-b border-[var(--border-subtle)]">
        <h3 className="text-lg font-semibold text-[var(--text-primary)]">检查更新</h3>
        <p className="text-sm text-[var(--text-tertiary)] mt-1">
          从 GitHub Releases 获取新版本，下载后手动拖入「应用程序」完成安装。
        </p>
      </div>

      <div className="p-6 space-y-5 max-h-[60vh] overflow-y-auto">
        <div className="flex items-center justify-between text-sm">
          <span className="text-[var(--text-tertiary)]">当前版本</span>
          <span className="font-mono text-[var(--text-primary)]">
            {currentVersion ? `v${currentVersion}` : '读取中…'}
          </span>
        </div>

        <label className="flex items-center justify-between gap-4 cursor-pointer select-none">
          <span className="text-xs text-[var(--text-tertiary)]">
            启动时自动检查更新（静默检查，仅在有新版本时提示）
          </span>
          <input
            type="checkbox"
            checked={autoCheck}
            onChange={(event) => onToggleAutoCheck(event.target.checked)}
            className="accent-[var(--accent-blue)] w-4 h-4 shrink-0"
          />
        </label>

        {error && (
          <div className="rounded-xl border border-[rgba(var(--accent-pink-rgb),0.3)] bg-[rgba(var(--accent-pink-rgb),0.1)] px-4 py-3">
            <p className="text-xs leading-relaxed text-[var(--accent-pink)]">{error}</p>
          </div>
        )}

        {isDownloading && (
          <div>
            <div className="flex items-center justify-between mb-2 text-xs">
              <span className="text-[var(--text-secondary)]">
                正在下载更新包
                {download.version ? ` ${download.version}` : ''}
              </span>
              <span className="font-mono text-[var(--text-tertiary)]">
                {download.percent}%
                {download.total > 0
                  ? ` · ${formatBytes(download.received)} / ${formatBytes(download.total)}`
                  : ''}
              </span>
            </div>
            <div className="h-2 rounded-full bg-[var(--bg-input)] overflow-hidden">
              <div
                className="h-full rounded-full bg-[var(--accent-blue)] transition-[width] duration-200"
                style={{ width: `${Math.max(download.percent, 2)}%` }}
              />
            </div>
            <p className="mt-2 text-[11px] text-[var(--text-quaternary)]">
              下载期间可以取消；已下载的部分会被清理，不会留下半截文件。
            </p>
          </div>
        )}

        {!isDownloading && isDownloaded && (
          <div className="rounded-xl border border-[rgba(var(--accent-green-rgb),0.3)] bg-[rgba(var(--accent-green-rgb),0.1)] px-4 py-3 space-y-2">
            <p className="text-xs leading-relaxed text-[var(--accent-green)]">
              更新包已下载完成。打开磁盘映像后，把「时光画框」拖入「应用程序」覆盖旧版本，
              然后退出并重新打开即可。
            </p>
            <p className="text-[11px] leading-relaxed text-[var(--text-tertiary)]">
              更新包未做代码签名：首次启动如被系统拦截，请在「应用程序」中右键应用选择「打开」。
            </p>
            {download.filePath && (
              <p className="text-xs leading-relaxed font-mono break-all text-[var(--text-quaternary)]">
                {download.filePath}
              </p>
            )}
          </div>
        )}

        {!isDownloading && !isDownloaded && hasUpdate && (
          <div className="space-y-3">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-sm text-[var(--text-secondary)]">
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
              <pre className="m-0 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-input)] px-4 py-3 text-xs leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap break-words max-h-48 overflow-y-auto font-sans">
                {checkResult.releaseNotes}
              </pre>
            ) : (
              <p className="text-xs text-[var(--text-quaternary)]">该版本没有填写更新说明。</p>
            )}
            {!checkResult?.asset && (
              <p className="text-xs leading-relaxed text-[var(--accent-pink)]">
                该版本没有提供 DMG 安装包，请前往发布页手动下载。
              </p>
            )}
          </div>
        )}

        {!isDownloading && !isDownloaded && !hasUpdate && !error && (
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-input)] px-4 py-3">
            <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
              {isChecking
                ? '正在检查更新…'
                : checkResult?.status === 'up-to-date'
                  ? '已是最新版本。'
                  : checkResult?.status === 'no-release'
                    ? 'GitHub 上还没有发布任何版本，暂时无法检查更新。'
                    : '点击下方「检查更新」获取最新版本信息。'}
            </p>
          </div>
        )}
      </div>

      <div className="px-6 py-4 border-t border-[var(--border-subtle)] flex items-center justify-between gap-3">
        <button type="button" onClick={onClose} className={secondaryButtonClass}>
          {isDownloading ? '后台下载' : '关闭'}
        </button>
        <div className="flex items-center gap-3">
          {hasUpdate && (
            <button type="button" onClick={onOpenRelease} className={secondaryButtonClass}>
              发布页
            </button>
          )}
          {isDownloading ? (
            <button type="button" onClick={onCancelDownload} className={primaryButtonClass}>
              取消下载
            </button>
          ) : isDownloaded ? (
            <>
              <button type="button" onClick={onRevealDownload} className={secondaryButtonClass}>
                在访达中显示
              </button>
              <button type="button" onClick={onOpenDownload} className={primaryButtonClass}>
                打开磁盘映像
              </button>
            </>
          ) : hasUpdate && checkResult?.asset ? (
            <button type="button" onClick={onDownload} className={primaryButtonClass}>
              下载更新
            </button>
          ) : (
            <button
              type="button"
              onClick={onCheck}
              disabled={isChecking}
              className={primaryButtonClass}
            >
              {isChecking && (
                <span className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
              )}
              {isChecking ? '检查中…' : '检查更新'}
            </button>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

export default UpdateModal;
