import { describe, expect, it } from 'vitest';
import { emptyAttachments } from '../src/attachments';
import {
  calculateRecoilImpulse, calculateWeaponSpread, reloadDuration, scopeModeOf, smoothAimProgress,
  WEAPON_RECOIL,
} from '../src/gunplay';
import { WEAPONS } from '../src/weapons';

const rifle = { def: WEAPONS.rifle, mag: 30, att: emptyAttachments() };

describe('枪械操控模型', () => {
  it('ADS 逐步进入且帧率变化不会明显改变耗时', () => {
    let at60 = 0;
    let at30 = 0;
    for (let i = 0; i < 30; i++) at60 = smoothAimProgress(at60, true, 'rifle', 1 / 60);
    for (let i = 0; i < 15; i++) at30 = smoothAimProgress(at30, true, 'rifle', 1 / 30);
    expect(at60).toBeGreaterThan(0.98);
    expect(Math.abs(at60 - at30)).toBeLessThan(0.001);
  });

  it('蹲姿 ADS 静止散布小于站立腰射移动散布', () => {
    const stable = calculateWeaponSpread({
      gun: rifle, aimProgress: 1, stance: 'crouch', speed: 0, grounded: true, bloom: 0,
    });
    const moving = calculateWeaponSpread({
      gun: rifle, aimProgress: 0, stance: 'stand', speed: 6.9, grounded: true, bloom: 0,
    });
    expect(stable).toBeLessThan(moving * 0.2);
  });

  it('每种瞄具在完成 ADS 后返回独立模式', () => {
    expect(scopeModeOf({ ...rifle, att: { ...emptyAttachments(), sight: 'reddot' } }, 1)).toBe('reddot');
    expect(scopeModeOf({ ...rifle, att: { ...emptyAttachments(), sight: 'scope2' } }, 1)).toBe('scope2');
    expect(scopeModeOf({ ...rifle, att: { ...emptyAttachments(), sight: 'scope4' } }, 1)).toBe('scope4');
    expect(scopeModeOf(rifle, 0.5)).toBe('none');
  });

  it('连续后坐遵循稳定横向骨架且补偿器和姿态真实生效', () => {
    const out = { vertical: 0, horizontal: 0, bloom: 0, gunKick: 0 };
    const standing = { ...calculateRecoilImpulse(out, rifle, 1, 'stand', 2, 0) };
    const leftStep = { ...calculateRecoilImpulse(out, rifle, 1, 'stand', 1, 0) };
    const prone = { ...calculateRecoilImpulse(out, rifle, 1, 'prone', 2, 0) };
    const compensated = {
      def: WEAPONS.rifle,
      mag: 30,
      att: { ...emptyAttachments(), muzzle: 'comp' as const },
    };
    const compensatedKick = { ...calculateRecoilImpulse(out, compensated, 1, 'stand', 2, 0) };

    expect(standing.horizontal).toBeGreaterThan(0);
    expect(leftStep.horizontal).toBeLessThan(0);
    expect(prone.vertical).toBeLessThan(standing.vertical);
    expect(compensatedKick.vertical).toBeCloseTo(standing.vertical * 0.7, 8);
    expect(compensatedKick.horizontal).toBeCloseTo(standing.horizontal * 0.7, 8);
  });

  it('空仓换弹慢于战术换弹且扩容弹匣增加操作时间', () => {
    const normal = { def: WEAPONS.rifle, mag: 12, att: emptyAttachments() };
    const extended = {
      def: WEAPONS.rifle,
      mag: 0,
      att: { ...emptyAttachments(), mag: 'extmag' as const },
    };
    expect(reloadDuration(normal, false)).toBeLessThan(reloadDuration(normal, true));
    expect(reloadDuration(extended, true)).toBeGreaterThan(reloadDuration(normal, true));
    expect(reloadDuration(
      { def: WEAPONS.shotgun, mag: 0, att: emptyAttachments() },
      true,
    )).toBe(WEAPONS.shotgun.reloadTime);
  });

  it('每种枪械都有独立且有效的后坐恢复参数', () => {
    for (const profile of Object.values(WEAPON_RECOIL)) {
      expect(profile.pitchRecovery).toBeGreaterThan(0);
      expect(profile.yawRecovery).toBeGreaterThan(0);
      expect(profile.bloomRecovery).toBeGreaterThan(0);
    }
    expect(WEAPON_RECOIL.smg.pitchRecovery).toBeGreaterThan(WEAPON_RECOIL.akm.pitchRecovery);
    expect(WEAPON_RECOIL.sniper.gunKick).toBeGreaterThan(WEAPON_RECOIL.pistol.gunKick);
  });
});
