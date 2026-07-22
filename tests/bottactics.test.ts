import { describe, expect, it } from 'vitest';
import { emptyAttachments } from '../src/attachments';
import {
  chooseCombatMode,
  chooseStrategicMode,
  preferredCombatRange,
  selectCombatGunSlot,
  shouldDeploySmoke,
  shouldExitVehicle,
  shouldSeekVehicle,
  shouldTacticalReload,
  zoneRotationUrgency,
} from '../src/bottactics';
import type { AmmoType, GunState } from '../src/types';
import { WEAPONS } from '../src/weapons';

const ammo = (overrides: Partial<Record<AmmoType, number>> = {}): Record<AmmoType, number> => ({
  pistol: 0,
  rifle: 0,
  smg: 0,
  sniper: 0,
  shotgun: 0,
  ...overrides,
});

const gun = (id: keyof typeof WEAPONS, mag: number): GunState => ({
  def: WEAPONS[id],
  mag,
  att: emptyAttachments(),
});

describe('机器人战术决策', () => {
  it('根据当前圈, 缩圈阶段和路程预留转移时间', () => {
    expect(zoneRotationUrgency({ outsideCurrent: true, distanceOutsideNext: 0, state: 'wait', timer: 80 }))
      .toBe('immediate');
    expect(zoneRotationUrgency({ outsideCurrent: false, distanceOutsideNext: 30, state: 'shrink', timer: 20 }))
      .toBe('immediate');
    expect(zoneRotationUrgency({ outsideCurrent: false, distanceOutsideNext: 104, state: 'wait', timer: 24 }))
      .toBe('prepare');
    expect(zoneRotationUrgency({ outsideCurrent: false, distanceOutsideNext: 104, state: 'wait', timer: 60 }))
      .toBe('none');
    expect(zoneRotationUrgency({ outsideCurrent: false, distanceOutsideNext: 2, state: 'done', timer: 0 }))
      .toBe('none');
    expect(zoneRotationUrgency({ outsideCurrent: false, distanceOutsideNext: 0, state: 'done', timer: 0 }))
      .toBe('none');
  });

  it('战略循环优先处理跑圈, 恢复和战后舔盒', () => {
    const base = {
      rotation: 'none' as const,
      hp: 100,
      hasHeal: false,
      hasGun: true,
      hasAmmo: true,
      needsGear: false,
      recentThreat: false,
      postCombat: false,
    };
    expect(chooseStrategicMode({ ...base, rotation: 'prepare', hp: 30, hasHeal: true })).toBe('rotate');
    expect(chooseStrategicMode({ ...base, hp: 40, hasHeal: true, postCombat: true })).toBe('recover');
    expect(chooseStrategicMode({ ...base, postCombat: true, recentThreat: true })).toBe('postcombat');
    expect(chooseStrategicMode({ ...base, recentThreat: true, needsGear: true })).toBe('hunt');
    expect(chooseStrategicMode({ ...base, hasAmmo: false })).toBe('loot');
    expect(chooseStrategicMode(base)).toBe('patrol');
  });

  it('战斗状态可切换转移, 掩体, 搜索, 进攻和后撤', () => {
    const base = {
      rotation: 'none' as const,
      hp: 100,
      reloading: false,
      hasLineOfSight: true,
      coverAvailable: false,
      meleeOnly: false,
      distance: 32,
      preferredRange: 32,
    };
    expect(chooseCombatMode({ ...base, rotation: 'immediate' })).toBe('rotate');
    expect(chooseCombatMode({ ...base, rotation: 'prepare', hasLineOfSight: false })).toBe('rotate');
    expect(chooseCombatMode({ ...base, reloading: true, coverAvailable: true })).toBe('cover');
    expect(chooseCombatMode({ ...base, hp: 22 })).toBe('retreat');
    expect(chooseCombatMode({ ...base, hasLineOfSight: false })).toBe('search');
    expect(chooseCombatMode({ ...base, meleeOnly: true })).toBe('advance');
    expect(chooseCombatMode({ ...base, distance: 50 })).toBe('advance');
    expect(chooseCombatMode({ ...base, distance: 12 })).toBe('retreat');
    expect(chooseCombatMode(base)).toBe('strafe');
  });

  it('按战斗距离选择武器而不只比品级', () => {
    const guns = [gun('shotgun', 2), gun('sniper', 5), null];
    expect(selectCombatGunSlot(guns, ammo(), 8)).toBe(0);
    expect(selectCombatGunSlot(guns, ammo(), 72)).toBe(1);
    expect(preferredCombatRange('smg')).toBeLessThan(preferredCombatRange('dmr'));
    expect(selectCombatGunSlot([gun('rifle', 0), null, null], ammo(), 30)).toBe(-1);
  });

  it('仅在弹量低且安全时战术换弹', () => {
    const rifle = gun('rifle', 12);
    expect(shouldTacticalReload(rifle, 30, true, true)).toBe(false);
    expect(shouldTacticalReload(rifle, 30, true, false)).toBe(true);
    expect(shouldTacticalReload({ ...rifle, mag: 20 }, 30, false, false)).toBe(false);
    expect(shouldTacticalReload({ ...rifle, mag: 0 }, 30, true, true)).toBe(true);
    expect(shouldTacticalReload(rifle, 0, false, false)).toBe(false);
  });

  it('在暴露的危急后撤和跑圈阶段使用烟雾弹', () => {
    const base = {
      hasSmoke: true,
      alreadyUsed: false,
      hp: 100,
      reloading: false,
      rotation: 'none' as const,
      hasLineOfSight: true,
      distance: 28,
    };
    expect(shouldDeploySmoke({ ...base, hp: 30 })).toBe(true);
    expect(shouldDeploySmoke({ ...base, reloading: true })).toBe(true);
    expect(shouldDeploySmoke({ ...base, rotation: 'immediate' })).toBe(true);
    expect(shouldDeploySmoke({ ...base, hasLineOfSight: false, hp: 30 })).toBe(false);
    expect(shouldDeploySmoke({ ...base, alreadyUsed: true, hp: 30 })).toBe(false);
    expect(shouldDeploySmoke({ ...base, distance: 6, hp: 30 })).toBe(false);
  });

  it('仅为长距离转移或追击寻找附近载具', () => {
    const base = {
      mode: 'rotate' as const,
      rotation: 'prepare' as const,
      goalDistance: 90,
      vehicleDistance: 24,
      hp: 100,
      hasUsableGun: true,
      cooldown: 0,
    };
    expect(shouldSeekVehicle(base)).toBe(true);
    expect(shouldSeekVehicle({ ...base, goalDistance: 30 })).toBe(false);
    expect(shouldSeekVehicle({ ...base, vehicleDistance: 50 })).toBe(false);
    expect(shouldSeekVehicle({ ...base, hp: 25 })).toBe(false);
    expect(shouldSeekVehicle({ ...base, mode: 'loot' })).toBe(false);
    expect(shouldSeekVehicle({ ...base, mode: 'hunt', rotation: 'none', goalDistance: 110 })).toBe(true);
  });

  it('到点接敌车况危险或持续卡住时下车', () => {
    const base = {
      goalDistance: 80,
      enemyDistance: Infinity,
      hpFraction: 1,
      stuckFor: 0,
      burning: false,
    };
    expect(shouldExitVehicle(base)).toBe(false);
    expect(shouldExitVehicle({ ...base, goalDistance: 8 })).toBe(true);
    expect(shouldExitVehicle({ ...base, enemyDistance: 40 })).toBe(true);
    expect(shouldExitVehicle({ ...base, hpFraction: 0.2 })).toBe(true);
    expect(shouldExitVehicle({ ...base, stuckFor: 7 })).toBe(true);
    expect(shouldExitVehicle({ ...base, burning: true })).toBe(true);
  });
});
