import { describe, expect, it } from 'vitest';
import {
  doorColliderDisabled, doorOpenAngleForActor, GABLE_ROOF_COURSES, gableRoofPitch, REGIONAL_BUILDING_STYLES,
  regionalBuildingStyle, stairRailX,
} from '../src/buildings';
import { REGIONS } from '../src/regions';

describe('建筑门交互方向', () => {
  it('精细坡屋顶瓦层保持成对对称且高度逐级上升', () => {
    expect(GABLE_ROOF_COURSES).toHaveLength(6);
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
    expect(gableRoofPitch(8)).toBeLessThan(0.3);
    expect(gableRoofPitch(12)).toBeLessThan(gableRoofPitch(8));
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

  it('靠两侧外墙的楼梯把扶手放在各自开放侧', () => {
    expect(stairRailX(2, 4, 'max')).toBe(4);
    expect(stairRailX(8, 10, 'min')).toBe(8);
  });
});
