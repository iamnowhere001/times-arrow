import { Place, arePlacesLoaded, getPlaces } from '@/lib/geo/places';
import { createLruCache } from '@/lib/cache/cacheManager';

/**
 * 离线地名查询：把坐标翻成「这是哪儿」。
 *
 * 数据见 `places.data.json`（约 1700 条城市，由 `places.ts` 按需加载）。
 * 纯本地应用不做在线逆地理编码，这里用最近邻顶替：地图标签、悬停预览、
 * 地点照片条都从这里取地名。
 *
 * **数据是按需加载的，所以本模块的查询在数据到位前返回 `null`**：
 * 调用方（地图标签绘制）本来就按「查不到就跳过」写，因此无需额外判空。
 * 需要确定性地拿到结果时，先 `await loadPlaces()`（见 places.ts）。
 */

const EARTH_RADIUS_KM = 6371;

/** 两点的近似距离（km）：城市级匹配下精度足够，只有一次三角函数 */
const distanceKm = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = (((lng2 - lng1) * Math.PI) / 180) * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return EARTH_RADIUS_KM * Math.hypot(dLat, dLng);
};

/** 1° 网格索引：城市分布不均，分桶后「找附近」从全表扫描降到常数级 */
let grid: Map<string, Place[]> | null = null;

const buildGrid = (places: readonly Place[]): Map<string, Place[]> => {
  const built = new Map<string, Place[]>();
  for (const place of places) {
    const key = `${Math.floor(place.longitude)}:${Math.floor(place.latitude)}`;
    const bucket = built.get(key);
    if (bucket) bucket.push(place);
    else built.set(key, [place]);
  }
  return built;
};

/**
 * 取网格索引，首次查询时按当时已加载的数据建立。
 *
 * 网格必须**惰性**构建：模块求值发生在数据加载之前（那是异步的），
 * 在模块顶层建索引只会建出一张空表。数据未就绪时返回 `null`，调用方据此短路。
 */
const gridOf = (): Map<string, Place[]> | null => {
  const places = getPlaces();
  if (places.length === 0) return null;
  if (!grid) grid = buildGrid(places);
  return grid;
};

export interface NearestPlace {
  place: Place;
  /** 与该城市的直线距离（km） */
  distanceKm: number;
}

const search = (latitude: number, longitude: number): NearestPlace | null => {
  const index = gridOf();
  if (!index) return null;

  const centerX = Math.floor(longitude);
  const centerY = Math.floor(latitude);
  let best: Place | null = null;
  let bestDistance = Infinity;

  // 5×5 格（±2°）之内取最近；覆盖不到的角落（大洋 / 极地）再退回全表
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dy = -2; dy <= 2; dy += 1) {
      const bucket = index.get(`${centerX + dx}:${centerY + dy}`);
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
    for (const place of getPlaces()) {
      const distance = distanceKm(latitude, longitude, place.latitude, place.longitude);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = place;
      }
    }
  }

  return best ? { place: best, distanceKm: bestDistance } : null;
};

/** 缓存条目上限：约 4000 个格子（0.02° 精度）足以覆盖一次浏览所经过的区域 */
const CACHE_LIMIT = 4000;

/**
 * 查询结果缓存。
 *
 * 改造前是普通 Map + 「满了就 `clear()`」：一次清空会让刚查过的地名全部重算，
 * 而地图标签每帧都在查，表现为拖动时周期性的卡顿尖峰。
 * 换成统一 LRU 后有两点改善：
 *   1. 只淘汰最久未用的条目，热点地名（当前视野附近）始终留在缓存里；
 *   2. 自动纳入 `cacheManager` 的注册表，系统内存吃紧时会被统一裁剪。
 *
 * 值可能是 `null`（该坐标附近确实没有城市），因此读取时要用 `!== undefined`
 * 区分「未命中」与「命中但结果为空」—— LRU 的 `get` 正好保持这个语义。
 */
const cache = createLruCache<string, NearestPlace | null>('placeIndex', CACHE_LIMIT, 'volatile');

/**
 * 找到坐标附近最近的城市（带缓存）。
 * 地图标签每帧都要查，缓存把同一处的重复计算收敛成一次。
 *
 * 数据未就绪时**直接返回 `null` 且不写缓存** —— 否则「空结果」会被记成
 * 这个坐标的答案，数据到位后同一坐标永远查不出城市来。
 */
export const findNearestPlace = (latitude: number, longitude: number): NearestPlace | null => {
  if (!arePlacesLoaded()) return null;
  const key = `${Math.round(latitude * 50)}:${Math.round(longitude * 50)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const result = search(latitude, longitude);
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
