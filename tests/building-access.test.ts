import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { World } from '../src/world';
import type { Destructible, HousePlot } from '../src/buildings';

const PLAYER_RADIUS = 0.42;
const OUTSIDE_DISTANCE = 1.6;
const INSIDE_DISTANCE = 1.35;

interface ExteriorEntrance {
  door?: Destructible;
  plot: HousePlot;
  x: number;
  z: number;
  halfWidth: number;
  outwardX: number;
  outwardZ: number;
}

function exteriorEntrances(world: World): ExteriorEntrance[] {
  const entrances: ExteriorEntrance[] = [];
  for (const plot of world.buildings.plots) {
    const ix0 = plot.minX + 2;
    const ix1 = plot.maxX - 2;
    const iz0 = plot.minZ + 2;
    const iz1 = plot.maxZ - 2;
    for (const door of world.buildings.destructibles) {
      if (door.kind !== 'door' || !door.doorAxis) continue;
      if (door.cx < ix0 - 0.2 || door.cx > ix1 + 0.2 || door.cz < iz0 - 0.2 || door.cz > iz1 + 0.2) continue;
      if (door.doorAxis === 'x' && Math.abs(door.cz - iz0) < 0.12) {
        entrances.push({ door, plot, x: door.cx, z: door.cz, halfWidth: (door.collider.maxX - door.collider.minX) / 2, outwardX: 0, outwardZ: -1 });
      } else if (door.doorAxis === 'x' && Math.abs(door.cz - iz1) < 0.12) {
        entrances.push({ door, plot, x: door.cx, z: door.cz, halfWidth: (door.collider.maxX - door.collider.minX) / 2, outwardX: 0, outwardZ: 1 });
      } else if (door.doorAxis === 'z' && Math.abs(door.cx - ix0) < 0.12) {
        entrances.push({ door, plot, x: door.cx, z: door.cz, halfWidth: (door.collider.maxZ - door.collider.minZ) / 2, outwardX: -1, outwardZ: 0 });
      } else if (door.doorAxis === 'z' && Math.abs(door.cx - ix1) < 0.12) {
        entrances.push({ door, plot, x: door.cx, z: door.cz, halfWidth: (door.collider.maxZ - door.collider.minZ) / 2, outwardX: 1, outwardZ: 0 });
      }
    }
    const centerX = (ix0 + ix1) / 2;
    if (plot.arch === 'shop' || plot.arch === 'barn') {
      entrances.push({ plot, x: centerX, z: iz0, halfWidth: plot.arch === 'shop' ? 1.2 : 1.3, outwardX: 0, outwardZ: -1 });
    } else if (plot.arch === 'gym') {
      entrances.push({ plot, x: centerX, z: iz1, halfWidth: 1.5, outwardX: 0, outwardZ: 1 });
    }
  }
  return entrances;
}

function traverseOpenDoor(
  world: World,
  entry: ExteriorEntrance,
  lateralOffset: number,
): { progress: number; lateral: number; y: number } {
  const { door, outwardX, outwardZ } = entry;
  const tangentX = outwardZ;
  const tangentZ = -outwardX;
  const point = new THREE.Vector3(
    entry.x + outwardX * OUTSIDE_DISTANCE + tangentX * lateralOffset,
    0,
    entry.z + outwardZ * OUTSIDE_DISTANCE + tangentZ * lateralOffset,
  );
  point.y = world.groundHeight(point.x, point.z, world.getHeight(point.x, point.z) + 0.4);
  if (door) {
    door.alive = true;
    door.collider.off = false;
    world.buildings.setDoorOpen(door, true, point.x, point.z);
    if (door.pivot) door.pivot.rotation.y = door.openAngle;
    door.collider.off = true;
  }
  const inwardX = -outwardX;
  const inwardZ = -outwardZ;
  const travel = OUTSIDE_DISTANCE + INSIDE_DISTANCE;
  const steps = Math.ceil(travel / 0.055);
  for (let step = 0; step < steps; step++) {
    point.x += inwardX * 0.055;
    point.z += inwardZ * 0.055;
    world.resolveCollision(point, PLAYER_RADIUS);
    const support = world.groundHeight(point.x, point.z, point.y + 0.38);
    if (support <= point.y + 0.34) point.y = support;
  }
  const deltaX = point.x - entry.x;
  const deltaZ = point.z - entry.z;
  return {
    progress: deltaX * inwardX + deltaZ * inwardZ,
    lateral: Math.abs(deltaX * outwardZ - deltaZ * outwardX),
    y: point.y,
  };
}

function traverseDoorFromSide(world: World, door: Destructible, side: 1 | -1): number {
  if (!door.doorAxis) return Number.NEGATIVE_INFINITY;
  const normalX = door.doorAxis === 'z' ? side : 0;
  const normalZ = door.doorAxis === 'x' ? side : 0;
  const point = new THREE.Vector3(door.cx + normalX, door.collider.minY, door.cz + normalZ);
  point.y = world.groundHeight(point.x, point.z, door.collider.minY + 0.1);
  door.alive = true;
  door.collider.off = false;
  world.buildings.setDoorOpen(door, true, point.x, point.z);
  if (door.pivot) door.pivot.rotation.y = door.openAngle;
  door.collider.off = true;
  for (let step = 0; step < 40; step++) {
    point.x -= normalX * 0.05;
    point.z -= normalZ * 0.05;
    world.resolveCollision(point, PLAYER_RADIUS);
    const support = world.groundHeight(point.x, point.z, point.y + 0.38);
    if (support <= point.y + 0.34) point.y = support;
  }
  return (point.x - door.cx) * -normalX + (point.z - door.cz) * -normalZ;
}

describe('逐栋建筑入口与楼层通行回归', () => {
  it('每栋建筑的全部外门和开放入口都能从室外完整进入室内', () => {
    const world = new World(new THREE.Scene());
    const entries = exteriorEntrances(world);
    expect(entries.length).toBeGreaterThanOrEqual(world.buildings.plots.length);
    const plotsWithEntrances = new Set(entries.map((entry) => entry.plot));
    expect(
      plotsWithEntrances.size,
      `缺少入口: ${world.buildings.plots.filter((plot) => !plotsWithEntrances.has(plot)).map((plot, index) => `${index}:${plot.arch}`).join(', ')}`,
    ).toBe(world.buildings.plots.length);
    const failures: string[] = [];
    for (const [index, entry] of entries.entries()) {
      const edgeLane = Math.max(0.16, entry.halfWidth - PLAYER_RADIUS - 0.12);
      for (const lateralOffset of [-edgeLane, 0, edgeLane]) {
        const result = traverseOpenDoor(world, entry, lateralOffset);
        const lateralError = Math.abs(result.lateral - Math.abs(lateralOffset));
        if (result.progress <= INSIDE_DISTANCE - 0.16 || lateralError >= 0.18) {
          failures.push(
            `建筑 ${world.buildings.plots.indexOf(entry.plot)} ${entry.plot.arch} 外门 ${index}` +
            ` (${entry.x.toFixed(2)},${entry.z.toFixed(2)})` +
            ` lane=${lateralOffset.toFixed(2)}` +
            ` progress=${result.progress.toFixed(2)} lateral=${result.lateral.toFixed(2)}` +
            ` lateralError=${lateralError.toFixed(2)}` +
            ` y=${result.y.toFixed(2)} floor=${(entry.plot.flatH + 0.28).toFixed(2)}` +
            ` terrain=${world.getHeight(entry.x, entry.z).toFixed(2)}` +
            ` bounds=[${entry.plot.minX.toFixed(1)},${entry.plot.minZ.toFixed(1)}..${entry.plot.maxX.toFixed(1)},${entry.plot.maxZ.toFixed(1)}]`,
          );
        }
        if (entry.door) {
          world.buildings.setDoorOpen(entry.door, false);
          if (entry.door.pivot) entry.door.pivot.rotation.y = 0;
          entry.door.collider.off = false;
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('每一层的实体门从两侧打开后都不会把角色弹回原侧', () => {
    const world = new World(new THREE.Scene());
    const doors = world.buildings.destructibles.filter((item) => item.kind === 'door' && item.doorAxis);
    const failures: string[] = [];
    for (const [index, door] of doors.entries()) {
      for (const side of [-1, 1] as const) {
        const progress = traverseDoorFromSide(world, door, side);
        if (progress < 0.78) {
          failures.push(
            `门 ${index} (${door.cx.toFixed(2)},${door.collider.minY.toFixed(2)},${door.cz.toFixed(2)})` +
            ` side=${side} progress=${progress.toFixed(2)}`,
          );
        }
        world.buildings.setDoorOpen(door, false);
        if (door.pivot) door.pivot.rotation.y = 0;
        door.collider.off = false;
      }
    }
    expect(failures).toEqual([]);
  });
});
