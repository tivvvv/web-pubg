import { describe, expect, it } from 'vitest';
import {
  ENEMY_COUNT,
  DROP_MAX_FLIGHT_DISTANCE,
  dropRegionWeight,
  emptyDropRegionCounts,
  flightLineDistance,
  selectDropRegion,
} from '../src/matchbalance';
import { MAP_CONTENT_SITES } from '../src/mapcontent';
import { CORE_LOOT_TARGET, LOOT_CAP } from '../src/loot';
import { REGIONS, regionAt } from '../src/regions';
import { VEHICLE_SPAWNS } from '../src/vehicles';
import { ZONE_PHASES } from '../src/zone';

describe('对局节奏和地图最终平衡', () => {
  it('六个区域的落点容量足以容纳全部敌人且都有稳定战斗套件', () => {
    expect(REGIONS.reduce((sum, region) => sum + region.dropCapacity, 0)).toBeGreaterThanOrEqual(ENEMY_COUNT);
    expect(REGIONS.reduce((sum, region) => sum + region.lootBudget, 0) + 18).toBeGreaterThanOrEqual(CORE_LOOT_TARGET);
    expect(CORE_LOOT_TARGET).toBeLessThan(LOOT_CAP - 20);
    for (const region of REGIONS) {
      expect(region.landmarkLootSpots).toBeGreaterThanOrEqual(7);
      expect(region.lootBudget).toBeGreaterThanOrEqual(26);
      expect(region.dropWeight).toBeGreaterThan(0);
      expect(region.dropCapacity).toBeGreaterThanOrEqual(3);
      expect(region.emptyChance).toBeGreaterThanOrEqual(0);
      expect(region.emptyChance).toBeLessThan(0.25);
      expect(region.signatureWeapon.length).toBeGreaterThan(2);
      const site = MAP_CONTENT_SITES.find((candidate) => candidate.region === region.id);
      expect(site).toBeDefined();
      expect(site?.premiumSpots ?? 0).toBeLessThan(region.landmarkLootSpots);
    }
  });

  it('落点选择遵守航线可达性和区域承载上限', () => {
    const counts = emptyDropRegionCounts();
    for (const region of REGIONS) counts[region.id] = region.dropCapacity;
    counts.sunfield--;
    expect(selectDropRegion(Math.PI / 2, counts, 0.5)?.id).toBe('sunfield');
    counts.sunfield++;
    expect(selectDropRegion(Math.PI / 2, counts, 0.5)).toBeNull();

    const stonegate = REGIONS.find((region) => region.id === 'stonegate');
    expect(stonegate).toBeDefined();
    if (!stonegate) return;
    expect(dropRegionWeight(stonegate, 0, stonegate.dropCapacity)).toBe(0);
    expect(flightLineDistance(30, 20, 0)).toBe(20);
    expect(DROP_MAX_FLIGHT_DISTANCE).toBeGreaterThan(150);
  });

  it('首圈保留搜索窗口且后期连续提速', () => {
    const durations = ZONE_PHASES.map((phase) => phase.wait + phase.shrink);
    const total = durations.reduce((sum, duration) => sum + duration, 0);
    expect(durations[0]).toBeGreaterThanOrEqual(60);
    expect(durations[durations.length - 1]).toBeLessThanOrEqual(18);
    for (let i = 1; i < durations.length; i++) {
      expect(durations[i]).toBeLessThan(durations[i - 1] as number);
    }
    expect(total).toBeGreaterThanOrEqual(215);
    expect(total).toBeLessThanOrEqual(230);
  });

  it('所有正式区域均拥有至少一个载具转移点', () => {
    const covered = new Set(
      VEHICLE_SPAWNS.map((spawn) => regionAt(spawn.x, spawn.z)?.id).filter(Boolean),
    );
    for (const region of REGIONS) expect(covered.has(region.id)).toBe(true);
  });
});
