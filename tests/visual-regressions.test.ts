import { describe, expect, it } from 'vitest';
import { ownModelVisibility } from '../src/character';
import { environmentLighting } from '../src/environment';
import { RENDER_QUALITY } from '../src/rendering';
import { SUN_SHADOW_MAP_SIZE } from '../src/world';

describe('画面回归保护', () => {
  it('第一人称趴下隐藏会穿入相机的自身模型', () => {
    expect(ownModelVisibility(false, 2)).toEqual({ head: true, body: true, hands: true });
    expect(ownModelVisibility(true, 0)).toEqual({ head: false, body: false, hands: true });
    expect(ownModelVisibility(true, 1)).toEqual({ head: false, body: false, hands: true });
    expect(ownModelVisibility(true, 1.1)).toEqual({ head: false, body: false, hands: false });
    expect(ownModelVisibility(true, 2)).toEqual({ head: false, body: false, hands: false });
  });

  it('夜间补光高于旧基线且白天亮度保持稳定', () => {
    const day = environmentLighting(1, 1, 0, 0);
    const clearNight = environmentLighting(0, 1, 0, 0);
    const rainyNight = environmentLighting(0, 0.86, 0.76, 0.16);

    expect(day.hemiIntensity).toBeCloseTo(1.14, 5);
    expect(day.exposure).toBeCloseTo(1.08, 5);
    expect(clearNight.hemiIntensity).toBeGreaterThanOrEqual(0.85);
    expect(clearNight.exposure).toBeCloseTo(1.35, 5);
    expect(rainyNight.hemiIntensity).toBeGreaterThan(clearNight.hemiIntensity);
    expect(rainyNight.exposure).toBeGreaterThan(clearNight.exposure);
  });

  it('性能优化不能降低核心渲染质量基线', () => {
    expect(RENDER_QUALITY).toEqual({
      antialias: true,
      maxPixelRatio: 1.5,
      shadows: true,
      baseExposure: 1.08,
    });
    expect(SUN_SHADOW_MAP_SIZE).toBe(2048);
  });
});
