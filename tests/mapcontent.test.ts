import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MAP_CONTENT_SITES, mapContentSiteAt, type ResolvedMapContentSite } from '../src/mapcontent';
import { REGIONS, regionAt } from '../src/regions';
import { ROAD_PATHS, roadIntersectsRect, WATER_Y, World } from '../src/world';

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

  it('全部道路中心线避开建筑主体且不会从房间中穿过', () => {
    const world = new World(new THREE.Scene());
    const issues: string[] = [];
    world.buildings.plots.forEach((plot, plotIndex) => {
      if (roadIntersectsRect(plot.minX + 2, plot.minZ + 2, plot.maxX - 2, plot.maxZ - 2, 4.1)) {
        issues.push(`${plotIndex}:${plot.arch}`);
      }
    });
    expect(issues).toEqual([]);
  });

  it('道路末端均在可读的陆地节点收口', () => {
    const worldScene = new THREE.Scene();
    const world = new World(worldScene);
    const degree = new Map<string, number>();
    for (const path of ROAD_PATHS) {
      for (let index = 0; index < path.length - 1; index++) {
        for (const point of [path[index], path[index + 1]] as const) {
          const key = `${point?.[0]},${point?.[1]}`;
          degree.set(key, (degree.get(key) ?? 0) + 1);
        }
      }
    }
    const terminals = [...degree.entries()].filter(([, count]) => count === 1).map(([key]) => {
      const [x, z] = key.split(',').map(Number) as [number, number];
      return [x, z, Number(world.getHeight(x, z).toFixed(2))] as const;
    });
    for (const [x, z, height] of terminals) {
      expect(height, `道路末端 ${x},${z} 仍伸入水面或湿滩`).toBeGreaterThanOrEqual(WATER_Y + 1.05);
    }
    expect(world.roadTerminusCount).toBe(3);
    const terminusGroup = worldScene.getObjectByName('road-termini');
    expect(terminusGroup?.children.length).toBeGreaterThanOrEqual(21);
  });

  it('道路全线经过水面时必须由正式桥梁承接', () => {
    const world = new World(new THREE.Scene());
    const unsupported: string[] = [];
    for (let pathIndex = 0; pathIndex < ROAD_PATHS.length; pathIndex++) {
      const path = ROAD_PATHS[pathIndex] as readonly (readonly [number, number])[];
      for (let segmentIndex = 0; segmentIndex < path.length - 1; segmentIndex++) {
        const a = path[segmentIndex] as readonly [number, number];
        const b = path[segmentIndex + 1] as readonly [number, number];
        const samples = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
        for (let sample = 0; sample <= samples; sample++) {
          const t = sample / samples;
          const x = a[0] + (b[0] - a[0]) * t;
          const z = a[1] + (b[1] - a[1]) * t;
          if (world.getHeight(x, z) >= WATER_Y + 0.08) continue;
          const onBridge = world.platforms.some((platform) => (
            x >= platform.minX - 0.05 && x <= platform.maxX + 0.05 &&
            z >= platform.minZ - 0.05 && z <= platform.maxZ + 0.05 &&
            platform.top >= WATER_Y + 0.45
          ));
          if (!onBridge) unsupported.push(`${pathIndex}:${segmentIndex}@${x.toFixed(1)},${z.toFixed(1)}`);
        }
      }
    }
    expect(unsupported).toEqual([]);
    expect(world.roadWaterCrossingCount).toBeGreaterThanOrEqual(5);
    expect(world.roadWaterCrossingPositions).toHaveLength(world.roadWaterCrossingCount);
    expect(world.roadWaterCrossingSegmentCount).toBeGreaterThan(40);
  });

  it('雾松林场拥有疏落林间建筑和完整护林设施', () => {
    const world = new World(new THREE.Scene());
    const forestBuildings = world.buildings.plots.filter((plot) => {
      const x = (plot.minX + plot.maxX) * 0.5;
      const z = (plot.minZ + plot.maxZ) * 0.5;
      return regionAt(x, z)?.id === 'mistwood';
    });
    expect(forestBuildings.length).toBeGreaterThanOrEqual(4);
    const lumberSite = world.mapSites.find((site) => site.kind === 'lumber');
    expect(lumberSite).toBeDefined();
    if (lumberSite) {
      for (let probe = 0; probe < 12; probe++) {
        const angle = probe / 12 * Math.PI * 2;
        const x = lumberSite.resolvedX + Math.cos(angle) * 7.2;
        const z = lumberSite.resolvedZ + Math.sin(angle) * 7.2;
        expect(world.getHeight(x, z), `林场设施边缘 ${probe} 落入水面或湿滩`).toBeGreaterThanOrEqual(WATER_Y + 0.55);
      }
    }
    expect(world.forestFacilityDetailCount).toBeGreaterThanOrEqual(35);
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
