import { describe, expect, it } from 'vitest';
import { createSeededRandom } from '../src/random';
import { DROP_MIN_SEPARATION, MATCH_PLAYER_COUNT, SQUAD_SIZE } from '../src/matchbalance';
import { createMatchSpawnPlan } from '../src/matchspawn';

describe('对局落点规划', () => {
  it('一次生成完整小队和全部敌人的合法落点', () => {
    const plan = createMatchSpawnPlan({
      pointFree: () => true,
      random: createSeededRandom(20260815),
    });

    expect(plan.points).toHaveLength(MATCH_PLAYER_COUNT);
    expect(plan.points.slice(0, SQUAD_SIZE)).toEqual(Array.from(
      { length: SQUAD_SIZE },
      () => ({ x: 0, z: 0 }),
    ));
    const enemySquads = Array.from(
      { length: (MATCH_PLAYER_COUNT - SQUAD_SIZE) / SQUAD_SIZE },
      (_, squad) => plan.points.slice(SQUAD_SIZE + squad * SQUAD_SIZE, SQUAD_SIZE + (squad + 1) * SQUAD_SIZE),
    );
    const centers = enemySquads.map((members) => ({
      x: members.reduce((sum, member) => sum + member.x, 0) / members.length,
      z: members.reduce((sum, member) => sum + member.z, 0) / members.length,
    }));
    for (const members of enemySquads) {
      for (const member of members) {
        expect(Math.hypot(member.x - (members[0]?.x ?? 0), member.z - (members[0]?.z ?? 0)))
          .toBeLessThanOrEqual(10);
      }
    }
    for (let i = 0; i < centers.length; i++) {
      for (let j = i + 1; j < centers.length; j++) {
        const a = centers[i] as { x: number; z: number };
        const b = centers[j] as { x: number; z: number };
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(DROP_MIN_SEPARATION);
      }
    }
  });

  it('相同随机种子生成完全一致的航线和落点', () => {
    const first = createMatchSpawnPlan({ pointFree: () => true, random: createSeededRandom(77) });
    const second = createMatchSpawnPlan({ pointFree: () => true, random: createSeededRandom(77) });
    expect(second).toEqual(first);
  });

  it('地图无法提供足够安全位置时给出明确错误', () => {
    expect(() => createMatchSpawnPlan({
      pointFree: () => false,
      random: createSeededRandom(1),
      playerCount: 5,
      squadSize: 4,
    })).toThrow('无法生成完整对局落点: 4/5');
  });
});
