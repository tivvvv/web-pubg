import { describe, expect, it } from 'vitest';
import {
  makeBroadleafCrownGeometry, makeDistantRidgeGeometry, makeFernGeometry, makePineCanopyGeometry,
  makeWildflowerGeometry,
  naturalDetailBudget, shorelineSuitability, terrainSurfaceWeights,
} from '../src/nature';
import { WATER_Y } from '../src/world';

describe('地形与自然环境重制', () => {
  it('地表生态权重归一化并按环境条件切换主层', () => {
    const shore = terrainSurfaceWeights(WATER_Y + 0.15, 0.08, WATER_Y, 11, 0, 0);
    const forest = terrainSurfaceWeights(6, 0.12, WATER_Y, 80, 1, 0);
    const cliff = terrainSurfaceWeights(14, 0.82, WATER_Y, 80, 0, 0);
    for (const sample of [shore, forest, cliff]) {
      expect(Object.values(sample).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6);
      expect(Object.values(sample).every((value) => value >= 0 && value <= 1)).toBe(true);
    }
    expect(shore.sand + shore.wetSand).toBeGreaterThan(shore.meadow);
    expect(forest.forest).toBeGreaterThan(forest.dryGrass);
    expect(cliff.rock).toBeGreaterThan(0.7);
  });

  it('岸线适配只在平缓水线附近达到高值', () => {
    expect(shorelineSuitability(WATER_Y + 0.08, WATER_Y, 0.08)).toBeGreaterThan(0.7);
    expect(shorelineSuitability(WATER_Y + 2, WATER_Y, 0.08)).toBe(0);
    expect(shorelineSuitability(WATER_Y + 0.08, WATER_Y, 0.9)).toBe(0);
  });

  it('轻量设备降低实例预算但保留全部生态层', () => {
    const compact = naturalDetailBudget(4);
    const full = naturalDetailBudget(10);
    expect(compact.grass).toBeLessThan(full.grass);
    expect(compact.understory).toBeGreaterThan(0);
    expect(compact.flowers).toBeGreaterThan(0);
    expect(compact.shore).toBeGreaterThan(0);
    expect(full.screePerRock).toBeGreaterThan(compact.screePerRock);
  });

  it('自然物程序几何具有可渲染顶点与法线', () => {
    for (const geometry of [
      makeFernGeometry(), makeWildflowerGeometry(), makePineCanopyGeometry(),
      makeBroadleafCrownGeometry(), makeDistantRidgeGeometry(1.2),
    ]) {
      expect(geometry.getAttribute('position').count).toBeGreaterThan(12);
      expect(geometry.getAttribute('normal').count).toBe(geometry.getAttribute('position').count);
    }
  });

  it('树冠资产具有多层次轮廓而不是单一几何体', () => {
    expect(makePineCanopyGeometry().getAttribute('position').count).toBeGreaterThanOrEqual(200);
    expect(makeBroadleafCrownGeometry().getAttribute('position').count).toBeGreaterThanOrEqual(150);
  });
});
