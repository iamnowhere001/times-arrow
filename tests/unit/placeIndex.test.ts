import { describe, it, expect, beforeAll } from 'vitest';
import { findNearestPlace, placeLabel, formatPlaceHint } from '@/lib/geo/placeIndex';
import { loadPlaces, Place } from '@/lib/geo/places';

/**
 * 离线地名查询。
 *
 * 断言刻意不写死具体城市名之外的细节 —— 数据表可能被重新生成，
 * 但「坐标落在某城市附近就应当报出该城市」这个语义必须稳定。
 *
 * 地名表自 P2-27 起是按需加载的独立 chunk，因此查询前必须显式 `await loadPlaces()`；
 * 「未加载时的行为」另见 placesData.test.ts。
 */

let PLACES: readonly Place[] = [];

beforeAll(async () => {
  PLACES = await loadPlaces();
});

describe('PLACES 数据完整性', () => {
  it('表非空，且每条都有合法坐标与层级', () => {
    expect(PLACES.length).toBeGreaterThan(1000);
    for (const place of PLACES) {
      expect(place.name.length).toBeGreaterThan(0);
      expect(Number.isFinite(place.longitude)).toBe(true);
      expect(Number.isFinite(place.latitude)).toBe(true);
      expect(Math.abs(place.longitude)).toBeLessThanOrEqual(180);
      expect(Math.abs(place.latitude)).toBeLessThanOrEqual(90);
      expect([1, 2, 3]).toContain(place.rank);
    }
  });
});

describe('findNearestPlace', () => {
  it('坐标落在某城市上时返回该城市，距离接近 0', () => {
    const sample = PLACES[Math.floor(PLACES.length / 2)];
    const nearest = findNearestPlace(sample.latitude, sample.longitude);
    expect(nearest).not.toBeNull();
    expect(nearest!.distanceKm).toBeLessThan(1);
  });

  it('每个已知城市自己的坐标都应查回自己（不是别的同名/邻近城市）', () => {
    // 抽 60 个样本做一致性检查，避免只测一两个城市掩盖索引 bug
    const step = Math.max(1, Math.floor(PLACES.length / 60));
    for (let i = 0; i < PLACES.length; i += step) {
      const place = PLACES[i];
      const nearest = findNearestPlace(place.latitude, place.longitude);
      expect(nearest!.place.name, `坐标 ${place.name} 查回了别的城市`).toBe(place.name);
    }
  });

  it('偏移一点点仍然命中同一个城市', () => {
    const target = PLACES.find((p) => p.name === '惠州') ?? PLACES[0];
    const nearest = findNearestPlace(target.latitude + 0.02, target.longitude + 0.02);
    expect(nearest!.place.name).toBe(target.name);
  });

  it('远离所有城市时仍返回最近的参照点，而不是 null', () => {
    // 南太平洋腹地：最近的城市也有上千公里
    const nearest = findNearestPlace(-30, -140);
    expect(nearest).not.toBeNull();
    expect(nearest!.distanceKm).toBeGreaterThan(500);
  });

  it('结果稳定：同一坐标多次查询返回一致（缓存不应改变语义）', () => {
    const a = findNearestPlace(31.23, 121.47);
    const b = findNearestPlace(31.23, 121.47);
    expect(a!.place.name).toBe(b!.place.name);
    expect(a!.distanceKm).toBeCloseTo(b!.distanceKm, 10);
  });

  it('极地 / 边界坐标不会抛错', () => {
    for (const [lat, lng] of [
      [90, 0],
      [-90, 0],
      [0, 180],
      [0, -180],
      [85, 179],
    ] as const) {
      expect(() => findNearestPlace(lat, lng)).not.toThrow();
    }
  });
});

describe('placeLabel', () => {
  it('有上级且与自身不同时拼上上级', () => {
    expect(placeLabel({ name: '惠州', sub: '广东', latitude: 0, longitude: 0, rank: 3 })).toBe(
      '惠州 · 广东'
    );
  });

  it('直辖市上下同级时不重复报', () => {
    expect(placeLabel({ name: '上海', sub: '上海', latitude: 0, longitude: 0, rank: 1 })).toBe(
      '上海'
    );
  });

  it('无上级时只报名称', () => {
    expect(placeLabel({ name: 'Tokyo', sub: '', latitude: 0, longitude: 0, rank: 1 })).toBe(
      'Tokyo'
    );
  });
});

describe('formatPlaceHint', () => {
  const place = { name: '惠州', sub: '广东', latitude: 23.08, longitude: 114.4, rank: 3 as const };

  it('25km 内直接报地名', () => {
    expect(formatPlaceHint({ place, distanceKm: 0 })).toBe('惠州 · 广东');
    expect(formatPlaceHint({ place, distanceKm: 25 })).toBe('惠州 · 广东');
  });

  it('150km 内算「附近」', () => {
    expect(formatPlaceHint({ place, distanceKm: 26 })).toBe('惠州附近');
    expect(formatPlaceHint({ place, distanceKm: 150 })).toBe('惠州附近');
  });

  it('更远时报距离（仍是有用的参照）', () => {
    expect(formatPlaceHint({ place, distanceKm: 151 })).toBe('距 惠州 151 公里');
    expect(formatPlaceHint({ place, distanceKm: 1234.6 })).toBe('距 惠州 1235 公里');
  });

  it('无结果时返回空串', () => {
    expect(formatPlaceHint(null)).toBe('');
  });
});
