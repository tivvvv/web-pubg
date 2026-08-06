import { describe, expect, it } from 'vitest';
import {
  shotAcousticMix,
  WEAPON_PRESENTATION,
  weaponPresentation,
} from '../src/combatpresentation';
import type { WeaponId } from '../src/types';

const WEAPONS: WeaponId[] = ['pistol', 'rifle', 'akm', 'lmg', 'smg', 'dmr', 'sniper', 'shotgun'];

describe('枪战表现配置', () => {
  it('八种武器拥有可辨识且范围合法的视觉与声音特征', () => {
    expect(Object.keys(WEAPON_PRESENTATION)).toEqual(WEAPONS);
    for (const id of WEAPONS) {
      const profile = WEAPON_PRESENTATION[id];
      expect(profile.muzzleScale).toBeGreaterThan(0.5);
      expect(profile.muzzleLight).toBeGreaterThan(0.5);
      expect(profile.tracerWidth).toBeGreaterThan(0.4);
      expect(profile.tracerWidth).toBeLessThanOrEqual(1.4);
      expect(profile.sampleGain).toBeGreaterThan(0.4);
      expect(profile.pitchVariation).toBeLessThan(0.08);
    }
    expect(WEAPON_PRESENTATION.sniper.muzzleScale).toBeGreaterThan(WEAPON_PRESENTATION.smg.muzzleScale);
    expect(WEAPON_PRESENTATION.sniper.tracerWidth).toBeGreaterThan(WEAPON_PRESENTATION.pistol.tracerWidth);
  });

  it('消音器压低枪焰与声压但保留机械动作和烟气', () => {
    const loud = weaponPresentation('rifle', false);
    const suppressed = weaponPresentation('rifle', true);
    expect(suppressed.muzzleScale).toBeLessThan(loud.muzzleScale * 0.25);
    expect(suppressed.muzzleLight).toBeLessThan(loud.muzzleLight * 0.2);
    expect(suppressed.sampleGain).toBeLessThan(loud.sampleGain * 0.3);
    expect(suppressed.mechanismGain).toBeGreaterThan(loud.mechanismGain);
    expect(suppressed.smokeScale).toBeGreaterThan(loud.smokeScale);
  });

  it('枪声主体随距离衰减并按空间生成独立尾响', () => {
    const nearOpen = shotAcousticMix('akm', 0, false, 'open', 0);
    const farOpen = shotAcousticMix('akm', 180, false, 'open', 0);
    const indoor = shotAcousticMix('akm', 0, false, 'indoor', 0);
    const suppressed = shotAcousticMix('akm', 0, true, 'open', 0);
    expect(nearOpen.bodyGain).toBeGreaterThan(farOpen.bodyGain);
    expect(nearOpen.mechanismGain).toBeGreaterThan(farOpen.mechanismGain);
    expect(indoor.tailGain).toBeGreaterThan(nearOpen.tailGain);
    expect(suppressed.tailGain).toBe(0);
    expect(suppressed.bodyGain).toBeLessThan(nearOpen.bodyGain);
  });

  it('随机音高始终被限制在自然变化范围内', () => {
    expect(shotAcousticMix('smg', 0, false, 'open', -5).playbackRate).toBeGreaterThanOrEqual(0.88);
    expect(shotAcousticMix('smg', 0, false, 'open', 5).playbackRate).toBeLessThanOrEqual(1.12);
  });
});
