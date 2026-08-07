import { describe, expect, it } from 'vitest';
import { canAttach, emptyAttachments, magSizeOf, recoilFactorOf, sightZoomOf } from '../src/attachments';
import { WEAPONS } from '../src/weapons';
import { attachWeaponMods, buildWeaponModel, FIREARM_MODEL_SCALE } from '../src/weaponmodels';

describe('武器配件规则', () => {
  it('枪械模型统一放大且近战装备保持原尺寸', () => {
    expect(buildWeaponModel('rifle').group.scale.x).toBe(FIREARM_MODEL_SCALE);
    expect(buildWeaponModel('pistol').group.scale.x).toBe(FIREARM_MODEL_SCALE);
    expect(buildWeaponModel('knife').group.scale.x).toBe(1);
  });
  it('瞄具和枪口配件具有可辨认的近景结构', () => {
    const scoped = buildWeaponModel('rifle');
    attachWeaponMods(scoped.group, { sight: 'scope4', muzzle: 'suppressor', mag: null });
    expect(scoped.group.getObjectsByProperty('name', 'optic-lens')).toHaveLength(2);
    expect(scoped.group.getObjectsByProperty('name', 'scope-mount')).toHaveLength(2);
    expect(scoped.group.getObjectByName('scope-turret')).toBeTruthy();
    expect(scoped.group.getObjectsByProperty('name', 'suppressor-band')).toHaveLength(2);

    const dotted = buildWeaponModel('akm');
    attachWeaponMods(dotted.group, { sight: 'reddot', muzzle: 'comp', mag: null });
    expect(dotted.group.getObjectByName('reddot-hood')).toBeTruthy();
    expect(dotted.group.getObjectByName('reddot-reticle')).toBeTruthy();
    expect(dotted.group.getObjectsByProperty('name', 'compensator-port')).toHaveLength(2);
  });

  it('扩容弹匣按枪型增加正确容量', () => {
    expect(magSizeOf({ def: WEAPONS.rifle, mag: 30, att: { ...emptyAttachments(), mag: 'extmag' } })).toBe(40);
    expect(magSizeOf({ def: WEAPONS.sniper, mag: 5, att: { ...emptyAttachments(), mag: 'extmag' } })).toBe(7);
    expect(magSizeOf({ def: WEAPONS.lmg, mag: 50, att: { ...emptyAttachments(), mag: 'extmag' } })).toBe(75);
  });

  it('瞄具提供真实 ADS 倍率', () => {
    expect(sightZoomOf({ def: WEAPONS.rifle, mag: 30, att: { ...emptyAttachments(), sight: 'scope4' } })).toBe(4);
    expect(sightZoomOf({ def: WEAPONS.rifle, mag: 30, att: { ...emptyAttachments(), sight: 'scope2' } })).toBe(2);
  });

  it('兼容规则和补偿器后坐系数保持稳定', () => {
    expect(canAttach('shotgun', 'reddot')).toBe(false);
    expect(canAttach('sniper', 'scope4')).toBe(false);
    expect(canAttach('pistol', 'scope2')).toBe(false);
    expect(canAttach('pistol', 'reddot')).toBe(true);
    expect(recoilFactorOf({ def: WEAPONS.akm, mag: 30, att: { ...emptyAttachments(), muzzle: 'comp' } })).toBe(0.7);
  });
});
