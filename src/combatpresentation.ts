import type { WeaponId } from './types';
import type { AcousticSpace } from './audio';
import { clamp } from './utils';

export interface WeaponPresentation {
  readonly muzzleScale: number;
  readonly muzzleColor: number;
  readonly muzzleLight: number;
  readonly tracerColor: number;
  readonly tracerWidth: number;
  readonly smokeScale: number;
  readonly sampleGain: number;
  readonly mechanismGain: number;
  readonly mechanismFrequency: number;
  readonly pitchVariation: number;
}

export const WEAPON_PRESENTATION: Readonly<Record<WeaponId, WeaponPresentation>> = Object.freeze({
  pistol: {
    muzzleScale: 0.78, muzzleColor: 0xffd08a, muzzleLight: 0.72,
    tracerColor: 0xffd995, tracerWidth: 0.72, smokeScale: 0.42,
    sampleGain: 0.54, mechanismGain: 0.035, mechanismFrequency: 2100, pitchVariation: 0.055,
  },
  rifle: {
    muzzleScale: 1, muzzleColor: 0xffbc62, muzzleLight: 1,
    tracerColor: 0xffc96f, tracerWidth: 0.9, smokeScale: 0.58,
    sampleGain: 0.64, mechanismGain: 0.044, mechanismFrequency: 1850, pitchVariation: 0.04,
  },
  akm: {
    muzzleScale: 1.12, muzzleColor: 0xffa942, muzzleLight: 1.16,
    tracerColor: 0xffba54, tracerWidth: 1.04, smokeScale: 0.68,
    sampleGain: 0.69, mechanismGain: 0.05, mechanismFrequency: 1580, pitchVariation: 0.035,
  },
  lmg: {
    muzzleScale: 1.08, muzzleColor: 0xffad49, muzzleLight: 1.12,
    tracerColor: 0xffbd58, tracerWidth: 1.02, smokeScale: 0.75,
    sampleGain: 0.72, mechanismGain: 0.054, mechanismFrequency: 1450, pitchVariation: 0.03,
  },
  smg: {
    muzzleScale: 0.72, muzzleColor: 0xffcb76, muzzleLight: 0.66,
    tracerColor: 0xffd282, tracerWidth: 0.66, smokeScale: 0.38,
    sampleGain: 0.46, mechanismGain: 0.038, mechanismFrequency: 2400, pitchVariation: 0.06,
  },
  dmr: {
    muzzleScale: 1.18, muzzleColor: 0xffa33d, muzzleLight: 1.2,
    tracerColor: 0xffb34a, tracerWidth: 1.08, smokeScale: 0.74,
    sampleGain: 0.72, mechanismGain: 0.052, mechanismFrequency: 1500, pitchVariation: 0.032,
  },
  sniper: {
    muzzleScale: 1.42, muzzleColor: 0xff9432, muzzleLight: 1.36,
    tracerColor: 0xffaa3d, tracerWidth: 1.28, smokeScale: 1.05,
    sampleGain: 0.82, mechanismGain: 0.062, mechanismFrequency: 1180, pitchVariation: 0.022,
  },
  shotgun: {
    muzzleScale: 1.34, muzzleColor: 0xff8d2f, muzzleLight: 1.3,
    tracerColor: 0xffaa45, tracerWidth: 1.18, smokeScale: 1.12,
    sampleGain: 0.78, mechanismGain: 0.058, mechanismFrequency: 1260, pitchVariation: 0.03,
  },
});

export interface ResolvedWeaponPresentation extends WeaponPresentation {
  readonly suppressed: boolean;
}

export function weaponPresentation(weapon: WeaponId, suppressed: boolean): ResolvedWeaponPresentation {
  const base = WEAPON_PRESENTATION[weapon];
  if (!suppressed) return { ...base, suppressed: false };
  return {
    ...base,
    muzzleScale: base.muzzleScale * 0.2,
    muzzleLight: base.muzzleLight * 0.16,
    smokeScale: base.smokeScale * 1.18,
    sampleGain: base.sampleGain * 0.24,
    mechanismGain: base.mechanismGain * 1.12,
    suppressed: true,
  };
}

export interface ShotAcousticMix {
  readonly bodyGain: number;
  readonly tailGain: number;
  readonly mechanismGain: number;
  readonly playbackRate: number;
}

export function shotAcousticMix(
  weapon: WeaponId,
  distance: number,
  suppressed: boolean,
  space: AcousticSpace,
  variation: number,
): ShotAcousticMix {
  const presentation = weaponPresentation(weapon, suppressed);
  const safeDistance = Math.max(0, distance);
  const distanceAttenuation = clamp(1.35 / (1 + safeDistance * 0.028), 0.015, 1);
  const tailBase = space === 'indoor' ? 0.3 : space === 'forest' ? 0.16 : 0.22;
  const distanceTail = clamp(0.62 + safeDistance / 180, 0.62, 1.08);
  return {
    bodyGain: distanceAttenuation * presentation.sampleGain,
    tailGain: suppressed ? 0 : distanceAttenuation * tailBase * distanceTail,
    mechanismGain: distanceAttenuation * presentation.mechanismGain * clamp(1 - safeDistance / 55, 0, 1),
    playbackRate: clamp(1 + clamp(variation, -1, 1) * presentation.pitchVariation, 0.88, 1.12),
  };
}
