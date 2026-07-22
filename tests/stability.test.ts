import { describe, expect, it } from 'vitest';
import {
  MatchStabilityMonitor,
  parseBoundedTestInteger,
  validateRoundReset,
  type StabilityActorSample,
  type StabilityResourceSnapshot,
} from '../src/stability';

const actor = (overrides: Partial<StabilityActorSample> = {}): StabilityActorSample => ({
  id: 1,
  name: 'bot',
  alive: true,
  active: true,
  trackMovement: true,
  x: 0,
  y: 1,
  z: 0,
  hp: 100,
  mode: 'rotate',
  ...overrides,
});

describe('长局稳定性监控', () => {
  it('移动意图持续不产生位移时报告卡住', () => {
    const monitor = new MatchStabilityMonitor(8, 0.8);
    monitor.update(0, [actor()]);
    expect(monitor.update(7.9, [actor()]).issues).toEqual([]);
    expect(monitor.update(8.1, [actor()]).issues).toContain('stuck:1:rotate');
  });

  it('有效位移会重置停滞计时', () => {
    const monitor = new MatchStabilityMonitor(8, 0.8);
    monitor.update(0, [actor()]);
    monitor.update(6, [actor({ x: 1 })]);
    expect(monitor.update(12, [actor({ x: 1 })]).issues).toEqual([]);
    expect(monitor.update(12, [actor({ x: 1 })]).maxStagnantSec).toBe(6);
  });

  it('检测非法角色状态和存活数回升', () => {
    const monitor = new MatchStabilityMonitor();
    monitor.update(0, [actor(), actor({ id: 2 })]);
    monitor.update(1, [actor()]);
    const summary = monitor.update(2, [actor(), actor({ id: 2, x: Number.NaN })]);
    expect(summary.issues).toContain('alive-count-increased:1:2');
    expect(summary.issues).toContain('non-finite:2');
  });

  it('重开后核心资源数量必须恢复基线', () => {
    const baseline: StabilityResourceSnapshot = {
      characters: 24, bots: 20, lootItems: 195, lootPool: 195, vehicles: 10, sceneChildren: 18,
      activeDeathCrates: 0, deathCratePool: 0,
    };
    expect(validateRoundReset(
      baseline,
      { ...baseline, lootItems: 209, lootPool: 209, deathCratePool: 18 },
      20,
      240,
    )).toEqual([]);
    expect(validateRoundReset(baseline, { ...baseline, characters: 25, activeDeathCrates: 1 }, 20)).toEqual([
      'resource-mismatch:characters:24:25',
      'active-death-crates:1',
    ]);
    expect(validateRoundReset(baseline, { ...baseline, lootPool: 241 }, 20, 240)).toEqual([
      'loot-pool:241:195:240',
    ]);
  });

  it('加速倍率和轮数参数始终限制在安全范围', () => {
    expect(parseBoundedTestInteger('?steps=8', 'steps', 1, 1, 12)).toBe(8);
    expect(parseBoundedTestInteger('?steps=99', 'steps', 1, 1, 12)).toBe(12);
    expect(parseBoundedTestInteger('?steps=bad', 'steps', 3, 1, 12)).toBe(3);
  });
});
