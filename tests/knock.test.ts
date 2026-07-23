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

  it('流血值耗尽时触发最终淘汰', () => {
    const { target, knock, bleedOutKill } = knockFixture();
    knock.knockDown(target, null, false);
    knock.update(60.1);

    expect(bleedOutKill).toHaveBeenCalledWith(target);
  });
});
