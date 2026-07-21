import type { GunState, WeaponId } from './types';
import type { Stance } from './character';
import { spreadFactorOf } from './attachments';
import { clamp, lerp } from './utils';

export type ScopeMode = 'none' | 'reddot' | 'scope2' | 'scope4';

interface WeaponHandling {
  aimIn: number;
  aimOut: number;
  sway: number;
  movePenalty: number;
}

export const WEAPON_HANDLING: Record<WeaponId, WeaponHandling> = {
  pistol: { aimIn: 13, aimOut: 16, sway: 0.00045, movePenalty: 0.85 },
  rifle: { aimIn: 9.5, aimOut: 14, sway: 0.00062, movePenalty: 1 },
  akm: { aimIn: 8.5, aimOut: 13, sway: 0.00072, movePenalty: 1.08 },
  smg: { aimIn: 11.5, aimOut: 15, sway: 0.00058, movePenalty: 0.9 },
  dmr: { aimIn: 7.4, aimOut: 12, sway: 0.00052, movePenalty: 1.04 },
  sniper: { aimIn: 5.8, aimOut: 10, sway: 0.00042, movePenalty: 1.15 },
  shotgun: { aimIn: 8.2, aimOut: 13, sway: 0.0008, movePenalty: 1.12 },
};

export interface SpreadInput {
  gun: GunState;
  aimProgress: number;
  stance: Stance;
  speed: number;
  grounded: boolean;
  bloom: number;
}

export interface AimSway {
  pitch: number;
  yaw: number;
}

export function smoothAimProgress(value: number, aiming: boolean, weaponId: WeaponId, dt: number): number {
  const handling = WEAPON_HANDLING[weaponId];
  const response = aiming ? handling.aimIn : handling.aimOut;
  return lerp(value, aiming ? 1 : 0, 1 - Math.exp(-response * dt));
}

export function aimBlend(progress: number): number {
  const p = clamp(progress, 0, 1);
  return p * p * (3 - 2 * p);
}

export function baseWeaponSpread(gun: GunState, aimProgress: number): number {
  return lerp(gun.def.spreadHip, gun.def.spreadAim, aimBlend(aimProgress));
}

export function calculateWeaponSpread(input: SpreadInput): number {
  const { gun, stance, grounded, bloom } = input;
  const stanceAccuracy = stance === 'crouch' ? 0.8 : stance === 'prone' ? 0.6 : 1;
  const move01 = clamp(input.speed / 6.9, 0, 1);
  const handling = WEAPON_HANDLING[gun.def.id];
  const moveFactor = 1 + move01 * move01 * 1.15 * handling.movePenalty + (grounded ? 0 : 0.8);
  return baseWeaponSpread(gun, input.aimProgress) * stanceAccuracy * spreadFactorOf(gun) * moveFactor + bloom;
}

export function calculateAimSway(
  out: AimSway,
  weaponId: WeaponId,
  aimProgress: number,
  stance: Stance,
  speed: number,
  time: number,
): AimSway {
  const stanceControl = stance === 'crouch' ? 0.72 : stance === 'prone' ? 0.48 : 1;
  const movement = 1 + clamp(speed / 4.55, 0, 1.5) * 1.7;
  const amplitude = WEAPON_HANDLING[weaponId].sway * stanceControl * movement * aimBlend(aimProgress);
  out.pitch = Math.sin(time * 1.67) * amplitude + Math.sin(time * 0.71) * amplitude * 0.42;
  out.yaw = Math.cos(time * 1.29) * amplitude * 0.86 + Math.sin(time * 0.53) * amplitude * 0.35;
  return out;
}

export function scopeModeOf(gun: GunState | null, aimProgress: number): ScopeMode {
  if (!gun || aimProgress < 0.72) return 'none';
  if (gun.def.id === 'sniper' || gun.att.sight === 'scope4') return 'scope4';
  if (gun.att.sight === 'scope2') return 'scope2';
  if (gun.att.sight === 'reddot') return 'reddot';
  return 'none';
}
