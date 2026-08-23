import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { AabbCollider } from '../src/types';
import { ROAD_PATHS, riverZAt, WATER_Y, World } from '../src/world';
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

function interiorPointFree(
  x: number,
  z: number,
  feetY: number,
  colliders: AabbCollider[],
  ignored: Set<AabbCollider>,
): boolean {
  const radius = 0.38;
  return !colliders.some((collider) => {
    if (
      collider.off || ignored.has(collider) || collider.tag === 'floor' || collider.tag === 'roof' ||
      feetY + 1.7 <= collider.minY || feetY + 0.04 >= collider.maxY
    ) return false;
    const dx = Math.max(collider.minX - x, 0, x - collider.maxX);
    const dz = Math.max(collider.minZ - z, 0, z - collider.maxZ);
    return dx * dx + dz * dz < radius * radius;
  });
}

function interiorRouteExists(
  plot: Plot,
  feetY: number,
  start: { x: number; z: number },
  target: { x: number; z: number },
  colliders: AabbCollider[],
  ignored: Set<AabbCollider>,
): boolean {
  const step = 0.38;
  const minX = plot.minX + 2 + 0.42;
  const maxX = plot.maxX - 2 - 0.42;
  const minZ = plot.minZ + 2 + 0.42;
  const maxZ = plot.maxZ - 2 - 0.42;
  const columns = Math.floor((maxX - minX) / step) + 1;
  const rows = Math.floor((maxZ - minZ) / step) + 1;
  const free = new Uint8Array(columns * rows);
  const index = (column: number, row: number) => row * columns + column;
  const point = (column: number, row: number) => ({ x: minX + column * step, z: minZ + row * step });
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const p = point(column, row);
    free[index(column, row)] = interiorPointFree(p.x, p.z, feetY, colliders, ignored) ? 1 : 0;
  }
  const nearest = (requested: { x: number; z: number }): number => {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      const i = index(column, row);
      if (!free[i]) continue;
      const p = point(column, row);
      const distance = Math.hypot(p.x - requested.x, p.z - requested.z);
      if (distance < bestDistance && distance <= 1.1) {
        best = i;
        bestDistance = distance;
      }
    }
    return best;
  };
  const startIndex = nearest(start);
  const targetIndex = nearest(target);
  if (startIndex < 0 || targetIndex < 0) return false;
  const visited = new Uint8Array(free.length);
  const queue = new Int32Array(free.length);
  let head = 0;
  let tail = 0;
  queue[tail++] = startIndex;
  visited[startIndex] = 1;
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  while (head < tail) {
    const current = queue[head++] as number;
    if (current === targetIndex) return true;
    const column = current % columns;
    const row = Math.floor(current / columns);
    for (const [dx, dz] of directions) {
      const nextColumn = column + dx;
      const nextRow = row + dz;
      if (nextColumn < 0 || nextColumn >= columns || nextRow < 0 || nextRow >= rows) continue;
      const next = index(nextColumn, nextRow);
      if (!free[next] || visited[next]) continue;
      visited[next] = 1;
      queue[tail++] = next;
    }
  }
  return false;
}

describe('地图与建筑终极几何巡检', () => {
  it('全地图每个五米网格都能返回有限的地形高度和坡度', () => {
    const world = createWorld();
    for (let z = -350; z <= 350; z += 5) {
      for (let x = -350; x <= 350; x += 5) {
        const height = world.getHeight(x, z);
        const slope = world.slopeAt(x, z);
        expect(Number.isFinite(height), `地形 ${x},${z} 返回非有限高度`).toBe(true);
        expect(Number.isFinite(slope), `地形 ${x},${z} 返回非有限坡度`).toBe(true);
        expect(height, `地形 ${x},${z} 低于地图允许范围`).toBeGreaterThanOrEqual(-7);
        expect(height, `地形 ${x},${z} 高于地图允许范围`).toBeLessThanOrEqual(17);
        expect(slope, `地形 ${x},${z} 返回负坡度`).toBeGreaterThanOrEqual(0);
      }
    }
  });

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

  it('全地图静态阻挡体尺寸合法且全部进入导航阻挡索引', () => {
    const world = createWorld();
    expect(world.colliders.length).toBe(world.cyls.length + world.aabbs.length);
    const radius = 0.38;
    for (const [index, collider] of world.cyls.entries()) {
      expect(
        [collider.x, collider.z, collider.r, collider.y0, collider.y1].every(Number.isFinite),
        `圆柱碰撞 ${index} 含非有限数值`,
      ).toBe(true);
      expect(collider.r, `圆柱碰撞 ${index} 半径无效`).toBeGreaterThan(0);
      expect(collider.y1, `圆柱碰撞 ${index} 高度无效`).toBeGreaterThan(collider.y0);
      const feetY = Math.max(world.getHeight(collider.x, collider.z), collider.y0);
      expect(
        world.navPointFree(collider.x, collider.z, feetY, radius, false),
        `圆柱碰撞 ${index} (${collider.x.toFixed(2)},${collider.z.toFixed(2)},r=${collider.r.toFixed(2)}) 未阻挡导航`,
      ).toBe(false);
    }

    for (const [index, collider] of world.aabbs.entries()) {
      expect(
        [collider.minX, collider.minY, collider.minZ, collider.maxX, collider.maxY, collider.maxZ]
          .every(Number.isFinite),
        `盒碰撞 ${index} 含非有限数值`,
      ).toBe(true);
      expect(collider.maxX, `盒碰撞 ${index} X 尺寸无效`).toBeGreaterThan(collider.minX);
      expect(collider.maxY, `盒碰撞 ${index} Y 尺寸无效`).toBeGreaterThan(collider.minY);
      expect(collider.maxZ, `盒碰撞 ${index} Z 尺寸无效`).toBeGreaterThan(collider.minZ);
      if (collider.off || collider.tag === 'floor' || collider.tag === 'roof' || collider.tag === 'door') continue;
      const centerX = (collider.minX + collider.maxX) * 0.5;
      const centerZ = (collider.minZ + collider.maxZ) * 0.5;
      const feetY = Math.max(world.getHeight(centerX, centerZ), collider.minY);
      if (feetY >= collider.maxY - 0.02) continue;
      const standY = world.groundHeight(centerX, centerZ, feetY + 0.16);
      if (standY >= collider.maxY - 0.02 || standY + 1.65 <= collider.minY) continue;
      expect(
        world.navPointFree(centerX, centerZ, feetY, radius, false),
        `盒碰撞 ${index} ${collider.tag} (${centerX.toFixed(2)},${feetY.toFixed(2)},${centerZ.toFixed(2)}) 未阻挡导航`,
      ).toBe(false);
    }
  });

  it('每栋建筑的入口, 房间物资和楼梯落脚区保持连通', () => {
    const world = createWorld();
    const plots = world.buildings.plots as Plot[];
    const ignoredDoors = new Set(world.buildings.destructibles
      .filter((item) => item.kind === 'door')
      .map((item) => item.collider));
    const storeyStep = 2.9 + 0.24;
    for (const plot of plots) {
      const ix0 = plot.minX + 2;
      const ix1 = plot.maxX - 2;
      const iz0 = plot.minZ + 2;
      const iz1 = plot.maxZ - 2;
      const centerX = (ix0 + ix1) * 0.5;
      const firstFloorY = plot.flatH + 0.28;
      const plotColliders = world.aabbs.filter((collider) => (
        collider.maxX > plot.minX && collider.minX < plot.maxX &&
        collider.maxZ > plot.minZ && collider.minZ < plot.maxZ
      ));
      const floors = plot.arch === 'apartment' ? plot.storeys ?? 3
        : plot.arch === 'cottage2' || plot.arch === 'terrace' ? 2 : 1;
      for (let level = 0; level < floors; level++) {
        const feetY = firstFloorY + level * storeyStep;
        let start = { x: centerX, z: iz0 + 0.78 };
        if (level > 0 && plot.arch === 'apartment') {
          const incomingWest = (level - 1) % 2 === 0;
          start = {
            x: incomingWest ? ix0 + 0.14 + 2.1 * 0.5 : ix1 - 0.14 - 2.1 * 0.5,
            z: incomingWest ? iz0 + 0.82 : iz1 - 0.82,
          };
        } else if (level > 0) {
          start = { x: ix0 + 0.14 + 2.1 * 0.5, z: iz0 + 0.82 };
        }
        const targets = world.buildings.lootSpots.filter((spot) => (
          spot.x > ix0 && spot.x < ix1 && spot.z > iz0 && spot.z < iz1 &&
          Math.abs(spot.y - feetY) < 0.08
        )).map((spot) => ({ x: spot.x, z: spot.z }));
        if (level < floors - 1 && plot.arch === 'apartment') {
          const outgoingWest = level % 2 === 0;
          targets.push({
            x: outgoingWest ? ix0 + 0.14 + 2.1 * 0.5 : ix1 - 0.14 - 2.1 * 0.5,
            z: outgoingWest ? iz1 - 0.82 : iz0 + 0.82,
          });
        } else if (level === 0 && (plot.arch === 'cottage2' || plot.arch === 'terrace')) {
          targets.push({ x: ix0 + 0.14 + 2.1 * 0.5, z: iz1 - 0.82 });
        }
        expect(targets.length, `${plot.arch} 第 ${level + 1} 层没有可验收目标`).toBeGreaterThan(0);
        for (const target of targets) {
          expect(
            interiorRouteExists(plot, feetY, start, target, plotColliders, ignoredDoors),
            `${plot.arch} 第 ${level + 1} 层从楼梯或入口无法到达 ${target.x.toFixed(1)},${target.z.toFixed(1)}`,
          ).toBe(true);
        }
      }
    }
  });

  it('每栋建筑的每一层都有可站立且能被屋顶遮蔽的室内区域', () => {
    const world = createWorld();
    for (const [plotIndex, plot] of (world.buildings.plots as Plot[]).entries()) {
      const storeys = plot.arch === 'apartment' ? plot.storeys ?? 3
        : plot.arch === 'cottage2' || plot.arch === 'terrace' ? 2 : 1;
      const ix0 = plot.minX + 2;
      const ix1 = plot.maxX - 2;
      const iz0 = plot.minZ + 2;
      const iz1 = plot.maxZ - 2;
      for (let level = 0; level < storeys; level++) {
        const feetY = plot.flatH + 0.28 + level * (2.9 + 0.24);
        let walkable = 0;
        let sheltered = 0;
        for (let gx = 1; gx <= 6; gx++) for (let gz = 1; gz <= 6; gz++) {
          const x = ix0 + (ix1 - ix0) * gx / 7;
          const z = iz0 + (iz1 - iz0) * gz / 7;
          if (!world.navPointFree(x, z, feetY, 0.32, false)) continue;
          walkable++;
          if (world.isShelteredAt(x, z, feetY)) sheltered++;
        }
        expect(walkable, `建筑 ${plotIndex} ${plot.arch} 第 ${level + 1} 层没有可站立区域`).toBeGreaterThan(0);
        expect(sheltered, `建筑 ${plotIndex} ${plot.arch} 第 ${level + 1} 层缺少有效屋顶遮蔽`).toBeGreaterThan(0);
      }
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

  it('高楼楼梯跳跃撞到楼板时停止上升而不会被横向推出外墙', () => {
    const world = createWorld();
    const tower = (world.buildings.plots as Plot[]).find((plot) => plot.arch === 'apartment');
    expect(tower).toBeDefined();
    if (!tower) return;
    const firstFloorY = tower.flatH + 0.28;
    const ceiling = world.aabbs.find((collider) => (
      collider.tag === 'floor' &&
      Math.abs(collider.minY - (firstFloorY + 2.9)) < 0.05 &&
      collider.minX >= tower.minX + 1.8 && collider.maxX <= tower.maxX - 1.8
    ));
    expect(ceiling).toBeDefined();
    if (!ceiling) return;
    const x = (ceiling.minX + ceiling.maxX) * 0.5;
    const z = (ceiling.minZ + ceiling.maxZ) * 0.5;
    const previousFeetY = ceiling.minY - 1.76;
    const position = new THREE.Vector3(x, previousFeetY + 0.16, z);

    expect(world.resolveCharacterCeiling(position, 0.38, previousFeetY)).toBe(true);
    expect(position.y + 1.7).toBeLessThan(ceiling.minY);
    world.resolveCollision(position, 0.38);
    expect(position.x).toBeCloseTo(x, 6);
    expect(position.z).toBeCloseTo(z, 6);
    expect(position.x).toBeGreaterThan(tower.minX + 2);
    expect(position.x).toBeLessThan(tower.maxX - 2);
  });

  it('所有双层住宅和排屋的楼梯在三条行走线上都有连续净空', () => {
    const scene = new THREE.Scene();
    const world = new World(scene);
    const handrails = scene.getObjectByName('building-stair-handrails') as THREE.InstancedMesh | undefined;
    const ceilings = scene.getObjectByName('building-interior-ceilings') as THREE.InstancedMesh | undefined;
    expect(handrails).toBeDefined();
    expect(handrails?.geometry.type).toBe('CylinderGeometry');
    expect(handrails?.count).toBeGreaterThanOrEqual(4);
    expect(handrails?.castShadow).toBe(false);
    expect(ceilings).toBeDefined();
    expect(ceilings?.geometry.type).toBe('BoxGeometry');
    expect(ceilings?.count).toBeGreaterThanOrEqual(12);
    expect(ceilings?.castShadow).toBe(false);
    expect(ceilings?.receiveShadow).toBe(false);
    if (ceilings) {
      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const rotation = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      for (let index = 0; index < ceilings.count; index++) {
        ceilings.getMatrixAt(index, matrix);
        matrix.decompose(position, rotation, scale);
        expect(world.aabbs.some((box) => (
          box.tag === 'roof' &&
          Math.abs((box.minX + box.maxX) * 0.5 - position.x) < 0.01 &&
          Math.abs((box.minY + box.maxY) * 0.5 - position.y) < 0.01 &&
          Math.abs((box.minZ + box.maxZ) * 0.5 - position.z) < 0.01 &&
          Math.abs(box.maxX - box.minX - scale.x) < 0.01 &&
          Math.abs(box.maxZ - box.minZ - scale.z) < 0.01
        )), `住宅天花 ${index} 没有镜头碰撞体`).toBe(true);
      }
    }
    const multiStoreyHomes = (world.buildings.plots as Plot[]).filter((plot) => (
      plot.arch === 'cottage2' || plot.arch === 'terrace'
    ));
    expect(multiStoreyHomes.length).toBeGreaterThanOrEqual(4);
    for (const home of multiStoreyHomes) {
      const ix0 = home.minX + 2;
      const ix1 = home.maxX - 2;
      const iz0 = home.minZ + 2;
      const iz1 = home.maxZ - 2;
      const fromY = home.flatH + 0.28;
      const toY = fromY + 2.9 + 0.24;
      const platforms = world.platforms.filter((platform) => (
        platform.minX >= ix0 && platform.maxX <= ix1 &&
        platform.minZ >= iz0 && platform.maxZ <= iz1 &&
        platform.top > fromY + 0.02 && platform.top <= toY + 0.02
      )).sort((a, b) => a.top - b.top);
      expect(platforms.length, `${home.arch} 楼梯踏步不完整`).toBeGreaterThanOrEqual(10);

      for (const platform of platforms) {
        const x = (platform.minX + platform.maxX) * 0.5;
        const z = (platform.minZ + platform.maxZ) * 0.5;
        const overhead = world.aabbs.find((collider) => (
          !collider.off && collider.minX < x && collider.maxX > x &&
          collider.minZ < z && collider.maxZ > z &&
          collider.minY > platform.top + 0.02 && collider.minY < platform.top + 1.7
        ));
        expect(overhead, `${home.arch} 楼梯在 ${platform.top.toFixed(2)}m 处被楼板或墙封堵`).toBeUndefined();
      }

      const stairMinX = Math.min(...platforms.map((platform) => platform.minX));
      const stairMaxX = Math.max(...platforms.map((platform) => platform.maxX));
      for (const lane of [0.24, 0.5, 0.76]) {
        let feetY = fromY;
        for (const platform of platforms) {
          const x = stairMinX + (stairMaxX - stairMinX) * lane;
          const z = (platform.minZ + platform.maxZ) * 0.5;
          const point = new THREE.Vector3(x, feetY, z);
          world.resolveCollision(point, 0.38);
          const next = world.groundHeight(point.x, point.z, feetY + 0.1);
          expect(next, `${home.arch} 楼梯无法连续抬步`).toBeGreaterThanOrEqual(feetY);
          expect(Math.abs(point.x - x), `${home.arch} 楼梯侧向卡位`).toBeLessThan(0.08);
          feetY = Math.max(feetY, next);
        }
        expect(feetY, `${home.arch} 楼梯未抵达二层`).toBeGreaterThan(toY - 0.36);
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
        `物资点 ${spot.x.toFixed(2)},${spot.y.toFixed(2)},${spot.z.toFixed(2)} 缺少承托面`).toBeLessThanOrEqual(0.081);
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

  it('两栋高楼使用克制且没有重复叠层的完整立面', () => {
    const world = createWorld();
    const apartmentCount = (world.buildings.plots as Plot[]).filter((plot) => plot.arch === 'apartment').length;
    expect(apartmentCount).toBe(2);
    expect(world.buildings.europeanFacadeDetailsByArch.apartment).toBeGreaterThanOrEqual(20);
    expect(world.buildings.europeanFacadeDetailsByArch.apartment).toBeLessThanOrEqual(32);
  });

  it('体育馆拥有独立场馆立面和高密度视觉细节', () => {
    const world = createWorld();
    expect((world.buildings.plots as Plot[]).filter((plot) => plot.arch === 'gym')).toHaveLength(1);
    expect(world.buildings.europeanFacadeDetailsByArch.gym).toBeGreaterThanOrEqual(220);
  });

  it('谷仓外墙没有贯穿门窗的长木条或错位檐线', () => {
    const scene = new THREE.Scene();
    const world = new World(scene);
    const barn = (world.buildings.plots as Plot[]).find((plot) => plot.arch === 'barn');
    expect(barn).toBeDefined();
    if (!barn) return;
    const ix0 = barn.minX + 2;
    const ix1 = barn.maxX - 2;
    const iz0 = barn.minZ + 2;
    const f1 = barn.flatH + 0.28;
    const wallTop = f1 + 4.2;
    const facadeWidth = ix1 - ix0;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const offenders: string[] = [];
    scene.traverse((object) => {
      if (!(object instanceof THREE.InstancedMesh)) return;
      for (let index = 0; index < object.count; index++) {
        object.getMatrixAt(index, matrix);
        matrix.decompose(position, rotation, scale);
        const crossesFacade = Math.abs(position.z - iz0) < 0.5 && scale.x > facadeWidth * 0.78;
        const liesAcrossWall = position.y - scale.y * 0.5 > f1 + 0.55 &&
          position.y + scale.y * 0.5 < wallTop - 0.2;
        if (crossesFacade && liesAcrossWall) {
          offenders.push(`${index}:${position.y.toFixed(2)}:${scale.x.toFixed(2)}`);
        }
      }
    });
    expect(offenders, `谷仓外墙仍有长条 ${offenders.join(',')}`).toEqual([]);
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

  it('城区花箱使用可辨识的石材植被配色而不是黑色占位块', () => {
    const scene = new THREE.Scene();
    const world = new World(scene);
    const boxes = scene.getObjectByName('city-planter-bases') as THREE.InstancedMesh | undefined;
    const spheres = scene.getObjectByName('city-planter-foliage') as THREE.InstancedMesh | undefined;
    expect(boxes?.count).toBeGreaterThanOrEqual(30);
    expect(spheres?.count).toBeGreaterThanOrEqual(70);
    expect(world.cityPlanterPositions).toHaveLength((boxes?.count ?? 0) / 2);
    if (!boxes || !spheres) return;

    const color = new THREE.Color();
    for (let index = 0; index < boxes.count; index++) {
      boxes.getColorAt(index, color);
      expect(color.r + color.g + color.b, `花箱石盆 ${index} 颜色过暗`).toBeGreaterThan(0.9);
    }
    for (let index = 0; index < spheres.count; index++) {
      spheres.getColorAt(index, color);
      expect(color.r + color.g + color.b, `花箱植被 ${index} 颜色过暗`).toBeGreaterThan(0.4);
    }
    expect((boxes.material as THREE.MeshStandardMaterial).emissiveIntensity).toBeGreaterThanOrEqual(0.5);
    expect((spheres.material as THREE.MeshStandardMaterial).emissiveIntensity).toBeGreaterThanOrEqual(0.58);

    const churchBases = scene.getObjectsByProperty('name', 'church-plaza-planter-base') as THREE.Mesh[];
    const churchCaps = scene.getObjectsByProperty('name', 'church-plaza-planter-cap') as THREE.Mesh[];
    const churchHedges = scene.getObjectsByProperty('name', 'church-plaza-planter-hedge') as THREE.Mesh[];
    const churchFlowers = scene.getObjectsByProperty('name', 'church-plaza-planter-flower') as THREE.Mesh[];
    const churchInsets = scene.getObjectsByProperty('name', 'church-plaza-planter-inset') as THREE.Mesh[];
    expect(churchBases).toHaveLength(2);
    expect(churchCaps).toHaveLength(2);
    expect(churchHedges).toHaveLength(6);
    expect(churchFlowers).toHaveLength(6);
    expect(churchInsets).toHaveLength(8);
    for (const mesh of [...churchBases, ...churchCaps]) {
      const material = mesh.material as THREE.MeshStandardMaterial;
      expect(material.color.r + material.color.g + material.color.b).toBeGreaterThan(1.3);
      expect(material.emissiveIntensity).toBeGreaterThanOrEqual(0.4);
    }
    for (const mesh of [...churchHedges, ...churchFlowers, ...churchInsets]) {
      const material = mesh.material as THREE.MeshStandardMaterial;
      expect(material.color.r + material.color.g + material.color.b).toBeGreaterThan(0.7);
      expect(material.emissiveIntensity).toBeGreaterThanOrEqual(0.4);
    }

    // 教堂外围旧版“黑盒加三个黑球”不得复用通用区域实例。
    const gardenPlanters = scene.getObjectsByProperty('name', 'church-garden-planter') as THREE.Group[];
    expect(gardenPlanters).toHaveLength(world.churchGardenPlanterCount);
    expect(gardenPlanters.length).toBeGreaterThanOrEqual(4);
    for (const planter of gardenPlanters) {
      const stone = planter.getObjectByName('church-garden-planter-stone') as THREE.Mesh | undefined;
      const soil = planter.getObjectByName('church-garden-planter-soil') as THREE.Mesh | undefined;
      expect(stone).toBeDefined();
      expect(soil).toBeDefined();
      expect(planter.children.filter((child) => child.name === 'church-garden-planter-bloom')).toHaveLength(5);
      const material = stone?.material as THREE.MeshStandardMaterial;
      expect(material.color.r + material.color.g + material.color.b).toBeGreaterThan(1.5);
      expect(material.emissiveIntensity).toBeGreaterThanOrEqual(0.35);
    }
  });

  it('路牌和金属桶在阴影中仍有可辨识颜色及结构环', () => {
    const scene = new THREE.Scene();
    const world = new World(scene);
    const signs = scene.getObjectByName('road-sign-boards') as THREE.InstancedMesh | undefined;
    const barrels = scene.getObjectByName('street-barrel-bodies') as THREE.InstancedMesh | undefined;
    const bands = scene.getObjectByName('street-barrel-bands') as THREE.InstancedMesh | undefined;
    expect(signs?.count).toBeGreaterThanOrEqual(8);
    expect(barrels?.count).toBeGreaterThanOrEqual(20);
    expect(bands?.count).toBe((barrels?.count ?? 0) * 3);
    expect(world.streetBarrelPositions).toHaveLength(barrels?.count ?? 0);
    if (!signs || !barrels || !bands) return;
    expect((signs.material as THREE.MeshStandardMaterial).emissiveIntensity).toBeGreaterThanOrEqual(0.3);
    expect((barrels.material as THREE.MeshStandardMaterial).emissiveIntensity).toBeGreaterThanOrEqual(0.35);
    expect((bands.material as THREE.MeshStandardMaterial).color.r).toBeGreaterThan(0.4);
    const color = new THREE.Color();
    for (let index = 0; index < barrels.count; index++) {
      barrels.getColorAt(index, color);
      expect(color.r + color.g + color.b, `金属桶 ${index} 颜色过暗`).toBeGreaterThan(0.75);
    }
  });

  it('农田土沟和围栏贴坡生成且不会退化成长悬空黑板', () => {
    const scene = new THREE.Scene();
    const world = new World(scene);
    const furrows = scene.getObjectByName('farm-soil-furrows') as THREE.InstancedMesh | undefined;
    const rails = scene.getObjectByName('farm-fence-rails') as THREE.InstancedMesh | undefined;
    const road = scene.getObjectByName('road-track-surface') as THREE.Mesh | undefined;
    const roadVerge = scene.getObjectByName('road-verge-surface') as THREE.Mesh | undefined;
    expect(furrows).toBeDefined();
    expect(rails).toBeDefined();
    expect(road).toBeDefined();
    expect(roadVerge).toBeUndefined();
    if (!furrows || !rails || !road) return;

    const trackMaterial = road.material as THREE.MeshStandardMaterial;
    expect(trackMaterial).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(trackMaterial.roughness).toBeGreaterThanOrEqual(0.95);
    expect(trackMaterial.color.getHex()).toBe(0x948267);
    expect(road.userData.roadSurfaceLift).toBeGreaterThanOrEqual(0.028);
    expect(road.userData.roadSurfaceLift).toBeLessThanOrEqual(0.04);

    expect(world.farmFurrowCount).toBeGreaterThanOrEqual(24);
    expect(world.farmFenceRailCount).toBeGreaterThanOrEqual(120);
    expect(world.farmFenceColliders.length).toBe(world.farmFenceRailCount / 2);
    expect(furrows.count).toBe(world.farmFurrowCount);
    expect(rails.count).toBe(world.farmFenceRailCount);
    expect(furrows.geometry.type).toBe('PlaneGeometry');
    expect(furrows.castShadow).toBe(false);

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (let index = 0; index < furrows.count; index++) {
      furrows.getMatrixAt(index, matrix);
      matrix.decompose(position, rotation, scale);
      expect(scale.x, `土沟 ${index} 过宽`).toBeLessThanOrEqual(0.5);
      expect(scale.z, `土沟 ${index} 过长`).toBeLessThanOrEqual(4.8);
    }
    for (let index = 0; index < rails.count; index++) {
      rails.getMatrixAt(index, matrix);
      matrix.decompose(position, rotation, scale);
      expect(scale.x, `围栏 ${index} 未分段贴坡`).toBeLessThanOrEqual(2.7);
    }

    for (const [index, collider] of world.farmFenceColliders.entries()) {
      const centerX = (collider.minX + collider.maxX) * 0.5;
      const centerZ = (collider.minZ + collider.maxZ) * 0.5;
      const feetY = world.getHeight(centerX, centerZ);
      expect(
        world.navPointFree(centerX, centerZ, feetY, 0.3, false),
        `围栏碰撞 ${index} 仍允许角色或机器人穿过`,
      ).toBe(false);

      const point = new THREE.Vector3(centerX, feetY, centerZ);
      world.resolveCollision(point, 0.38);
      const dx = Math.max(collider.minX - point.x, 0, point.x - collider.maxX);
      const dz = Math.max(collider.minZ - point.z, 0, point.z - collider.maxZ);
      expect(
        dx * dx + dz * dz,
        `围栏碰撞 ${index} 没有把角色推出可见栅栏`,
      ).toBeGreaterThanOrEqual(0.38 ** 2 - 0.0001);
    }

    const normals = road.geometry.getAttribute('normal') as THREE.BufferAttribute;
    expect(normals.count).toBeGreaterThan(0);
    for (let index = 0; index < normals.count; index++) {
      expect(normals.getY(index), `道路三角面 ${index} 法线朝下`).toBeGreaterThan(0);
    }

    const patchCenters = road.userData.roadPatchCenters as Array<readonly [number, number]> | undefined;
    const patchSegments = road.userData.roadPatchSegments as number | undefined;
    expect(patchCenters).toBeDefined();
    expect(patchCenters?.length).toBeGreaterThanOrEqual(28);
    expect(patchSegments).toBeGreaterThanOrEqual(16);
    const positions = road.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let index = 0; index < positions.count; index += 3) {
      const ax = positions.getX(index);
      const az = positions.getZ(index);
      const bx = positions.getX(index + 1);
      const bz = positions.getZ(index + 1);
      const cx = positions.getX(index + 2);
      const cz = positions.getZ(index + 2);
      const signedArea = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
      expect(signedArea, `道路三角面 ${index / 3} 发生翻面`).toBeLessThan(-0.000001);
      const centerX = (positions.getX(index) + positions.getX(index + 1) + positions.getX(index + 2)) / 3;
      const centerZ = (positions.getZ(index) + positions.getZ(index + 1) + positions.getZ(index + 2)) / 3;
      const overlapsMainBridge = [-50, 170].some((bridgeX) => (
        Math.abs(centerX - bridgeX) < 2.7 && Math.abs(centerZ - riverZAt(bridgeX)) < 14
      ));
      expect(overlapsMainBridge, `道路三角面 ${index / 3} 仍叠在主桥桥面下`).toBe(false);
    }
    for (const mesh of [road]) {
      const surface = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const expectedLift = mesh.userData.roadSurfaceLift as number;
      for (let index = 0; index < surface.count; index++) {
        const x = surface.getX(index);
        const y = surface.getY(index);
        const z = surface.getZ(index);
        const terrainY = world.getHeight(x, z);
        if (terrainY < WATER_Y + 0.18) continue;
        const offset = y - terrainY;
        expect(
          offset,
          `${mesh.name} 顶点 ${index} 与物理地面错位导致角色陷入或路面悬空`,
        ).toBeGreaterThanOrEqual(expectedLift - 0.004);
        expect(offset).toBeLessThanOrEqual(expectedLift + 0.01);
      }
    }
    for (const [patchIndex, center] of (patchCenters ?? []).entries()) {
      let centerVertices = 0;
      for (let index = 0; index < positions.count; index++) {
        if (Math.hypot(positions.getX(index) - center[0], positions.getZ(index) - center[1]) < 0.01) {
          centerVertices++;
        }
      }
      expect(centerVertices, `道路节点 ${patchIndex} 没有完整交叉口补片`).toBeGreaterThanOrEqual(patchSegments ?? 16);
    }

    const pointCoveredByRoad = (x: number, z: number): boolean => {
      for (let index = 0; index < positions.count; index += 3) {
        const ax = positions.getX(index);
        const az = positions.getZ(index);
        const bx = positions.getX(index + 1);
        const bz = positions.getZ(index + 1);
        const cx = positions.getX(index + 2);
        const cz = positions.getZ(index + 2);
        const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
        const ab = (bx - ax) * (z - az) - (bz - az) * (x - ax);
        const bc = (cx - bx) * (z - bz) - (cz - bz) * (x - bx);
        const ca = (ax - cx) * (z - cz) - (az - cz) * (x - cx);
        const epsilon = Math.max(0.0001, Math.abs(area) * 0.00001);
        if (area < 0 && ab <= epsilon && bc <= epsilon && ca <= epsilon) return true;
        if (area > 0 && ab >= -epsilon && bc >= -epsilon && ca >= -epsilon) return true;
      }
      return false;
    };
    for (let pathIndex = 0; pathIndex < ROAD_PATHS.length; pathIndex++) {
      const path = ROAD_PATHS[pathIndex] as readonly (readonly [number, number])[];
      for (let segmentIndex = 0; segmentIndex < path.length - 1; segmentIndex++) {
        const a = path[segmentIndex] as readonly [number, number];
        const b = path[segmentIndex + 1] as readonly [number, number];
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        const length = Math.hypot(dx, dz);
        const nx = -dz / length;
        const nz = dx / length;
        const samples = Math.max(2, Math.ceil(length / 2));
        for (let sample = 0; sample <= samples; sample++) {
          const t = sample / samples;
          // 主桥桥面会从 7.2 米路肩自然收窄到 5.4 米，逐段审计稳定可行驶的 4.8 米核心宽度。
          for (const lateral of [-2.4, 0, 2.4]) {
            const x = a[0] + dx * t + nx * lateral;
            const z = a[1] + dz * t + nz * lateral;
            if (pointCoveredByRoad(x, z)) continue;
            const bridged = world.platforms.some((platform) => (
              x >= platform.minX - 0.08 && x <= platform.maxX + 0.08 &&
              z >= platform.minZ - 0.08 && z <= platform.maxZ + 0.08 &&
              platform.top >= WATER_Y + 0.45
            ));
            expect(
              bridged,
              `道路 ${pathIndex} 第 ${segmentIndex} 节在 ${x.toFixed(1)},${z.toFixed(1)} 露出草地或缺少桥面`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it('支路跨水桥使用开放式亮色护栏而不是遮挡视线的黑色整墙', () => {
    const scene = new THREE.Scene();
    const world = new World(scene);
    const decks = scene.getObjectByName('road-water-crossing-decks') as THREE.InstancedMesh | undefined;
    const rails = scene.getObjectByName('road-water-crossing-top-rails') as THREE.InstancedMesh | undefined;
    const posts = scene.getObjectByName('road-water-crossing-rail-posts') as THREE.InstancedMesh | undefined;
    expect(decks?.count).toBe(world.roadWaterCrossingSegmentCount);
    expect(rails?.count).toBe(world.roadWaterCrossingSegmentCount * 2);
    expect(posts?.count).toBe(world.roadWaterCrossingSegmentCount * 2);
    if (!decks || !rails || !posts) return;

    expect(decks.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    const railMaterial = rails.material as THREE.MeshStandardMaterial;
    expect(railMaterial.color.r + railMaterial.color.g + railMaterial.color.b).toBeGreaterThan(1.25);
    expect(railMaterial.emissiveIntensity).toBeGreaterThanOrEqual(0.4);

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (let index = 0; index < rails.count; index++) {
      rails.getMatrixAt(index, matrix);
      matrix.decompose(position, rotation, scale);
      expect(scale.y, `支路桥护栏 ${index} 仍是遮挡视线的整面高墙`).toBeLessThanOrEqual(0.15);
    }
    for (let index = 0; index < posts.count; index++) {
      posts.getMatrixAt(index, matrix);
      matrix.decompose(position, rotation, scale);
      expect(scale.x, `支路桥立柱 ${index} 过粗`).toBeLessThanOrEqual(0.15);
      expect(scale.y, `支路桥立柱 ${index} 高度不足`).toBeGreaterThanOrEqual(0.68);
      expect(scale.z, `支路桥立柱 ${index} 过粗`).toBeLessThanOrEqual(0.15);
    }
  });

  it('道路核心通道全线可供角色与机器人连续通行', () => {
    const scene = new THREE.Scene();
    const world = new World(scene);
    const blocked: string[] = [];
    const terminusPoints = [[194, -43], [205, -209], [20, -200]] as const;
    const supportAt = (x: number, z: number): number => {
      const terrainY = world.getHeight(x, z);
      return world.platforms.reduce((highest, platform) => (
        x >= platform.minX - 0.06 && x <= platform.maxX + 0.06 &&
        z >= platform.minZ - 0.06 && z <= platform.maxZ + 0.06
          ? Math.max(highest, platform.top)
          : highest
      ), terrainY);
    };
    for (let pathIndex = 0; pathIndex < ROAD_PATHS.length; pathIndex++) {
      const path = ROAD_PATHS[pathIndex] as readonly (readonly [number, number])[];
      for (let segmentIndex = 0; segmentIndex < path.length - 1; segmentIndex++) {
        const a = path[segmentIndex] as readonly [number, number];
        const b = path[segmentIndex + 1] as readonly [number, number];
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        const length = Math.hypot(dx, dz);
        const sideX = -dz / length;
        const sideZ = dx / length;
        const samples = Math.max(2, Math.ceil(length / 0.7));
        for (let sample = 0; sample <= samples; sample++) {
          const t = sample / samples;
          const centerX = a[0] + dx * t;
          const centerZ = a[1] + dz * t;
          if (terminusPoints.some(([x, z]) => Math.hypot(centerX - x, centerZ - z) < 5.2)) continue;
          const lanes = [-1.75, 0, 1.75].map((lateral) => {
            const x = centerX + sideX * lateral;
            const z = centerZ + sideZ * lateral;
            const feetY = supportAt(x, z);
            return {
              x, z, feetY,
              open: world.navPointFree(x, z, feetY, 0.48, false, false, true),
            };
          });
          const openLanes = lanes.filter((lane) => lane.open);
          if (openLanes.length === 0) {
            const reasons = lanes.map((lane) => {
              const cylinder = world.cyls.find((collider) => (
                Math.hypot(lane.x - collider.x, lane.z - collider.z) < 0.48 + collider.r &&
                lane.feetY < collider.y1 - 0.05 && lane.feetY + 1.65 > collider.y0
              ));
              const box = world.aabbs.find((collider) => (
                !collider.off && collider.tag !== 'floor' && collider.tag !== 'roof' && collider.tag !== 'door' &&
                lane.feetY < collider.maxY - 0.02 && lane.feetY + 1.65 > collider.minY &&
                Math.hypot(
                  lane.x - Math.max(collider.minX, Math.min(lane.x, collider.maxX)),
                  lane.z - Math.max(collider.minZ, Math.min(lane.z, collider.maxZ)),
                ) < 0.48
              ));
              return cylinder ? `cyl-${cylinder.tag}` : box
                ? `box-${box.tag}:${box.minX.toFixed(1)},${box.minZ.toFixed(1)}-${box.maxX.toFixed(1)},${box.maxZ.toFixed(1)}`
                : 'height';
            });
            blocked.push(`${pathIndex}:${segmentIndex}@${centerX.toFixed(1)},${centerZ.toFixed(1)}[${reasons.join(',')}]`);
          }
        }
      }
    }
    expect(blocked, `道路全宽被阻断: ${blocked.slice(0, 20).join(' | ')}`).toEqual([]);
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
    expect(world.stonegatePaverCount).toBe(336);
    expect(world.fountainDetailCount).toBeGreaterThanOrEqual(15);
    expect(world.religiousCrossCount).toBe(1);

    const floorTop = world.platforms
      .filter((platform) => (
        platform.minX < church.x && platform.maxX > church.x &&
        platform.minZ < church.z - 5 && platform.maxZ > church.z - 5
      ))
      .reduce((highest, platform) => Math.max(highest, platform.top), -Infinity);
    expect(Number.isFinite(floorTop)).toBe(true);
    const plazaPlatform = world.platforms.find((platform) => (
      Math.abs(platform.minX - (church.x - 13.5)) < 0.01 &&
      Math.abs(platform.maxX - (church.x + 13.5)) < 0.01 &&
      Math.abs(platform.minZ - (church.z + 5)) < 0.01 &&
      Math.abs(platform.maxZ - (church.z + 23)) < 0.01
    ));
    expect(plazaPlatform).toBeDefined();
    expect(floorTop).toBeGreaterThanOrEqual((plazaPlatform?.top ?? Infinity) + 0.05);
    for (const z of [church.z + 3.1, church.z + 4.2, church.z + 4.8, church.z + 5.4, church.z + 6.2]) {
      const feetY = world.groundHeight(church.x, z, floorTop + 1);
      expect(
        world.navPointFree(church.x, z, feetY, 0.35, false),
        `教堂正门通道在 z=${z.toFixed(2)} 被墙体或广场地基封堵`,
      ).toBe(true);
    }
    const access = new THREE.Vector2();
    expect(world.churchPlazaAccessWaypoint(
      access,
      church.x - 24,
      church.z + 14,
      church.x + 4,
      church.z + 14,
    )).toBe(true);
    expect(access.x).toBeCloseTo(church.x, 6);
    expect(access.y).toBeCloseTo(church.z + 25.95, 6);
    expect(world.churchPlazaAccessWaypoint(
      access,
      church.x,
      church.z + 25.9,
      church.x + 4,
      church.z + 14,
    )).toBe(true);
    expect(access.y).toBeCloseTo(church.z + 22.75, 6);
    expect(world.churchPlazaAccessWaypoint(
      access,
      church.x,
      church.z + 22.7,
      church.x + 4,
      church.z + 14,
    )).toBe(false);
    const accessSteps = world.platforms.filter((platform) => (
      platform.minX < church.x - 4 && platform.maxX > church.x + 4 &&
      platform.minZ > church.z + 21.8 && platform.maxZ < church.z + 27
    ));
    expect(accessSteps).toHaveLength(7);
    let approachY = world.getHeight(church.x, church.z + 26.5);
    for (let z = church.z + 26.3; z >= church.z + 22.7; z -= 0.2) {
      const nextY = world.groundHeight(church.x, z, approachY + 0.3);
      expect(nextY - approachY, `广场入口 z=${z.toFixed(2)} 台阶过高`).toBeLessThanOrEqual(0.45);
      expect(world.navPointFree(church.x, z, approachY, 0.35, false)).toBe(true);
      approachY = nextY;
    }
    expect(Math.abs(approachY - (plazaPlatform?.top ?? approachY))).toBeLessThan(0.08);
    expect(world.cyls.some((collider) => (
      Math.abs(collider.x - church.x) < 0.05 &&
      Math.abs(collider.z - (church.z + 14)) < 0.05 && collider.r >= 2.2
    ))).toBe(true);
    expect(world.mapLootSpots.filter((spot) => spot.siteId.startsWith('stonegate-church'))).toHaveLength(4);
    expect(world.assetUsage.count('map.landmark.church')).toBe(1);
    expect(world.assetUsage.count('map.landmark.plaza')).toBe(1);
  });

  it('桥梁和观景台只在可见栏杆处阻挡并保留入口', () => {
    const world = createWorld();
    for (const bridgeX of [-50, 170]) {
      const riverZ = riverZAt(bridgeX);
      const deck = world.platforms.find((platform) => (
        platform.minX < bridgeX && platform.maxX > bridgeX &&
        platform.minZ < riverZ && platform.maxZ > riverZ &&
        platform.maxZ - platform.minZ > 20
      ));
      expect(deck, `${bridgeX} 桥缺少桥面平台`).toBeDefined();
      if (!deck) continue;
      expect(deck.maxX - deck.minX).toBeCloseTo(5.4, 4);
      expect(world.navPointFree(bridgeX, riverZ, deck.top, 0.34, false)).toBe(true);
      expect(world.navPointFree(bridgeX - 2.6, riverZ, deck.top, 0.34, false)).toBe(false);
      expect(world.navPointFree(bridgeX + 2.6, riverZ, deck.top, 0.34, false)).toBe(false);
    }

    const lookout = world.landmarks.find((site) => site.kind === 'lookout');
    expect(lookout).toBeDefined();
    if (!lookout) return;
    const deckTop = world.platforms
      .filter((platform) => platform.minX < lookout.x && platform.maxX > lookout.x &&
        platform.minZ < lookout.z && platform.maxZ > lookout.z)
      .reduce((highest, platform) => Math.max(highest, platform.top), -Infinity);
    expect(Number.isFinite(deckTop)).toBe(true);
    expect(world.navPointFree(lookout.x, lookout.z - 2.7, deckTop, 0.3, false)).toBe(false);
    expect(world.navPointFree(lookout.x - 1.9, lookout.z + 2.7, deckTop, 0.3, false)).toBe(false);
    expect(world.navPointFree(lookout.x, lookout.z + 2.7, deckTop, 0.3, false)).toBe(true);
  });

  it('地图和建筑生成结果均登记到可审计资产目录', () => {
    const world = createWorld();
    expect(world.assetUsage.uniqueCount).toBeGreaterThanOrEqual(15);
    expect(world.assetUsage.totalInstances).toBeGreaterThanOrEqual(5000);
    expect(world.assetUsage.count('map.infrastructure.bridge')).toBe(2 + world.roadWaterCrossingCount);
    expect(world.assetUsage.count('map.landmark.region-site')).toBe(6);
    expect(world.buildings.assetUsage.uniqueCount).toBeGreaterThanOrEqual(20);
    expect(world.buildings.assetUsage.totalInstances).toBeGreaterThan(world.buildings.plots.length * 6);
  });

  it('七种建筑原型全部接入欧式立面组件且不改变室内碰撞', () => {
    const world = createWorld();
    expect(world.buildings.assetUsage.count('building.module.european-facade')).toBe(world.buildings.plots.length);
    expect(world.buildings.europeanFacadeDetailCount).toBeGreaterThan(world.buildings.plots.length * 45);
    for (const [arch, count] of Object.entries(world.buildings.europeanFacadeDetailsByArch)) {
      const minimum = arch === 'apartment' ? 20 : 45;
      expect(count, `${arch} 没有完整欧式立面`).toBeGreaterThanOrEqual(minimum);
    }
  });
});
