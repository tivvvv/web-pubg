import { REGIONS, type RegionDef, type RegionId } from './regions';

export const MATCH_PLAYER_COUNT = 50;
export const SQUAD_SIZE = 4;
export const ENEMY_COUNT = MATCH_PLAYER_COUNT - SQUAD_SIZE;
export const DROP_MAX_FLIGHT_DISTANCE = 168;
export const DROP_MIN_SEPARATION = 24;
export const BOT_JUMP_ROUTE_START = 55;
export const BOT_JUMP_ROUTE_END = 945;
export const BOT_VS_PLAYER_DAMAGE_SCALE = 0.7;
export const BOT_VS_BOT_DAMAGE_SCALE = 0.86;

export interface FlightRoute {
  readonly id: string;
  readonly angle: number;
  /** 航线相对地图中心的有符号垂直偏移. */
  readonly offset: number;
}

// 固定航线池保证每条路线都经过足够陆地, 同向但不同偏移的路线也会形成不同资源区选择.
export const FLIGHT_ROUTES: readonly FlightRoute[] = Object.freeze([
  { id: 'west-north', angle: 0, offset: -72 },
  { id: 'east-south', angle: Math.PI, offset: -54 },
  { id: 'north-east', angle: Math.PI / 2, offset: 62 },
  { id: 'south-west', angle: -Math.PI / 2, offset: 58 },
  { id: 'northwest-southeast', angle: Math.PI / 4, offset: -52 },
  { id: 'southeast-northwest', angle: -Math.PI * 3 / 4, offset: 48 },
  { id: 'southwest-northeast', angle: -Math.PI / 4, offset: -44 },
  { id: 'northeast-southwest', angle: Math.PI * 3 / 4, offset: 56 },
]);

export function selectFlightRoute(unitRandom: number): FlightRoute {
  const random = Math.max(0, Math.min(0.999999, unitRandom));
  return FLIGHT_ROUTES[Math.floor(random * FLIGHT_ROUTES.length)] as FlightRoute;
}

export function flightRouteOrigin(route: FlightRoute): { x: number; z: number } {
  return {
    x: Math.sin(route.angle) * route.offset,
    z: -Math.cos(route.angle) * route.offset,
  };
}

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

export function flightLineDistance(x: number, z: number, flightAngle: number, flightOffset = 0): number {
  return Math.abs(x * Math.sin(flightAngle) - z * Math.cos(flightAngle) - flightOffset);
}

/**
 * 将机器人分层铺在整条航线上, 再混合目标资源区的投影和小幅随机扰动.
 * 每六名机器人有一名更偏向覆盖航线空段, 其余机器人优先在选定资源区附近离机.
 */
export function botJumpDistance(
  targetX: number,
  targetZ: number,
  flightAngle: number,
  botIndex: number,
  botCount: number,
  unitRandom: number,
): number {
  const count = Math.max(1, Math.floor(botCount));
  const index = Math.max(0, Math.floor(botIndex)) % count;
  // 17 与 46 互质, 50 人局的 46 名敌人能以稳定乱序覆盖所有航线分层.
  const stratum = (index * 17) % count;
  const random = Math.max(0, Math.min(0.999999, unitRandom));
  const routeFraction = (stratum + 0.2 + random * 0.6) / count;
  const routeDistance = BOT_JUMP_ROUTE_START +
    routeFraction * (BOT_JUMP_ROUTE_END - BOT_JUMP_ROUTE_START);
  const dirX = Math.cos(flightAngle);
  const dirZ = Math.sin(flightAngle);
  const strategicDistance = Math.max(BOT_JUMP_ROUTE_START, Math.min(
    BOT_JUMP_ROUTE_END,
    500 + targetX * dirX + targetZ * dirZ,
  ));
  const routeWeight = index % 6 === 0 ? 0.88 : 0.62 + (index % 3) * 0.06;
  const jitter = (random - 0.5) * 26;
  return Math.max(BOT_JUMP_ROUTE_START, Math.min(
    BOT_JUMP_ROUTE_END,
    routeDistance * routeWeight + strategicDistance * (1 - routeWeight) + jitter,
  ));
}

export function dropRegionWeight(region: RegionDef, flightAngle: number, count: number, flightOffset = 0): number {
  if (region.id === 'wilderness' || count >= region.dropCapacity) return 0;
  const lineDistance = Math.max(
    0,
    flightLineDistance(region.x, region.z, flightAngle, flightOffset) - region.radius * 0.72,
  );
  if (lineDistance > DROP_MAX_FLIGHT_DISTANCE) return 0;
  const access = 1 - lineDistance / (DROP_MAX_FLIGHT_DISTANCE * 1.35);
  const remaining = 1 - count / region.dropCapacity;
  return region.dropWeight * Math.max(0.25, access) * (0.3 + remaining * remaining * 0.7);
}

export function selectDropRegion(
  flightAngle: number,
  counts: DropRegionCounts,
  unitRandom: number,
  flightOffset = 0,
): RegionDef | null {
  const weighted = REGIONS.map((region) => ({
    region,
    weight: dropRegionWeight(region, flightAngle, counts[region.id as RegionId], flightOffset),
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
