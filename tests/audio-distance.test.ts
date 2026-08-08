import { describe, expect, it } from 'vitest';
import {
  footstepDistanceProfile,
  meleeDistanceProfile,
  motionWhooshDistanceProfile,
} from '../src/audio';

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

  it('挥拳只在近距离清楚可闻且十一米外完全静音', () => {
    const self = meleeDistanceProfile(0);
    const close = meleeDistanceProfile(2);
    const middle = meleeDistanceProfile(5);
    const far = meleeDistanceProfile(9);
    const silent = meleeDistanceProfile(11);
    expect(self.gain).toBe(1);
    expect(close.gain).toBeGreaterThan(middle.gain * 4);
    expect(middle.gain).toBeGreaterThan(far.gain * 8);
    expect(silent.gain).toBe(0);
    expect(far.lowpassHz).toBeLessThan(close.lowpassHz);
  });

  it('墙体遮挡会同时降低响度和高频细节', () => {
    const openStep = footstepDistanceProfile(8);
    const blockedStep = footstepDistanceProfile(8, true);
    const openMelee = meleeDistanceProfile(3);
    const blockedMelee = meleeDistanceProfile(3, true);
    expect(blockedStep.gain).toBeLessThan(openStep.gain * 0.4);
    expect(blockedStep.lowpassHz).toBeLessThanOrEqual(1250);
    expect(blockedMelee.gain).toBeLessThan(openMelee.gain * 0.3);
    expect(blockedMelee.lowpassHz).toBeLessThanOrEqual(1050);
  });

  it('翻越与投掷风声比挥拳传播范围更短', () => {
    expect(motionWhooshDistanceProfile(3).gain).toBeGreaterThan(0);
    expect(motionWhooshDistanceProfile(7).gain).toBeLessThan(0.01);
    expect(motionWhooshDistanceProfile(8).gain).toBe(0);
  });
});
