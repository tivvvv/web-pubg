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
  storeys?: number;
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

  it('磐石城拥有两栋不同高度且屋顶可达的高层建筑', () => {
    const world = createWorld();
    const towers = (world.buildings.plots as Plot[])
      .filter((plot) => plot.arch === 'apartment')
      .sort((a, b) => (b.storeys ?? 0) - (a.storeys ?? 0));
    expect(towers).toHaveLength(2);
    expect(towers.map((plot) => plot.storeys)).toEqual([7, 6]);
    for (const tower of towers) {
      const centerX = (tower.minX + tower.maxX) * 0.5;
      const firstFloorY = tower.flatH + 0.28;
      const roofY = tower.flatH + 0.28 + (tower.storeys ?? 0) * (2.9 + 0.24);
      const roofPlatforms = world.aabbs.filter((collider) => (
        collider.tag === 'floor' && Math.abs(collider.maxY - roofY) < 0.05 &&
        collider.minX < centerX && collider.maxX > centerX
      ));
      expect(roofPlatforms.length, `${tower.storeys} 层高楼缺少可站立屋顶`).toBeGreaterThan(0);
      expect(world.buildings.lootSpots.some((spot) => (
        spot.x > tower.minX + 2 && spot.x < tower.maxX - 2 &&
        spot.z > tower.minZ + 2 && spot.z < tower.maxZ - 2 &&
        Math.abs(spot.y - roofY) < 0.05
      )), `${tower.storeys} 层高楼屋顶缺少物资`).toBe(true);
      for (let level = 0; level < (tower.storeys ?? 0); level++) {
        const fromY = firstFloorY + level * (2.9 + 0.24);
        const toY = fromY + 2.9 + 0.24;
        const stairTops = new Set(world.platforms.filter((platform) => (
          platform.minX >= tower.minX + 2 && platform.maxX <= tower.maxX - 2 &&
          platform.minZ >= tower.minZ + 2 && platform.maxZ <= tower.maxZ - 2 &&
          platform.top > fromY + 0.02 && platform.top <= toY + 0.02
        )).map((platform) => platform.top.toFixed(3)));
        expect(stairTops.size, `${tower.storeys} 层高楼第 ${level + 1} 跑楼梯不连续`).toBeGreaterThanOrEqual(9);
      }
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
      const supportY = world.groundHeight(spot.x, spot.z, spot.y + 0.18);
      expect(Math.abs(supportY - spot.y),
        `物资点 ${spot.x.toFixed(2)},${spot.y.toFixed(2)},${spot.z.toFixed(2)} 缺少承托面`).toBeLessThan(0.08);
    }
  });

  it('磐石城垂直切片具备独立街区和样板楼细节预算', () => {
    const world = createWorld();
    expect(world.verticalSliceDetailCount).toBeGreaterThanOrEqual(100);
    expect(world.buildings.verticalSliceDetailCount).toBeGreaterThanOrEqual(120);
    const plot = world.buildings.plots[world.buildings.verticalSlicePlotIndex];
    expect(plot).toBeDefined();
    if (!plot) return;
    expect(plot.arch === 'cottage2' || plot.arch === 'terrace').toBe(true);
    expect(regionAt((plot.minX + plot.maxX) * 0.5, (plot.minZ + plot.maxZ) * 0.5)?.id).toBe('stonegate');
  });

  it('自然环境具备完整地表生态, 岸线和远景层次预算', () => {
    const world = createWorld();
    expect(world.naturalGroundDetailCount).toBeGreaterThanOrEqual(1800);
    expect(world.shorelineDetailCount).toBeGreaterThanOrEqual(1200);
    expect(world.distantLandformCount).toBeGreaterThanOrEqual(12);
    expect(world.environmentDetailInstanceCount).toBeGreaterThanOrEqual(6000);
  });

  it('地图和建筑生成结果均登记到可审计资产目录', () => {
    const world = createWorld();
    expect(world.assetUsage.uniqueCount).toBeGreaterThanOrEqual(15);
    expect(world.assetUsage.totalInstances).toBeGreaterThanOrEqual(5000);
    expect(world.assetUsage.count('map.infrastructure.bridge')).toBe(2);
    expect(world.assetUsage.count('map.landmark.region-site')).toBe(6);
    expect(world.buildings.assetUsage.uniqueCount).toBeGreaterThanOrEqual(20);
    expect(world.buildings.assetUsage.totalInstances).toBeGreaterThan(world.buildings.plots.length * 6);
  });
});
