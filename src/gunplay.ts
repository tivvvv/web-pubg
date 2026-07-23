import type { GunState, WeaponId } from './types';
import type { Stance } from './character';
import { recoilFactorOf, spreadFactorOf } from './attachments';
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

export interface WeaponRecoilProfile {
  vertical: number;
  horizontal: number;
  bloom: number;
  gunKick: number;
  pitchRecovery: number;
  yawRecovery: number;
  bloomRecovery: number;
}

export const WEAPON_RECOIL: Record<WeaponId, WeaponRecoilProfile> = {
  pistol: {
    vertical: 0.95, horizontal: 0.22, bloom: 0.32, gunKick: 0.045,
    pitchRecovery: 11, yawRecovery: 14, bloomRecovery: 9.5,
  },
  rifle: {
    vertical: 1, horizontal: 0.42, bloom: 0.46, gunKick: 0.055,
    pitchRecovery: 9.5, yawRecovery: 12.5, bloomRecovery: 8.5,
  },
  akm: {
    vertical: 1.18, horizontal: 0.5, bloom: 0.52, gunKick: 0.07,
    pitchRecovery: 8.4, yawRecovery: 11, bloomRecovery: 7.6,
  },
  smg: {
    vertical: 0.78, horizontal: 0.5, bloom: 0.52, gunKick: 0.045,
    pitchRecovery: 12.5, yawRecovery: 15, bloomRecovery: 10,
  },
  dmr: {
    vertical: 1.16, horizontal: 0.25, bloom: 0.3, gunKick: 0.085,
    pitchRecovery: 7.8, yawRecovery: 11.5, bloomRecovery: 7,
  },
  sniper: {
    vertical: 1.35, horizontal: 0.16, bloom: 0.2, gunKick: 0.12,
    pitchRecovery: 5.8, yawRecovery: 9, bloomRecovery: 5.5,
  },
  shotgun: {
    vertical: 1.2, horizontal: 0.3, bloom: 0.16, gunKick: 0.1,
    pitchRecovery: 7.2, yawRecovery: 10, bloomRecovery: 6.5,
  },
};

export interface RecoilImpulse {
  vertical: number;
  horizontal: number;
  bloom: number;
  gunKick: number;
}

const HORIZONTAL_RECOIL_PATTERN = [0.08, -0.32, 0.42, -0.18, 0.56, -0.48, 0.28, -0.12] as const;

export function calculateRecoilImpulse(
  out: RecoilImpulse,
  gun: GunState,
  aimProgress: number,
  stance: Stance,
  shotIndex: number,
  randomSigned: number,
): RecoilImpulse {
  const profile = WEAPON_RECOIL[gun.def.id];
  const stanceControl = stance === 'crouch' ? 0.82 : stance === 'prone' ? 0.62 : 1;
  const aimControl = lerp(1, 0.88, aimBlend(aimProgress));
  const patternIndex = Math.floor(Math.max(0, shotIndex));
  const chain = Math.min(patternIndex, 12);
  const chainFactor = 1 + chain * 0.027;
  const recoil = gun.def.recoil * recoilFactorOf(gun) * stanceControl * aimControl;
  const pattern = HORIZONTAL_RECOIL_PATTERN[patternIndex % HORIZONTAL_RECOIL_PATTERN.length] ?? 0;
  const horizontalShape = pattern * 0.72 + clamp(randomSigned, -1, 1) * 0.28;
  out.vertical = recoil * profile.vertical * chainFactor;
  out.horizontal = recoil * profile.horizontal * horizontalShape * (0.9 + chainFactor * 0.1);
  out.bloom = baseWeaponSpread(gun, aimProgress) * profile.bloom * (1 + chain * 0.018);
  out.gunKick = profile.gunKick * lerp(1, 0.8, aimBlend(aimProgress));
  return out;
}

export function reloadDuration(gun: GunState, empty: boolean): number {
  if (gun.def.id === 'shotgun') return gun.def.reloadTime;
  const reloadState = empty ? 1.1 : 0.9;
  const magazineWeight = gun.att.mag === 'extmag' ? 1.04 : 1;
  return gun.def.reloadTime * reloadState * magazineWeight;
}

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
