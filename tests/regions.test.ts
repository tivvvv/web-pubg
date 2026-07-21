import { describe, expect, it } from 'vitest';
import { REGIONS, regionAt, regionOrWilderness } from '../src/regions';

describe('地图区域定义', () => {
  it('所有正式区域名称和资源配置保持完整', () => {
    expect(REGIONS).toHaveLength(6);
    for (const region of REGIONS) {
      expect(region.name.length).toBeGreaterThan(1);
      expect(region.feature.length).toBeGreaterThan(4);
      expect(region.radius).toBeGreaterThan(50);
    }
  });

  it('区域中心命中自身且远离区域时回退荒野', () => {
    for (const region of REGIONS) expect(regionAt(region.x, region.z)?.id).toBe(region.id);
    expect(regionOrWilderness(340, 340).id).toBe('wilderness');
  });
});
