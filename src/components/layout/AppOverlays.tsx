import type { ComponentProps } from 'react';
import type { LibrarySource, Photo, PhotoFilters, SmartAlbum } from '@/types';
import type { ContextMenuItem } from '@/types/contextMenu';
import type { ToastData } from '@/types/toast';
import { basenameOfPath } from '@/lib/persistence/sources';
import type { useUpdateChecker } from '@/hooks/useUpdateChecker';
import ContextMenu from '@/components/common/ContextMenu';
import ToastStack from '@/components/layout/ToastStack';
import QuickLook from '@/components/detail/QuickLook';
import RenameModal from '@/components/modal/RenameModal';
import DeleteConfirmModal from '@/components/modal/DeleteConfirmModal';
import ClearListConfirmModal from '@/components/modal/ClearListConfirmModal';
import RestoreLibraryModal from '@/components/modal/RestoreLibraryModal';
import AiSettingsModal from '@/components/modal/AiSettingsModal';
import UpdateModal from '@/components/modal/UpdateModal';
import DataAssetsModal from '@/components/modal/DataAssetsModal';
import ExportModal from '@/components/modal/ExportModal';
import AdjustDateModal from '@/components/modal/AdjustDateModal';
import SaveAlbumModal from '@/components/modal/SaveAlbumModal';
import ShortcutsOverlay from '@/components/common/ShortcutsOverlay';

/**
 * 全部弹层与浮层。
 *
 * ## 为什么集中在一个文件
 *
 * 这些组件彼此没有依赖，共同点只有一个：**由 App 的某个布尔开关控制显隐**。
 * 散在 App 的 return 里时，加一个弹窗要在 1400 行文件里找插入点，
 * 而且「哪个开关对应哪个弹层」只能靠读 JSX 反推。集中之后：
 * 加弹层是往这里加一段，App 只负责把状态传进来。
 *
 * ## 什么不该放在这里
 *
 * 带业务分支的流程（导出完成后的汇总判定、恢复图库的确认副作用）留在 App ——
 * 它们是决策，不是「开关 → 渲染」的映射。这里只接收已决好的回调。
 */

type RenameConfirm = ComponentProps<typeof RenameModal>['onConfirm'];
type DeleteConfirm = ComponentProps<typeof DeleteConfirmModal>['onConfirm'];
type ClearListConfirm = ComponentProps<typeof ClearListConfirmModal>['onConfirm'];
type AdjustDateApply = ComponentProps<typeof AdjustDateModal>['onApply'];
type SaveAlbumSave = ComponentProps<typeof SaveAlbumModal>['onSave'];
type ExportFinish = ComponentProps<typeof ExportModal>['onFinish'];
type ToastDismiss = ComponentProps<typeof ToastStack>['onDismiss'];

export interface AppOverlaysProps {
  // 右键菜单
  contextMenu: { x: number; y: number; photo?: Photo } | null;
  contextMenuActions: ContextMenuItem[];
  onCloseContextMenu: () => void;

  // Toast
  toasts: ToastData[];
  onDismissToast: ToastDismiss;

  // 重命名 / 删除：都以「当前选中集」为作用对象
  isRenameModalOpen: boolean;
  onCloseRenameModal: () => void;
  onRenameConfirm: RenameConfirm;
  photos: Photo[];
  selectedIds: Set<string>;
  isFileOpBusy: boolean;

  isDeleteModalOpen: boolean;
  onCloseDeleteModal: () => void;
  onDeleteConfirm: DeleteConfirm;

  // 清空照片列表
  isClearListConfirmOpen: boolean;
  onCloseClearListConfirm: () => void;
  onClearListConfirm: ClearListConfirm;

  // 恢复上次的图库
  isRestorePromptOpen: boolean;
  onCloseRestorePrompt: () => void;
  onConfirmRestore: () => void;
  sources: LibrarySource[];
  directorySources: LibrarySource[];
  fileSources: LibrarySource[];
  unavailableSourceCount: number;

  // 设置类
  isAiSettingsOpen: boolean;
  onCloseAiSettings: () => void;
  onNotify: (message: string, type?: 'success' | 'info' | 'error' | 'warning') => void;

  isDataAssetsOpen: boolean;
  onCloseDataAssets: () => void;

  isShortcutsOpen: boolean;
  onCloseShortcuts: () => void;

  isSaveAlbumModalOpen: boolean;
  onCloseSaveAlbum: () => void;
  onSaveAlbum: SaveAlbumSave;
  filters: PhotoFilters;
  albums: SmartAlbum[];

  isAdjustDateModalOpen: boolean;
  onCloseAdjustDate: () => void;
  onApplyDateAdjustment: AdjustDateApply;
  selectedPhotos: Photo[];

  // 检查更新与下载
  updateChecker: ReturnType<typeof useUpdateChecker>;

  // 导出
  isExportModalOpen: boolean;
  onCloseExport: () => void;
  exportTargets: Photo[];
  onExportFinish: ExportFinish;

  // 全屏预览
  quickLookPhoto: Photo | null;
  onCloseQuickLook: () => void;
  quickLookList: Photo[];
  quickLookIndex: number;
  quickLookPreloadSources: string[];
  onQuickLookNext: () => void;
  onQuickLookPrev: () => void;
  onQuickLookJump: (photo: Photo) => void;
  onToggleFavorite: (id: string) => void;
}

export default function AppOverlays({
  contextMenu,
  contextMenuActions,
  onCloseContextMenu,
  toasts,
  onDismissToast,
  isRenameModalOpen,
  onCloseRenameModal,
  onRenameConfirm,
  photos,
  selectedIds,
  isFileOpBusy,
  isDeleteModalOpen,
  onCloseDeleteModal,
  onDeleteConfirm,
  isClearListConfirmOpen,
  onCloseClearListConfirm,
  onClearListConfirm,
  isRestorePromptOpen,
  onCloseRestorePrompt,
  onConfirmRestore,
  sources,
  directorySources,
  fileSources,
  unavailableSourceCount,
  isAiSettingsOpen,
  onCloseAiSettings,
  onNotify,
  isDataAssetsOpen,
  onCloseDataAssets,
  isShortcutsOpen,
  onCloseShortcuts,
  isSaveAlbumModalOpen,
  onCloseSaveAlbum,
  onSaveAlbum,
  filters,
  albums,
  isAdjustDateModalOpen,
  onCloseAdjustDate,
  onApplyDateAdjustment,
  selectedPhotos,
  updateChecker,
  isExportModalOpen,
  onCloseExport,
  exportTargets,
  onExportFinish,
  quickLookPhoto,
  onCloseQuickLook,
  quickLookList,
  quickLookIndex,
  quickLookPreloadSources,
  onQuickLookNext,
  onQuickLookPrev,
  onQuickLookJump,
  onToggleFavorite,
}: AppOverlaysProps) {
  return (
    <>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={onCloseContextMenu}
          actions={contextMenuActions}
        />
      )}

      {/* Toast 队列：底部居中堆叠，避免遮挡工具栏（渲染见 ToastStack） */}
      <ToastStack toasts={toasts} onDismiss={onDismissToast} />

      {isRenameModalOpen && (
        <RenameModal
          isOpen={isRenameModalOpen}
          onClose={onCloseRenameModal}
          onConfirm={onRenameConfirm}
          photos={photos.filter((p) => selectedIds.has(p.id))}
          count={selectedIds.size}
          isBusy={isFileOpBusy}
        />
      )}
      {isDeleteModalOpen && (
        <DeleteConfirmModal
          isOpen={isDeleteModalOpen}
          count={selectedIds.size}
          isDiskOperation={true}
          onClose={onCloseDeleteModal}
          onConfirm={onDeleteConfirm}
          isBusy={isFileOpBusy}
        />
      )}

      {/* 清空照片列表二次确认：侧栏底部入口与右键菜单都走这里 */}
      <ClearListConfirmModal
        isOpen={isClearListConfirmOpen}
        count={photos.length}
        onClose={onCloseClearListConfirm}
        onConfirm={onClearListConfirm}
      />

      {/* 「恢复上次的图库」确认框（N8）：启动时存在常驻来源才出现 */}
      <RestoreLibraryModal
        isOpen={isRestorePromptOpen}
        sourceCount={sources.length}
        directoryCount={directorySources.length}
        fileCount={fileSources.length}
        directoryNames={directorySources.map((source) => basenameOfPath(source.path))}
        unavailableCount={unavailableSourceCount}
        onClose={onCloseRestorePrompt}
        onConfirm={onConfirmRestore}
      />

      {/* AI 分析设置：应用内配置 DeepSeek API Key / 接口地址 / 模型 */}
      <AiSettingsModal isOpen={isAiSettingsOpen} onClose={onCloseAiSettings} onNotify={onNotify} />

      {/* 检查更新：GitHub Releases 检查 / 下载 DMG / 引导安装（见 hooks/useUpdateChecker） */}
      <UpdateModal
        isOpen={updateChecker.isOpen}
        onClose={updateChecker.closePanel}
        currentVersion={updateChecker.currentVersion}
        checkResult={updateChecker.checkResult}
        isChecking={updateChecker.isChecking}
        error={updateChecker.error}
        download={updateChecker.download}
        onCheck={updateChecker.checkNow}
        onDownload={updateChecker.startDownload}
        onCancelDownload={updateChecker.cancelDownload}
        onOpenDownload={updateChecker.openDownloaded}
        onRevealDownload={updateChecker.revealDownloaded}
        onOpenRelease={updateChecker.openReleasePage}
      />

      {/* 数据资产：配置导出导入 / 路径重连 / 操作日志与撤销 / 增量备份 */}
      <DataAssetsModal isOpen={isDataAssetsOpen} onClose={onCloseDataAssets} onNotify={onNotify} />

      {isExportModalOpen && (
        <ExportModal
          isOpen={isExportModalOpen}
          photos={exportTargets}
          onClose={onCloseExport}
          onFinish={onExportFinish}
        />
      )}

      {isAdjustDateModalOpen && (
        <AdjustDateModal
          isOpen={isAdjustDateModalOpen}
          photos={selectedPhotos}
          onClose={onCloseAdjustDate}
          onApply={onApplyDateAdjustment}
        />
      )}

      {isSaveAlbumModalOpen && (
        <SaveAlbumModal
          isOpen={isSaveAlbumModalOpen}
          filters={filters}
          existingNames={albums.map((album) => album.name)}
          onClose={onCloseSaveAlbum}
          onSave={onSaveAlbum}
        />
      )}

      {isShortcutsOpen && <ShortcutsOverlay onClose={onCloseShortcuts} />}

      {quickLookPhoto && (
        <QuickLook
          photo={quickLookPhoto}
          onClose={onCloseQuickLook}
          onNext={onQuickLookNext}
          onPrev={onQuickLookPrev}
          onFirst={quickLookList.length > 0 ? () => onQuickLookJump(quickLookList[0]) : undefined}
          hasNext={quickLookIndex >= 0 && quickLookIndex < quickLookList.length - 1}
          hasPrev={quickLookIndex > 0}
          currentIndex={quickLookIndex}
          totalCount={quickLookList.length}
          onToggleFavorite={onToggleFavorite}
          preloadSources={quickLookPreloadSources}
        />
      )}
    </>
  );
}
