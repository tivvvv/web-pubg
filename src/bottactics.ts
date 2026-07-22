import { magSizeOf } from './attachments';
import type { AmmoType, GunState, WeaponId } from './types';

export type BotStrategicMode = 'loot' | 'rotate' | 'hunt' | 'recover' | 'postcombat' | 'patrol';
export type BotCombatMode = 'advance' | 'strafe' | 'retreat' | 'cover' | 'search' | 'rotate';
export type ZoneRotationUrgency = 'none' | 'prepare' | 'immediate';

export interface ZoneRotationInput {
  outsideCurrent: boolean;
  distanceOutsideNext: number;
  state: 'wait' | 'shrink' | 'done';
  timer: number;
  moveSpeed?: number;
}

export function zoneRotationUrgency(input: ZoneRotationInput): ZoneRotationUrgency {
  if (input.outsideCurrent) return 'immediate';
  if (input.state === 'done') return 'none';
  if (input.distanceOutsideNext <= 0) return 'none';
  if (input.state === 'shrink') return 'immediate';
  const travelTime = input.distanceOutsideNext / (input.moveSpeed ?? 5.2);
  return input.timer <= travelTime + 5 ? 'prepare' : 'none';
}

export interface StrategicDecisionInput {
  rotation: ZoneRotationUrgency;
  hp: number;
  hasHeal: boolean;
  hasGun: boolean;
  hasAmmo: boolean;
  needsGear: boolean;
  recentThreat: boolean;
  postCombat: boolean;
}

export function chooseStrategicMode(input: StrategicDecisionInput): BotStrategicMode {
  if (input.rotation !== 'none') return 'rotate';
  if (input.hp < 58 && input.hasHeal) return 'recover';
  if (input.postCombat) return 'postcombat';
  if (input.recentThreat) return 'hunt';
  if (!input.hasGun || !input.hasAmmo || input.needsGear) return 'loot';
  return 'patrol';
}

const PREFERRED_RANGE: Record<WeaponId, number> = {
  pistol: 18,
  rifle: 32,
  akm: 28,
  smg: 17,
  dmr: 48,
  sniper: 66,
  shotgun: 9,
};

export function preferredCombatRange(id: WeaponId | null): number {
  return id ? PREFERRED_RANGE[id] : 2.1;
}

export interface CombatDecisionInput {
  rotation: ZoneRotationUrgency;
  hp: number;
  reloading: boolean;
  hasLineOfSight: boolean;
  coverAvailable: boolean;
  meleeOnly: boolean;
  distance: number;
  preferredRange: number;
}

export function chooseCombatMode(input: CombatDecisionInput): BotCombatMode {
  if (input.rotation === 'immediate') return 'rotate';
  if (input.rotation === 'prepare' && (!input.hasLineOfSight || input.distance > Math.max(30, input.preferredRange * 1.35))) {
    return 'rotate';
  }
  if ((input.reloading || input.hp < 36) && input.coverAvailable) return 'cover';
  if (input.hp < 28 || (input.reloading && !input.hasLineOfSight)) return 'retreat';
  if (!input.hasLineOfSight) return 'search';
  if (input.meleeOnly || input.distance > input.preferredRange * 1.25) return 'advance';
  if (input.distance < input.preferredRange * 0.55) return 'retreat';
  return 'strafe';
}

function gunScore(gun: GunState, reserve: number, distance: number): number {
  if (gun.mag + reserve <= 0) return -Infinity;
  const id = gun.def.id;
  const preferred = preferredCombatRange(id);
  let score = gun.def.tier * 12 - Math.abs(distance - preferred) * 0.22;
  if (gun.mag > 0) score += 8;
  else score -= 6;
  if (id === 'shotgun' && distance > 28) score -= 45;
  if (id === 'sniper' && distance < 24) score -= 28;
  if (id === 'dmr' && distance < 12) score -= 12;
  if ((id === 'smg' || id === 'shotgun') && distance < 18) score += 7;
  if ((id === 'dmr' || id === 'sniper') && distance > 42) score += 8;
  return score;
}

export function selectCombatGunSlot(
  guns: readonly (GunState | null)[],
  ammo: Record<AmmoType, number>,
  distance: number,
): number {
  let bestSlot = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < guns.length; i++) {
    const gun = guns[i];
    if (!gun) continue;
    const score = gunScore(gun, ammo[gun.def.ammo], distance);
    if (score <= bestScore) continue;
    bestScore = score;
    bestSlot = i;
  }
  return bestSlot;
}

export function shouldTacticalReload(
  gun: GunState | null,
  reserve: number,
  inCombat: boolean,
  hasLineOfSight: boolean,
): boolean {
  if (!gun || reserve <= 0) return false;
  const magSize = magSizeOf(gun);
  if (gun.mag >= magSize) return false;
  if (gun.mag <= 0) return true;
  if (inCombat && hasLineOfSight) return false;
  return gun.mag / magSize <= 0.45;
}

export interface SmokeDecisionInput {
  hasSmoke: boolean;
  alreadyUsed: boolean;
  hp: number;
  reloading: boolean;
  rotation: ZoneRotationUrgency;
  hasLineOfSight: boolean;
  distance: number;
}

export function shouldDeploySmoke(input: SmokeDecisionInput): boolean {
  if (!input.hasSmoke || input.alreadyUsed || !input.hasLineOfSight) return false;
  if (input.distance < 10 || input.distance > 62) return false;
  return input.hp < 38 || input.reloading || input.rotation === 'immediate';
}
