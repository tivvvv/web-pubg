import { describe, expect, it, vi } from 'vitest';
import { Character } from '../src/character';
import type { Game } from '../src/game';
import { KnockSys } from '../src/knock';
import { TeammateController } from '../src/teammate';

describe('机器人队友持续救援', () => {
  it('救援开始后不会被环境威胁和其他战术任务中途抢占', () => {
    const mate = new TeammateController('队友1', 0x3cb36a, 0);
    const player = new Character('玩家', true, 0x3a6ea5);
    player.team = 'squad';
    player.knocked = true;
    player.hp = 0;
    player.knockHp = 30;
    player.bleedTime = 60;
    player.pos.set(1.55, 3, 0);
    mate.char.pos.set(0, 3, 0);
    mate.char.grounded = true;

    const fleeBombardment = vi.fn(() => true);
    const fleeGrenade = vi.fn(() => ({ x: 0.5, z: 0.5 }));
    const game = {
      chars: [mate.char, player],
      playerCtl: { char: player, driving: null },
      squadMates: [mate],
      squadOrder: { kind: 'follow', serial: 0, issuedAt: 0, yaw: 0, targetId: 0, x: 0, y: 0, z: 0 },
      bombardment: { escapeVector: fleeBombardment },
      grenades: { nearestLiveFrag: fleeGrenade },
      hud: { killFeed: vi.fn(), toast: vi.fn(), setHealCast: vi.fn() },
      audio: { warn: vi.fn(), heal: vi.fn() },
      bleedOutKill: vi.fn(),
    } as unknown as Game;
    const knock = new KnockSys(game);
    (game as unknown as { knock: KnockSys }).knock = knock;

    knock.startRevive(mate.char, player);
    knock.update(3.9);
    expect(mate.char.reviveT).toBeCloseTo(3.9);

    // 模拟上一帧导航残留速度；队友更新必须原地锁定救援，不能进入避险或跟随分支。
    mate.char.speed2d = 4.5;
    mate.update(0.1, game);

    expect(mate.commandState).toBe('reviving');
    expect(mate.char.reviveTarget).toBe(player);
    expect(mate.char.speed2d).toBe(0);
    expect(fleeBombardment).not.toHaveBeenCalled();
    expect(fleeGrenade).not.toHaveBeenCalled();

    knock.update(4.2);
    expect(player.knocked).toBe(false);
    expect(player.hp).toBe(30);
    expect(mate.char.reviveTarget).toBeNull();
  });
});
