import { describe, expect, it } from 'vitest';
import { doorOpenAngleForActor, stairRailX } from '../src/buildings';

describe('建筑门交互方向', () => {
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

  it('靠两侧外墙的楼梯把扶手放在各自开放侧', () => {
    expect(stairRailX(2, 4, 'max')).toBe(4);
    expect(stairRailX(8, 10, 'min')).toBe(8);
  });
});
