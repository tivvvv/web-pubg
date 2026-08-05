import { REGIONS, type RegionDef, type RegionId } from './regions';

export const MATCH_PLAYER_COUNT = 24;
export const SQUAD_SIZE = 4;
export const ENEMY_COUNT = MATCH_PLAYER_COUNT - SQUAD_SIZE;
export const DROP_MAX_FLIGHT_DISTANCE = 168;
export const DROP_MIN_SEPARATION = 24;
export const BOT_VS_PLAYER_DAMAGE_SCALE = 0.7;
export const BOT_VS_BOT_DAMAGE_SCALE = 0.86;

export type CombatTeam = 'squad' | 'enemy';

/**
 * 玩家输出和队友火力保持原值, 只压低机器人互相清场的速度.
 * 机器人对玩家的既有减伤规则也集中在这里, 避免远程和近战出现不同口径.
 */
export function combatDamageScale(
  attackerTeam: CombatTeam,
  victimTeam: CombatTeam,
  victimIsPlayer: boolean,
): number {
  if (attackerTeam === 'enemy' && victimIsPlayer) return BOT_VS_PLAYER_DAMAGE_SCALE;
  if (attackerTeam === 'enemy' && victimTeam === 'enemy') return BOT_VS_BOT_DAMAGE_SCALE;
  return 1;
}

export interface DropRegionCounts {
  stonegate: number;
  ironring: number;
  sunfield: number;
  mistwood: number;
  eagleridge: number;
  tideharbor: number;
}

export function emptyDropRegionCounts(): DropRegionCounts {
  return {
    stonegate: 0,
    ironring: 0,
    sunfield: 0,
    mistwood: 0,
    eagleridge: 0,
    tideharbor: 0,
  };
}

export function flightLineDistance(x: number, z: number, flightAngle: number): number {
  return Math.abs(x * Math.sin(flightAngle) - z * Math.cos(flightAngle));
}

export function dropRegionWeight(region: RegionDef, flightAngle: number, count: number): number {
  if (region.id === 'wilderness' || count >= region.dropCapacity) return 0;
  const lineDistance = Math.max(0, flightLineDistance(region.x, region.z, flightAngle) - region.radius * 0.72);
  if (lineDistance > DROP_MAX_FLIGHT_DISTANCE) return 0;
  const access = 1 - lineDistance / (DROP_MAX_FLIGHT_DISTANCE * 1.35);
  const remaining = 1 - count / region.dropCapacity;
  return region.dropWeight * Math.max(0.25, access) * (0.3 + remaining * remaining * 0.7);
}

export function selectDropRegion(
  flightAngle: number,
  counts: DropRegionCounts,
  unitRandom: number,
): RegionDef | null {
  const weighted = REGIONS.map((region) => ({
    region,
    weight: dropRegionWeight(region, flightAngle, counts[region.id as RegionId]),
  })).filter((entry) => entry.weight > 0);
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return null;
  let cursor = Math.max(0, Math.min(0.999999, unitRandom)) * total;
  for (const entry of weighted) {
    cursor -= entry.weight;
    if (cursor <= 0) return entry.region;
  }
  return weighted[weighted.length - 1]?.region ?? null;
}
