import { describe, expect, it } from 'vitest';
import {
  playerDeathDetail,
  resolvePlayerFlowCue,
  shouldCelebrateFirstGun,
  type PlayerFlowInput,
} from '../src/playerflow';

const base: PlayerFlowInput = {
  descent: null,
  jumpReady: false,
  outsideZone: false,
  knocked: false,
  hasGun: true,
  hp: 100,
  healCount: 0,
  secondsSinceLanded: 20,
  secondsSinceArmed: 20,
};

describe('玩家流程行动提示', () => {
  it('空降阶段只显示当前可执行动作', () => {
    expect(resolvePlayerFlowCue({ ...base, descent: 'plane', jumpReady: false })?.title).toBe('航线准备');
    expect(resolvePlayerFlowCue({ ...base, descent: 'plane', jumpReady: true })?.title).toBe('跳伞窗口已开启');
    expect(resolvePlayerFlowCue({ ...base, descent: 'freefall' })?.detail).toContain('Space');
    expect(resolvePlayerFlowCue({ ...base, descent: 'canopy' })?.title).toBe('准备着陆');
  });

  it('落地后优先引导空手玩家搜寻武器', () => {
    const cue = resolvePlayerFlowCue({ ...base, hasGun: false, secondsSinceLanded: 1 });
    expect(cue).toEqual({
      title: '搜寻武器',
      detail: '靠近武器按 F 拾取',
      tone: 'warning',
    });
  });

  it('圈外和低血量反馈覆盖普通阶段提示', () => {
    expect(resolvePlayerFlowCue({ ...base, outsideZone: true, hasGun: false })?.title).toBe('立即进圈');
    expect(resolvePlayerFlowCue({ ...base, hp: 30, healCount: 1 })?.detail).toContain('按 X');
    expect(resolvePlayerFlowCue({ ...base, hp: 30, healCount: 0 })?.detail).toContain('缺少恢复品');
    expect(resolvePlayerFlowCue({ ...base, hp: 30, hasGun: false })?.title).toBe('生命危险');
  });

  it('击倒状态交给专用横幅且稳定状态不占用界面', () => {
    expect(resolvePlayerFlowCue({ ...base, knocked: true, outsideZone: true })).toBeNull();
    expect(resolvePlayerFlowCue(base)).toBeNull();
  });

  it('只有从无枪到有枪的第一次转换触发武装完成', () => {
    expect(shouldCelebrateFirstGun(false, -1)).toBe(true);
    expect(shouldCelebrateFirstGun(true, -1)).toBe(false);
    expect(shouldCelebrateFirstGun(false, 12)).toBe(false);
  });
});

describe('失败结算原因', () => {
  it('区分敌人爆头, 环境伤害和自身爆炸', () => {
    expect(playerDeathDetail({
      attackerName: '对手',
      via: null,
      headshot: true,
      selfInflicted: false,
    })).toBe('对手爆头将你淘汰');
    expect(playerDeathDetail({
      attackerName: null,
      via: '轰炸区',
      headshot: false,
      selfInflicted: false,
    })).toBe('你死于轰炸区');
    expect(playerDeathDetail({
      attackerName: '你',
      via: '手雷',
      headshot: false,
      selfInflicted: true,
    })).toBe('你被自己的手雷淘汰');
  });
});
