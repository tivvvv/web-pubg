import { describe, expect, it } from 'vitest';
import {
  compactHealCounts, healthFeedback, matchCountLabels, selectQueuedToast, shouldShowSwimmingStatus,
  toastShouldInterrupt,
} from '../src/hud';

describe('HUD 状态互斥', () => {
  it('所有人数文案统一使用正式对局人数', () => {
    expect(matchCountLabels()).toEqual({
      alive: '剩余 64',
      start: '64 人孤岛大逃杀 · 16 支四人小队 · 活到最后',
      death: '#16 / 16',
      win: '#1 / 16',
    });
  });

  it('恢复品栏隐藏零数量并压缩成短文案', () => {
    expect(compactHealCounts(0, 0, 0)).toBe('');
    expect(compactHealCounts(2, 0, 1)).toBe('绷带 2 · 饮料 1');
  });

  it('低血量反馈平滑增强且仅在存活的危急血量脉动', () => {
    expect(healthFeedback(100)).toEqual({ opacity: 0, critical: false });
    expect(healthFeedback(55)).toEqual({ opacity: 0, critical: false });
    expect(healthFeedback(25).opacity).toBeGreaterThan(0.35);
    expect(healthFeedback(25).critical).toBe(true);
    expect(healthFeedback(0)).toEqual({ opacity: 0.72, critical: false });
  });

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
