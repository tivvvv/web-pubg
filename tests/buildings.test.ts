import { describe, expect, it } from 'vitest';
import {
  apartmentFloorLayout, doorColliderDisabled, doorLeafSegment, doorOpenAngleForActor, GABLE_INFILL_LAYERS, GABLE_ROOF_COURSES,
  GABLE_ROOF_RISE,
  entranceStepProfile, facadeSegments, gableRoofPitch, interiorWallPanelInset, mainEntranceHalfWidth, REGIONAL_BUILDING_STYLES, regionalBuildingStyle, resolveCircleAgainstDoorLeaf,
  stairHandrailTransform, stairRailX,
} from '../src/buildings';
import type { AabbCollider } from '../src/types';
import { REGIONS } from '../src/regions';

describe('建筑门交互方向', () => {
  it('门廊台阶按地基高差细分且从地面到室内无需跳跃', () => {
    for (const [floorY, groundY] of [[2.4, 2.05], [3.2, 1.65], [5.1, 2.9]] as const) {
      const profile = entranceStepProfile(floorY, groundY);
      const walkPath = [groundY, ...profile.tops.slice().reverse(), floorY];
      expect(profile.count).toBeGreaterThanOrEqual(3);
      expect(profile.count).toBeLessThanOrEqual(8);
      expect(profile.depth).toBeGreaterThanOrEqual(profile.count * 0.42);
      for (let i = 1; i < walkPath.length; i++) {
        expect((walkPath[i] as number) - (walkPath[i - 1] as number)).toBeLessThanOrEqual(0.36);
      }
    }
  });

  it('正立面装饰为不同原型保留完整主入口净宽', () => {
    expect(mainEntranceHalfWidth('apartment')).toBeGreaterThan(mainEntranceHalfWidth('cottage2'));
    expect(mainEntranceHalfWidth('gym')).toBe(mainEntranceHalfWidth('apartment'));
    expect(mainEntranceHalfWidth('shop')).toBeGreaterThan(mainEntranceHalfWidth('cottage1'));
  });

  it('连续墙脚按多个真实门洞切段并保留安全余量', () => {
    expect(facadeSegments(0, 12, [[4, 5], [7, 8]], 0.2)).toEqual([
      [0, 3.8], [5.2, 6.8], [8.2, 12],
    ]);
    expect(facadeSegments(0, 12, [[4, 6], [5, 8]], 0.1)).toEqual([
      [0, 3.9], [8.1, 12],
    ]);
  });

  it('室内护墙板贴紧墙面而不是悬空形成可穿透挡板', () => {
    expect(interiorWallPanelInset(0.26)).toBeCloseTo(0.175, 6);
    expect(interiorWallPanelInset(0.14)).toBeCloseTo(0.115, 6);
    expect(interiorWallPanelInset(0.26)).toBeLessThan(0.2);
  });

  it('高楼楼层包含大厅住宅办公休息和设备五种格局', () => {
    const layouts = Array.from({ length: 7 }, (_, level) => apartmentFloorLayout(level, 7));
    expect(layouts).toEqual(['lobby', 'residence', 'office', 'lounge', 'residence', 'office', 'utility']);
    expect(new Set(layouts).size).toBe(5);
    for (let level = 1; level < layouts.length; level++) {
      expect(layouts[level]).not.toBe(layouts[level - 1]);
    }
  });
  it('精细坡屋顶瓦层保持成对对称且高度逐级上升', () => {
    expect(GABLE_ROOF_COURSES).toHaveLength(10);
    for (let i = 0; i < GABLE_ROOF_COURSES.length; i += 2) {
      const left = GABLE_ROOF_COURSES[i];
      const right = GABLE_ROOF_COURSES[i + 1];
      expect(left).toBeDefined();
      expect(right).toBeDefined();
      if (!left || !right) continue;
      expect(left.z + right.z).toBeCloseTo(1, 6);
      expect(left.y).toBe(right.y);
      if (i > 0) expect(left.y).toBeGreaterThan(GABLE_ROOF_COURSES[i - 2]?.y ?? 0);
    }
    expect(gableRoofPitch(8)).toBeGreaterThan(0.1);
    expect(gableRoofPitch(8)).toBeLessThan(0.5);
    expect(gableRoofPitch(12)).toBeLessThan(gableRoofPitch(8));
    expect(GABLE_ROOF_RISE / GABLE_INFILL_LAYERS).toBeLessThanOrEqual(0.08);
  });

  it('六个区域拥有独立建筑主色和完整立面风格', () => {
    expect(Object.keys(REGIONAL_BUILDING_STYLES)).toHaveLength(REGIONS.length);
    const accents = new Set(REGIONS.map((region) => regionalBuildingStyle(region.id).accent));
    expect(accents.size).toBe(REGIONS.length);
    for (const region of REGIONS) {
      const style = regionalBuildingStyle(region.id);
      expect(style.walls.length).toBeGreaterThanOrEqual(3);
      expect(style.roofs.length).toBeGreaterThanOrEqual(2);
      expect(style.chimneyChance).toBeGreaterThanOrEqual(0);
      expect(style.acChance).toBeLessThanOrEqual(1);
    }
  });

  it('沿 X 的门向远离操作者的 Z 方向打开', () => {
    const fromNorth = doorOpenAngleForActor('x', 10, 20, 10, 18, 0.5);
    const fromSouth = doorOpenAngleForActor('x', 10, 20, 10, 22, 0.5);

    expect(fromNorth).toBeLessThan(0);
    expect(fromSouth).toBeGreaterThan(0);
    expect(Math.abs(fromNorth)).toBeCloseTo(Math.abs(fromSouth), 6);
  });

  it('沿 Z 的门向远离操作者的 X 方向打开并保留贴门回退方向', () => {
    expect(doorOpenAngleForActor('z', 10, 20, 8, 20, 0.5)).toBeGreaterThan(0);
    expect(doorOpenAngleForActor('z', 10, 20, 12, 20, 0.5)).toBeLessThan(0);
    expect(doorOpenAngleForActor('z', 10, 20, 10.01, 20, 0.5)).toBe(0.5);
  });

  it('双开门两侧铰链使用相反转角', () => {
    const left = doorOpenAngleForActor('x', 9, 20, 9, 18, 0.5, 1);
    const right = doorOpenAngleForActor('x', 11, 20, 11, 18, -0.5, -1);

    expect(left).toBeLessThan(0);
    expect(right).toBeGreaterThan(0);
  });

  it('关门动画接近门框后才恢复碰撞且破门永久放行', () => {
    expect(doorColliderDisabled(true, true, 0.8)).toBe(true);
    expect(doorColliderDisabled(true, false, 0.7)).toBe(true);
    expect(doorColliderDisabled(true, false, 0.11)).toBe(false);
    expect(doorColliderDisabled(false, false, 0)).toBe(true);
  });

  it('门扇碰撞随铰链和开门角度旋转', () => {
    const collider: AabbCollider = {
      kind: 'aabb', minX: 2, minY: 0, minZ: 4.95,
      maxX: 3.3, maxY: 2.2, maxZ: 5.05, tag: 'door',
    };
    const closed = doorLeafSegment(collider, 'x', 1, 0);
    expect(closed.hingeX).toBe(2);
    expect(closed.endX).toBeCloseTo(3.3, 6);
    expect(closed.endZ).toBeCloseTo(5, 6);

    const opened = doorLeafSegment(collider, 'x', 1, -Math.PI / 2);
    expect(opened.endX).toBeCloseTo(2, 6);
    expect(opened.endZ).toBeCloseTo(6.3, 6);
  });

  it('角色无法穿过打开后的门板', () => {
    const point = { x: 2.45, z: 5.02 };
    const hit = resolveCircleAgainstDoorLeaf(point, 0.38, {
      hingeX: 2,
      hingeZ: 5,
      endX: 3.3,
      endZ: 5,
    });
    expect(hit).toBe(true);
    expect(point.z).toBeGreaterThanOrEqual(5.43);
    expect(resolveCircleAgainstDoorLeaf({ x: 2.6, z: 5.8 }, 0.38, {
      hingeX: 2,
      hingeZ: 5,
      endX: 3.3,
      endZ: 5,
    })).toBe(false);
  });

  it('靠两侧外墙的楼梯把扶手放在各自开放侧', () => {
    expect(stairRailX(2, 4, 'max')).toBe(4);
    expect(stairRailX(8, 10, 'min')).toBe(8);
  });

  it('正反方向楼梯都生成贯穿整跑的连续斜扶手', () => {
    const forward = stairHandrailTransform(2, 8, 3, 0.32, 9);
    const reverse = stairHandrailTransform(8, 2, 3, 0.32, 9);
    const postSpan = 8 / 9;
    expect(forward.centerZ).toBe(5);
    expect(reverse.centerZ).toBe(5);
    expect(forward.centerY).toBeCloseTo(reverse.centerY, 6);
    expect(forward.length).toBeCloseTo(Math.hypot(6 * postSpan, 2.56) - 0.32, 6);
    expect(reverse.length).toBeCloseTo(forward.length, 6);
    expect(forward.pitch).toBeLessThan(0);
    expect(reverse.pitch).toBeGreaterThan(0);
    expect(Math.abs(forward.pitch)).toBeCloseTo(Math.abs(reverse.pitch), 6);
    const halfRise = Math.sin(Math.abs(forward.pitch)) * forward.length / 2;
    expect(forward.centerY - halfRise).toBeGreaterThan(3 + 0.32 + 0.83);
    expect(forward.centerY + halfRise).toBeLessThan(3 + 0.32 * 9 + 0.83);
  });
});
