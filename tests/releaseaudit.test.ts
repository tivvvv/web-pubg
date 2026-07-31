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
      [{ index: 0, x: 20, y: 1, z: 20, hp: 700, speed: 18 }],
      300,
    )).toEqual([]);
  });

  it('能同时发现非法坐标, 悬空, 弹匣, 镜头和载具状态', () => {
    const issues = auditReleaseState(
      [{ ...validActor, x: Number.NaN, y: 8, groundY: 2, magazine: 40 }],
      { x: 0, y: 0, z: 0, fov: 5, distance: 12 },
      [{ index: 2, x: 400, y: 0, z: 0, hp: 100, speed: 100 }],
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
});
