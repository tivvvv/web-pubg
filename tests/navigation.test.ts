import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { findSwimBank } from '../src/botnav';
import { WATER_Y } from '../src/world';

describe('游泳上岸点搜索', () => {
  it('优先寻找移动方向上的可站立岸点', () => {
    const world = {
      getHeight: (_x: number, z: number) => z >= 8 ? WATER_Y - 0.1 : WATER_Y - 2,
      pointFree: () => true,
    };
    const out = new THREE.Vector2();
    expect(findSwimBank(out, 0, 0, 0, 30, world)).toBe(true);
    expect(out.y).toBeGreaterThanOrEqual(8);
  });

  it('无合法岸点时仍返回稳定的探索方向', () => {
    const world = {
      getHeight: () => WATER_Y - 4,
      pointFree: () => false,
    };
    const out = new THREE.Vector2();
    expect(findSwimBank(out, 0, 0, 20, 0, world)).toBe(false);
    expect(out.x).toBeGreaterThan(0);
  });
});
