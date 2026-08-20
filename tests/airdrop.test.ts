import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { AirdropManager, createAirdropLootManifest, type Crate } from '../src/airdrop';
import { canAttach } from '../src/attachments';
import type { Game } from '../src/game';
import type { World } from '../src/world';

describe('空投动态碰撞资源', () => {
  it('每箱固定包含两把满配高级枪和完整三级套', () => {
    const manifest = createAirdropLootManifest(() => 0.2);
    const guns = manifest.filter((item) => ['sniper', 'lmg', 'akm', 'dmr'].includes(item.kind));
    expect(guns).toHaveLength(2);
    expect(guns.every((item) => item.mag && item.mag > 0 && item.att?.mag === 'extmag')).toBe(true);
    for (const item of guns) {
      for (const attachment of Object.values(item.att ?? {}).filter((value) => value !== null)) {
        expect(canAttach(item.kind as 'sniper' | 'lmg' | 'akm' | 'dmr', attachment)).toBe(true);
      }
    }
    expect(manifest.map((item) => item.kind)).toEqual(expect.arrayContaining([
      'helmet3', 'vest3', 'pack3', 'medkit', 'drink', 'frag', 'smoke',
    ]));
    const ammo = manifest.filter((item) => item.kind.startsWith('ammo'));
    expect(ammo.length).toBeGreaterThanOrEqual(4);
  });

  it('落地时注册碰撞和平台且重开时完整注销', () => {
    const scene = new THREE.Scene();
    const addCollider = vi.fn();
    const removeCollider = vi.fn(() => true);
    const addPlatform = vi.fn();
    const removePlatform = vi.fn(() => true);
    const world = { addCollider, removeCollider, addPlatform, removePlatform } as unknown as World;
    const game = {
      world,
      scene,
      now: 20,
      effects: { burst: vi.fn() },
      bots: [],
      audio: { planeDroneStop: vi.fn() },
    } as unknown as Game;
    const manager = new AirdropManager(game, scene);
    const harness = manager as unknown as {
      crates: Crate[];
      land(crate: Crate, groundHeight: number): void;
    };
    const crate = harness.crates[0] as Crate;
    crate.pos.set(12, 4.5, -8);

    harness.land(crate, 4);

    expect(addCollider).toHaveBeenCalledOnce();
    expect(addPlatform).toHaveBeenCalledOnce();
    expect(crate.collider).not.toBeNull();
    expect(crate.platform).not.toBeNull();

    const collider = crate.collider;
    const platform = crate.platform;
    manager.reset();

    expect(removeCollider).toHaveBeenCalledWith(collider);
    expect(removePlatform).toHaveBeenCalledWith(platform);
    expect(crate.collider).toBeNull();
    expect(crate.platform).toBeNull();
  });

  it('开箱会生成完整升级清单且枪械保留预装配件', () => {
    const scene = new THREE.Scene();
    const spawn = vi.fn();
    const game = {
      world: { getHeight: vi.fn(() => 3) },
      scene,
      loot: { spawn },
      soundAt: vi.fn(),
    } as unknown as Game;
    const manager = new AirdropManager(game, scene);
    const harness = manager as unknown as { crates: Crate[] };
    const crate = harness.crates[0] as Crate;
    crate.state = 'landed';
    crate.pos.set(20, 3.5, 10);

    manager.open(crate);

    expect(crate.state).toBe('opened');
    expect(spawn).toHaveBeenCalledTimes(14);
    const gunCalls = spawn.mock.calls.filter((call) => ['sniper', 'lmg', 'akm', 'dmr'].includes(call[0] as string));
    expect(gunCalls).toHaveLength(2);
    expect(gunCalls.every((call) => call[4] > 0 && call[6]?.mag === 'extmag')).toBe(true);
  });
});
