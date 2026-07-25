import { describe, expect, it } from 'vitest';
import { selectQueuedToast, shouldShowSwimmingStatus, toastShouldInterrupt } from '../src/hud';

describe('HUD 状态互斥', () => {
  it('仅在游泳且未空降时显示游泳标记', () => {
    expect(shouldShowSwimmingStatus(true, false)).toBe(true);
    expect(shouldShowSwimmingStatus(false, false)).toBe(false);
    expect(shouldShowSwimmingStatus(true, true)).toBe(false);
    expect(shouldShowSwimmingStatus(false, true)).toBe(false);
  });

  it('关键反馈不会被普通拾取提示覆盖', () => {
    expect(toastShouldInterrupt('danger', 'info')).toBe(false);
    expect(toastShouldInterrupt('warning', 'success')).toBe(false);
    expect(toastShouldInterrupt('info', 'warning')).toBe(true);
    expect(toastShouldInterrupt('warning', 'danger')).toBe(true);
    expect(toastShouldInterrupt('info', 'info')).toBe(true);
  });

  it('等待展示的高优先级反馈不会被后来普通消息替换', () => {
    const warning = { message: '护甲损坏', tone: 'warning' as const };
    const info = { message: '拾取弹药', tone: 'info' as const };
    const danger = { message: '轰炸开始', tone: 'danger' as const };

    expect(selectQueuedToast(warning, info)).toBe(warning);
    expect(selectQueuedToast(info, warning)).toBe(warning);
    expect(selectQueuedToast(warning, danger)).toBe(danger);
  });
});
