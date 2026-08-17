import { describe, expect, it } from 'vitest';
import { Character } from '../src/character';
import { EnemySquadSystem, enemySquadSnapshots } from '../src/enemysquads';
import { hostileTo, sameSquad, squadFormationPoint, squadRole } from '../src/squads';

function actor(name: string, squadId: number, squadSlot: number, x = 0, z = 0): Character {
  const character = new Character(name, false, 0x667788);
  character.squadId = squadId;
  character.squadSlot = squadSlot;
  character.pos.set(x, 0, z);
  return character;
}

describe('敌方四人小队', () => {
  it('统一识别队友与敌人并提供四种战术位置', () => {
    const leader = actor('队长', 3, 0);
    const support = actor('支援', 3, 3);
    const rival = actor('敌人', 4, 0);
    expect(sameSquad(leader, support)).toBe(true);
    expect(hostileTo(leader, support)).toBe(false);
    expect(hostileTo(leader, rival)).toBe(true);
    expect([0, 1, 2, 3].map(squadRole)).toEqual(['leader', 'assault', 'flank', 'support']);
    const positions = [0, 1, 2, 3].map((slot) => squadFormationPoint(20, -10, 3, slot));
    expect(new Set(positions.map((point) => `${point.x.toFixed(2)},${point.z.toFixed(2)}`)).size).toBe(4);
  });

  it('把视觉接触共享给同队成员但不泄露给其他队伍', () => {
    const system = new EnemySquadSystem();
    const scout = actor('侦察', 2, 1, 0, 0);
    const teammate = actor('队友', 2, 2, 10, 0);
    const rival = actor('对手', 5, 0, 35, 5);
    const outsider = actor('旁队', 6, 0, 8, 0);
    const chars = [scout, teammate, rival, outsider];
    system.report(scout, rival, 12);

    expect(system.contactFor(teammate, 13, chars)?.targetId).toBe(rival.id);
    expect(system.contactFor(outsider, 13, chars)).toBeNull();
    system.update(20, chars);
    expect(system.activeContactCount).toBe(0);
  });

  it('只救援本队倒地成员并在离队过远时回到队形', () => {
    const system = new EnemySquadSystem();
    const leader = actor('队长', 7, 0, 0, 0);
    const rescuer = actor('救援', 7, 3, 42, 0);
    const ally = actor('倒地队友', 7, 1, 38, 0);
    const rival = actor('倒地对手', 8, 0, 39, 0);
    ally.knocked = true;
    rival.knocked = true;
    expect(system.nearestKnocked(rescuer, [leader, rescuer, ally, rival], 20)).toBe(ally);
    expect(system.regroupPoint(rescuer, [leader, rescuer, ally, rival])).not.toBeNull();
  });

  it('按小队汇总存活成员和中心位置', () => {
    const a = actor('甲', 1, 0, 10, 10);
    const b = actor('乙', 1, 1, 14, 10);
    const c = actor('丙', 2, 0, -20, 8);
    b.alive = false;
    const snapshots = enemySquadSnapshots([a, b, c]);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.members).toHaveLength(2);
    expect(snapshots[0]?.alive).toEqual([a]);
    expect(snapshots[0]?.centerX).toBe(10);
  });
});
