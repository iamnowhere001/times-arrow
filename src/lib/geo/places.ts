/**
 * 离线地名数据（1731 条城市）：把坐标翻成「这是哪儿」。
 *
 * **数据本体在 `places.data.json`**，这里只留类型与加载入口。
 * 查询与展示逻辑见 `placeIndex.ts`（生成脚本只管数据，重跑不会覆盖逻辑）。
 *
 * 为什么外置并改成动态 `import()`：
 * 这份表原来是以 1767 行的字符串常量内嵌在 `.ts` 里的 —— 数据与逻辑同目录同格式，
 * 而且**静态导入会被 Rollup 内联进主 chunk**：从不打开地图的用户，也要在启动时
 * 解析这 50KB。改成动态 `import()` 后，构建产物是独立 chunk，只有真正进入地图视图
 * 时才拉取，主 bundle 不再为地图付出这份体积。
 *
 * 数据格式见 JSON 头部的 `encoding` 字段，每行是
 * `[经度, 纬度, 名称, 上级, 层级]`：
 *   - 上级：中国的省级（如「广东」）；其他国家为空字符串；
 *   - 层级：1 = 首都 / 超大城市，2 = 大城市，3 = 一般城镇（地图标签按此优先级取舍）。
 *
 * 数据来源：Natural Earth 10m Populated Places（public domain，自带 NAME_ZH 中文字段）。
 */
import { logger } from '@/lib/logger';

export interface Place {
  name: string;
  /** 中国的省级（如「广东」）；其他国家为空 */
  sub: string;
  latitude: number;
  longitude: number;
  /** 1 = 首都 / 超大城市，2 = 大城市，3 = 一般城镇 */
  rank: 1 | 2 | 3;
}

/** `places.data.json` 的行编码：[经度, 纬度, 名称, 上级, 层级] */
type PlaceRow = readonly [number, number, string, string, number];

interface PlacesDataFile {
  readonly source: string;
  readonly sourceUrl: string;
  readonly encoding: readonly string[];
  readonly note: string;
  readonly places: readonly PlaceRow[];
}

/**
 * 数据未就绪时对外暴露的空表。
 *
 * 刻意用「空表」而不是 `null`：调用方（地图标签绘制）本来就按「查不到就跳过」
 * 写，空表让这条路径天然成立，不必在每个调用点多一次判空。
 */
const NO_PLACES: readonly Place[] = Object.freeze([]);

let loaded: readonly Place[] | null = null;
let inFlight: Promise<readonly Place[]> | null = null;

const toPlace = ([longitude, latitude, name, sub, rank]: PlaceRow): Place => ({
  name,
  sub,
  longitude,
  latitude,
  // 数据里只会出现 1/2/3；越界一律降级为「一般城镇」，不让脏数据把标签优先级带偏
  rank: rank === 1 || rank === 2 ? rank : 3,
});

/**
 * 加载地名表。幂等：
 *   - 已加载完成：直接返回同一份数组；
 *   - 加载中：返回同一个 Promise，并发调用不会重复发起请求。
 *
 * 失败时**不抛错也不缓存失败结果** —— 地图少了城市标注仍然可用，而下次进入地图
 * 视图还会重试。调用方用 `arePlacesLoaded()` 区分「加载完成」与「加载失败」。
 */
export const loadPlaces = (): Promise<readonly Place[]> => {
  if (loaded) return Promise.resolve(loaded);
  if (!inFlight) {
    inFlight = import('./places.data.json')
      .then(module => {
        // JSON 模块的类型由 tsc 从文件内容推导（数组会被推成 (string | number)[][]），
        // 这里按约定的行编码断言成元组形状；真实数据是否符合该形状由
        // tests/unit/placesData.test.ts 逐条校验，而不是靠类型系统一厢情愿。
        const data = (module as unknown as { default: PlacesDataFile }).default;
        loaded = data.places.map(toPlace);
        return loaded;
      })
      .catch((error: unknown) => {
        inFlight = null; // 不留失败缓存，下次进入地图视图可以重试
        logger.warn('地名数据加载失败，地图将不显示城市标注:', error);
        return NO_PLACES;
      });
  }
  return inFlight;
};

/** 同步读取已加载的地名表；未加载完成（或加载失败）时返回空表 */
export const getPlaces = (): readonly Place[] => loaded ?? NO_PLACES;

/** 地名表是否已经就绪 */
export const arePlacesLoaded = (): boolean => loaded !== null;
