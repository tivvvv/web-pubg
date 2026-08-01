import { describe, expect, it } from 'vitest';
import { auditReleaseState, type ReleaseActorSample } from '../src/releaseaudit';

const validActor: ReleaseActorSample = {
  id: 1,
  name: '测试角色',
  alive: true,
  visible: true,
  x: 0,
  y: 2,
  z: 0,
  hp: 100,
  knocked: false,
  speed: 4,
  grounded: true,
  swimming: false,
  seated: false,
  groundY: 2,
  magazine: 30,
  capacity: 30,
};

describe('发布级运行状态审计', () => {
  it('合法角色, 镜头和载具状态不会误报', () => {
    expect(auditReleaseState(
      [validActor],
      { x: 0, y: 4, z: -3, fov: 75, distance: 3.4 },
      [{ index: 0, x: 20, y: 1, z: 20, hp: 700, maxHp: 800, speed: 18 }],
      300,
    )).toEqual([]);
  });

  it('能同时发现非法坐标, 悬空, 弹匣, 镜头和载具状态', () => {
    const issues = auditReleaseState(
      [{ ...validActor, x: Number.NaN, y: 8, groundY: 2, magazine: 40 }],
      { x: 0, y: 0, z: 0, fov: 5, distance: 12 },
      [{ index: 2, x: 400, y: 0, z: 0, hp: 100, maxHp: 800, speed: 100 }],
      300,
    );
    expect(issues).toContain('actor:1:测试角色:non-finite');
    expect(issues).toContain('camera:fov:5.0');
    expect(issues).toContain('camera:distance:12.00');
    expect(issues).toContain('vehicle:2:out-of-world');
    expect(issues).toContain('vehicle:2:speed:100.0');
  });

  it('单独发现贴地差和超容量弹匣', () => {
    const issues = auditReleaseState(
      [{ ...validActor, y: 3, groundY: 2, magazine: 31 }],
      null,
      [],
      300,
    );
    expect(issues).toContain('actor:1:测试角色:ground-gap:1.00');
    expect(issues).toContain('actor:1:测试角色:magazine:31/30');
  });

  it('忽略测试场景中隐藏停放角色的地图外占位坐标', () => {
    expect(auditReleaseState(
      [{ ...validActor, visible: false, x: 999, z: 999 }],
      null,
      [],
      300,
    )).toEqual([]);
  });

  it('训练靶可以显式声明更高生命上限而不放宽普通角色约束', () => {
    expect(auditReleaseState(
      [{ ...validActor, hp: 900, healthLimit: 1000 }],
      null,
      [],
      300,
    )).toEqual([]);
    expect(auditReleaseState([{ ...validActor, hp: 900 }], null, [], 300)).toContain('actor:1:测试角色:hp:900.0');
  });

  it('检测重复角色, 垂直越界, 零生命存活和非法载具生命', () => {
    const issues = auditReleaseState(
      [validActor, { ...validActor, y: 500, hp: 0, magazine: 1.5 }],
      { x: 0, y: 500, z: 0, fov: 75, distance: 3 },
      [{ index: 1, x: 0, y: 90, z: 0, hp: 900, maxHp: 800, speed: 0 }],
      300,
    );

    expect(issues).toContain('actor:1:测试角色:duplicate-id');
    expect(issues).toContain('actor:1:测试角色:vertical:500.0');
    expect(issues).toContain('actor:1:测试角色:hp:0.0');
    expect(issues).toContain('actor:1:测试角色:magazine:1.5/30');
    expect(issues).toContain('camera:vertical:500.0');
    expect(issues).toContain('vehicle:1:vertical:90.0');
    expect(issues).toContain('vehicle:1:hp:900.0/800.0');
  });

  it('击倒角色允许常规生命归零但仍拒绝负生命', () => {
    expect(auditReleaseState([{ ...validActor, hp: 0, knocked: true }], null, [], 300)).toEqual([]);
    expect(auditReleaseState([{ ...validActor, hp: -1, knocked: true }], null, [], 300))
      .toContain('actor:1:测试角色:hp:-1.0');
  });
});
