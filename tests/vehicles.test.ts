import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Character } from '../src/character';
import { seatWorldAt, Vehicle, VehicleManager, VEHICLE_SPEC } from '../src/vehicles';

describe('载具座位 命中和损毁状态', () => {
  it('按朝向计算驾驶位和乘客位世界坐标', () => {
    const vehicle = new Vehicle('car', new THREE.Vector3(10, 2, 20), Math.PI / 2);
    const driver = seatWorldAt(vehicle, 0, new THREE.Vector3());
    const passenger = seatWorldAt(vehicle, 1, new THREE.Vector3());

    expect(driver.y).toBeCloseTo(2 + VEHICLE_SPEC.car.seat[1], 6);
    expect(driver.y - vehicle.pos.y).toBeLessThan(0.3);
    expect(driver.distanceTo(passenger)).toBeCloseTo(1, 6);
    expect(driver.z).toBeGreaterThan(passenger.z);
  });

  it('三类载具都使用坐姿根节点且角色腿部进入坐姿', () => {
    for (const kind of ['car', 'moto', 'buggy'] as const) {
      expect(VEHICLE_SPEC[kind].seat[1]).toBeGreaterThanOrEqual(0.05);
      expect(VEHICLE_SPEC[kind].seat[1]).toBeLessThan(0.3);
    }
    const seated = new Character('乘员', true, 0x3a6ea5);
    seated.airPose = 'sit';
    seated.syncModel(1, false);

    expect(seated.parts.inner.position.y).toBeCloseTo(0, 5);
    expect(seated.parts.legL.rotation.x).toBeLessThan(-1.2);
    expect(seated.parts.legR.rotation.x).toBeLessThan(-1.2);
  });

  it('最近载具查询忽略已占用和已损毁载具', () => {
    const manager = new VehicleManager(new THREE.Scene());
    const near = new Vehicle('moto', new THREE.Vector3(2, 0, 0), 0);
    const far = new Vehicle('buggy', new THREE.Vector3(7, 0, 0), 0);
    manager.list.push(near, far);

    expect(manager.nearest(0, 0, 10)).toBe(near);
    near.driver = new Character('司机', true, 0x3a6ea5);
    expect(manager.nearest(0, 0, 10)).toBe(far);
    near.driver = null;
    near.dead = true;
    far.dead = true;
    expect(manager.nearest(0, 0, 10)).toBeNull();
  });

  it('燃烧倒计时中的载具不可再驾驶或认领', () => {
    const manager = new VehicleManager(new THREE.Scene());
    const burning = new Vehicle('car', new THREE.Vector3(2, 0, 0), 0);
    const safe = new Vehicle('buggy', new THREE.Vector3(7, 0, 0), 0);
    const claimant = new Character('驾驶员', false, 0x3a6ea5);
    burning.burnT = 1.5;
    manager.list.push(burning, safe);

    expect(manager.nearest(0, 0, 10)).toBe(safe);
    expect(manager.nearestClaimable(0, 0, 10, claimant)).toBe(safe);
  });

  it('机器人认领载具后其他机器人选择下一辆车', () => {
    const manager = new VehicleManager(new THREE.Scene());
    const near = new Vehicle('car', new THREE.Vector3(3, 0, 0), 0);
    const far = new Vehicle('buggy', new THREE.Vector3(8, 0, 0), 0);
    const first = new Character('甲', false, 0x3a6ea5);
    const second = new Character('乙', false, 0x3a6ea5);
    manager.list.push(near, far);

    expect(manager.nearestClaimable(0, 0, 12, first)).toBe(near);
    near.claimedBy = first;
    expect(manager.nearestClaimable(0, 0, 12, first)).toBe(near);
    expect(manager.nearestClaimable(0, 0, 12, second)).toBe(far);
    first.alive = false;
    expect(manager.nearestClaimable(0, 0, 12, second)).toBe(near);
  });

  it('射线命中车体且致命伤进入燃烧倒计时', () => {
    const manager = new VehicleManager(new THREE.Scene());
    const vehicle = new Vehicle('car', new THREE.Vector3(0, 0, 0), 0);
    manager.list.push(vehicle);
    const hit = manager.raycast(new THREE.Vector3(0, 0.8, -6), new THREE.Vector3(0, 0, 1), 20);

    expect(hit?.v).toBe(vehicle);
    expect(hit?.t).toBeGreaterThan(4);
    manager.damage(vehicle, VEHICLE_SPEC.car.hp + 1);
    expect(vehicle.hp).toBe(0);
    expect(vehicle.burnT).toBe(2);
    expect(vehicle.dead).toBe(false);
  });
});
