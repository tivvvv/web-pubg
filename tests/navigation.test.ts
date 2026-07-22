import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { findBridgeExit, findSwimBank, findVehicleRiverWaypoint } from '../src/botnav';
import {
  shouldEnterSwimming, shouldExitSwimming, SWIM_ENTER_DEPTH, SWIM_EXIT_DEPTH, SWIM_SPEED, SWIM_SPRINT_SPEED,
} from '../src/character';
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

  it('严格区分深水入水和浅滩上岸阈值', () => {
    expect(shouldEnterSwimming(SWIM_ENTER_DEPTH + 0.01, WATER_Y - 1.01, WATER_Y)).toBe(true);
    expect(shouldEnterSwimming(SWIM_ENTER_DEPTH, WATER_Y - 2, WATER_Y)).toBe(false);
    expect(shouldEnterSwimming(2, WATER_Y - 0.9, WATER_Y)).toBe(false);
    expect(shouldExitSwimming(SWIM_EXIT_DEPTH, WATER_Y - 2)).toBe(true);
    expect(shouldExitSwimming(2, WATER_Y - SWIM_EXIT_DEPTH)).toBe(true);
    expect(shouldExitSwimming(2, WATER_Y - SWIM_EXIT_DEPTH - 0.01)).toBe(false);
  });

  it('加速游泳速度明显高于普通划水', () => {
    expect(SWIM_SPRINT_SPEED).toBeGreaterThanOrEqual(SWIM_SPEED * 1.8);
  });
});

describe('桥面导航', () => {
  it('桥上角色先选择更接近原目标的桥头', () => {
    const out = new THREE.Vector2();
    expect(findBridgeExit(out, 168.5, 88, 120, 150)).toBe(true);
    expect(out.x).toBe(170);
    expect(out.y).toBeGreaterThan(88);
  });

  it('离开桥面后不再覆盖原导航目标', () => {
    const out = new THREE.Vector2();
    expect(findBridgeExit(out, 166, 88, 120, 150)).toBe(false);
  });

  it('载具跨河时依次选择桥头和对岸出口', () => {
    const out = new THREE.Vector2();
    expect(findVehicleRiverWaypoint(out, 130, 130, 210, -120)).toBe(true);
    const bridgeX = out.x;
    const bridgeZ = out.y;
    expect([-50, 170]).toContain(bridgeX);
    expect(findVehicleRiverWaypoint(out, bridgeX, bridgeZ, 210, -120)).toBe(true);
    expect(out.x).toBe(bridgeX);
    expect(out.y).toBeLessThan(bridgeZ);
    expect(findVehicleRiverWaypoint(out, 210, -120, 250, -180)).toBe(false);
  });
});
