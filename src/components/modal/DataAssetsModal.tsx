import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useModalA11y } from '@/hooks/useModalA11y';
import { formatBytes } from '@/lib/format/format';
import { loadDataHealth, openCrashLogFile } from '@/lib/dataAssets/health';

type Tab = 'operations' | 'relink' | 'backup' | 'health';
type Notify = (message: string, type: 'success' | 'info' | 'error' | 'warning') => void;

interface DataAssetsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onNotify?: Notify;
}

const PAGE_SIZE = 20;
const TYPE_LABEL: Record<string, string> = {
  rename: '重命名',
  delete: '删除',
  move: '移动',
  export: '导出',
};

const fmtTime = (ts: number): string => new Date(ts).toLocaleString('zh-CN', { hour12: false });

const card = 'rounded-xl border border-[var(--border-default)] bg-[var(--bg-input)] px-4 py-3';
const smallBtn =
  'px-3 py-1.5 text-xs font-medium rounded-lg border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] transition-all disabled:opacity-40 disabled:cursor-not-allowed';
const primaryBtn =
  'px-4 py-2 text-sm font-medium rounded-xl text-[var(--accent-contrast)] bg-[linear-gradient(135deg,var(--accent-blue),var(--accent-blue-hover))] disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * 「数据资产」面板（菜单：文件 → 数据资产…，⌘⇧D）。
 *
 * 把四件容易散落各处的收口集中到一个入口：配置导出 / 导入、路径重连、
 * 操作日志与撤销、按原目录增量备份。所有动作都走主进程 IPC，面板只负责展示与确认。
 */
const DataAssetsModal: React.FC<DataAssetsModalProps> = ({ isOpen, onClose, onNotify }) => {
  const [tab, setTab] = useState<Tab>('operations');
  const [busy, setBusy] = useState(false);

  // ---- 最近操作 ----
  const [entries, setEntries] = useState<OperationEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState('all');

  const loadLog = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.getOperationLog) return;
    const res = await api.getOperationLog({ offset, limit: PAGE_SIZE, type: filter });
    if (res.ok) {
      setEntries(res.data.entries);
      setTotal(res.data.total);
    } else onNotify?.(res.error, 'error');
  }, [offset, filter, onNotify]);

  // ---- 路径重连 ----
  const [candidates, setCandidates] = useState<
    { path: string; kind: string; available: boolean }[]
  >([]);
  const [orphanCount, setOrphanCount] = useState(0);

  const loadCandidates = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.getRelinkCandidates) return;
    const res = await api.getRelinkCandidates();
    if (res.ok) {
      setCandidates(res.data.sources);
      setOrphanCount(res.data.orphanCount);
    } else onNotify?.(res.error, 'error');
  }, [onNotify]);

  // ---- 增量备份 ----
  const [targetDir, setTargetDir] = useState('');
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [backupRunning, setBackupRunning] = useState(false);
  const [summary, setSummary] = useState<BackupSummary | null>(null);

  // ---- 数据健康检查 ----
  const [health, setHealth] = useState<DataHealthReport | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  useModalA11y({
    isOpen,
    onClose,
    containerRef: dialogRef,
    disabled: busy || backupRunning,
  });

  const loadHealth = useCallback(async () => {
    setHealthLoading(true);
    setHealthError(null);
    try {
      const res = await loadDataHealth();
      if (res.ok) setHealth(res.data);
      else setHealthError(res.error);
    } finally {
      setHealthLoading(false);
    }
  }, []);

  const handleOpenCrashLog = async () => {
    const error = await openCrashLogFile();
    if (error) onNotify?.(error, 'error');
  };

  useEffect(() => {
    if (!isOpen) return;
    return window.electronAPI?.onBackupProgress?.((p) => setProgress(p));
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (tab === 'operations') void loadLog();
    if (tab === 'relink') void loadCandidates();
    if (tab === 'health') void loadHealth();
  }, [isOpen, tab, loadLog, loadCandidates, loadHealth]);

  if (!isOpen) return null;

  const pickDirectory = async (allowCreate: boolean): Promise<string | null> => {
    const res = await window.electronAPI?.chooseDirectory?.({ allowCreate });
    if (!res) return null;
    if (!res.ok) {
      onNotify?.(res.error, 'error');
      return null;
    }
    return res.data;
  };

  const handleExport = async () => {
    setBusy(true);
    try {
      const res = await window.electronAPI?.exportConfig?.();
      if (!res) return;
      if (!res.ok) onNotify?.(res.error, 'error');
      else if (res.data) onNotify?.(`配置已导出到 ${res.data.path}（不含 AI 密钥）`, 'success');
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    setBusy(true);
    try {
      const res = await window.electronAPI?.importConfig?.();
      if (!res) return;
      if (!res.ok) onNotify?.(res.error, 'error');
      else if (res.data) {
        onNotify?.('配置已导入，请重启应用使设置生效；旧配置已备份为 config.json.bak', 'warning');
        void loadCandidates();
      }
    } finally {
      setBusy(false);
    }
  };

  const handleUndo = async (id: string) => {
    setBusy(true);
    try {
      const res = await window.electronAPI?.undoOperation?.(id);
      if (!res) return;
      if (res.ok) {
        onNotify?.('已撤销，文件已回到原路径', 'success');
        await loadLog();
      } else onNotify?.(res.error, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleRelink = async (oldRoot: string) => {
    const newRoot = await pickDirectory(false);
    if (!newRoot) return;
    setBusy(true);
    try {
      const res = await window.electronAPI?.relinkSource?.(oldRoot, newRoot);
      if (!res) return;
      if (!res.ok) onNotify?.(res.error, 'error');
      else {
        const { count, conflicts, unresolved } = res.data;
        onNotify?.(
          `已重连：续接 ${count} 条记录，冲突 ${conflicts} 条（保留现值），${unresolved} 条仍找不到文件`,
          unresolved > 0 ? 'warning' : 'success'
        );
        await loadCandidates();
        void onNotify?.('请重新导入新目录，标注会随内容指纹自动回到照片上', 'info');
      }
    } finally {
      setBusy(false);
    }
  };

  const handlePickTarget = async () => {
    const picked = await pickDirectory(true);
    if (picked) setTargetDir(picked);
  };

  const handleStartBackup = async () => {
    if (!targetDir) return;
    setBackupRunning(true);
    setProgress(null);
    setSummary(null);
    try {
      const res = await window.electronAPI?.startBackup?.(targetDir);
      if (!res) return;
      if (!res.ok) onNotify?.(res.error, 'error');
      else {
        setSummary(res.data);
        const s = res.data;
        onNotify?.(
          `备份完成：复制 ${s.copied} 个、跳过 ${s.skipped} 个、失败 ${s.failed} 个${s.cancelled ? '（已取消）' : ''}`,
          s.failed > 0 || s.cancelled ? 'warning' : 'success'
        );
      }
    } finally {
      setBackupRunning(false);
    }
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: 'operations', label: '最近操作' },
    { key: 'relink', label: '路径重连' },
    { key: 'backup', label: '增量备份' },
    { key: 'health', label: '健康检查' },
  ];

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[var(--bg-overlay)] backdrop-blur-md animate-fadeIn">
      <div
        className="bg-[var(--bg-elevated)] rounded-2xl shadow-2xl w-[680px] max-w-[92vw] max-h-[86vh] overflow-hidden border border-[var(--border-default)] animate-scaleIn flex flex-col"
        role="dialog"
        aria-modal="true"
        ref={dialogRef}
        aria-label="数据资产"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-[var(--border-subtle)] flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-[var(--text-primary)]">数据资产</h3>
            <p className="text-sm text-[var(--text-tertiary)] mt-1">
              配置、路径、操作记录与备份。所有处理都在本机完成。
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <button className={smallBtn} disabled={busy} onClick={() => void handleExport()}>
              导出配置
            </button>
            <button className={smallBtn} disabled={busy} onClick={() => void handleImport()}>
              导入配置
            </button>
          </div>
        </div>

        <div className="px-6 pt-4 flex gap-2">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 text-xs rounded-lg transition-all ${
                tab === t.key
                  ? 'bg-[var(--bg-glass-hover)] text-[var(--text-primary)] font-medium'
                  : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="px-6 py-4 flex-1 overflow-y-auto min-h-[260px] space-y-3">
          {tab === 'operations' && (
            <>
              <div className="flex items-center justify-between gap-3">
                <select
                  value={filter}
                  onChange={(e) => {
                    setFilter(e.target.value);
                    setOffset(0);
                  }}
                  className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border-default)] bg-[var(--bg-input)] text-[var(--text-primary)]"
                >
                  <option value="all">全部操作</option>
                  <option value="rename">重命名</option>
                  <option value="delete">删除</option>
                  <option value="move">移动</option>
                  <option value="export">导出</option>
                </select>
                <span className="text-xs text-[var(--text-tertiary)]">共 {total} 条</span>
              </div>

              {entries.length === 0 && (
                <div className={card}>
                  <p className="text-xs text-[var(--text-tertiary)]">还没有文件操作记录。</p>
                </div>
              )}

              {entries.map((e) => (
                <div key={e.id} className={card}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="shrink-0 px-2 py-0.5 rounded-md text-[11px] bg-[var(--bg-glass-hover)] text-[var(--text-secondary)]">
                        {TYPE_LABEL[e.type] ?? e.type}
                      </span>
                      <span className="text-[11px] text-[var(--text-quaternary)] shrink-0">
                        {fmtTime(e.at)}
                      </span>
                      {e.undone && (
                        <span className="text-[11px] text-[var(--text-quaternary)]">已撤销</span>
                      )}
                    </div>
                    {(e.type === 'rename' || e.type === 'delete') && !e.undone && (
                      <button
                        className={smallBtn}
                        disabled={busy}
                        onClick={() => void handleUndo(e.id)}
                      >
                        撤销
                      </button>
                    )}
                  </div>
                  <p className="mt-2 text-xs font-mono text-[var(--text-secondary)] break-all">
                    {e.from ?? '—'}
                    {e.to ? ` → ${e.to}` : ''}
                  </p>
                </div>
              ))}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  className={smallBtn}
                  disabled={offset === 0 || busy}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  上一页
                </button>
                <button
                  className={smallBtn}
                  disabled={offset + PAGE_SIZE >= total || busy}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  下一页
                </button>
              </div>
              <p className="text-[11px] leading-relaxed text-[var(--text-quaternary)]">
                撤销支持最近的重命名与删除。删除的文件需仍在系统回收站中；macOS
                上按文件名、体积与修改时间三重校验后取回，找不到或原位置已有同名文件时会明确提示，不会覆盖。
              </p>
            </>
          )}

          {tab === 'relink' && (
            <>
              <div className={card}>
                <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
                  配置已按内容指纹保存，文件改名、移动、删后重导入都会自动续上标注。
                  若整个目录被搬到别处，可在这里「重新定位」；待续接的旧记录还有{' '}
                  <b>{orphanCount}</b> 条。
                </p>
              </div>
              {candidates.length === 0 && (
                <div className={card}>
                  <p className="text-xs text-[var(--text-tertiary)]">尚无常驻来源。</p>
                </div>
              )}
              {candidates.map((s) => (
                <div key={s.path} className={card}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-mono text-[var(--text-secondary)] break-all">
                        {s.path}
                      </p>
                      <p className="mt-1 text-[11px] text-[var(--text-quaternary)]">
                        {s.available ? '可用' : '不可用（目录可能已被移动或卷未挂载）'}
                      </p>
                    </div>
                    <button
                      className={smallBtn}
                      disabled={busy}
                      onClick={() => void handleRelink(s.path)}
                    >
                      重新定位
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}

          {tab === 'health' && (
            <>
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-[var(--text-tertiary)]">
                  只读取本机统计：配置与备份、路径重连、缩略图缓存、迁移与崩溃记录。不上传任何内容。
                </p>
                <button
                  className={smallBtn}
                  disabled={healthLoading}
                  onClick={() => void loadHealth()}
                >
                  {healthLoading ? '检查中…' : '重新检查'}
                </button>
              </div>

              {healthError && (
                <div className={card}>
                  <p className="text-xs text-[var(--accent-pink)]">{healthError}</p>
                </div>
              )}

              {health && (
                <>
                  {health.warnings.length === 0 ? (
                    <div className={card}>
                      <p className="text-xs text-[var(--text-secondary)]">
                        未发现需要处理的问题。配置有备份，标注没有待续接的孤儿，崩溃日志为空。
                      </p>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-[rgba(var(--accent-orange-rgb),0.35)] bg-[rgba(var(--accent-orange-rgb),0.1)] px-4 py-3">
                      <p className="mb-1.5 text-xs font-medium text-[var(--accent-orange)]">
                        需要注意 {health.warnings.length} 项
                      </p>
                      <ul className="space-y-1">
                        {health.warnings.map((warning) => (
                          <li
                            key={warning}
                            className="text-[11px] leading-relaxed text-[var(--text-secondary)]"
                          >
                            · {warning}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className={card}>
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs font-medium text-[var(--text-secondary)]">配置与备份</p>
                      <p className="text-[11px] text-[var(--text-quaternary)]">
                        结构版本 v{health.config.version}
                      </p>
                    </div>
                    <div className="mt-2 space-y-1.5 text-[11px] text-[var(--text-tertiary)]">
                      <p>
                        config.json：
                        {health.config.exists
                          ? `${formatBytes(health.config.size)} · ${fmtTime(health.config.mtime ?? 0)}`
                          : '尚未写入'}
                        {health.config.parseOk === false ? ' · 无法解析' : ''}
                      </p>
                      {health.config.backups.map((backup) => (
                        <p
                          key={backup.name}
                          className={
                            backup.exists && backup.parseOk === false
                              ? 'text-[var(--accent-pink)]'
                              : undefined
                          }
                        >
                          {backup.name}：
                          {backup.exists
                            ? `${formatBytes(backup.size)} · ${fmtTime(backup.mtime ?? 0)}${
                                backup.parseOk === false ? ' · 无法解析' : ''
                              }`
                            : '不存在'}
                        </p>
                      ))}
                    </div>
                  </div>

                  <div className={`${card} grid grid-cols-2 gap-x-4 gap-y-3 text-[11px]`}>
                    <div>
                      <p className="text-[var(--text-quaternary)]">待路径重连</p>
                      <p className="mt-1 text-sm font-semibold tabular-nums text-[var(--text-primary)]">
                        {health.orphans} 条
                      </p>
                    </div>
                    <div>
                      <p className="text-[var(--text-quaternary)]">缩略图缓存</p>
                      <p className="mt-1 text-sm font-semibold tabular-nums text-[var(--text-primary)]">
                        {health.thumbCache.files} 个 · {formatBytes(health.thumbCache.bytes)}
                      </p>
                      <p className="mt-0.5 text-[11px] text-[var(--text-quaternary)]">
                        上限 {health.thumbCache.limit} 个，超过时启动自动修剪
                      </p>
                    </div>
                    <div>
                      <p className="text-[var(--text-quaternary)]">操作日志</p>
                      <p className="mt-1 text-sm font-semibold tabular-nums text-[var(--text-primary)]">
                        {health.operationLog.entries} 条
                      </p>
                      <p className="mt-0.5 text-[11px] text-[var(--text-quaternary)]">
                        {health.operationLog.lastAt
                          ? `最近 ${fmtTime(health.operationLog.lastAt)}`
                          : '还没有文件操作记录'}
                      </p>
                    </div>
                    <div>
                      <p className="text-[var(--text-quaternary)]">崩溃日志</p>
                      <p className="mt-1 text-sm font-semibold tabular-nums text-[var(--text-primary)]">
                        {health.crashLog.entries} 条
                      </p>
                      <p className="mt-0.5 text-[11px] text-[var(--text-quaternary)]">
                        {health.crashLog.lastAt
                          ? `最近 ${fmtTime(health.crashLog.lastAt)}`
                          : '没有异常记录'}
                      </p>
                      {health.crashLog.entries > 0 && (
                        <button
                          className={`${smallBtn} mt-1.5`}
                          onClick={() => void handleOpenCrashLog()}
                        >
                          打开日志
                        </button>
                      )}
                    </div>
                  </div>

                  <div className={card}>
                    <p className="text-xs font-medium text-[var(--text-secondary)]">
                      最近一次启动迁移
                    </p>
                    {health.migration ? (
                      <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
                        {fmtTime(health.migration.at)} ·{' '}
                        {health.migration.error
                          ? `失败：${health.migration.error}`
                          : health.migration.changed && health.migration.stats
                            ? `完成 v1 → v2：扫描 ${health.migration.stats.paths} 条路径，匹配 ${health.migration.stats.matched} 条，留下 ${health.migration.stats.orphans} 条孤儿待重连`
                            : '无需迁移（配置已是当前结构）'}
                      </p>
                    ) : (
                      <p className="mt-2 text-[11px] text-[var(--text-tertiary)]">
                        还没有迁移记录。
                      </p>
                    )}
                  </div>
                </>
              )}
            </>
          )}

          {tab === 'backup' && (
            <>
              <div className={card}>
                <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
                  按原目录结构把来源里的文件增量复制到备份盘。体积与修改时间一致即跳过，
                  因此中断后重跑会接着上次继续，不会重复复制。区别于「导出」——这里不做格式转换。
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  className={smallBtn}
                  disabled={backupRunning}
                  onClick={() => void handlePickTarget()}
                >
                  选择备份目录…
                </button>
                <span className="text-xs font-mono text-[var(--text-tertiary)] break-all flex-1">
                  {targetDir || '尚未选择'}
                </span>
              </div>

              {progress && (
                <div className={card}>
                  <div className="flex justify-between text-xs text-[var(--text-secondary)]">
                    <span>
                      {progress.done} / {progress.total}
                    </span>
                    <span>
                      复制 {progress.copied} · 跳过 {progress.skipped} · 失败 {progress.failed}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 rounded-full bg-[var(--bg-glass-hover)] overflow-hidden">
                    <div
                      className="h-full bg-[var(--accent-blue)] transition-all"
                      style={{
                        width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%`,
                      }}
                    />
                  </div>
                  <p className="mt-2 text-xs font-mono text-[var(--text-quaternary)] truncate">
                    {progress.current}
                  </p>
                </div>
              )}

              {summary && (
                <div className={card}>
                  <p className="text-xs text-[var(--text-secondary)]">
                    结果：共 {summary.total} 个，复制 {summary.copied}，跳过 {summary.skipped}，失败{' '}
                    {summary.failed}
                    {summary.cancelled ? '（已取消）' : ''}
                  </p>
                </div>
              )}

              <div className="flex gap-2">
                <button
                  className={primaryBtn}
                  disabled={!targetDir || backupRunning}
                  onClick={() => void handleStartBackup()}
                >
                  {backupRunning ? '备份中…' : '开始备份'}
                </button>
                <button
                  className={smallBtn}
                  disabled={!backupRunning}
                  onClick={() => void window.electronAPI?.cancelBackup?.()}
                >
                  取消
                </button>
              </div>
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-[var(--border-subtle)] flex items-center justify-between gap-3">
          <p className="text-[11px] text-[var(--text-quaternary)]">
            导出文件不含 AI 设置里的 API Key
          </p>
          <button onClick={onClose} disabled={backupRunning} className={smallBtn}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
};

export default DataAssetsModal;
