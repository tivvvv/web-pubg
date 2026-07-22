import type { RegionId } from './regions';
import type * as THREE from 'three';

export type TacticalCoverKind = 'barrier' | 'crate' | 'hay' | 'logs' | 'breastwork';

export interface TacticalRoute {
  id: string;
  region: RegionId;
  name: string;
  role: 'advance' | 'flank' | 'defend';
  cover: TacticalCoverKind;
  points: readonly (readonly [number, number])[];
}

// 区域战术路线同时是场景布置和回归测试的数据源。相邻节点保持 10~24m,
// 玩家和 AI 均可在一次短冲刺内从一个硬掩体转移到下一个硬掩体。
export const TACTICAL_ROUTES: readonly TacticalRoute[] = [
  {
    id: 'stonegate-market', region: 'stonegate', name: '市集推进线', role: 'advance', cover: 'barrier',
    points: [[-111, -19], [-94, -10], [-77, -20], [-58, -10], [-39, -19]],
  },
  {
    id: 'stonegate-drain', region: 'stonegate', name: '南侧排水巷', role: 'flank', cover: 'crate',
    points: [[-91, -63], [-76, -50], [-58, -43], [-40, -51], [-24, -39]],
  },
  {
    id: 'ironring-west', region: 'ironring', name: '西侧攻坚线', role: 'advance', cover: 'barrier',
    points: [[133, -65], [143, -49], [141, -30], [149, -13]],
  },
  {
    id: 'ironring-east', region: 'ironring', name: '东侧集装箱巷', role: 'flank', cover: 'crate',
    points: [[219, -69], [214, -50], [219, -31], [211, -12]],
  },
  {
    id: 'sunfield-ditch', region: 'sunfield', name: '灌溉渠推进线', role: 'advance', cover: 'hay',
    points: [[-103, 203], [-84, 196], [-64, 205], [-43, 198], [-22, 207]],
  },
  {
    id: 'mistwood-timber', region: 'mistwood', name: '伐木运输线', role: 'flank', cover: 'logs',
    points: [[-72, -211], [-52, -201], [-31, -211], [-10, -201], [11, -212]],
  },
  {
    id: 'eagleridge-rampart', region: 'eagleridge', name: '山脊防御线', role: 'defend', cover: 'breastwork',
    points: [[-274, 4], [-257, 15], [-239, 7], [-221, 18], [-203, 10]],
  },
  {
    id: 'tideharbor-quay', region: 'tideharbor', name: '码头货运巷', role: 'advance', cover: 'crate',
    points: [[166, -237], [184, -228], [202, -239], [219, -228], [235, -239]],
  },
];

export function findTacticalRouteWaypoint(
  out: THREE.Vector2,
  x: number,
  z: number,
  role: TacticalRoute['role'] | null,
  side = 1,
  maxDistance = 110,
): boolean {
  let bestRoute: TacticalRoute | null = null;
  let bestIndex = -1;
  let bestDistance = maxDistance;
  for (const route of TACTICAL_ROUTES) {
    if (role && route.role !== role) continue;
    for (let i = 0; i < route.points.length; i++) {
      const point = route.points[i] as readonly [number, number];
      const distance = Math.hypot(point[0] - x, point[1] - z);
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      bestRoute = route;
      bestIndex = i;
    }
  }
  if (!bestRoute || bestIndex < 0) return false;
  const targetIndex = bestIndex + (side < 0 ? -1 : 1);
  if (targetIndex < 0 || targetIndex >= bestRoute.points.length) return false;
  const target = bestRoute.points[targetIndex] as readonly [number, number];
  const prev = bestRoute.points[Math.max(0, targetIndex - 1)] as readonly [number, number];
  const next = bestRoute.points[Math.min(bestRoute.points.length - 1, targetIndex + 1)] as readonly [number, number];
  const dx = next[0] - prev[0];
  const dz = next[1] - prev[1];
  const length = Math.hypot(dx, dz) || 1;
  const offset = 2.8 * (side < 0 ? -1 : 1);
  out.set(target[0] - dz / length * offset, target[1] + dx / length * offset);
  return true;
}
