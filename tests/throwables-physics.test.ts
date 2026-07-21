import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { stepProjectile } from '../src/throwables';
import type { World } from '../src/world';

function mockWorld(height = 0): World {
  return {
    aabbs: [],
    cyls: [],
    getHeight: () => height,
  } as unknown as World;
}

describe('投掷物共享物理', () => {
  it('空中推进应用重力且不误报碰撞', () => {
    const world = mockWorld(-100);
    const pos = new THREE.Vector3(0, 10, 0);
    const vel = new THREE.Vector3(2, 3, -1);
    expect(stepProjectile(world, pos, vel, 0.1)).toBe(false);
    expect(vel.x).toBeCloseTo(2, 8);
    expect(vel.y).toBeCloseTo(0.8, 8);
    expect(vel.z).toBeCloseTo(-1, 8);
    expect(pos.x).toBeCloseTo(0.2, 8);
    expect(pos.y).toBeCloseTo(10.08, 8);
    expect(pos.z).toBeCloseTo(-0.1, 8);
  });

  it('接触地形后抬离表面并向上反弹', () => {
    const world = mockWorld(0);
    const pos = new THREE.Vector3(0, 0.05, 0);
    const vel = new THREE.Vector3(1, -1, 0);
    expect(stepProjectile(world, pos, vel, 0.1)).toBe(true);
    expect(pos.y).toBeCloseTo(0.04, 8);
    expect(vel.y).toBeGreaterThan(0);
    expect(Math.abs(vel.x)).toBeLessThan(1);
  });

  it('墙体和圆柱碰撞将弹体推出并反射速度', () => {
    const wallWorld = mockWorld(-100);
    wallWorld.aabbs.push({
      kind: 'aabb', tag: 'wall', minX: 0, maxX: 1, minY: 0, maxY: 2, minZ: 0, maxZ: 1,
    });
    const wallPos = new THREE.Vector3(-0.1, 1, 0.5);
    const wallVel = new THREE.Vector3(2, 0, 0);
    expect(stepProjectile(wallWorld, wallPos, wallVel, 0.1)).toBe(true);
    expect(wallPos.x).toBeCloseTo(-0.04, 8);
    expect(wallVel.x).toBeLessThan(0);

    const cylinderWorld = mockWorld(-100);
    cylinderWorld.cyls.push({ kind: 'cyl', tag: 'tree', x: 0, z: 0, r: 0.5, y0: 0, y1: 2 });
    const cylinderPos = new THREE.Vector3(-0.6, 1, 0);
    const cylinderVel = new THREE.Vector3(2, 0, 0);
    expect(stepProjectile(cylinderWorld, cylinderPos, cylinderVel, 0.1)).toBe(true);
    expect(cylinderPos.x).toBeCloseTo(-0.54, 8);
    expect(cylinderVel.x).toBeLessThan(0);
  });
});
