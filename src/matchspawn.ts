import {
  DROP_MAX_FLIGHT_DISTANCE,
  DROP_MIN_SEPARATION,
  MATCH_PLAYER_COUNT,
  SQUAD_SIZE,
  emptyDropRegionCounts,
  flightLineDistance,
  selectDropRegion,
  selectFlightRoute,
  type DropRegionCounts,
  type FlightRoute,
} from './matchbalance';
import { regionOrWilderness } from './regions';

export interface MatchSpawnPoint {
  x: number;
  z: number;
}

export interface MatchSpawnPlan {
  route: FlightRoute;
  points: MatchSpawnPoint[];
}

export interface MatchSpawnOptions {
  pointFree: (x: number, z: number) => boolean;
  random: () => number;
  playerCount?: number;
  squadSize?: number;
}

function distance2D(a: MatchSpawnPoint, x: number, z: number): number {
  return Math.hypot(a.x - x, a.z - z);
}

function squadDropPoints(
  anchorX: number,
  anchorZ: number,
  memberCount: number,
  pointFree: MatchSpawnOptions['pointFree'],
  seedAngle: number,
): MatchSpawnPoint[] | null {
  for (const radius of [5.5, 7.5, 9.5] as const) {
    for (let rotation = 0; rotation < 8; rotation++) {
      const angleOffset = seedAngle + rotation * Math.PI / 4;
      const points: MatchSpawnPoint[] = [];
      let valid = true;
      for (let slot = 0; slot < memberCount; slot++) {
        const distance = slot === 0 ? 0 : radius * (slot === 3 ? 0.78 : 1);
        const angle = angleOffset + (slot - 1) * Math.PI * 2 / 3;
        const x = anchorX + Math.cos(angle) * distance;
        const z = anchorZ + Math.sin(angle) * distance;
        if (!pointFree(x, z)) {
          valid = false;
          break;
        }
        points.push({ x, z });
      }
      if (valid) return points;
    }
  }
  return null;
}

/**
 * 为一局对战生成航线和全部落点。区域选择、承载限制与兜底网格集中在这里，
 * Game 只负责把生成结果实例化为玩家、队友和机器人。
 */
export function createMatchSpawnPlan(options: MatchSpawnOptions): MatchSpawnPlan {
  const playerCount = options.playerCount ?? MATCH_PLAYER_COUNT;
  const squadSize = options.squadSize ?? SQUAD_SIZE;
  if (!Number.isInteger(playerCount) || !Number.isInteger(squadSize) || squadSize < 1 || playerCount < squadSize) {
    throw new Error(`无效的对局人数配置: players=${playerCount}, squad=${squadSize}`);
  }

  const route = selectFlightRoute(options.random());
  const points: MatchSpawnPoint[] = Array.from({ length: squadSize }, () => ({ x: 0, z: 0 }));
  const enemySquadAnchors: MatchSpawnPoint[] = [];
  const dropCounts = emptyDropRegionCounts();
  const separated = (x: number, z: number, separation = DROP_MIN_SEPARATION + 12): boolean => {
    for (const anchor of enemySquadAnchors) {
      if (distance2D(anchor, x, z) < separation) return false;
    }
    return true;
  };

  const appendSquad = (x: number, z: number): boolean => {
    const memberCount = Math.min(squadSize, playerCount - points.length);
    const squadPoints = squadDropPoints(
      x,
      z,
      memberCount,
      options.pointFree,
      enemySquadAnchors.length * 2.399963229728653,
    );
    if (!squadPoints) return false;
    enemySquadAnchors.push({ x, z });
    points.push(...squadPoints);
    return true;
  };

  let guard = 0;
  while (points.length < playerCount && guard++ < 5000) {
    const region = selectDropRegion(route.angle, dropCounts, options.random(), route.offset);
    if (!region) break;
    let x = 0;
    let z = 0;
    let sampled = false;
    for (let retry = 0; retry < 18; retry++) {
      const angle = options.random() * Math.PI * 2;
      const distance = Math.sqrt(options.random()) * region.radius * 0.76;
      x = region.x + Math.cos(angle) * distance;
      z = region.z + Math.sin(angle) * distance;
      if (flightLineDistance(x, z, route.angle, route.offset) > DROP_MAX_FLIGHT_DISTANCE) continue;
      if (regionOrWilderness(x, z).id !== region.id || !options.pointFree(x, z)) continue;
      sampled = true;
      break;
    }
    if (!sampled || !separated(x, z)) continue;
    const memberCount = Math.min(squadSize, playerCount - points.length);
    if (dropCounts[region.id as keyof DropRegionCounts] + memberCount > region.dropCapacity) continue;
    if (!appendSquad(x, z)) continue;
    dropCounts[region.id as keyof DropRegionCounts] += memberCount;
  }

  // 极端地形或航线组合仍遵守航线距离和区域承载, 仅放宽区域采样策略。
  guard = 0;
  while (points.length < playerCount && guard++ < 6000) {
    const x = -320 + options.random() * 640;
    const z = -320 + options.random() * 640;
    if (flightLineDistance(x, z, route.angle, route.offset) > DROP_MAX_FLIGHT_DISTANCE) continue;
    if (!options.pointFree(x, z) || !separated(x, z)) continue;
    const fallbackRegion = regionOrWilderness(x, z);
    if (fallbackRegion.id !== 'wilderness') {
      const id = fallbackRegion.id as keyof DropRegionCounts;
      const memberCount = Math.min(squadSize, playerCount - points.length);
      if (dropCounts[id] + memberCount > fallbackRegion.dropCapacity) continue;
      if (!appendSquad(x, z)) continue;
      dropCounts[id] += memberCount;
    } else if (!appendSquad(x, z)) {
      continue;
    }
  }

  // 最终使用确定性安全网格, 保证不会把角色塞入碰撞体或相互重叠。
  for (let x = -300; x <= 300 && points.length < playerCount; x += 24) {
    for (let z = -300; z <= 300 && points.length < playerCount; z += 24) {
      if (flightLineDistance(x, z, route.angle, route.offset) > DROP_MAX_FLIGHT_DISTANCE + 35) continue;
      if (!options.pointFree(x, z) || !separated(x, z)) continue;
      appendSquad(x, z);
    }
  }
  for (let x = -300; x <= 300 && points.length < playerCount; x += 16) {
    for (let z = -300; z <= 300 && points.length < playerCount; z += 16) {
      if (!options.pointFree(x, z) || !separated(x, z, 22)) continue;
      appendSquad(x, z);
    }
  }

  if (points.length !== playerCount) {
    throw new Error(`无法生成完整对局落点: ${points.length}/${playerCount}`);
  }
  return { route, points };
}
