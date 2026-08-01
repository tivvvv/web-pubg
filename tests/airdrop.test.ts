import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { AirdropManager, type Crate } from '../src/airdrop';
import type { Game } from '../src/game';
import type { World } from '../src/world';

describe('空投动态碰撞资源', () => {
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
});
