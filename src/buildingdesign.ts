import type { RegionId } from './regions';

export type ArchId = 'cottage1' | 'cottage2' | 'terrace' | 'apartment' | 'barn' | 'shop' | 'gym';

export interface HousePlot {
  minX: number; minZ: number; maxX: number; maxZ: number;
  flatH: number;
  arch: ArchId;
  w: number;
  d: number;
  storeys?: number;
}

export const BUILDING_ARCHETYPES: Readonly<
  Record<ArchId, { w: readonly [number, number]; d: readonly [number, number]; weight: number }>
> = Object.freeze({
  cottage1: { w: [8.2, 10.8], d: [7.4, 9.6], weight: 26 },
  cottage2: { w: [8.8, 11.6], d: [7.8, 10.5], weight: 22 },
  terrace: { w: [10.0, 12.2], d: [8.8, 10.8], weight: 12 },
  apartment: { w: [11.0, 14.0], d: [9.8, 12.0], weight: 8 },
  barn: { w: [10.0, 12.5], d: [8.8, 11.0], weight: 8 },
  shop: { w: [7.2, 9.0], d: [6.0, 7.5], weight: 12 },
  gym: { w: [40, 43], d: [25, 28], weight: 0 },
});

export const GABLE_ROOF_RISE = 1.9;
export const GABLE_ROOF_COURSES = Object.freeze([
  { z: 0.08, y: 0.34 }, { z: 0.92, y: 0.34 },
  { z: 0.18, y: 0.72 }, { z: 0.82, y: 0.72 },
  { z: 0.28, y: 1.1 }, { z: 0.72, y: 1.1 },
  { z: 0.38, y: 1.46 }, { z: 0.62, y: 1.46 },
  { z: 0.46, y: 1.74 }, { z: 0.54, y: 1.74 },
]);
export const GABLE_INFILL_LAYERS = 24;

export function gableRoofPitch(depth: number): number {
  return Math.atan2(GABLE_ROOF_RISE, Math.max(1, depth * 0.5 + 0.34));
}

export interface RegionalBuildingStyle {
  walls: readonly number[];
  roofs: readonly number[];
  accent: number;
  secondary: number;
  chimneyChance: number;
  acChance: number;
}

export const REGIONAL_BUILDING_STYLES: Readonly<Record<RegionId, RegionalBuildingStyle>> = {
  stonegate: {
    walls: [0xe1d5bd, 0xc8d0cb, 0xd4b99b], roofs: [0x5f6a70, 0x934f3f],
    accent: 0x877b68, secondary: 0xb85f45, chimneyChance: 0.34, acChance: 0.62,
  },
  ironring: {
    walls: [0xb7b9b2, 0x9fa7a5, 0xc3b9aa], roofs: [0x676d70, 0x80564a],
    accent: 0x9c493d, secondary: 0x515c62, chimneyChance: 0.12, acChance: 0.72,
  },
  sunfield: {
    walls: [0xd4c096, 0xc8a970, 0xbca27a], roofs: [0x995542, 0x795e44],
    accent: 0x765239, secondary: 0xc4a24f, chimneyChance: 0.58, acChance: 0.08,
  },
  mistwood: {
    walls: [0x9ba58f, 0x8f9a87, 0xb0aa91], roofs: [0x4f5a50, 0x665644],
    accent: 0x4f493e, secondary: 0x6f7c59, chimneyChance: 0.7, acChance: 0.04,
  },
  eagleridge: {
    walls: [0xbdbdb5, 0xa9aca8, 0xc9c3b4], roofs: [0x686d70, 0x7e6556],
    accent: 0x666b6b, secondary: 0xa84f42, chimneyChance: 0.22, acChance: 0.42,
  },
  tideharbor: {
    walls: [0xa9c0c2, 0xb8c8c1, 0xd0c4a5], roofs: [0x55747a, 0x82594a],
    accent: 0x3f6f79, secondary: 0xd0a957, chimneyChance: 0.28, acChance: 0.18,
  },
};

export function regionalBuildingStyle(region: RegionId): RegionalBuildingStyle {
  return REGIONAL_BUILDING_STYLES[region];
}

export function isMultiStoreyArch(arch: ArchId): boolean {
  return arch === 'cottage2' || arch === 'terrace' || arch === 'apartment';
}

export function buildingStoreys(plot: Pick<HousePlot, 'arch' | 'storeys'>): number {
  if (plot.arch === 'apartment') return Math.max(3, Math.floor(plot.storeys ?? 3));
  return plot.arch === 'cottage2' || plot.arch === 'terrace' ? 2 : 1;
}

export function mainEntranceHalfWidth(arch: ArchId, doorWidth: number): number {
  if (arch === 'apartment' || arch === 'gym') return doorWidth;
  if (arch === 'barn') return 1.3;
  if (arch === 'shop') return 1.2;
  return doorWidth / 2;
}

export type FacadeOpening = readonly [number, number];

export function facadeSegments(
  start: number,
  end: number,
  openings: readonly FacadeOpening[],
  padding = 0.12,
): Array<[number, number]> {
  const clipped = openings
    .map(([a0, a1]) => [Math.max(start, Math.min(a0, a1) - padding), Math.min(end, Math.max(a0, a1) + padding)] as const)
    .filter(([a0, a1]) => a1 > a0)
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [a0, a1] of clipped) {
    const previous = merged[merged.length - 1];
    if (previous && a0 <= previous[1]) previous[1] = Math.max(previous[1], a1);
    else merged.push([a0, a1]);
  }
  const segments: Array<[number, number]> = [];
  let cursor = start;
  for (const [a0, a1] of merged) {
    if (a0 > cursor + 0.001) segments.push([cursor, a0]);
    cursor = Math.max(cursor, a1);
  }
  if (cursor < end - 0.001) segments.push([cursor, end]);
  return segments;
}

export function overlapsFacadeOpening(
  a0: number,
  a1: number,
  openings: readonly FacadeOpening[],
  padding = 0.1,
): boolean {
  return openings.some(([door0, door1]) => a1 > door0 - padding && a0 < door1 + padding);
}

export function stairRailX(x0: number, x1: number, side: 'min' | 'max'): number {
  return side === 'max' ? x1 : x0;
}

export interface StairHandrailTransform {
  centerY: number;
  centerZ: number;
  length: number;
  pitch: number;
}

export type ApartmentFloorLayout = 'lobby' | 'residence' | 'office' | 'lounge' | 'utility';

export function apartmentFloorLayout(level: number, storeys: number): ApartmentFloorLayout {
  if (level <= 0) return 'lobby';
  if (level >= storeys - 1) return 'utility';
  return (['residence', 'office', 'lounge'] as const)[(level - 1) % 3] as ApartmentFloorLayout;
}

export function stairHandrailTransform(
  zFrom: number,
  zTo: number,
  floorY: number,
  rise: number,
  steps: number,
  endClearance: number,
): StairHandrailTransform {
  const run = zTo - zFrom;
  const postSpanRatio = Math.max(0, steps - 1) / Math.max(1, steps);
  const railRun = run * postSpanRatio;
  const railRise = rise * Math.max(0, steps - 1);
  const fullLength = Math.hypot(railRun, railRise);
  const clearance = Math.min(endClearance, fullLength * 0.12);
  return {
    centerY: floorY + rise * ((steps + 1) / 2) + 0.83,
    centerZ: (zFrom + zTo) / 2,
    length: Math.max(0.2, fullLength - clearance * 2),
    pitch: -Math.sign(run || 1) * Math.atan2(railRise, Math.abs(railRun)),
  };
}

export interface EntranceStepProfile {
  count: number;
  depth: number;
  tops: number[];
}

// 入口最高一级必须比角色碰撞半径更深，让角色在接触地板侧面前先完整站上门前平台。
// 0.42m 同时给 groundHeight 的边缘采样留出余量，坡地房屋不会因一两厘米高差被推出门洞。
export const ENTRANCE_STEP_MIN_TREAD_DEPTH = 0.42;

export function entranceStepProfile(floorY: number, groundY: number, baseDepth = 0.78): EntranceStepProfile {
  const climb = Math.max(0, floorY - groundY);
  const count = Math.max(3, Math.min(8, Math.ceil(climb / 0.28)));
  const depth = Math.max(baseDepth, count * ENTRANCE_STEP_MIN_TREAD_DEPTH);
  const lowTop = Math.min(floorY - 0.16, groundY + 0.08);
  const tops = Array.from({ length: count }, (_, step) => {
    const progress = (count - step) / count;
    return lowTop + (floorY - 0.035 - lowTop) * progress;
  });
  return { count, depth, tops };
}
