import { describe, expect, it } from 'vitest';
import { emptyAttachments } from '../src/attachments';
import { calculateWeaponSpread, scopeModeOf, smoothAimProgress } from '../src/gunplay';
import { WEAPONS } from '../src/weapons';

const rifle = { def: WEAPONS.rifle, mag: 30, att: emptyAttachments() };

describe('枪械操控模型', () => {
  it('ADS 逐步进入且帧率变化不会明显改变耗时', () => {
    let at60 = 0;
    let at30 = 0;
    for (let i = 0; i < 30; i++) at60 = smoothAimProgress(at60, true, 'rifle', 1 / 60);
    for (let i = 0; i < 15; i++) at30 = smoothAimProgress(at30, true, 'rifle', 1 / 30);
    expect(at60).toBeGreaterThan(0.98);
    expect(Math.abs(at60 - at30)).toBeLessThan(0.001);
  });

  it('蹲姿 ADS 静止散布小于站立腰射移动散布', () => {
    const stable = calculateWeaponSpread({
      gun: rifle, aimProgress: 1, stance: 'crouch', speed: 0, grounded: true, bloom: 0,
    });
    const moving = calculateWeaponSpread({
      gun: rifle, aimProgress: 0, stance: 'stand', speed: 6.9, grounded: true, bloom: 0,
    });
    expect(stable).toBeLessThan(moving * 0.2);
  });

  it('每种瞄具在完成 ADS 后返回独立模式', () => {
    expect(scopeModeOf({ ...rifle, att: { ...emptyAttachments(), sight: 'reddot' } }, 1)).toBe('reddot');
    expect(scopeModeOf({ ...rifle, att: { ...emptyAttachments(), sight: 'scope2' } }, 1)).toBe('scope2');
    expect(scopeModeOf({ ...rifle, att: { ...emptyAttachments(), sight: 'scope4' } }, 1)).toBe('scope4');
    expect(scopeModeOf(rifle, 0.5)).toBe('none');
  });
});
