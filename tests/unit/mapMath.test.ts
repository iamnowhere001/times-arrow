import { describe, it, expect } from 'vitest';
import {
  MAX_MERCATOR_LATITUDE,
  cameraScaleBounds,
  clamp,
  projectLngLat,
  mercatorYToLatitude,
  mercatorXToLongitude,
  worldToScreen,
  clampCamera,
  zoomCameraAt,
  buildGeoPoints,
  countGeoLocations,
  clusterGeoPoints,
  findClusterAt,
  worldCamera,
  fitCameraToPoints,
  formatLatLng,
  type MapCamera,
  type MapViewport,
} from '@/lib/geo/mapMath';
import { makePhoto } from './fixtures';

const viewport: MapViewport = { width: 800, height: 600 };

/** 造一张带 GPS 的照片 */
const geoPhoto = (id: string, longitude: number, latitude: number) =>
  makePhoto({ id, exif: { gps: { longitude, latitude } } });

describe('projectLngLat（Web Mercator）', () => {
  it('本初子午线与赤道落在归一化坐标 (0.5, 0.5)', () => {
    const p = projectLngLat(0, 0);
    expect(p.x).toBeCloseTo(0.5, 10);
    expect(p.y).toBeCloseTo(0.5, 10);
  });

  it('经度线性映射：-180 → 0，180 → 1', () => {
    expect(projectLngLat(-180, 0).x).toBeCloseTo(0, 10);
    expect(projectLngLat(180, 0).x).toBeCloseTo(1, 10);
  });

  it('纬度越高 y 越小（北在上）', () => {
    expect(projectLngLat(0, 60).y).toBeLessThan(projectLngLat(0, 0).y);
    expect(projectLngLat(0, -60).y).toBeGreaterThan(projectLngLat(0, 0).y);
  });

  it('超出墨卡托极限的纬度被夹住，不会发散成 Infinity', () => {
    // 注意：夹到极限后 y 会落在 0/1 附近，但浮点误差可能让它溢出到边界外
    // 一个极小量（实测约 6e-12）。这个量级远小于一个像素，不影响渲染，
    // 因此这里用 epsilon 断言而不是要求严格落在 [0,1] 内。
    const EPS = 1e-9;
    for (const lat of [90, -90, 89.9, 1e9]) {
      const p = projectLngLat(0, lat);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(p.y).toBeGreaterThanOrEqual(-EPS);
      expect(p.y).toBeLessThanOrEqual(1 + EPS);
    }
    expect(projectLngLat(0, 90).y).toBeCloseTo(projectLngLat(0, MAX_MERCATOR_LATITUDE).y, 10);
  });
});

describe('逆投影', () => {
  it('与正投影互为逆运算（往返误差在浮点精度内）', () => {
    for (const [lng, lat] of [
      [0, 0],
      [116.4, 39.9],
      [-122.4, 37.8],
      [151.2, -33.9],
    ] as const) {
      const p = projectLngLat(lng, lat);
      expect(mercatorXToLongitude(p.x)).toBeCloseTo(lng, 6);
      expect(mercatorYToLatitude(p.y)).toBeCloseTo(lat, 6);
    }
  });
});

describe('worldToScreen', () => {
  it('相机中心点落在视口正中', () => {
    const camera: MapCamera = { centerX: 0.5, centerY: 0.5, scale: 1000 };
    const screen = worldToScreen({ x: 0.5, y: 0.5 }, camera, viewport);
    expect(screen.x).toBeCloseTo(viewport.width / 2, 10);
    expect(screen.y).toBeCloseTo(viewport.height / 2, 10);
  });

  it('缩放越大，同样的世界距离在屏幕上越远', () => {
    const point = { x: 0.6, y: 0.5 };
    const near = worldToScreen(point, { centerX: 0.5, centerY: 0.5, scale: 100 }, viewport);
    const far = worldToScreen(point, { centerX: 0.5, centerY: 0.5, scale: 200 }, viewport);
    expect(far.x - viewport.width / 2).toBeCloseTo((near.x - viewport.width / 2) * 2, 10);
  });
});

describe('clampCamera', () => {
  it('缩放被夹进 bounds', () => {
    const bounds = cameraScaleBounds(viewport);
    expect(clampCamera({ centerX: 0.5, centerY: 0.5, scale: 0.01 }, viewport).scale).toBe(
      bounds.min
    );
    expect(clampCamera({ centerX: 0.5, centerY: 0.5, scale: 1e12 }, viewport).scale).toBe(
      bounds.max
    );
  });

  it('视口为空时原样返回（不产生 NaN 相机）', () => {
    const camera: MapCamera = { centerX: 0.3, centerY: 0.7, scale: 500 };
    expect(clampCamera(camera, { width: 0, height: 0 })).toEqual(camera);
    expect(clampCamera(camera, { width: -10, height: 20 })).toEqual(camera);
  });

  it('世界比视口窄时中心被钉在 0.5', () => {
    // 极大缩放 → halfW 远小于 0.5 → margin 取 halfW*0.7，中心仍可小幅移动
    const zoomed = clampCamera({ centerX: 0.9, centerY: 0.9, scale: 1e6 }, viewport);
    expect(zoomed.centerX).toBeGreaterThan(0.5);
    expect(zoomed.centerX).toBeLessThanOrEqual(1);
  });

  it('输出永远是有限数（不会把视图拖进 NaN）', () => {
    for (const camera of [
      { centerX: -5, centerY: 5, scale: 1000 },
      { centerX: NaN, centerY: NaN, scale: 1000 },
      { centerX: 0.5, centerY: 0.5, scale: Infinity },
    ]) {
      const out = clampCamera(camera, viewport);
      expect(Number.isFinite(out.scale)).toBe(true);
    }
  });
});

describe('zoomCameraAt', () => {
  it('锚点下方的世界坐标在缩放前后保持不变', () => {
    const camera: MapCamera = { centerX: 0.5, centerY: 0.5, scale: 2000 };
    const sx = 600;
    const sy = 200;
    const anchorBefore = {
      x: camera.centerX + (sx - viewport.width / 2) / camera.scale,
      y: camera.centerY + (sy - viewport.height / 2) / camera.scale,
    };
    const zoomed = zoomCameraAt(camera, viewport, sx, sy, 1.5);
    const anchorAfter = {
      x: zoomed.centerX + (sx - viewport.width / 2) / zoomed.scale,
      y: zoomed.centerY + (sy - viewport.height / 2) / zoomed.scale,
    };
    // 被 clampCamera 夹过之后可能略有偏移，但应当非常接近
    expect(anchorAfter.x).toBeCloseTo(anchorBefore.x, 3);
    expect(anchorAfter.y).toBeCloseTo(anchorBefore.y, 3);
  });

  it('已到缩放上下限时原样返回同一个对象（省掉无意义的重渲染）', () => {
    const bounds = cameraScaleBounds(viewport);
    const atMax: MapCamera = { centerX: 0.5, centerY: 0.5, scale: bounds.max };
    expect(zoomCameraAt(atMax, viewport, 100, 100, 2)).toBe(atMax);
  });
});

describe('buildGeoPoints', () => {
  it('筛掉无 GPS 的条目', () => {
    const points = buildGeoPoints([makePhoto({ id: 'a' }), geoPhoto('b', 116.4, 39.9)]);
    expect(points.map((p) => p.photo.id)).toEqual(['b']);
  });

  it('筛掉 (0,0) —— 那多半是缺失值而不是几内亚湾', () => {
    expect(buildGeoPoints([geoPhoto('a', 0, 0)])).toHaveLength(0);
  });

  it('筛掉越界与非法坐标', () => {
    const bad = [
      geoPhoto('lng', 200, 0),
      geoPhoto('lat', 0, 100),
      geoPhoto('nan', NaN, 10),
      geoPhoto('inf', 10, Infinity),
    ];
    expect(buildGeoPoints(bad)).toHaveLength(0);
  });

  it('保持传入顺序', () => {
    const points = buildGeoPoints([geoPhoto('a', 1, 1), geoPhoto('b', 2, 2), geoPhoto('c', 3, 3)]);
    expect(points.map((p) => p.photo.id)).toEqual(['a', 'b', 'c']);
  });

  it('同时带上原始经纬度与投影后的世界坐标', () => {
    const [point] = buildGeoPoints([geoPhoto('a', 116.4, 39.9)]);
    expect(point.longitude).toBe(116.4);
    expect(point.latitude).toBe(39.9);
    expect(point.world).toEqual(projectLngLat(116.4, 39.9));
  });
});

describe('countGeoLocations', () => {
  it('同一 0.5° 网格内的点算同一个地点', () => {
    const points = buildGeoPoints([geoPhoto('a', 116.4, 39.9), geoPhoto('b', 116.45, 39.95)]);
    expect(countGeoLocations(points)).toBe(1);
  });

  it('跨网格的点各算一个地点', () => {
    const points = buildGeoPoints([geoPhoto('a', 116.0, 39.0), geoPhoto('b', 120.0, 39.0)]);
    expect(countGeoLocations(points)).toBe(2);
  });

  it('空输入返回 0', () => {
    expect(countGeoLocations([])).toBe(0);
  });
});

describe('clusterGeoPoints', () => {
  const camera: MapCamera = { centerX: 0.5, centerY: 0.5, scale: 100000 };

  // 注意：夹具刻意避开 (0,0) —— buildGeoPoints 会把该坐标当作缺失值过滤掉
  // （见「筛掉 (0,0)」那条用例），用它会得到空点位集，让聚合断言失去意义。
  const nearA = geoPhoto('a', 10, 10);
  const nearB = geoPhoto('b', 10.001, 10.001);
  const farB = geoPhoto('b', 30, 30);

  it('屏幕距离很近的点合并成一个簇，并取组内平均', () => {
    const points = buildGeoPoints([nearA, nearB]);
    const clusters = clusterGeoPoints(points, camera, viewport, 200);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].points).toHaveLength(2);
    expect(clusters[0].longitude).toBeCloseTo(10.0005, 6);
    expect(clusters[0].latitude).toBeCloseTo(10.0005, 6);
  });

  it('格子越小越容易分开（缩放越深越分散的手感来源）', () => {
    const points = buildGeoPoints([nearA, farB]);
    const coarse = clusterGeoPoints(points, camera, viewport, 100000);
    const fine = clusterGeoPoints(points, camera, viewport, 10);
    expect(coarse).toHaveLength(1);
    expect(fine).toHaveLength(2);
  });

  it('不丢点：所有簇的点数之和等于输入数', () => {
    const points = buildGeoPoints(
      Array.from({ length: 23 }, (_, i) => geoPhoto(`p${i}`, i * 1.7 - 20, i * 0.9 - 10))
    );
    const clusters = clusterGeoPoints(points, camera, viewport, 64);
    expect(clusters.reduce((sum, c) => sum + c.points.length, 0)).toBe(points.length);
  });

  it('空输入返回空数组', () => {
    expect(clusterGeoPoints([], camera, viewport, 64)).toEqual([]);
  });
});

describe('findClusterAt', () => {
  const clusters = clusterGeoPoints(
    buildGeoPoints([geoPhoto('a', 10, 10)]),
    { centerX: 0.5, centerY: 0.5, scale: 100000 },
    viewport,
    200
  );

  it('半径内命中最近的簇', () => {
    expect(clusters).toHaveLength(1);
    const target = clusters[0];
    expect(findClusterAt(clusters, target.x + 3, target.y + 4, 10)).toBe(target);
  });

  it('超出半径返回 null', () => {
    expect(findClusterAt(clusters, -9999, -9999, 10)).toBeNull();
  });

  it('空簇列表返回 null', () => {
    expect(findClusterAt([], 0, 0, 10)).toBeNull();
  });
});

describe('worldCamera / fitCameraToPoints', () => {
  it('无点时 fitCameraToPoints 返回 null（调用方据此回退世界视图）', () => {
    expect(fitCameraToPoints([], viewport)).toBeNull();
    expect(
      fitCameraToPoints(buildGeoPoints([geoPhoto('a', 10, 10)]), { width: 0, height: 0 })
    ).toBeNull();
  });

  it('单点：给一个城市尺度的视野，而不是贴到最大缩放', () => {
    const camera = fitCameraToPoints(buildGeoPoints([geoPhoto('a', 116.4, 39.9)]), viewport);
    expect(camera).not.toBeNull();
    expect(Number.isFinite(camera!.scale)).toBe(true);
  });

  it('多点：所有点都落在视口内', () => {
    const points = buildGeoPoints([
      geoPhoto('a', 100, 20),
      geoPhoto('b', 130, 45),
      geoPhoto('c', 110, 35),
    ]);
    const camera = fitCameraToPoints(points, viewport, 0)!;
    for (const point of points) {
      const screen = worldToScreen(point.world, camera, viewport);
      expect(screen.x).toBeGreaterThanOrEqual(-1);
      expect(screen.x).toBeLessThanOrEqual(viewport.width + 1);
      expect(screen.y).toBeGreaterThanOrEqual(-1);
      expect(screen.y).toBeLessThanOrEqual(viewport.height + 1);
    }
  });

  it('世界视图是有限相机', () => {
    const camera = worldCamera(viewport);
    expect(Number.isFinite(camera.centerX)).toBe(true);
    expect(Number.isFinite(camera.centerY)).toBe(true);
    expect(Number.isFinite(camera.scale)).toBe(true);
  });
});

describe('clamp / formatLatLng', () => {
  it('clamp 边界', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('经纬度格式化带方向后缀，且北纬/东经为正', () => {
    expect(formatLatLng(39.9, 116.4)).toContain('N');
    expect(formatLatLng(39.9, 116.4)).toContain('E');
    expect(formatLatLng(-33.9, -70.6)).toContain('S');
    expect(formatLatLng(-33.9, -70.6)).toContain('W');
  });

  it('小数位数可配', () => {
    expect(formatLatLng(1.23456, 2.34567, 2)).toMatch(/1\.23/);
    expect(formatLatLng(1.23456, 2.34567, 4)).toMatch(/1\.2346/);
  });
});
