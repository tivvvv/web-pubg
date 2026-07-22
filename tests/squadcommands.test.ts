import { describe, expect, it } from 'vitest';
import { SQUAD_ORDER_LABELS, squadAimScore, squadFormationTarget } from '../src/squadcommands';

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
});
