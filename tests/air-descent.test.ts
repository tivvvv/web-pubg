import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CANOPY_DEPLOY_VELOCITY, moveAirDescentHorizontal, stepAirDescentVelocity } from '../src/character';
import { World } from '../src/world';

function simulate(vy: number, phase: 'freefall' | 'canopy', seconds: number, step = 1 / 60): number {
  for (let elapsed = 0; elapsed < seconds; elapsed += step) {
    vy = stepAirDescentVelocity(vy, phase, step);
  }
  return vy;
}

describe('共享空降垂直物理', () => {
  it('自由落体稳定逼近终端速度且不会越界', () => {
    const afterTenSeconds = simulate(-2, 'freefall', 10);
    expect(afterTenSeconds).toBeGreaterThanOrEqual(-55);
    expect(afterTenSeconds).toBeLessThan(-54.9);
  });

  it('开伞速度平滑稳定到低速终端值', () => {
    const afterThreeSeconds = simulate(CANOPY_DEPLOY_VELOCITY, 'canopy', 3);
    expect(afterThreeSeconds).toBeGreaterThanOrEqual(-10);
    expect(afterThreeSeconds).toBeLessThan(-9.99);
  });

  it('不同帧率下结果保持一致', () => {
    const at30 = simulate(-2, 'freefall', 4, 1 / 30);
    const at144 = simulate(-2, 'freefall', 4, 1 / 144);
    expect(Math.abs(at30 - at144)).toBeLessThan(0.05);
  });

  it('空降水平位移不会穿过建筑薄墙', () => {
    const world = new World(new THREE.Scene());
    world.addCollider({
      kind: 'aabb', minX: 0, minY: 0, minZ: -2,
      maxX: 0.24, maxY: 8, maxZ: 2, tag: 'wall',
    });
    const position = new THREE.Vector3(-1.2, 1, 0);

    expect(moveAirDescentHorizontal(position, 3, 0, 0.42, world)).toBe(true);
    expect(position.x).toBeLessThanOrEqual(-0.419);
    expect(Math.abs(position.z)).toBeLessThan(0.001);
  });

  it('无障碍空降位移保持原始方向和距离', () => {
    const world = new World(new THREE.Scene());
    const position = new THREE.Vector3(2, 12, -3);

    expect(moveAirDescentHorizontal(position, 1.5, -0.75, 0.72, world)).toBe(false);
    expect(position.x).toBeCloseTo(3.5, 6);
    expect(position.z).toBeCloseTo(-3.75, 6);
  });
});
