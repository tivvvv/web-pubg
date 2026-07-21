import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Zone, ZONE_PHASES } from '../src/zone';

function canvasStub(): HTMLCanvasElement {
  const gradient = { addColorStop: vi.fn() };
  const context = {
    createLinearGradient: vi.fn(() => gradient),
    fillRect: vi.fn(),
    fillStyle: '',
  };
  return { width: 0, height: 0, getContext: vi.fn(() => context) } as unknown as HTMLCanvasElement;
}

describe('毒圈完整阶段流程', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { createElement: vi.fn(() => canvasStub()) });
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => vi.restoreAllMocks());

  it('圈内外和圈外距离使用当前圆心半径', () => {
    const zone = new Zone(new THREE.Scene());
    expect(zone.isOutside(zone.center.x, zone.center.y)).toBe(false);
    expect(zone.isOutside(zone.center.x + zone.radius + 0.1, zone.center.y)).toBe(true);
    expect(zone.distOutside(zone.center.x + zone.radius + 5, zone.center.y)).toBeCloseTo(5, 8);
  });

  it('全部六阶段结束于九米最终圈且半径从不增大', () => {
    const zone = new Zone(new THREE.Scene());
    let previousRadius = zone.radius;
    const totalTime = ZONE_PHASES.reduce((sum, phase) => sum + phase.wait + phase.shrink, 0);
    for (let elapsed = 0; elapsed < totalTime + 1; elapsed += 0.1) {
      zone.update(0.1);
      expect(zone.radius).toBeLessThanOrEqual(previousRadius + 1e-8);
      expect(zone.center.distanceTo(zone.nextCenter) + zone.nextRadius).toBeLessThanOrEqual(zone.radius + 1e-7);
      previousRadius = zone.radius;
    }
    expect(zone.state).toBe('done');
    expect(zone.phase).toBe(ZONE_PHASES.length);
    expect(zone.radius).toBe(9);
    expect(zone.statusText()).toBe('最终圈');
  });

  it('单次大步推进和小步推进得到相同阶段结果', () => {
    const largeStep = new Zone(new THREE.Scene());
    const smallSteps = new Zone(new THREE.Scene());
    largeStep.update(100);
    for (let i = 0; i < 1000; i++) smallSteps.update(0.1);
    expect(largeStep.state).toBe(smallSteps.state);
    expect(largeStep.phase).toBe(smallSteps.phase);
    expect(largeStep.timer).toBeCloseTo(smallSteps.timer, 6);
    expect(largeStep.radius).toBeCloseTo(smallSteps.radius, 6);
    expect(largeStep.center.distanceTo(smallSteps.center)).toBeLessThan(1e-6);
  });
});
