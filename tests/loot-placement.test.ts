import { describe, expect, it } from 'vitest';
import { lootPointClear } from '../src/loot';

describe('掉落物空间校验', () => {
  const floor = {
    kind: 'aabb' as const,
    minX: -2, minY: 0, minZ: -2,
    maxX: 2, maxY: 0.2, maxZ: 2,
    tag: 'floor' as const,
  };

  it('允许物资放在地板上并忽略其他楼层的墙', () => {
    const world = {
      cyls: [],
      aabbs: [
        floor,
        {
          kind: 'aabb' as const,
          minX: -1, minY: 3, minZ: -1,
          maxX: 1, maxY: 5, maxZ: 1,
          tag: 'wall' as const,
        },
      ],
    };
    expect(lootPointClear(world, 0, 0.2, 0)).toBe(true);
  });

  it('拒绝嵌入同层墙体和门窗的物资', () => {
    for (const tag of ['wall', 'door', 'window'] as const) {
      const world = {
        cyls: [],
        aabbs: [
          floor,
          {
            kind: 'aabb' as const,
            minX: -0.1, minY: 0.2, minZ: -1,
            maxX: 0.1, maxY: 2.4, maxZ: 1,
            tag,
          },
        ],
      };
      expect(lootPointClear(world, 0, 0.2, 0)).toBe(false);
    }
  });

  it('拒绝刷进树木和岩石占地', () => {
    const world = {
      aabbs: [floor],
      cyls: [
        { kind: 'cyl' as const, x: 0, z: 0, r: 0.45, y0: 0, y1: 2.8, tag: 'tree' as const },
      ],
    };
    expect(lootPointClear(world, 0.5, 0.2, 0)).toBe(false);
    expect(lootPointClear(world, 1.2, 0.2, 0)).toBe(true);
  });
});
