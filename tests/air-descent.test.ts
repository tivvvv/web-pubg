import { describe, expect, it } from 'vitest';
import { CANOPY_DEPLOY_VELOCITY, stepAirDescentVelocity } from '../src/character';

function simulate(vy: number, phase: 'freefall' | 'canopy', seconds: number, step = 1 / 60): number {
  for (let elapsed = 0; elapsed < seconds; elapsed += step) {
    vy = stepAirDescentVelocity(vy, phase, step);
  }
  return vy;
}

describe('共享空降垂直物理', () => {
  it('自由落体稳定逼近终端速度且不会越界', () => {
    const afterTenSeconds = simulate(-2, 'freefall', 10);
    expect(afterTenSeconds).toBeGreaterThanOrEqual(-55);
    expect(afterTenSeconds).toBeLessThan(-54.9);
  });

  it('开伞速度平滑稳定到低速终端值', () => {
    const afterThreeSeconds = simulate(CANOPY_DEPLOY_VELOCITY, 'canopy', 3);
    expect(afterThreeSeconds).toBeGreaterThanOrEqual(-10);
    expect(afterThreeSeconds).toBeLessThan(-9.99);
  });

  it('不同帧率下结果保持一致', () => {
    const at30 = simulate(-2, 'freefall', 4, 1 / 30);
    const at144 = simulate(-2, 'freefall', 4, 1 / 144);
    expect(Math.abs(at30 - at144)).toBeLessThan(0.05);
  });
});
