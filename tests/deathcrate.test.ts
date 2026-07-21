import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ARMORS } from '../src/armor';
import { emptyAttachments } from '../src/attachments';
import { carryCapacity, carryWeight } from '../src/backpack';
import { Character } from '../src/character';
import { autoLootDeathCrate, DeathCrateManager, deathCrateEmpty } from '../src/deathcrate';
import { MELEE, WEAPONS } from '../src/weapons';

describe('死亡盒集中掉落与自动搜索', () => {
  it('复制阵亡装备并为无装备角色自动装配完整物资', () => {
    const donor = new Character('阵亡者', false, 0x777777);
    donor.pos.set(4, 2, 8);
    donor.guns[0] = {
      def: WEAPONS.akm,
      mag: 40,
      att: { ...emptyAttachments(), sight: 'scope4', mag: 'extmag', muzzle: 'comp' },
    };
    donor.melee = { def: MELEE.pan };
    donor.ammo.rifle = 90;
    donor.heals.bandage = 5;
    donor.heals.medkit = 1;
    donor.heals.drink = 2;
    donor.throwables.frag = 1;
    donor.throwables.smoke = 1;
    donor.pack = { level: 3 };
    donor.helmet = { level: 3, durability: ARMORS.helmet[3].maxDurability };
    donor.vest = { level: 3, durability: ARMORS.vest[3].maxDurability };

    const manager = new DeathCrateManager(new THREE.Scene());
    const crate = manager.spawn(donor, 2);
    donor.guns[0].mag = 0;
    const looter = new Character('搜索者', true, 0x3a6ea5);

    expect(crate.contents.guns[0]?.mag).toBe(40);
    expect(manager.nearest(4, 2, 8, 1)).toBe(crate);
    expect(autoLootDeathCrate(looter, crate)).toBeGreaterThan(0);
    expect(looter.guns[0]?.def.id).toBe('akm');
    expect(looter.guns[0]?.att.sight).toBe('scope4');
    expect(looter.melee.def.id).toBe('pan');
    expect(looter.pack?.level).toBe(3);
    expect(looter.helmet?.level).toBe(3);
    expect(looter.vest?.level).toBe(3);
    expect(deathCrateEmpty(crate)).toBe(true);
    manager.consumeIfEmpty(crate);
    expect(crate.active).toBe(false);
    expect(crate.group.visible).toBe(false);
  });

  it('没有背包时严格按负重上限拿取弹药', () => {
    const donor = new Character('弹药携带者', false, 0x777777);
    donor.ammo.rifle = 100;
    const crate = new DeathCrateManager(new THREE.Scene()).spawn(donor, 0);
    const looter = new Character('空背包角色', true, 0x3a6ea5);

    autoLootDeathCrate(looter, crate);

    expect(looter.ammo.rifle).toBe(80);
    expect(crate.contents.ammo.rifle).toBe(20);
    expect(carryWeight(looter)).toBeLessThanOrEqual(carryCapacity(looter.pack));
  });
});
