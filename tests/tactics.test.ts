import { describe, expect, it } from 'vitest';
import { REGIONS } from '../src/regions';
import { TACTICAL_ROUTES } from '../src/tactics';

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
});
