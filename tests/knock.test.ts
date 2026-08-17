import { describe, expect, it, vi } from 'vitest';
import { Character } from '../src/character';
import type { Game } from '../src/game';
import { KnockSys } from '../src/knock';

function knockFixture(): {
  reviver: Character;
  target: Character;
  knock: KnockSys;
  bleedOutKill: ReturnType<typeof vi.fn>;
  setHealCast: ReturnType<typeof vi.fn>;
} {
  const reviver = new Character('救援者', true, 0x3a6ea5);
  const target = new Character('倒地队友', false, 0x3cb36a);
  reviver.team = 'squad';
  target.team = 'squad';
  reviver.squadId = 0;
  target.squadId = 0;
  const bleedOutKill = vi.fn();
  const setHealCast = vi.fn();
  const game = {
    chars: [reviver, target],
    playerCtl: null,
    squadMates: [],
    healT: -1,
    hud: { killFeed: vi.fn(), toast: vi.fn(), setHealCast },
    audio: { warn: vi.fn(), heal: vi.fn() },
    forceExitVehicle: vi.fn(),
    cancelHeal: vi.fn(),
    bleedOutKill,
  } as unknown as Game;
  return { reviver, target, knock: new KnockSys(game), bleedOutKill, setHealCast };
}

describe('击倒与救援读条', () => {
  it('首次击倒进入趴姿并在八秒后以三十血站起', () => {
    const { reviver, target, knock, setHealCast } = knockFixture();
    target.beginAction('pickup', 1);
    target.reload01 = 0.5;
    knock.knockDown(target, null, false);

    expect(target.knocked).toBe(true);
    expect(target.knockHp).toBe(30);
    expect(target.bleedTime).toBe(60);
    expect(target.stance).toBe('prone');
    expect(target.stanceF).toBe(2);
    expect(target.actionPose).toBeNull();
    expect(target.reload01).toBe(0);

    knock.startRevive(reviver, target);
    knock.update(8);

    expect(target.knocked).toBe(false);
    expect(target.hp).toBe(30);
    expect(target.stance).toBe('stand');
    expect(reviver.reviveTarget).toBeNull();
    expect(setHealCast).toHaveBeenLastCalledWith(-1);
  });

  it('救援者移动会立即打断读条并清除关联', () => {
    const { reviver, target, knock, setHealCast } = knockFixture();
    knock.knockDown(target, null, false);
    knock.startRevive(reviver, target);
    reviver.speed2d = 0.3;
    knock.update(0.1);

    expect(reviver.reviveTarget).toBeNull();
    expect(reviver.reviveT).toBe(0);
    expect(target.rescuerId).toBe(0);
    expect(setHealCast).toHaveBeenLastCalledWith(-1);
  });

  it('被救者爬出交互范围会打断救援并给玩家反馈', () => {
    const { reviver, target, knock, setHealCast } = knockFixture();
    knock.knockDown(target, null, false);
    knock.startRevive(reviver, target);
    target.pos.x = 3;
    knock.update(0.1);

    expect(reviver.reviveTarget).toBeNull();
    expect(target.rescuerId).toBe(0);
    expect(setHealCast).toHaveBeenLastCalledWith(-1);
  });

  it('玩家可以主动取消正在进行的救援', () => {
    const { reviver, target, knock, setHealCast } = knockFixture();
    knock.knockDown(target, null, false);
    knock.startRevive(reviver, target);

    expect(knock.cancelRevive(reviver, '已取消救援')).toBe(true);
    expect(reviver.reviveTarget).toBeNull();
    expect(target.rescuerId).toBe(0);
    expect(setHealCast).toHaveBeenLastCalledWith(-1);
    expect(knock.cancelRevive(reviver)).toBe(false);
  });

  it('流血值耗尽时触发最终淘汰', () => {
    const { target, knock, bleedOutKill } = knockFixture();
    knock.knockDown(target, null, false);
    knock.update(60.1);

    expect(bleedOutKill).toHaveBeenCalledWith(target);
  });

  it('敌方小队成员使用同一套击倒与救援规则', () => {
    const { reviver, target, knock } = knockFixture();
    reviver.team = 'enemy';
    target.team = 'enemy';
    reviver.squadId = 9;
    target.squadId = 9;
    knock.knockDown(target, null, false);
    knock.startRevive(reviver, target);
    knock.update(8);

    expect(target.knocked).toBe(false);
    expect(target.hp).toBe(30);
    expect(reviver.reviveTarget).toBeNull();
  });

  it('不同敌方小队不能相互救援', () => {
    const { reviver, target, knock } = knockFixture();
    reviver.squadId = 3;
    target.squadId = 4;
    knock.knockDown(target, null, false);
    knock.startRevive(reviver, target);

    expect(reviver.reviveTarget).toBeNull();
    expect(target.rescuerId).toBe(0);
  });
});
