import { describe, expect, it } from 'vitest';
import { MAP_CONTENT_SITES, mapContentSiteAt, type ResolvedMapContentSite } from '../src/mapcontent';
import { REGIONS } from '../src/regions';
import { ROAD_PATHS } from '../src/world';

describe('地图内容收口', () => {
  it('六个正式区域均拥有唯一主地标和资源配置', () => {
    expect(MAP_CONTENT_SITES).toHaveLength(REGIONS.length);
    expect(new Set(MAP_CONTENT_SITES.map((site) => site.name)).size).toBe(MAP_CONTENT_SITES.length);
    for (const region of REGIONS) {
      const site = MAP_CONTENT_SITES.find((candidate) => candidate.region === region.id);
      expect(site).toBeDefined();
      if (!site) continue;
      expect(Math.hypot(site.x - region.x, site.z - region.z)).toBeLessThan(region.radius);
      expect(site.feature.length).toBeGreaterThan(7);
    }
  });

  it('宏观道路覆盖林场并使用南部桥线连接农场', () => {
    const allPoints = ROAD_PATHS.flat();
    expect(allPoints.some(([x, z]) => Math.hypot(x, z + 200) < 24)).toBe(true);
    expect(ROAD_PATHS.some((path) => path.some(([x, z]) => Math.abs(x - 170) < 2 && z > 90))).toBe(true);
  });

  it('进入主地标范围时返回最近地标', () => {
    const sites: ResolvedMapContentSite[] = MAP_CONTENT_SITES.slice(0, 2).map((site) => ({
      ...site,
      resolvedX: site.x,
      resolvedZ: site.z,
    }));
    const first = sites[0] as ResolvedMapContentSite;
    expect(mapContentSiteAt(sites, first.resolvedX + 2, first.resolvedZ)?.id).toBe(first.id);
    expect(mapContentSiteAt(sites, 340, 340)).toBeNull();
  });
});
