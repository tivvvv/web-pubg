import { describe, expect, it } from 'vitest';
import {
  VFX_QUALITY,
  blastScreenStrength,
  tracerStreakLength,
  tracerVisualDuration,
} from '../src/effects';

describe('游戏特效参数', () => {
  it('曳光弹时长和光迹长度在近远距离保持清晰且有上限', () => {
    expect(tracerVisualDuration(0)).toBe(0.045);
    expect(tracerVisualDuration(920)).toBe(0.13);
    expect(tracerStreakLength(2)).toBe(2.4);
    expect(tracerStreakLength(400)).toBe(18);
    expect(tracerVisualDuration(100)).toBeGreaterThan(tracerVisualDuration(10));
  });

  it('爆炸屏幕反馈随距离平滑衰减并在远处归零', () => {
    expect(blastScreenStrength(0)).toBe(1);
    expect(blastScreenStrength(24)).toBe(0.5);
    expect(blastScreenStrength(48)).toBe(0);
    expect(blastScreenStrength(100)).toBe(0);
  });

  it('核心特效使用固定容量对象池', () => {
    expect(VFX_QUALITY.tracerPool).toBeGreaterThanOrEqual(40);
    expect(VFX_QUALITY.particlePool).toBeGreaterThanOrEqual(768);
    expect(VFX_QUALITY.impactMarkPool).toBeLessThanOrEqual(96);
    expect(VFX_QUALITY.blastPool).toBeGreaterThanOrEqual(4);
  });
});
