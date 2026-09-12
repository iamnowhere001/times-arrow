import { PLACES, Place } from '@/lib/geo/places';

/**
 * 离线地名查询：把坐标翻成「这是哪儿」。
 *
 * 数据见 places.ts（约 1700 条城市）。纯本地应用不做在线逆地理编码，
 * 这里用最近邻顶替：地图标签、悬停预览、地点照片条都从这里取地名。
 */

const EARTH_RADIUS_KM = 6371;

/** 两点的近似距离（km）：城市级匹配下精度足够，只有一次三角函数 */
const distanceKm = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = (((lng2 - lng1) * Math.PI) / 180) * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return EARTH_RADIUS_KM * Math.hypot(dLat, dLng);
};

/** 1° 网格索引：城市分布不均，分桶后「找附近」从全表扫描降到常数级 */
const PLACE_GRID = (() => {
  const grid = new Map<string, Place[]>();
  for (const place of PLACES) {
    const key = `${Math.floor(place.longitude)}:${Math.floor(place.latitude)}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(place);
    else grid.set(key, [place]);
  }
  return grid;
})();

export interface NearestPlace {
  place: Place;
  /** 与该城市的直线距离（km） */
  distanceKm: number;
}

const search = (latitude: number, longitude: number): NearestPlace | null => {
  const centerX = Math.floor(longitude);
  const centerY = Math.floor(latitude);
  let best: Place | null = null;
  let bestDistance = Infinity;

  // 5×5 格（±2°）之内取最近；覆盖不到的角落（大洋 / 极地）再退回全表
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dy = -2; dy <= 2; dy += 1) {
      const bucket = PLACE_GRID.get(`${centerX + dx}:${centerY + dy}`);
      if (!bucket) continue;
      for (const place of bucket) {
        const distance = distanceKm(latitude, longitude, place.latitude, place.longitude);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = place;
        }
      }
    }
  }

  if (!best) {
    for (const place of PLACES) {
      const distance = distanceKm(latitude, longitude, place.latitude, place.longitude);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = place;
      }
    }
  }

  return best ? { place: best, distanceKm: bestDistance } : null;
};

/** 0.02°（约 2km）内的坐标视为同一处，避免每帧重复扫描 */
const cache = new Map<string, NearestPlace | null>();
const CACHE_LIMIT = 4000;

/**
 * 找到坐标附近最近的城市（带缓存）。
 * 地图标签每帧都要查，缓存把同一处的重复计算收敛成一次。
 */
export const findNearestPlace = (latitude: number, longitude: number): NearestPlace | null => {
  const key = `${Math.round(latitude * 50)}:${Math.round(longitude * 50)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const result = search(latitude, longitude);
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, result);
  return result;
};

/** 地点的完整称谓：中国的带上级（深圳 · 广东）；直辖市上下同级，不重复报 */
export const placeLabel = (place: Place): string =>
  place.sub && place.sub !== place.name ? `${place.name} · ${place.sub}` : place.name;

/**
 * 「这是哪儿」的一句话：
 *   25km 内直接报地名；150km 内算「附近」；再远就报距离（仍是有用的参照）。
 */
export const formatPlaceHint = (nearest: NearestPlace | null): string => {
  if (!nearest) return '';
  const { place, distanceKm: distance } = nearest;
  if (distance <= 25) return placeLabel(place);
  if (distance <= 150) return `${place.name}附近`;
  return `距 ${place.name} ${Math.round(distance)} 公里`;
};
