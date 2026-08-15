import { describe, expect, it } from 'vitest';
import {
  BOT_VS_BOT_DAMAGE_SCALE,
  BOT_VS_PLAYER_DAMAGE_SCALE,
  BOT_JUMP_ROUTE_END,
  BOT_JUMP_ROUTE_START,
  DROP_MIN_SEPARATION,
  ENEMY_COUNT,
  DROP_MAX_FLIGHT_DISTANCE,
  FLIGHT_ROUTES,
  MATCH_PLAYER_COUNT,
  botJumpDistance,
  combatDamageScale,
  dropRegionWeight,
  emptyDropRegionCounts,
  flightLineDistance,
  flightRouteOrigin,
  selectFlightRoute,
  selectDropRegion,
} from '../src/matchbalance';
import { MAP_CONTENT_SITES } from '../src/mapcontent';
import { CORE_LOOT_TARGET, LOOT_CAP } from '../src/loot';
import { REGIONS, regionAt } from '../src/regions';
import { VEHICLE_SPAWNS } from '../src/vehicles';
import { ZONE_PHASES } from '../src/zone';

describe('对局节奏和地图最终平衡', () => {
  it('64 人对局包含完整四人小队和六十名敌人', () => {
    expect(MATCH_PLAYER_COUNT).toBe(64);
    expect(ENEMY_COUNT).toBe(60);
  });

  it('每局从多条跨岛航线中随机选择且偏移计算保持一致', () => {
    expect(FLIGHT_ROUTES.length).toBeGreaterThanOrEqual(8);
    expect(new Set(FLIGHT_ROUTES.map((route) => route.id)).size).toBe(FLIGHT_ROUTES.length);
    expect(selectFlightRoute(0)).toBe(FLIGHT_ROUTES[0]);
    expect(selectFlightRoute(0.999999)).toBe(FLIGHT_ROUTES[FLIGHT_ROUTES.length - 1]);
    for (const route of FLIGHT_ROUTES) {
      const origin = flightRouteOrigin(route);
      expect(flightLineDistance(origin.x, origin.z, route.angle, route.offset)).toBeCloseTo(0, 8);
      const alongX = origin.x + Math.cos(route.angle) * 320;
      const alongZ = origin.z + Math.sin(route.angle) * 320;
      expect(flightLineDistance(alongX, alongZ, route.angle, route.offset)).toBeCloseTo(0, 8);
    }
  });

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
    expect(DROP_MIN_SEPARATION).toBeGreaterThanOrEqual(24);
  });

  it('机器人沿整条航线分层离机且保留目标区域策略偏置', () => {
    const count = ENEMY_COUNT;
    const jumps = Array.from({ length: count }, (_, index) => botJumpDistance(
      index < count / 2 ? -220 : 220,
      0,
      0,
      index,
      count,
      ((index * 37) % 101) / 101,
    ));
    expect(Math.min(...jumps)).toBeGreaterThanOrEqual(BOT_JUMP_ROUTE_START);
    expect(Math.max(...jumps)).toBeLessThanOrEqual(BOT_JUMP_ROUTE_END);
    expect(Math.max(...jumps) - Math.min(...jumps)).toBeGreaterThan(650);
    const occupiedBands = new Set(jumps.map((distance) => Math.floor(
      (distance - BOT_JUMP_ROUTE_START) / ((BOT_JUMP_ROUTE_END - BOT_JUMP_ROUTE_START) / 8),
    )));
    expect(occupiedBands.size).toBeGreaterThanOrEqual(7);

    const earlyTarget = botJumpDistance(-220, 0, 0, 2, count, 0.5);
    const lateTarget = botJumpDistance(220, 0, 0, 2, count, 0.5);
    expect(lateTarget - earlyTarget).toBeGreaterThan(80);
  });

  it('机器人互战降速但不削弱玩家和队友输出', () => {
    expect(combatDamageScale('enemy', 'enemy', false)).toBe(BOT_VS_BOT_DAMAGE_SCALE);
    expect(combatDamageScale('enemy', 'squad', true)).toBe(BOT_VS_PLAYER_DAMAGE_SCALE);
    expect(combatDamageScale('enemy', 'squad', false)).toBe(1);
    expect(combatDamageScale('squad', 'enemy', false)).toBe(1);
    expect(BOT_VS_BOT_DAMAGE_SCALE).toBeGreaterThan(BOT_VS_PLAYER_DAMAGE_SCALE);
    expect(BOT_VS_BOT_DAMAGE_SCALE).toBeLessThan(1);
  });

  it('首圈保留搜索窗口且后期连续提速', () => {
    const durations = ZONE_PHASES.map((phase) => phase.wait + phase.shrink);
    const total = durations.reduce((sum, duration) => sum + duration, 0);
    expect(durations[0]).toBeGreaterThanOrEqual(105);
    expect(durations[durations.length - 1]).toBeLessThanOrEqual(34);
    for (let i = 1; i < durations.length; i++) {
      expect(durations[i]).toBeLessThan(durations[i - 1] as number);
    }
    expect(total).toBeGreaterThanOrEqual(465);
    expect(total).toBeLessThanOrEqual(480);
  });

  it('所有正式区域均拥有至少一个载具转移点', () => {
    const covered = new Set(
      VEHICLE_SPAWNS.map((spawn) => regionAt(spawn.x, spawn.z)?.id).filter(Boolean),
    );
    for (const region of REGIONS) expect(covered.has(region.id)).toBe(true);
  });
});
