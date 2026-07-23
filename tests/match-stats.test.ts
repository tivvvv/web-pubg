import { describe, expect, it } from 'vitest';
import { accumulatePlayerDamage } from '../src/game';

describe('对局伤害统计', () => {
  it('在胜利结算前计入玩家最后一击的实际伤害', () => {
    expect(accumulatePlayerDamage(86, 10, true, false)).toBe(96);
  });

  it('不计入敌人伤害和玩家自身伤害', () => {
    expect(accumulatePlayerDamage(42, 20, false, false)).toBe(42);
    expect(accumulatePlayerDamage(42, 20, true, true)).toBe(42);
  });
});
