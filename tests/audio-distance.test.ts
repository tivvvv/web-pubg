import { describe, expect, it } from 'vitest';
import { footstepDistanceProfile } from '../src/audio';

describe('脚步距离声学', () => {
  it('近中远脚步有明显分级且远声失去高频', () => {
    const near = footstepDistanceProfile(2);
    const middle = footstepDistanceProfile(14);
    const far = footstepDistanceProfile(32);
    expect(near.gain).toBeGreaterThan(middle.gain * 2);
    expect(middle.gain).toBeGreaterThan(far.gain * 2);
    expect(near.lowpassHz).toBeGreaterThan(6000);
    expect(far.lowpassHz).toBeLessThan(1800);
    expect(far.delaySeconds).toBeGreaterThan(0.08);
  });
});
