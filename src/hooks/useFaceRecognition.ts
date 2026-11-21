import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FaceModelStatus,
  FacePerson,
  FacePersonPhotoRef,
  FaceScanDone,
  FaceScanState,
  FaceStatus,
  Photo,
} from '@/types';
import { photoTakenTime } from '@/lib/media/photoTime';
import { isVideoPhoto } from '@/utils';

const IDLE_SCAN: FaceScanState = {
  isScanning: false,
  phase: 'idle',
  done: 0,
  total: 0,
  current: '',
  faces: 0,
  failed: 0,
};

function errorOf(result: { ok: boolean; error?: string }): string | null {
  return result.ok ? null : result.error || '操作失败';
}

/**
 * 人像识别视图的状态与动作。
 *
 * 特征向量只存在主进程的 faces.json 里，渲染层只拿「人物摘要 + fileId」，
 * 因此这里永远不需要把几百 KB 的向量塞进 React state。
 */
export function useFaceRecognition(photos: Photo[]) {
  const [status, setStatus] = useState<FaceStatus | null>(null);
  const [people, setPeople] = useState<FacePerson[]>([]);
  const [personPhotos, setPersonPhotos] = useState<Photo[]>([]);
  const [selectedPerson, setSelectedPerson] = useState<FacePerson | null>(null);
  const [model, setModel] = useState<FaceModelStatus | null>(null);
  const [scan, setScan] = useState<FaceScanState>(IDLE_SCAN);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const photosRef = useRef(photos);
  photosRef.current = photos;

  const photoByFileId = useMemo(
    () => new Map(photos.map((photo) => [photo.fileId, photo])),
    [photos]
  );

  const refreshPeople = useCallback(async () => {
    const result = await window.electronAPI.listFacePeople();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPeople(result.data);
  }, []);

  const refreshStatus = useCallback(async () => {
    const result = await window.electronAPI.getFaceStatus();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setStatus(result.data);
    setModel(result.data.model);
    setScan(result.data.scan);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([refreshStatus(), refreshPeople()]);
    } finally {
      setLoading(false);
    }
  }, [refreshStatus, refreshPeople]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 主进程事件：下载进度 / 扫描进度 / 完成与失败
  useEffect(() => {
    const offModel = window.electronAPI.onFaceModelProgress((progress) => {
      setModel(progress);
      setError(progress.state === 'error' ? progress.error : null);
    });
    const offModelError = window.electronAPI.onFaceModelError(({ message }) => {
      setError(message);
    });
    const offScan = window.electronAPI.onFaceScanProgress((progress) => {
      setScan(progress);
    });
    const offDone = window.electronAPI.onFaceScanDone((summary: FaceScanDone) => {
      setScan((prev) => ({ ...prev, isScanning: false, phase: 'done' }));
      setNotice(
        summary.faces > 0
          ? `识别完成：${summary.faces} 张人脸，${summary.people} 位人物${
              summary.failed > 0 ? `，${summary.failed} 张失败` : ''
            }`
          : '识别完成：这批照片里没有找到人脸'
      );
      void refreshPeople();
      void refreshStatus();
    });
    const offScanError = window.electronAPI.onFaceScanError(({ message }) => {
      setError(message);
      setScan((prev) => ({ ...prev, isScanning: false, phase: 'error' }));
    });
    const offStatus = window.electronAPI.onFaceStatusChanged(() => {
      void refreshStatus();
      void refreshPeople();
    });

    return () => {
      offModel();
      offModelError();
      offScan();
      offDone();
      offScanError();
      offStatus();
    };
  }, [refreshPeople, refreshStatus]);

  const downloadModel = useCallback(async () => {
    setError(null);
    setNotice(null);
    setModel((prev) =>
      prev
        ? { ...prev, state: 'downloading', percent: 0, error: null }
        : { state: 'downloading', percent: 0, received: 0, total: 0, error: null }
    );
    const result = await window.electronAPI.downloadFaceModel();
    const failure = errorOf(result);
    if (failure) {
      setError(failure);
      setModel((prev) => (prev ? { ...prev, state: 'error', error: failure } : prev));
    }
  }, []);

  const cancelModelDownload = useCallback(() => {
    void window.electronAPI.cancelFaceModelDownload();
    setModel((prev) => (prev ? { ...prev, state: 'missing', percent: 0 } : prev));
  }, []);

  const startScan = useCallback(async (force = false) => {
    setError(null);
    setNotice(null);
    // flatMap 而不是 filter+map：`path` / `fileId` 都是可选字段，
    // 这样写能让编译器确认传下去的都是 string，不必在调用点加断言。
    const candidates = photosRef.current.flatMap((photo) =>
      photo.path && photo.fileId && !isVideoPhoto(photo)
        ? [{ path: photo.path, fileId: photo.fileId }]
        : []
    );
    if (candidates.length === 0) {
      setError('当前图库没有可识别的照片');
      return;
    }
    const result = await window.electronAPI.startFaceScan(candidates, { force });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setScan({
      isScanning: true,
      phase: 'preparing',
      done: 0,
      total: result.data.total,
      current: '',
      faces: 0,
      failed: 0,
    });
  }, []);

  const cancelScan = useCallback(() => {
    void window.electronAPI.cancelFaceScan();
  }, []);

  const clearIndex = useCallback(async () => {
    setBusy(true);
    try {
      const result = await window.electronAPI.clearFaceIndex();
      const failure = errorOf(result);
      if (failure) {
        setError(failure);
        return;
      }
      setSelectedPerson(null);
      setPersonPhotos([]);
      setPeople([]);
      setNotice('已清空人像数据，原照片不受影响');
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  }, [refreshStatus]);

  const renamePerson = useCallback(async (personId: string, name: string) => {
    const result = await window.electronAPI.renameFacePerson(personId, name);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    const nextName = result.data.name;
    setPeople((prev) =>
      prev.map((person) => (person.id === personId ? { ...person, name: nextName } : person))
    );
    setSelectedPerson((prev) =>
      prev && prev.id === personId ? { ...prev, name: nextName } : prev
    );
    return true;
  }, []);

  const mergePeople = useCallback(
    async (sourceIds: string[]) => {
      const target = people.find((person) => sourceIds.includes(person.id));
      if (!target || sourceIds.length < 2) return false;
      setBusy(true);
      try {
        const others = sourceIds.filter((id) => id !== target.id);
        const result = await window.electronAPI.mergeFacePeople(target.id, others);
        const failure = errorOf(result);
        if (failure) {
          setError(failure);
          return false;
        }
        setNotice(`已合并 ${others.length + 1} 位人物`);
        await refreshPeople();
        return true;
      } finally {
        setBusy(false);
      }
    },
    [people, refreshPeople]
  );

  const openPerson = useCallback(
    async (person: FacePerson) => {
      setSelectedPerson(person);
      setPersonPhotos([]);
      const result = await window.electronAPI.getFacePersonPhotos(person.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const matched = result.data
        .map((ref: FacePersonPhotoRef) => photoByFileId.get(ref.fileId))
        .filter((photo): photo is Photo => Boolean(photo));
      matched.sort((a, b) => photoTakenTime(b) - photoTakenTime(a));
      setPersonPhotos(matched);
    },
    [photoByFileId]
  );

  const closePerson = useCallback(() => {
    setSelectedPerson(null);
    setPersonPhotos([]);
  }, []);

  return {
    status,
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
    refresh,
    downloadModel,
    cancelModelDownload,
    startScan,
    cancelScan,
    clearIndex,
    renamePerson,
    mergePeople,
    openPerson,
    closePerson,
  };
}
