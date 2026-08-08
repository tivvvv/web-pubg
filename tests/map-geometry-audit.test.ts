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
        const stairPlatforms = world.platforms.filter((platform) => (
          platform.minX >= tower.minX + 2 && platform.maxX <= tower.maxX - 2 &&
          platform.minZ >= tower.minZ + 2 && platform.maxZ <= tower.maxZ - 2 &&
          platform.top > fromY + 0.02 && platform.top <= toY + 0.02
        ));
        for (const platform of stairPlatforms) {
          const x = (platform.minX + platform.maxX) * 0.5;
          const z = (platform.minZ + platform.maxZ) * 0.5;
          const overhead = world.aabbs.find((collider) => (
            !collider.off && collider.minX < x && collider.maxX > x &&
            collider.minZ < z && collider.maxZ > z &&
            collider.minY > platform.top + 0.02 && collider.minY < platform.top + 1.7
          ));
          expect(overhead, `${tower.storeys} 层高楼第 ${level + 1} 跑楼梯头顶净空不足`).toBeUndefined();
        }

        // 模拟角色沿梯段左中右三条路线连续行走。每一步都必须能吸附到下一踏步，
        // 碰撞解析后也不能被楼板边缘或护栏横向夹出梯段。
        const ordered = [...stairPlatforms].sort((a, b) => a.top - b.top);
        expect(ordered.length).toBeGreaterThanOrEqual(10);
        const stairMinX = Math.min(...ordered.map((platform) => platform.minX));
        const stairMaxX = Math.max(...ordered.map((platform) => platform.maxX));
        for (const lane of [0.24, 0.5, 0.76]) {
          let feetY = fromY;
          for (const platform of ordered) {
            const x = stairMinX + (stairMaxX - stairMinX) * lane;
            const z = (platform.minZ + platform.maxZ) * 0.5;
            const point = new THREE.Vector3(x, feetY, z);
            world.resolveCollision(point, 0.38);
            const next = world.groundHeight(point.x, point.z, feetY + 0.1);
            expect(next, `${tower.storeys} 层高楼第 ${level + 1} 跑楼梯无法连续抬步`).toBeGreaterThanOrEqual(feetY);
            expect(Math.abs(point.x - x), `${tower.storeys} 层高楼第 ${level + 1} 跑楼梯侧向卡位`).toBeLessThan(0.08);
            feetY = Math.max(feetY, next);
          }
          expect(feetY, `${tower.storeys} 层高楼第 ${level + 1} 跑楼梯未抵达上层`).toBeGreaterThan(toY - 0.36);
        }
      }
    }
  });

  it('高层正门使用宽双扇结构且铰链相向布置', () => {
    const world = createWorld();
    const towers = (world.buildings.plots as Plot[]).filter((plot) => plot.arch === 'apartment');
    for (const tower of towers) {
      const frontZ = tower.minZ + 2;
      const centerX = (tower.minX + tower.maxX) * 0.5;
      const doors = world.buildings.destructibles.filter((item) => (
        item.kind === 'door' && item.doorAxis === 'x' &&
        Math.abs(item.cz - frontZ) < 0.1 && Math.abs(item.cx - centerX) < 1.5
      ));
      expect(doors, `${tower.storeys} 层高楼正门不是双开门`).toHaveLength(2);
      expect(doors.map((door) => door.doorHinge).sort()).toEqual([-1, 1]);
      const openingWidth = Math.max(...doors.map((door) => door.collider.maxX)) -
        Math.min(...doors.map((door) => door.collider.minX));
      expect(openingWidth).toBeGreaterThanOrEqual(2.5);
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
    expect(world.grassPatchCount).toBeGreaterThanOrEqual(12000);
    expect(world.halfBushCount).toBeGreaterThanOrEqual(620);
    expect(world.tacticalRockCount).toBeGreaterThanOrEqual(64);
    expect(world.treeCount).toBeGreaterThanOrEqual(540);
    expect(world.treeVariantCount).toBe(4);
    expect(world.naturalGroundDetailCount).toBeGreaterThanOrEqual(17000);
    expect(world.shorelineDetailCount).toBeGreaterThanOrEqual(1200);
    expect(world.distantLandformCount).toBeGreaterThanOrEqual(12);
    expect(world.environmentDetailInstanceCount).toBeGreaterThanOrEqual(24000);
  });

  it('空旷地带具备微地表, 中型自然物, 人造细节和区域专属四层内容', () => {
    const world = createWorld();
    expect(world.groundMicroDetailCount).toBeGreaterThanOrEqual(3000);
    expect(world.naturalStoryPropCount).toBeGreaterThanOrEqual(140);
    expect(world.humanDetailPropCount).toBeGreaterThanOrEqual(90);
    expect(world.regionalIdentityDetailCount).toBeGreaterThanOrEqual(160);
    expect(world.assetUsage.count('map.nature.deadwood')).toBeGreaterThanOrEqual(70);
    expect(world.assetUsage.count('map.infrastructure.street-furniture')).toBeGreaterThanOrEqual(30);
    expect(world.assetUsage.count('map.landmark.regional-detail')).toBeGreaterThanOrEqual(100);
  });

  it('树木, 自然岩石和半身灌木之间没有严重穿模', () => {
    const world = createWorld();
    const trees = world.cyls.filter((collider) => collider.tag === 'tree');
    for (const rock of world.naturalRocks) {
      for (const tree of trees) {
        expect(
          Math.hypot(rock.x - tree.x, rock.z - tree.z),
          `岩石 ${rock.x.toFixed(1)},${rock.z.toFixed(1)} 与树木穿模`,
        ).toBeGreaterThanOrEqual(rock.r + tree.r - 0.02);
      }
    }
    for (const bush of world.bushes) {
      const visualRadius = bush.r / 1.5;
      for (const obstacle of [...trees, ...world.naturalRocks]) {
        expect(
          Math.hypot(bush.x - obstacle.x, bush.z - obstacle.z),
          `灌木 ${bush.x.toFixed(1)},${bush.z.toFixed(1)} 与自然掩体穿模`,
        ).toBeGreaterThanOrEqual(visualRadius + obstacle.r - 0.02);
      }
    }
  });

  it('磐石城新增可进入教堂和具备战术层次的完整广场', () => {
    const world = createWorld();
    const church = world.landmarks.find((site) => site.kind === 'church');
    expect(church).toBeDefined();
    if (!church) return;
    expect(regionAt(church.x, church.z)?.id).toBe('stonegate');
    expect(world.churchDetailCount).toBeGreaterThanOrEqual(60);
    expect(world.plazaDetailCount).toBeGreaterThanOrEqual(20);
    expect(world.fountainDetailCount).toBeGreaterThanOrEqual(15);
    expect(world.religiousCrossCount).toBe(1);

    const floorTop = world.platforms
      .filter((platform) => (
        platform.minX < church.x && platform.maxX > church.x &&
        platform.minZ < church.z - 5 && platform.maxZ > church.z - 5
      ))
      .reduce((highest, platform) => Math.max(highest, platform.top), -Infinity);
    expect(Number.isFinite(floorTop)).toBe(true);
    expect(world.navPointFree(church.x, church.z + 3.1, floorTop, 0.35, false)).toBe(true);
    expect(world.cyls.some((collider) => (
      Math.abs(collider.x - church.x) < 0.05 &&
      Math.abs(collider.z - (church.z + 14)) < 0.05 && collider.r >= 2.2
    ))).toBe(true);
    expect(world.mapLootSpots.filter((spot) => spot.siteId.startsWith('stonegate-church'))).toHaveLength(4);
    expect(world.assetUsage.count('map.landmark.church')).toBe(1);
    expect(world.assetUsage.count('map.landmark.plaza')).toBe(1);
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

  it('七种建筑原型全部接入欧式立面组件且不改变室内碰撞', () => {
    const world = createWorld();
    expect(world.buildings.assetUsage.count('building.module.european-facade')).toBe(world.buildings.plots.length);
    expect(world.buildings.europeanFacadeDetailCount).toBeGreaterThan(world.buildings.plots.length * 45);
    for (const [arch, count] of Object.entries(world.buildings.europeanFacadeDetailsByArch)) {
      expect(count, `${arch} 没有完整欧式立面`).toBeGreaterThanOrEqual(45);
    }
  });
});
