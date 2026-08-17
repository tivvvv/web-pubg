import { describe, expect, it } from 'vitest';
import { Character } from '../src/character';
import {
  MatchDirector,
  choosePressureSquad,
  fairInterceptPoint,
  scoreTacticalZoneCandidate,
  type DirectorZoneState,
} from '../src/matchdirector';
import { enemySquadSnapshots } from '../src/enemysquads';

function actor(name: string, squadId: number, squadSlot: number, x: number, z: number): Character {
  const character = new Character(name, squadId === 0 && squadSlot === 0, 0x667788);
  character.squadId = squadId;
  character.squadSlot = squadSlot;
  character.team = squadId === 0 ? 'squad' : 'enemy';
  character.pos.set(x, 0, z);
  character.lastShotT = -100;
  return character;
}

const zone = (overrides: Partial<DirectorZoneState> = {}): DirectorZoneState => ({
  centerX: 0,
  centerZ: 0,
  radius: 310,
  nextCenterX: 80,
  nextCenterZ: 0,
  nextRadius: 210,
  state: 'wait',
  ...overrides,
});

describe('公平战局导演', () => {
  it('决赛圈候选优先选择干燥且具有掩体和地标的区域', () => {
    const empty = scoreTacticalZoneCandidate({
      phase: 4, nextRadius: 44, dryLand: true, coverCount: 1, landmarkDistance: 100,
    });
    const tactical = scoreTacticalZoneCandidate({
      phase: 4, nextRadius: 44, dryLand: true, coverCount: 24, landmarkDistance: 8,
    });
    const water = scoreTacticalZoneCandidate({
      phase: 4, nextRadius: 44, dryLand: false, coverCount: 99, landmarkDistance: 0,
    });
    expect(tactical).toBeGreaterThan(empty);
    expect(water).toBeLessThan(empty);
  });

  it('截击点位于玩家前方的安全区内且保留可反应距离', () => {
    const result = fairInterceptPoint(0, 0, zone(), () => true);
    expect(result).not.toBeNull();
    expect(Math.hypot(result?.x ?? 0, result?.z ?? 0)).toBeGreaterThanOrEqual(54);
    expect(Math.hypot((result?.x ?? 0) - 80, result?.z ?? 0)).toBeLessThan(206);
  });

  it('只选择真实存活、未接战且距离合理的小队施加压力', () => {
    const chars = [
      actor('近处1', 1, 0, 20, 0), actor('近处2', 1, 1, 22, 0),
      actor('候选1', 2, 0, 130, 0), actor('候选2', 2, 1, 134, 0),
      actor('远处1', 3, 0, 280, 0), actor('远处2', 3, 1, 284, 0),
    ];
    expect(choosePressureSquad(enemySquadSnapshots(chars), 0, 0, 50)?.squadId).toBe(2);
    chars[2]!.lastShotT = 48;
    expect(choosePressureSquad(enemySquadSnapshots(chars), 0, 0, 50)).toBeNull();
  });

  it('交战空窗后只下达移动指令而不生成或移动角色', () => {
    const director = new MatchDirector();
    const player = actor('玩家', 0, 0, 0, 0);
    const enemies = [
      actor('敌1', 2, 0, 128, 0), actor('敌2', 2, 1, 132, 0),
      actor('敌3', 2, 2, 130, 4), actor('敌4', 2, 3, 130, -4),
    ];
    const background = [3, 4, 5, 6].flatMap((squadId, index) => [
      actor(`远队${squadId}-1`, squadId, 0, 195 + index * 8, 35),
      actor(`远队${squadId}-2`, squadId, 1, 198 + index * 8, 38),
    ]);
    const chars = [player, ...enemies, ...background];
    const before = enemies.map((enemy) => enemy.pos.clone());
    director.reset(0);
    director.update({ now: 0, armed: true, player, chars, zone: zone(), events: [], pointFree: () => true });
    director.update({ now: 40, armed: true, player, chars, zone: zone(), events: [], pointFree: () => true });

    expect(director.activeDirectives.some((directive) => directive.kind === 'intercept')).toBe(true);
    expect(enemies.map((enemy) => enemy.pos)).toEqual(before);
    expect(director.directiveFor(enemies[0] as Character, 40)?.squadId).toBe(2);
  });

  it('决赛阶段按小队分配不同进圈方位', () => {
    const director = new MatchDirector();
    const player = actor('玩家', 0, 0, 0, 0);
    const enemies = [
      actor('甲1', 1, 0, -60, 0), actor('甲2', 1, 1, -62, 0),
      actor('乙1', 2, 0, 60, 0), actor('乙2', 2, 1, 62, 0),
    ];
    const chars = [player, ...enemies];
    director.reset(0);
    director.update({ now: 0, armed: true, player, chars, zone: zone(), events: [], pointFree: () => true });
    director.update({
      now: 10,
      armed: true,
      player,
      chars,
      zone: zone({ radius: 70, nextRadius: 44, nextCenterX: 5 }),
      events: [],
      pointFree: () => true,
    });
    const directives = director.activeDirectives;
    expect(directives).toHaveLength(2);
    expect(directives.every((directive) => directive.kind === 'endgame')).toBe(true);
    expect(`${directives[0]?.x},${directives[0]?.z}`).not.toBe(`${directives[1]?.x},${directives[1]?.z}`);
  });

  it('玩家被淘汰后仍继续非玩家相关的决赛圈调度', () => {
    const director = new MatchDirector();
    const player = actor('玩家', 0, 0, 0, 0);
    const enemies = [
      actor('甲1', 1, 0, -60, 0), actor('甲2', 1, 1, -62, 0),
      actor('乙1', 2, 0, 60, 0), actor('乙2', 2, 1, 62, 0),
    ];
    const chars = [player, ...enemies];
    director.reset(0);
    director.update({ now: 0, armed: true, player, chars, zone: zone(), events: [], pointFree: () => true });
    player.alive = false;
    director.update({
      now: 10,
      armed: true,
      player,
      chars,
      zone: zone({ radius: 70, nextRadius: 44, nextCenterX: 5 }),
      events: [],
      pointFree: () => true,
    });

    expect(director.activeDirectives).toHaveLength(2);
    expect(director.activeDirectives.every((directive) => directive.kind === 'endgame')).toBe(true);
  });

  it('同一公开事件同时最多调度一支敌方小队', () => {
    const director = new MatchDirector();
    const player = actor('玩家', 0, 0, 0, 0);
    const enemies = [1, 2, 3, 4, 5].flatMap((squadId, index) => [
      actor(`${squadId}-1`, squadId, 0, 80 + index * 8, 0),
      actor(`${squadId}-2`, squadId, 1, 82 + index * 8, 2),
    ]);
    const event = {
      kind: 'armory' as const,
      region: 'stonegate' as const,
      siteId: 'test',
      x: 0,
      z: 90,
      label: '军械缓存',
      feature: '测试',
      color: '#fff',
    };
    director.reset(0);
    director.update({ now: 0, armed: true, player, chars: [player, ...enemies], zone: zone(), events: [event], pointFree: () => true });
    director.update({ now: 10, armed: true, player, chars: [player, ...enemies], zone: zone(), events: [event], pointFree: () => true });
    director.update({ now: 20, armed: true, player, chars: [player, ...enemies], zone: zone(), events: [event], pointFree: () => true });

    expect(director.activeDirectives.filter((directive) => directive.kind === 'contest')).toHaveLength(1);
  });
});
