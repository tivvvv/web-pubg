import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { REGIONS } from '../src/regions';
import { findTacticalRouteWaypoint, TACTICAL_ROUTES } from '../src/tactics';

describe('区域战术路线', () => {
  it('六个正式区域均至少拥有一条战术路线', () => {
    for (const region of REGIONS) {
      expect(TACTICAL_ROUTES.some((route) => route.region === region.id)).toBe(true);
    }
  });

  it('相邻硬掩体保持一次短冲刺可达', () => {
    for (const route of TACTICAL_ROUTES) {
      expect(route.points.length).toBeGreaterThanOrEqual(4);
      for (let i = 1; i < route.points.length; i++) {
        const prev = route.points[i - 1] as readonly [number, number];
        const point = route.points[i] as readonly [number, number];
        const gap = Math.hypot(point[0] - prev[0], point[1] - prev[1]);
        expect(gap).toBeGreaterThanOrEqual(10);
        expect(gap).toBeLessThanOrEqual(24);
      }
    }
  });

  it('战术路线节点均位于对应区域范围内', () => {
    for (const route of TACTICAL_ROUTES) {
      const region = REGIONS.find((candidate) => candidate.id === route.region);
      expect(region).toBeDefined();
      if (!region) continue;
      for (const [x, z] of route.points) {
        expect(Math.hypot(x - region.x, z - region.z)).toBeLessThanOrEqual(region.radius);
      }
    }
  });

  it('机器人能从路线附近取得下一个侧向机动点', () => {
    const out = new THREE.Vector2();
    for (const route of TACTICAL_ROUTES) {
      for (let i = 0; i < route.points.length; i++) {
        const origin = route.points[i] as readonly [number, number];
        for (const direction of [-1, 1]) {
          const targetIndex = i + direction;
          const found = findTacticalRouteWaypoint(out, origin[0], origin[1], route.role, direction, 8);
          if (targetIndex < 0 || targetIndex >= route.points.length) {
            expect(found).toBe(false);
            continue;
          }
          expect(found).toBe(true);
          const target = route.points[targetIndex] as readonly [number, number];
          expect(Math.hypot(out.x - target[0], out.y - target[1])).toBeCloseTo(2.8, 5);
          expect(Math.hypot(out.x - origin[0], out.y - origin[1])).toBeLessThan(28);
        }
      }
    }
  });

  it('远离已制作路线时不生成伪路点', () => {
    const out = new THREE.Vector2();
    expect(findTacticalRouteWaypoint(out, 500, 500, null, 1, 30)).toBe(false);
  });
});
