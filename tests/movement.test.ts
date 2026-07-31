import { describe, expect, it } from 'vitest';
import { resolveMovementDirection, wadingSpeedMultiplier } from '../src/movement';

describe('玩家移动输入', () => {
  it('相反方向准确抵消', () => {
    expect(resolveMovementDirection(0, {
      forward: true,
      backward: true,
      left: false,
      right: false,
    })).toEqual({ x: 0, z: 0, length: 0, forward: 0, strafe: 0 });
  });

  it('斜后移动不会偏向后退轴且速度保持归一', () => {
    const movement = resolveMovementDirection(0, {
      forward: false,
      backward: true,
      left: true,
      right: false,
    });
    expect(movement.forward).toBeCloseTo(-Math.SQRT1_2);
    expect(movement.strafe).toBeCloseTo(-Math.SQRT1_2);
    expect(Math.hypot(movement.x, movement.z)).toBeCloseTo(1);
  });

  it('世界方向随视角旋转', () => {
    const movement = resolveMovementDirection(Math.PI / 2, {
      forward: true,
      backward: false,
      left: false,
      right: false,
    });
    expect(movement.x).toBeCloseTo(1);
    expect(movement.z).toBeCloseTo(0);
  });

  it('涉水减速有上下限且随水深连续增强', () => {
    expect(wadingSpeedMultiplier(-1)).toBeCloseTo(0.84);
    expect(wadingSpeedMultiplier(0.425)).toBeCloseTo(0.695);
    expect(wadingSpeedMultiplier(2)).toBeCloseTo(0.55);
  });
});
