import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  BOMBARDMENT_BOUNDARY_HALF_WIDTH,
  BOMBARDMENT_BOUNDARY_MARKERS,
  BOMBARDMENT_TIMING,
  bombardmentEscapeVector,
  bombardmentHudText,
} from '../src/bombardment';

describe('轰炸区避险方向', () => {
  it('边界使用密集低矮信标和方向标识', () => {
    expect(BOMBARDMENT_BOUNDARY_MARKERS).toEqual({ posts: 24, chevrons: 32, signs: 8 });
  });

  it('贴地高亮边界带具备足够辨识宽度', () => {
    expect(BOMBARDMENT_BOUNDARY_HALF_WIDTH).toBeGreaterThanOrEqual(0.8);
    expect(BOMBARDMENT_BOUNDARY_HALF_WIDTH).toBeLessThanOrEqual(1.2);
  });

  it('首轮和后续轰炸保留充足搜索与转移间隔', () => {
    expect(BOMBARDMENT_TIMING.initialCooldownMin).toBeGreaterThanOrEqual(80);
    expect(BOMBARDMENT_TIMING.initialCooldownMax).toBeGreaterThan(BOMBARDMENT_TIMING.initialCooldownMin);
    expect(BOMBARDMENT_TIMING.repeatCooldownMin).toBeGreaterThanOrEqual(90);
    expect(BOMBARDMENT_TIMING.warning).toBeGreaterThanOrEqual(15);
    expect(BOMBARDMENT_TIMING.shellIntervalMin).toBeGreaterThanOrEqual(0.9);
  });

  it('区内角色获得指向圈外的单位方向', () => {
    const out = new THREE.Vector2();
    expect(bombardmentEscapeVector('warning', 10, 20, 30, 16, 28, out)).toBe(true);
    expect(out.length()).toBeCloseTo(1, 6);
    expect(out.x).toBeGreaterThan(0);
    expect(out.y).toBeGreaterThan(0);
  });

  it('中心点使用稳定方向且区外与空闲状态不触发避险', () => {
    const out = new THREE.Vector2();
    expect(bombardmentEscapeVector('active', 0, 0, 30, 0, 0, out)).toBe(true);
    expect(out.toArray()).toEqual([1, 0]);
    expect(bombardmentEscapeVector('active', 0, 0, 30, 40, 0, out)).toBe(false);
    expect(bombardmentEscapeVector('idle', 0, 0, 30, 2, 0, out)).toBe(false);
  });

  it('HUD 明确区分区内危险和区外距离', () => {
    expect(bombardmentHudText('warning', 12.2, 0, 0, 30, 4, 5))
      .toContain('你在轰炸区内');
    expect(bombardmentHudText('warning', 12.2, 0, 0, 30, 42, 0))
      .toContain('距你 12m');
    expect(bombardmentHudText('active', 8, 0, 0, 30, 0, 0))
      .toContain('炮火正在落下');
    expect(bombardmentHudText('idle', 0, 0, 0, 30, 0, 0)).toBeNull();
  });
});
