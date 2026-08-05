import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { AabbCollider } from '../src/types';
import { World } from '../src/world';
import { doorLeafSegment } from '../src/buildings';
import { regionAt } from '../src/regions';

type Plot = {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  flatH: number;
  arch: string;
};

function createWorld(): World {
  return new World(new THREE.Scene());
}

function colliderKey(collider: AabbCollider): string {
  return [
    collider.tag,
    collider.minX, collider.minY, collider.minZ,
    collider.maxX, collider.maxY, collider.maxZ,
  ].join('|');
}

describe('地图与建筑终极几何巡检', () => {
  it('全部建筑原型都有落位且建筑安全边界互不重叠', () => {
    const world = createWorld();
    const plots = world.buildings.plots as Plot[];
    expect(new Set(plots.map((plot) => plot.arch))).toEqual(new Set([
      'cottage1', 'cottage2', 'terrace', 'apartment', 'barn', 'shop', 'gym',
    ]));

    for (let i = 0; i < plots.length; i++) {
      const a = plots[i] as Plot;
      expect(a.maxX - a.minX).toBeGreaterThan(11);
      expect(a.maxZ - a.minZ).toBeGreaterThan(10);
      for (let j = i + 1; j < plots.length; j++) {
        const b = plots[j] as Plot;
        const overlaps = a.maxX > b.minX && a.minX < b.maxX &&
          a.maxZ > b.minZ && a.minZ < b.maxZ;
        expect(overlaps, `建筑 ${i} 与 ${j} 安全边界重叠`).toBe(false);
      }
    }
  });

  it('建筑碰撞体没有完全重复且边界尺寸合法', () => {
    const world = createWorld();
    const active = world.aabbs.filter((collider) => !collider.off);
    const keys = active.map(colliderKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const collider of active) {
      expect(collider.maxX).toBeGreaterThan(collider.minX);
      expect(collider.maxY).toBeGreaterThan(collider.minY);
      expect(collider.maxZ).toBeGreaterThan(collider.minZ);
    }
  });

  it('打开的真实门扇通过世界碰撞阻挡角色', () => {
    const world = createWorld();
    const door = world.buildings.destructibles.find((item) => (
      item.kind === 'door' && item.pivot && item.doorAxis
    ));
    expect(door).toBeDefined();
    if (!door?.pivot || !door.doorAxis) return;
    world.buildings.setDoorOpen(door, true, door.cx, door.cz - 2);
    door.pivot.rotation.y = door.openAngle;
    door.collider.off = true;
    const leaf = doorLeafSegment(door.collider, door.doorAxis, door.doorHinge, door.openAngle);
    const radius = 0.38;
    const point = new THREE.Vector3(
      (leaf.hingeX + leaf.endX) * 0.5,
      door.collider.minY + 0.05,
      (leaf.hingeZ + leaf.endZ) * 0.5,
    );

    world.resolveCollision(point, radius);

    const sx = leaf.endX - leaf.hingeX;
    const sz = leaf.endZ - leaf.hingeZ;
    const projection = Math.max(0, Math.min(1,
      ((point.x - leaf.hingeX) * sx + (point.z - leaf.hingeZ) * sz) / (sx * sx + sz * sz),
    ));
    const closestX = leaf.hingeX + sx * projection;
    const closestZ = leaf.hingeZ + sz * projection;
    expect(Math.hypot(point.x - closestX, point.z - closestZ)).toBeGreaterThanOrEqual(radius + 0.049);
  });

  it('每栋建筑至少保留一个可用物资点且物资不会刷进实体', () => {
    const world = createWorld();
    const plots = world.buildings.plots as Plot[];
    const spots = world.buildings.lootSpots;
    const solid = world.aabbs.filter((collider) => (
      !collider.off && collider.tag !== 'floor' && collider.tag !== 'roof'
    ));

    for (const plot of plots) {
      expect(spots.some((spot) => (
        spot.x > plot.minX + 2 && spot.x < plot.maxX - 2 &&
        spot.z > plot.minZ + 2 && spot.z < plot.maxZ - 2
      )), `${plot.arch} 缺少室内物资点`).toBe(true);
    }
    for (const spot of spots) {
      const blocked = solid.some((collider) => {
        if (spot.y + 0.8 < collider.minY || spot.y > collider.maxY) return false;
        const dx = Math.max(collider.minX - spot.x, 0, spot.x - collider.maxX);
        const dz = Math.max(collider.minZ - spot.z, 0, spot.z - collider.maxZ);
        return dx * dx + dz * dz < 0.3 * 0.3;
      });
      expect(blocked, `物资点 ${spot.x.toFixed(2)},${spot.y.toFixed(2)},${spot.z.toFixed(2)} 与实体重叠`).toBe(false);
    }
  });

  it('磐石城垂直切片具备独立街区和样板楼细节预算', () => {
    const world = createWorld();
    expect(world.verticalSliceDetailCount).toBeGreaterThanOrEqual(50);
    expect(world.buildings.verticalSliceDetailCount).toBeGreaterThanOrEqual(70);
    const plot = world.buildings.plots[world.buildings.verticalSlicePlotIndex];
    expect(plot).toBeDefined();
    if (!plot) return;
    expect(plot.arch === 'cottage2' || plot.arch === 'terrace').toBe(true);
    expect(regionAt((plot.minX + plot.maxX) * 0.5, (plot.minZ + plot.maxZ) * 0.5)?.id).toBe('stonegate');
  });
});
