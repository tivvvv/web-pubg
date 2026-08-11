import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BOMBARDMENT_TIMING, bombardmentEscapeVector } from '../src/bombardment';

describe('轰炸区避险方向', () => {
  it('首轮和后续轰炸保留充足搜索与转移间隔', () => {
    expect(BOMBARDMENT_TIMING.initialCooldownMin).toBeGreaterThanOrEqual(50);
    expect(BOMBARDMENT_TIMING.initialCooldownMax).toBeGreaterThan(BOMBARDMENT_TIMING.initialCooldownMin);
    expect(BOMBARDMENT_TIMING.repeatCooldownMin).toBeGreaterThanOrEqual(60);
    expect(BOMBARDMENT_TIMING.warning).toBeGreaterThanOrEqual(12);
    expect(BOMBARDMENT_TIMING.shellIntervalMin).toBeGreaterThanOrEqual(0.8);
  });

  it('区内角色获得指向圈外的单位方向', () => {
    const out = new THREE.Vector2();
    expect(bombardmentEscapeVector('warning', 10, 20, 30, 16, 28, out)).toBe(true);
    expect(out.length()).toBeCloseTo(1, 6);
    expect(out.x).toBeGreaterThan(0);
    expect(out.y).toBeGreaterThan(0);
  });

  it('中心点使用稳定方向且区外与空闲状态不触发避险', () => {
    const out = new THREE.Vector2();
    expect(bombardmentEscapeVector('active', 0, 0, 30, 0, 0, out)).toBe(true);
    expect(out.toArray()).toEqual([1, 0]);
    expect(bombardmentEscapeVector('active', 0, 0, 30, 40, 0, out)).toBe(false);
    expect(bombardmentEscapeVector('idle', 0, 0, 30, 2, 0, out)).toBe(false);
  });
});
