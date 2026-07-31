import { describe, expect, it } from 'vitest';
import type { Character } from '../src/character';
import {
  SQUAD_CONTACT_TTL, SQUAD_ORDER_LABELS, SquadIntelSystem, squadAimScore, squadCombatRole,
  squadCombatTarget, squadFormationTarget,
} from '../src/squadcommands';

function trackable(id: number, team: 'squad' | 'enemy', x: number, z: number): Character {
  return { id, team, alive: true, pos: { x, y: 0, z } } as unknown as Character;
}

describe('小队协同指令', () => {
  it('三名队友在目标点保持不重叠的横向队形', () => {
    expect(squadFormationTarget(10, 20, 0, 0)).toEqual({ x: 6.8, z: 18.7 });
    expect(squadFormationTarget(10, 20, 0, 1)).toEqual({ x: 10, z: 20 });
    expect(squadFormationTarget(10, 20, 0, 2)).toEqual({ x: 13.2, z: 18.7 });
  });

  it('队形会跟随玩家下令时的朝向旋转', () => {
    const left = squadFormationTarget(10, 20, Math.PI / 2, 0);
    expect(left.x).toBeCloseTo(8.7, 6);
    expect(left.z).toBeCloseTo(23.2, 6);
  });

  it('成员索引越界时会限制到有效队形槽位', () => {
    expect(squadFormationTarget(0, 0, 0, -3)).toEqual(squadFormationTarget(0, 0, 0, 0));
    expect(squadFormationTarget(0, 0, 0, 8)).toEqual(squadFormationTarget(0, 0, 0, 2));
  });

  it('四类指令都有稳定的界面文案', () => {
    expect(SQUAD_ORDER_LABELS).toEqual({
      follow: '跟随队长',
      move: '前往标记并警戒',
      hold: '原地警戒',
      focus: '集中火力',
    });
  });

  it('准星附近目标可锁定而明显偏离或身后目标会被忽略', () => {
    expect(squadAimScore(20, 20 * 20)).toBeTypeOf('number');
    expect(squadAimScore(20, 20 * 20 + 1)).toBeTypeOf('number');
    expect(squadAimScore(20, 20 * 20 + 4)).toBeNull();
    expect(squadAimScore(-2, 4)).toBeNull();
  });

  it('三名队友固定承担左侧翼, 支援和右侧翼职责', () => {
    expect([0, 1, 2].map(squadCombatRole)).toEqual(['leftFlank', 'support', 'rightFlank']);
    const left = squadCombatTarget(0, 20, 0, 0, 0, 20);
    const support = squadCombatTarget(0, 20, 0, 0, 1, 20);
    const right = squadCombatTarget(0, 20, 0, 0, 2, 20);
    expect(left.x).toBeLessThan(0);
    expect(right.x).toBeGreaterThan(0);
    expect(support.x).toBeCloseTo(0);
    expect(support.z).toBeGreaterThan(left.z);
  });

  it('队员共享接敌目标并在情报过期或目标死亡后清理', () => {
    const intel = new SquadIntelSystem();
    const observer = trackable(1, 'squad', 0, 0);
    const nearEnemy = trackable(2, 'enemy', 20, 0);
    const farEnemy = trackable(3, 'enemy', 70, 0);
    const chars = [observer, nearEnemy, farEnemy];
    intel.report(farEnemy, observer.id, 1);
    intel.report(nearEnemy, observer.id, 2);
    expect(intel.activeCount).toBe(2);
    expect(intel.bestContact(observer, 2, chars)?.targetId).toBe(nearEnemy.id);
    expect(intel.latestTarget(2, chars)).toBe(nearEnemy);
    intel.update(2 + SQUAD_CONTACT_TTL + 0.01, chars);
    expect(intel.activeCount).toBe(0);

    intel.report(nearEnemy, observer.id, 10);
    nearEnemy.alive = false;
    intel.update(10.1, chars);
    expect(intel.activeCount).toBe(0);
  });
});
