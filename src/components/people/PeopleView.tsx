import React, { useCallback, useMemo, useState } from 'react';
import { FacePerson, Photo } from '@/types';
import { useFaceRecognition } from '@/hooks/useFaceRecognition';
import { ChevronLeftIcon } from '@/components/icons';
import ImmersiveView from '@/components/common/ImmersiveView';
import { ThumbImage } from '@/components/grid/ThumbnailImage';

interface PeopleViewProps {
  /** 图库里未被隐藏的照片；扫描只用这些，人物照片也按 fileId 回连 */
  photos: Photo[];
  onQuickLook: (photo: Photo) => void;
  onBack: () => void;
  /** 侧栏是否展开：标题栏据此为红绿灯让位 */
  isLeftPaneOpen: boolean;
}

/** 未命名人物的展示名；命名后原样显示 */
function displayName(person: FacePerson): string {
  return person.name || '未命名';
}

const PeopleGlyph: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
    <circle cx="17" cy="9" r="2.4" />
    <path d="M15 14.4c2.6-.5 5 1.2 5.6 4.2" />
  </svg>
);

const PencilGlyph: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z" />
    <path d="M13.5 6.5l3 3" />
  </svg>
);

const PeopleView: React.FC<PeopleViewProps> = ({ photos, onQuickLook, onBack, isLeftPaneOpen }) => {
  const {
    model,
    scan,
    people,
    personPhotos,
    selectedPerson,
    loading,
    busy,
    error,
    notice,
    setError,
    setNotice,
    downloadModel,
    cancelModelDownload,
    startScan,
    cancelScan,
    clearIndex,
    renamePerson,
    mergePeople,
    openPerson,
    closePerson,
  } = useFaceRecognition(photos);

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  const modelState = model?.state ?? 'unknown';
  const modelReady = modelState === 'ready';
  const downloading = modelState === 'downloading' || modelState === 'installing';
  const scanning = scan.isScanning;
  const scanPercent = scan.total > 0 ? Math.round((scan.done / scan.total) * 100) : 0;

  const totalFaces = useMemo(
    () => people.reduce((sum, person) => sum + person.faceCount, 0),
    [people]
  );

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  }, []);

  const exitSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds([]);
  }, []);

  const handleMerge = useCallback(async () => {
    if (selectedIds.length < 2) return;
    // 合并目标优先选「已经有名字」的那个人，避免把用户命名冲掉
    const target =
      people.find((person) => selectedIds.includes(person.id) && person.name) ||
      people.find((person) => person.id === selectedIds[0]);
    if (!target) return;
    const sourceIds = [target.id, ...selectedIds.filter((id) => id !== target.id)];
    const merged = await mergePeople(sourceIds);
    if (merged) exitSelection();
  }, [selectedIds, people, mergePeople, exitSelection]);

  const startRename = useCallback((person: FacePerson) => {
    setEditingId(person.id);
    setDraftName(person.name);
  }, []);

  const commitRename = useCallback(async () => {
    if (!editingId) return;
    const id = editingId;
    setEditingId(null);
    await renamePerson(id, draftName);
  }, [editingId, draftName, renamePerson]);

  const scanBanner = scanning ? (
    <div className="mx-auto mb-6 w-full max-w-[560px] rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-[var(--text-primary)]">
            正在识别人像 · {scanPercent}%
          </p>
          <p className="mt-0.5 truncate text-[11px] text-[var(--text-tertiary)]">
            {scan.current || '正在准备模型…'}（{scan.done}/{scan.total}）
          </p>
        </div>
        <button
          type="button"
          onClick={cancelScan}
          className="shrink-0 rounded-lg border border-[var(--border-subtle)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)]"
        >
          取消
        </button>
      </div>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-[var(--bg-input)]">
        <div
          className="h-full rounded-full bg-[var(--accent-blue)] transition-[width] duration-200"
          style={{ width: `${Math.max(scanPercent, 2)}%` }}
        />
      </div>
    </div>
  ) : null;

  const onboarding = (
    <div className="mx-auto mt-[8vh] w-full max-w-[520px] px-6">
      <div className="rounded-3xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-8">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--bg-input)] text-[var(--text-secondary)]">
          <PeopleGlyph className="h-6 w-6" />
        </div>
        <h2 className="mt-5 text-[19px] font-semibold text-[var(--text-primary)]">本地人像识别</h2>
        <p className="mt-2 text-[13px] leading-6 text-[var(--text-secondary)]">
          自动把照片里的人物聚到一起。识别模型只在首次使用时下载（约
          15MB），之后所有推理都在本机完成， 照片不会离开这台 Mac。
        </p>

        {downloading ? (
          <div className="mt-6">
            <div className="flex items-center justify-between text-[12px] text-[var(--text-secondary)]">
              <span>正在下载模型…</span>
              <span className="font-numeric tabular-nums">{model?.percent ?? 0}%</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--bg-input)]">
              <div
                className="h-full rounded-full bg-[var(--accent-blue)] transition-[width] duration-200"
                style={{ width: `${Math.max(model?.percent ?? 0, 2)}%` }}
              />
            </div>
            <button
              type="button"
              onClick={cancelModelDownload}
              className="mt-4 text-[12px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
            >
              取消下载
            </button>
          </div>
        ) : (
          <div className="mt-6 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void downloadModel()}
              className="rounded-xl bg-[var(--accent-blue)] px-4 py-2 text-[13px] font-medium text-[var(--accent-contrast)] transition-opacity hover:opacity-90 active:scale-[0.99]"
            >
              下载并启用模型
            </button>
            <span className="text-[11px] text-[var(--text-tertiary)]">
              {modelState === 'error' ? '上次下载失败，可重试' : '仅支持 macOS Apple Silicon'}
            </span>
          </div>
        )}
      </div>
    </div>
  );

  const personCard = (person: FacePerson) => {
    const selected = selectedIds.includes(person.id);
    const editing = editingId === person.id;
    return (
      <div key={person.id} className="group relative min-w-0">
        <button
          type="button"
          onClick={() => {
            if (selectionMode) toggleSelection(person.id);
            else void openPerson(person);
          }}
          className={`block w-full overflow-hidden rounded-2xl border text-left transition-all duration-200 ${
            selected
              ? 'border-[var(--accent-blue)] ring-2 ring-[var(--accent-blue)]/30'
              : 'border-[var(--border-subtle)] hover:border-[var(--border-hover)]'
          }`}
        >
          <div className="relative aspect-square w-full overflow-hidden bg-[var(--bg-card)]">
            {person.coverUrl ? (
              <img
                src={person.coverUrl}
                alt={displayName(person)}
                loading="lazy"
                draggable={false}
                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-[var(--text-tertiary)]">
                <PeopleGlyph className="h-8 w-8" />
              </div>
            )}
            {selectionMode && (
              <span
                className={`absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full border ${
                  selected
                    ? 'border-[var(--accent-blue)] bg-[var(--accent-blue)] text-[var(--accent-contrast)]'
                    : 'border-[var(--border-default)] bg-[var(--bg-overlay)]'
                }`}
              >
                {selected && (
                  <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden>
                    <path
                      d="M3.5 8.5l3 3 6-6.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </span>
            )}
          </div>
        </button>

        <div className="mt-2 flex items-center gap-1 px-1">
          {editing ? (
            <input
              autoFocus
              value={draftName}
              maxLength={40}
              placeholder="输入姓名"
              onChange={(event) => setDraftName(event.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void commitRename();
                if (event.key === 'Escape') setEditingId(null);
              }}
              className="h-6 min-w-0 flex-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-1.5 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-blue)]"
            />
          ) : (
            <>
              <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text-primary)]">
                {displayName(person)}
              </p>
              {!selectionMode && (
                <button
                  type="button"
                  title="重命名"
                  aria-label={`重命名 ${displayName(person)}`}
                  onClick={() => startRename(person)}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] opacity-0 transition-opacity hover:text-[var(--text-primary)] group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <PencilGlyph className="h-3.5 w-3.5" />
                </button>
              )}
            </>
          )}
        </div>
        <p className="mt-0.5 px-1 text-[11px] text-[var(--text-tertiary)]">
          {person.photoCount} 张照片 · {person.faceCount} 张人脸
        </p>
      </div>
    );
  };

  const header = selectedPerson ? (
    <header
      className={`app-drag z-20 shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] backdrop-blur-xl ${
        isLeftPaneOpen ? 'px-4' : 'pl-[78px] pr-4'
      }`}
    >
      <div className="app-no-drag flex h-[52px] items-center gap-3">
        <button
          type="button"
          onClick={closePerson}
          title="返回人物列表"
          aria-label="返回人物列表"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[var(--text-secondary)] transition-all duration-200 hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] active:scale-[0.98]"
        >
          <ChevronLeftIcon />
        </button>
        <div className="flex min-w-0 items-baseline gap-3">
          {editingId === selectedPerson.id ? (
            <input
              autoFocus
              value={draftName}
              maxLength={40}
              placeholder="输入姓名"
              onChange={(event) => setDraftName(event.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void commitRename();
                if (event.key === 'Escape') setEditingId(null);
              }}
              className="h-7 min-w-0 max-w-[240px] rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-2 text-[14px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-blue)]"
            />
          ) : (
            <h1 className="truncate text-[17px] font-semibold text-[var(--text-primary)]">
              {displayName(selectedPerson)}
            </h1>
          )}
          <span className="hidden text-[11px] text-[var(--text-tertiary)] sm:inline">
            {selectedPerson.photoCount} 张照片
          </span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => startRename(selectedPerson)}
            className="rounded-lg border border-[var(--border-subtle)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)]"
          >
            重命名
          </button>
        </div>
      </div>
    </header>
  ) : (
    <header
      className={`app-drag z-20 shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] backdrop-blur-xl ${
        isLeftPaneOpen ? 'px-4' : 'pl-[78px] pr-4'
      }`}
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
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="truncate text-[17px] font-semibold text-[var(--text-primary)]">人像</h1>
          {people.length > 0 && (
            <span className="hidden text-[11px] text-[var(--text-tertiary)] sm:inline">
              {people.length} 位人物 · {totalFaces} 张人脸
            </span>
          )}
        </div>
        {modelReady && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {people.length > 1 && (
              <button
                type="button"
                onClick={() => (selectionMode ? exitSelection() : setSelectionMode(true))}
                className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  selectionMode
                    ? 'border-[var(--accent-blue)] text-[var(--accent-blue)]'
                    : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)]'
                }`}
              >
                {selectionMode ? '取消选择' : '选择'}
              </button>
            )}
            <button
              type="button"
              disabled={scanning}
              onClick={() => void startScan(true)}
              className="rounded-lg border border-[var(--border-subtle)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-glass-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
            >
              重新识别
            </button>
          </div>
        )}
      </div>
    </header>
  );

  return (
    <ImmersiveView>
      {header}

      <div className="custom-scrollbar flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1280px] px-5 py-7 sm:px-7 md:px-10">
          {error && (
            <div className="mb-5 flex items-start justify-between gap-3 rounded-xl border border-[var(--color-signal-danger)]/40 bg-[var(--color-signal-danger)]/10 px-4 py-3 text-[12px] text-[var(--color-signal-danger)]">
              <span className="min-w-0">{error}</span>
              <button
                type="button"
                onClick={() => setError(null)}
                className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
                aria-label="关闭错误提示"
              >
                ×
              </button>
            </div>
          )}
          {notice && (
            <div className="mb-5 flex items-start justify-between gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-4 py-3 text-[12px] text-[var(--text-secondary)]">
              <span className="min-w-0">{notice}</span>
              <button
                type="button"
                onClick={() => setNotice(null)}
                className="shrink-0 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
                aria-label="关闭提示"
              >
                ×
              </button>
            </div>
          )}

          {selectedPerson ? (
            personPhotos.length > 0 ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
                {personPhotos.map((photo) => (
                  <button
                    key={photo.id}
                    type="button"
                    onClick={() => onQuickLook(photo)}
                    title={photo.name}
                    className="group relative aspect-square overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] transition-colors hover:border-[var(--border-hover)]"
                  >
                    <ThumbImage
                      photo={photo}
                      size={320}
                      alt={photo.name}
                      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                    />
                  </button>
                ))}
              </div>
            ) : (
              <p className="py-20 text-center text-[13px] text-[var(--text-tertiary)]">
                这位人物的照片已不在当前图库中
              </p>
            )
          ) : (
            <>
              {!modelReady && !loading && onboarding}
              {!modelReady && loading && (
                <p className="py-24 text-center text-[13px] text-[var(--text-tertiary)]">
                  正在检查人像模型…
                </p>
              )}
              {modelReady && scanBanner}
              {modelReady && loading && (
                <p className="py-24 text-center text-[13px] text-[var(--text-tertiary)]">
                  正在读取人像数据…
                </p>
              )}
              {modelReady && !loading && people.length === 0 && !scanning && (
                <div className="mx-auto mt-[8vh] w-full max-w-[520px] px-6 text-center">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--bg-input)] text-[var(--text-tertiary)]">
                    <PeopleGlyph className="h-6 w-6" />
                  </div>
                  <h2 className="mt-5 text-[17px] font-semibold text-[var(--text-primary)]">
                    还没有识别过人像
                  </h2>
                  <p className="mt-2 text-[13px] leading-6 text-[var(--text-secondary)]">
                    扫描当前图库，按人物自动整理照片。首次扫描会为每张照片建立索引，之后新增照片可以继续增量识别。
                  </p>
                  <button
                    type="button"
                    onClick={() => void startScan(false)}
                    className="mt-6 rounded-xl bg-[var(--accent-blue)] px-4 py-2 text-[13px] font-medium text-[var(--accent-contrast)] transition-opacity hover:opacity-90 active:scale-[0.99]"
                  >
                    开始识别
                  </button>
                </div>
              )}
              {modelReady && !loading && people.length > 0 && (
                <>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-4 gap-y-6">
                    {people.map(personCard)}
                  </div>

                  {selectionMode ? (
                    <div className="sticky bottom-4 mt-8 flex items-center justify-between gap-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-4 py-2.5 shadow-[var(--shadow-lg)]">
                      <span className="text-[12px] text-[var(--text-secondary)]">
                        已选 {selectedIds.length} 位人物，合并到其中命名的那位
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={exitSelection}
                          className="rounded-lg px-2.5 py-1 text-[12px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          disabled={selectedIds.length < 2 || busy}
                          onClick={() => void handleMerge()}
                          className="rounded-lg bg-[var(--accent-blue)] px-3 py-1.5 text-[12px] font-medium text-[var(--accent-contrast)] transition-opacity hover:opacity-90 disabled:opacity-40"
                        >
                          合并所选
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-10 flex items-center justify-center gap-4 text-[11px] text-[var(--text-tertiary)]">
                      <span>识别在本机完成，不会上传照片</span>
                      {confirmClear ? (
                        <span className="flex items-center gap-2">
                          <span>确定清空人像数据？</span>
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmClear(false);
                              void clearIndex();
                            }}
                            disabled={busy}
                            className="text-[var(--color-signal-danger)] transition-opacity hover:opacity-80 disabled:opacity-40"
                          >
                            清空
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmClear(false)}
                            className="transition-colors hover:text-[var(--text-secondary)]"
                          >
                            取消
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmClear(true)}
                          className="underline decoration-[var(--border-default)] underline-offset-2 transition-colors hover:text-[var(--text-secondary)]"
                        >
                          清空人像数据
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </ImmersiveView>
  );
};

export default PeopleView;
