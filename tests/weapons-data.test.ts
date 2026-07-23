import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  AMMO_BOX, AMMO_LOOT_KIND, MELEE, WEAPONS, ammoTypeFromLoot, applySpread, pelletFalloff,
  weaponMaxRange,
} from '../src/weapons';

describe('武器数据与弹道边界', () => {
  it('全部枪械拥有可用弹匣射速散布和弹药映射', () => {
    for (const def of Object.values(WEAPONS)) {
      expect(def.damage).toBeGreaterThan(0);
      expect(def.fireInterval).toBeGreaterThan(0);
      expect(def.magSize).toBeGreaterThan(0);
      expect(def.spreadAim).toBeLessThanOrEqual(def.spreadHip);
      expect(AMMO_BOX[def.ammo]).toBeGreaterThan(0);
      expect(ammoTypeFromLoot(AMMO_LOOT_KIND[def.ammo])).toBe(def.ammo);
    }
    for (const def of Object.values(MELEE)) {
      expect(def.cooldown).toBeGreaterThanOrEqual(0.45);
      expect(def.range).toBeGreaterThan(2);
    }
  });

  it('全部枪械的距离衰减连续单调且射程边界一致', () => {
    for (const def of Object.values(WEAPONS)) {
      const [full, min, minFactor, zero] = def.falloff as [number, number, number, number];
      expect(full).toBeGreaterThan(0);
      expect(min).toBeGreaterThan(full);
      expect(zero).toBeGreaterThan(min);
      expect(weaponMaxRange(def)).toBe(zero);
      expect(pelletFalloff(def, full)).toBe(1);
      expect(pelletFalloff(def, min)).toBeCloseTo(minFactor, 8);
      expect(pelletFalloff(def, zero)).toBe(0);
      let previous = 1;
      for (let distance = full; distance <= zero; distance += (zero - full) / 20) {
        const factor = pelletFalloff(def, distance);
        expect(factor).toBeLessThanOrEqual(previous + 1e-10);
        expect(factor).toBeGreaterThanOrEqual(0);
        previous = factor;
      }
    }
    expect(pelletFalloff(WEAPONS.smg, 120)).toBeLessThan(pelletFalloff(WEAPONS.rifle, 120));
    expect(pelletFalloff(WEAPONS.sniper, 250)).toBeGreaterThan(pelletFalloff(WEAPONS.rifle, 250));
  });

  it('散布保持单位向量且零散布不改变方向', () => {
    const base = new THREE.Vector3(0.2, 0.1, 0.97).normalize();
    const zero = base.clone();
    expect(applySpread(zero, 0, new THREE.Vector3())).toBe(zero);
    expect(zero.distanceTo(base)).toBe(0);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const spread = applySpread(base.clone(), 0.02, new THREE.Vector3());
    expect(spread.length()).toBeCloseTo(1, 10);
    expect(spread.angleTo(base)).toBeLessThanOrEqual(0.021);
    vi.restoreAllMocks();
  });
});
