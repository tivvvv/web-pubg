import { describe, expect, it } from 'vitest';
import { shouldShowSwimmingStatus } from '../src/hud';

describe('HUD 状态互斥', () => {
  it('仅在游泳且未空降时显示游泳标记', () => {
    expect(shouldShowSwimmingStatus(true, false)).toBe(true);
    expect(shouldShowSwimmingStatus(false, false)).toBe(false);
    expect(shouldShowSwimmingStatus(true, true)).toBe(false);
    expect(shouldShowSwimmingStatus(false, true)).toBe(false);
  });
});
