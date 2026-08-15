import { clamp } from './utils';
import type { LootKind, WeaponId } from './types';

export type InteractionKind = 'ally' | 'door' | 'airdrop' | 'treasure' | 'deathcrate' | 'vehicle' | 'item';
export type ComparisonTone = 'positive' | 'neutral' | 'warning';
export type ReviveCancelReason = 'target' | 'incapacitated' | 'movement' | 'range';

export const REVIVE_INTERACTION_RANGE = 2.75;

const AUTOMATIC_PICKUP_KINDS: ReadonlySet<LootKind> = new Set([
  'ammoRifle', 'ammoSmg', 'ammoSniper', 'ammoPistol', 'ammoShotgun',
  'bandage', 'medkit', 'drink', 'frag', 'smoke', 'flash',
]);

export function isAutomaticPickupKind(kind: LootKind): boolean {
  return AUTOMATIC_PICKUP_KINDS.has(kind);
}

export function weaponPickupSlot(
  weapon: WeaponId,
  guns: readonly ({ def: { tier: number } } | null)[],
  currentSlot: number,
  playerControlled: boolean,
): number {
  if (weapon === 'pistol') return 2;
  if (!guns[0]) return 0;
  if (!guns[1]) return 1;
  if (playerControlled && (currentSlot === 0 || currentSlot === 1)) return currentSlot;
  const tier0 = guns[0]?.def.tier ?? 99;
  const tier1 = guns[1]?.def.tier ?? 99;
  return tier0 <= tier1 ? 0 : 1;
}

export function interactionDistanceText(distance: number): string {
  return `${Math.max(0, distance).toFixed(1)} 米`;
}

export function interactionSelfOcclusionTolerance(kind: InteractionKind): number {
  if (kind === 'door') return 0.45;
  if (kind === 'treasure') return 1.05;
  return 0.32;
}

export function reviveCancellationReason(input: {
  targetValid: boolean;
  reviverIncapacitated: boolean;
  reviverSpeed: number;
  distance: number;
}): ReviveCancelReason | null {
  if (!input.targetValid) return 'target';
  if (input.reviverIncapacitated) return 'incapacitated';
  if (input.reviverSpeed > 0.2) return 'movement';
  if (input.distance > REVIVE_INTERACTION_RANGE) return 'range';
  return null;
}

export interface DoorwayBounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface DoorwayActorSample {
  x: number;
  y: number;
  z: number;
  radius: number;
  height?: number;
  active: boolean;
}

// 关门前按真实门洞范围检测角色胶囊，避免门扇穿人或把角色锁进碰撞体。
export function doorwayOccupied(
  bounds: DoorwayBounds,
  actors: readonly DoorwayActorSample[],
  clearance = 0.08,
): boolean {
  for (const actor of actors) {
    if (!actor.active) continue;
    const height = actor.height ?? 1.65;
    if (actor.y + height <= bounds.minY || actor.y >= bounds.maxY) continue;
    const cx = clamp(actor.x, bounds.minX, bounds.maxX);
    const cz = clamp(actor.z, bounds.minZ, bounds.maxZ);
    const dx = actor.x - cx;
    const dz = actor.z - cz;
    const radius = actor.radius + clearance;
    if (dx * dx + dz * dz < radius * radius) return true;
  }
  return false;
}

export interface EquipmentComparison {
  text: string;
  tone: ComparisonTone;
}

export function equipmentComparison(
  currentName: string | null,
  currentLevel: number | null,
  nextLevel: number,
): EquipmentComparison {
  if (!currentName || currentLevel === null) return { text: '空栏位 · 直接装备', tone: 'positive' };
  if (nextLevel > currentLevel) return { text: `升级 · 当前 ${currentName}`, tone: 'positive' };
  if (nextLevel < currentLevel) return { text: `降级 · 当前 ${currentName}`, tone: 'warning' };
  return { text: `同等级 · 当前 ${currentName}`, tone: 'neutral' };
}

export interface InteractionCandidate<T = object> {
  kind: InteractionKind;
  target: T;
  distance: number;
  dot: number;
  maxDistance: number;
  minDot: number;
  priority: number;
}

const STICKY_DISTANCE_MARGIN = 0.18;
const STICKY_DOT_MARGIN = 0.08;

export function interactionScore<T>(candidate: InteractionCandidate<T>, sticky: boolean): number {
  // 当前目标允许很小的距离和准星容差，避免站在门边或物资堆中时提示逐帧闪断。
  // 容差只参与保留，首次选中仍使用严格阈值。
  const maxDistance = candidate.maxDistance + (sticky ? STICKY_DISTANCE_MARGIN : 0);
  const minDot = candidate.minDot - (sticky ? STICKY_DOT_MARGIN : 0);
  if (candidate.distance > maxDistance || candidate.dot < minDot) return -Infinity;
  const proximity = 1 - clamp(candidate.distance / candidate.maxDistance, 0, 1);
  const focus = clamp((candidate.dot - candidate.minDot) / Math.max(0.001, 1 - candidate.minDot), 0, 1);
  return candidate.priority + focus * 0.62 + proximity * 0.38 + (sticky ? 0.13 : 0);
}

// 统一处理门, 物品, 载具和队友。当前目标获得小幅黏滞, 防止相邻目标逐帧抢占提示。
export function chooseInteractionCandidate<T>(
  candidates: readonly InteractionCandidate<T>[],
  currentTarget: T | null,
): InteractionCandidate<T> | null {
  let best: InteractionCandidate<T> | null = null;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const score = interactionScore(candidate, candidate.target === currentTarget);
    if (score <= bestScore) continue;
    best = candidate;
    bestScore = score;
  }
  return best;
}
