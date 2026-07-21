import { describe, expect, it } from 'vitest';
import { ARMORS, armorFromLoot, armorLootKind } from '../src/armor';
import { BASE_CAPACITY, PACKS, carryCapacity, carryWeight, packLevelFromLoot, packLootKind } from '../src/backpack';
import { DRINK_DURATION, DRINK_TOTAL, HEALS, HEAL_ORDER } from '../src/heals';

describe('局内物资与容量规则', () => {
  it('背包容量和掉落映射完整对应三级配置', () => {
    expect(carryCapacity(null)).toBe(BASE_CAPACITY);
    for (const level of [1, 2, 3] as const) {
      expect(carryCapacity({ level })).toBe(BASE_CAPACITY + PACKS[level].bonus);
      expect(packLevelFromLoot(packLootKind(level))).toBe(level);
    }
  });

  it('混合弹药恢复品和投掷物重量计算准确', () => {
    expect(carryWeight({
      ammo: { pistol: 10, rifle: 20, smg: 30, sniper: 5, shotgun: 5 },
      heals: { bandage: 4, medkit: 1, drink: 2 },
      throwables: { frag: 1, smoke: 2 },
    })).toBe(85);
  });

  it('恢复品数值和护具等级保持递进', () => {
    expect(HEAL_ORDER).toEqual(['bandage', 'medkit', 'drink']);
    expect(HEALS.bandage).toMatchObject({ heal: 15, cap: 75, cast: 2, max: 10 });
    expect(HEALS.medkit).toMatchObject({ heal: 100, cap: 100, cast: 4, max: 3 });
    expect(HEALS.drink).toMatchObject({ heal: DRINK_TOTAL, cap: 100, cast: 1.5, max: 5 });
    expect(DRINK_DURATION).toBe(20);
    for (const kind of ['helmet', 'vest'] as const) {
      const defs = [ARMORS[kind][1], ARMORS[kind][2], ARMORS[kind][3]];
      expect(defs.map((def) => def.reduce)).toEqual([0.3, 0.4, 0.55]);
      expect(defs[0].maxDurability).toBeLessThan(defs[1].maxDurability);
      expect(defs[1].maxDurability).toBeLessThan(defs[2].maxDurability);
      for (const level of [1, 2, 3] as const) {
        expect(armorFromLoot(armorLootKind(kind, level))).toEqual({ kind, level });
      }
    }
  });
});
