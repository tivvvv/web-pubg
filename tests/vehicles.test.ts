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
    expect(driver.distanceTo(passenger)).toBeCloseTo(1, 6);
    expect(driver.z).toBeGreaterThan(passenger.z);
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
