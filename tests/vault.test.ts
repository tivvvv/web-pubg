import { describe, expect, it } from 'vitest';
import { Character } from '../src/character';
import { emptyAttachments } from '../src/attachments';
import type { AabbCollider } from '../src/types';
import { probeVault, startVault, updateVaultMotion } from '../src/vault';
import { WEAPONS } from '../src/weapons';
import type { World } from '../src/world';

function vaultWorld(obstacle: AabbCollider, extras: AabbCollider[] = []): World {
  return {
    aabbs: [obstacle, ...extras],
    cyls: [],
    buildings: { destructibles: [] },
    groundHeight: () => 0,
  } as unknown as World;
}

function obstacle(maxX = 0.9, maxY = 1): AabbCollider {
  return {
    kind: 'aabb', tag: 'wall', minX: 0.5, maxX, minY: 0, maxY, minZ: -0.25, maxZ: 0.25,
  };
}

describe('翻越探测和位移流程', () => {
  it('识别前方可翻矮墙并生成墙后落点', () => {
    const character = new Character('测试角色', true, 0x3a6ea5);
    character.pos.set(0, 0, 0);
    const probe = probeVault(character, 1, 0, vaultWorld(obstacle()));
    expect(probe).not.toBeNull();
    expect(probe?.topY).toBeCloseTo(1.32, 8);
    expect(probe?.landX).toBeGreaterThan(1);
    expect(probe?.landY).toBe(0);
  });

  it('拒绝过厚过高和落点被占用的障碍', () => {
    const character = new Character('测试角色', true, 0x3a6ea5);
    character.pos.set(0, 0, 0);
    expect(probeVault(character, 1, 0, vaultWorld(obstacle(1.3)))).toBeNull();
    expect(probeVault(character, 1, 0, vaultWorld(obstacle(0.9, 1.31)))).toBeNull();
    const blocker: AabbCollider = {
      kind: 'aabb', tag: 'wall', minX: 1.2, maxX: 1.7, minY: 0, maxY: 2, minZ: -0.3, maxZ: 0.3,
    };
    expect(probeVault(character, 1, 0, vaultWorld(obstacle(), [blocker]))).toBeNull();
  });

  it('七百毫秒后准确落地并进入冷却', () => {
    const character = new Character('测试角色', true, 0x3a6ea5);
    character.pos.set(0, 0, 0);
    const probe = probeVault(character, 1, 0, vaultWorld(obstacle()));
    expect(probe).not.toBeNull();
    startVault(character, probe!);
    expect(character.grounded).toBe(false);
    expect(updateVaultMotion(character, 0.35)).toBe(true);
    expect(character.pos.y).toBeGreaterThan(1);
    expect(updateVaultMotion(character, 0.35)).toBe(true);
    expect(character.vault).toBeNull();
    expect(character.grounded).toBe(true);
    expect(character.vaultCd).toBe(0.4);
    expect(character.pos.x).toBeCloseTo(probe!.landX, 8);
    expect(character.pos.y).toBeCloseTo(probe!.landY, 8);
  });

  it('起翻时取消冲突动作并在翻越全程收起武器', () => {
    const character = new Character('翻越动作测试', true, 0x3a6ea5);
    character.guns[0] = { def: WEAPONS.rifle, mag: 15, att: emptyAttachments() };
    character.curSlot = 0;
    character.reload01 = 0.5;
    character.swingT = 1;
    character.beginAction('interact', 1);
    const probe = probeVault(character, 1, 0, vaultWorld(obstacle()));

    startVault(character, probe!);
    character.syncModel(1 / 60, false);

    expect(character.reload01).toBe(0);
    expect(character.swingT).toBe(0);
    expect(character.actionPose).toBeNull();
    expect(character.parts.held).toBeNull();
  });
});
