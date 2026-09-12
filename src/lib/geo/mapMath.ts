import { Photo } from '@/types';
import { LAND_MASK_HEIGHT, LAND_MASK_WIDTH, isLandCell } from '@/lib/geo/landMask';

/**
 * 「按地点浏览」的几何与投影。
 *
 * 全部为纯函数：投影、相机、屏幕聚类、点阵采样都与 React 无关，
 * 组件只负责把结果画出来。这样地图交互（缩放 / 平移 / 命中）好推理也好测。
 *
 * 坐标系约定：
 * - 地理坐标：经度 [-180, 180]、纬度 [-90, 90]（十进制度数）；
 * - 归一化墨卡托：x ∈ [0,1]（西 → 东）、y ∈ [0,1]（北 → 南），整个可见世界是 [0,1]²；
 * - 相机：中心（归一化）+ scale（世界宽度对应的屏幕像素数）。
 */

/** Web Mercator 可投影的最大纬度（再向极点投影会发散） */
export const MAX_MERCATOR_LATITUDE = 85.05112878;

/** 地图点阵底图的最小缩放：世界至少占视口较短边的一半，再拉远只会看到空场 */
export const cameraScaleBounds = (viewport: MapViewport): { min: number; max: number } => ({
  min: Math.min(viewport.width, viewport.height) * 0.8,
  // 世界宽度的 64 倍 ≈ 视口里约 5.6° 经度，够看清一座城市的取景范围
  max: Math.max(viewport.width, 1) * 64,
});

export interface MapViewport {
  width: number;
  height: number;
}

/** 归一化墨卡托坐标 */
export interface MercatorPoint {
  x: number;
  y: number;
}

/** 相机：中心点（归一化墨卡托）+ 缩放（世界宽度对应的屏幕像素） */
export interface MapCamera {
  centerX: number;
  centerY: number;
  scale: number;
}

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const projectLngLat = (lng: number, lat: number): MercatorPoint => {
  const safeLat = clamp(lat, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE);
  const rad = (safeLat * Math.PI) / 180;
  return {
    x: (lng + 180) / 360,
    y: 0.5 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / (2 * Math.PI),
  };
};

export const mercatorYToLatitude = (y: number): number =>
  (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - 2 * y)));

export const mercatorXToLongitude = (x: number): number => x * 360 - 180;

export const worldToScreen = (
  point: MercatorPoint,
  camera: MapCamera,
  viewport: MapViewport
): { x: number; y: number } => ({
  x: (point.x - camera.centerX) * camera.scale + viewport.width / 2,
  y: (point.y - camera.centerY) * camera.scale + viewport.height / 2,
});

/** 把相机夹回可用范围：缩放不越界，视口尽量不越出世界边界 */
export const clampCamera = (camera: MapCamera, viewport: MapViewport): MapCamera => {
  if (viewport.width <= 0 || viewport.height <= 0) return camera;
  const bounds = cameraScaleBounds(viewport);
  const scale = clamp(camera.scale, bounds.min, bounds.max);

  // 视口半宽（归一化）。世界比视口窄时直接居中，否则留 30% 余量，
  // 让边缘的大陆可以有呼吸空间，但不会把视图拖进彻底空白的地方
  const halfW = viewport.width / 2 / scale;
  const halfH = viewport.height / 2 / scale;
  const marginX = halfW >= 0.5 ? 0.5 : halfW * 0.7;
  const marginY = halfH >= 0.5 ? 0.5 : halfH * 0.7;

  return {
    scale,
    centerX: clamp(camera.centerX, marginX, 1 - marginX),
    centerY: clamp(camera.centerY, marginY, 1 - marginY),
  };
};

/** 以某个屏幕点为锚点缩放：该点下方的画面保持不动（与 QuickLook 的滚轮缩放同一手感） */
export const zoomCameraAt = (
  camera: MapCamera,
  viewport: MapViewport,
  screenX: number,
  screenY: number,
  factor: number
): MapCamera => {
  const bounds = cameraScaleBounds(viewport);
  const scale = clamp(camera.scale * factor, bounds.min, bounds.max);
  if (scale === camera.scale) return camera;

  const anchorX = camera.centerX + (screenX - viewport.width / 2) / camera.scale;
  const anchorY = camera.centerY + (screenY - viewport.height / 2) / camera.scale;
  return clampCamera(
    {
      scale,
      centerX: anchorX - (screenX - viewport.width / 2) / scale,
      centerY: anchorY - (screenY - viewport.height / 2) / scale,
    },
    viewport
  );
};

// ---------------------------------------------------------------------------
// 照片点位
// ---------------------------------------------------------------------------

/** 单张照片的地图点位（世界坐标与相机无关，只在照片集合变化时重建） */
export interface GeoPoint {
  photo: Photo;
  longitude: number;
  latitude: number;
  world: MercatorPoint;
}

/**
 * EXIF 里的缺失值通常是 0/0 或越界值，这类坐标不参与落点。
 * 卫星定位偶尔会写入 (0, 0)（几内亚湾），当作有效值只会让地图上多一个假地点。
 */
const isValidCoordinate = (lng: number, lat: number): boolean =>
  Number.isFinite(lng) &&
  Number.isFinite(lat) &&
  Math.abs(lng) <= 180 &&
  Math.abs(lat) <= 90 &&
  !(lng === 0 && lat === 0);

/** 从照片集合中筛出带有效 GPS 的点位（保持传入顺序） */
export const buildGeoPoints = (photos: Photo[]): GeoPoint[] => {
  const points: GeoPoint[] = [];
  for (const photo of photos) {
    const gps = photo.exif?.gps;
    if (!gps || !isValidCoordinate(gps.longitude, gps.latitude)) continue;
    points.push({
      photo,
      longitude: gps.longitude,
      latitude: gps.latitude,
      world: projectLngLat(gps.longitude, gps.latitude),
    });
  }
  return points;
};

/** 「地点」聚合粒度：0.5° 网格（约 55km）。用于不随视图变化的统计文案 */
const SITE_CELL_DEGREES = 0.5;

/** 不随缩放变化的「地点数」：同一 0.5° 网格内的照片算同一个地点 */
export const countGeoLocations = (points: GeoPoint[]): number => {
  const cells = new Set<string>();
  for (const point of points) {
    const cellX = Math.floor((point.longitude + 180) / SITE_CELL_DEGREES);
    const cellY = Math.floor((point.latitude + 90) / SITE_CELL_DEGREES);
    cells.add(`${cellX},${cellY}`);
  }
  return cells.size;
};

/** 屏幕空间聚合后的点簇 */
export interface GeoCluster {
  /** 当前相机下的网格 key（仅用于悬停态匹配，视图一变即失效） */
  key: string;
  /** 屏幕坐标（组内平均） */
  x: number;
  y: number;
  /** 代表坐标（组内平均经纬度） */
  longitude: number;
  latitude: number;
  points: GeoPoint[];
}

/**
 * 按屏幕网格聚合：落到同一格的点合并成一个簇。
 * 缩放越深，相邻照片自然分开 —— 与真实地图应用的聚合手感一致。
 */
export const clusterGeoPoints = (
  points: GeoPoint[],
  camera: MapCamera,
  viewport: MapViewport,
  cellSize: number
): GeoCluster[] => {
  const buckets = new Map<
    string,
    { sumX: number; sumY: number; sumLng: number; sumLat: number; points: GeoPoint[] }
  >();

  for (const point of points) {
    const screen = worldToScreen(point.world, camera, viewport);
    const gx = Math.floor(screen.x / cellSize);
    const gy = Math.floor(screen.y / cellSize);
    const key = `${gx},${gy}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { sumX: 0, sumY: 0, sumLng: 0, sumLat: 0, points: [] };
      buckets.set(key, bucket);
    }
    bucket.sumX += screen.x;
    bucket.sumY += screen.y;
    bucket.sumLng += point.longitude;
    bucket.sumLat += point.latitude;
    bucket.points.push(point);
  }

  const clusters: GeoCluster[] = [];
  for (const [key, bucket] of buckets) {
    const n = bucket.points.length;
    clusters.push({
      key,
      x: bucket.sumX / n,
      y: bucket.sumY / n,
      longitude: bucket.sumLng / n,
      latitude: bucket.sumLat / n,
      points: bucket.points,
    });
  }
  return clusters;
};

/** 命中测试：返回距离最近的簇（超出半径返回 null） */
export const findClusterAt = (
  clusters: GeoCluster[],
  screenX: number,
  screenY: number,
  radius: number
): GeoCluster | null => {
  let best: GeoCluster | null = null;
  let bestDist = radius * radius;
  for (const cluster of clusters) {
    const dx = cluster.x - screenX;
    const dy = cluster.y - screenY;
    const dist = dx * dx + dy * dy;
    if (dist <= bestDist) {
      bestDist = dist;
      best = cluster;
    }
  }
  return best;
};

// ---------------------------------------------------------------------------
// 相机取景
// ---------------------------------------------------------------------------

/** 点数未知 / 为空时的世界视图：整个地球铺满视口 */
export const worldCamera = (viewport: MapViewport): MapCamera =>
  clampCamera(
    {
      centerX: 0.5,
      centerY: 0.5,
      scale: Math.max(viewport.width, 1),
    },
    viewport
  );

/** 单点 / 极近的点位：不要贴到最大缩放，给一个约 1.5° 跨度的「城市尺度」视野 */
const MIN_FIT_SPAN = 1.2 / 360;

/**
 * 把全部点位收进视口（留出 padding）。
 * 返回 null 表示没有可用的点，调用方改用世界视图。
 */
export const fitCameraToPoints = (
  points: GeoPoint[],
  viewport: MapViewport,
  padding = 72
): MapCamera | null => {
  if (points.length === 0 || viewport.width <= 0 || viewport.height <= 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.world.x < minX) minX = point.world.x;
    if (point.world.x > maxX) maxX = point.world.x;
    if (point.world.y < minY) minY = point.world.y;
    if (point.world.y > maxY) maxY = point.world.y;
  }

  const availW = Math.max(1, viewport.width - padding * 2);
  const availH = Math.max(1, viewport.height - padding * 2);
  const spanX = Math.max(maxX - minX, MIN_FIT_SPAN);
  const spanY = Math.max(maxY - minY, MIN_FIT_SPAN);
  const scale = Math.min(availW / spanX, availH / spanY);

  return clampCamera(
    {
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2,
      scale,
    },
    viewport
  );
};

// ---------------------------------------------------------------------------
// 点阵底图采样
// ---------------------------------------------------------------------------

/**
 * 遍历当前视野内应当绘制的陆地格点。
 *
 * 采样步长按屏幕像素换算：缩放越深，步长越小（点距保持在肉眼均匀的量级），
 * 因此放大时点阵不会变成大色块，而是浮出更多细节。
 */
export const forEachLandDot = (
  camera: MapCamera,
  viewport: MapViewport,
  spacingPx: number,
  onDot: (screenX: number, screenY: number, cellPx: number) => void
): void => {
  const cellPx = camera.scale / LAND_MASK_WIDTH;
  if (!Number.isFinite(cellPx) || cellPx <= 0) return;
  const step = Math.max(1, Math.round(spacingPx / cellPx));

  // 可见范围（归一化墨卡托）→ 掩码行列
  const left = camera.centerX - viewport.width / 2 / camera.scale;
  const right = camera.centerX + viewport.width / 2 / camera.scale;
  const top = camera.centerY - viewport.height / 2 / camera.scale;
  const bottom = camera.centerY + viewport.height / 2 / camera.scale;

  const latTop = mercatorYToLatitude(top);
  const latBottom = mercatorYToLatitude(bottom);

  const degPerRow = 180 / LAND_MASK_HEIGHT;
  const colFrom = Math.max(0, Math.floor(left * LAND_MASK_WIDTH));
  const colTo = Math.min(LAND_MASK_WIDTH - 1, Math.ceil(right * LAND_MASK_WIDTH));
  const rowFrom = Math.max(0, Math.floor((90 - latTop) / degPerRow));
  const rowTo = Math.min(LAND_MASK_HEIGHT - 1, Math.ceil((90 - latBottom) / degPerRow));

  // 极限视野下（世界铺满视口）也不超过 ~15 万次迭代，交互帧率可控。
  // 世界之外不重复绘制：横向拖到边缘时看到的是空场而不是第二个地球
  for (let row = rowFrom; row <= rowTo; row += step) {
    const lat = 90 - (row + 0.5) * degPerRow;
    const worldY = projectLngLat(0, lat).y;
    const screenY = (worldY - camera.centerY) * camera.scale + viewport.height / 2;

    for (let col = colFrom; col <= colTo; col += step) {
      if (!isLandCell(col, row)) continue;
      const worldX = (col + 0.5) / LAND_MASK_WIDTH;
      const screenX = (worldX - camera.centerX) * camera.scale + viewport.width / 2;
      onDot(screenX, screenY, step * cellPx);
    }
  }
};

/** 经纬度文案：34.05°N · 118.24°W */
export const formatLatLng = (lat: number, lng: number, digits = 2): string => {
  const latText = `${Math.abs(lat).toFixed(digits)}°${lat >= 0 ? 'N' : 'S'}`;
  const lngText = `${Math.abs(lng).toFixed(digits)}°${lng >= 0 ? 'E' : 'W'}`;
  return `${latText} · ${lngText}`;
};
