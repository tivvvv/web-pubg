import { describe, expect, it } from 'vitest';
import { canAttach, emptyAttachments, magSizeOf, recoilFactorOf, sightZoomOf } from '../src/attachments';
import { WEAPONS } from '../src/weapons';

describe('武器配件规则', () => {
  it('扩容弹匣按枪型增加正确容量', () => {
    expect(magSizeOf({ def: WEAPONS.rifle, mag: 30, att: { ...emptyAttachments(), mag: 'extmag' } })).toBe(40);
    expect(magSizeOf({ def: WEAPONS.sniper, mag: 5, att: { ...emptyAttachments(), mag: 'extmag' } })).toBe(7);
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
