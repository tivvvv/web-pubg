import { describe, expect, it } from 'vitest';
import {
  playerDeathDetail,
  shouldCelebrateFirstGun,
} from '../src/playerflow';

describe('玩家流程反馈', () => {
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
