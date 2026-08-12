import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { forestCoreMetrics, WildlifeSystem, WILDLIFE_COUNTS, type WildlifeKind } from '../src/wildlife';
import { WATER_Y, World } from '../src/world';
import { Vehicle, VEHICLE_SPEC } from '../src/vehicles';

function createWildlife(): { world: World; wildlife: WildlifeSystem } {
  const scene = new THREE.Scene();
  const world = new World(scene);
  return { world, wildlife: new WildlifeSystem(world, scene) };
}

describe('环境动物系统', () => {
  it('牛羊鱼鸟和守护老虎按规划数量生成在对应生态层', () => {
    const { world, wildlife } = createWildlife();
    for (const kind of Object.keys(WILDLIFE_COUNTS) as WildlifeKind[]) {
      expect(wildlife.count(kind)).toBe(WILDLIFE_COUNTS[kind]);
      expect(wildlife.count(kind, true)).toBe(WILDLIFE_COUNTS[kind]);
    }
    for (const entity of wildlife.entities) {
      const { x, y, z } = entity.group.position;
      expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)).toBe(true);
      if (entity.kind === 'fish') {
        expect(y).toBeLessThan(WATER_Y);
        expect(world.getHeight(x, z)).toBeLessThan(WATER_Y - 0.35);
      } else if (entity.kind === 'bird') {
        expect(y - world.getHeight(x, z)).toBeGreaterThan(12);
      } else {
        expect(Math.abs(y - world.getHeight(x, z))).toBeLessThan(0.02);
        expect(y).toBeGreaterThan(WATER_Y + 0.25);
      }
    }
  });

  it('牛羊鸟使用完整近景轮廓而不是基础几何占位物', () => {
    const { wildlife } = createWildlife();
    const cow = wildlife.entities.find((entity) => entity.kind === 'cow');
    const sheep = wildlife.entities.find((entity) => entity.kind === 'sheep');
    const bird = wildlife.entities.find((entity) => entity.kind === 'bird');
    expect(cow && sheep && bird).toBeDefined();
    if (!cow || !sheep || !bird) return;

    const countNamed = (root: THREE.Object3D, name: string) => {
      let count = 0;
      root.traverse((object) => { if (object.name === name) count++; });
      return count;
    };

    expect(cow.group.name).toBe('wildlife-cow');
    for (const name of [
      'cow-body', 'cow-shoulder', 'cow-neck', 'cow-head', 'cow-muzzle',
      'cow-face-blaze', 'cow-eye-left', 'cow-eye-right', 'cow-tail-tuft', 'cow-udder',
    ]) expect(cow.group.getObjectByName(name), name).toBeDefined();
    expect(countNamed(cow.group, 'cow-coat-patch')).toBeGreaterThanOrEqual(2);
    expect(countNamed(cow.group, 'cow-hoof')).toBe(4);
    expect(cow.limbs).toHaveLength(5);

    expect(sheep.group.name).toBe('wildlife-sheep');
    for (const name of [
      'sheep-wool-core', 'sheep-head', 'sheep-muzzle', 'sheep-eye-left',
      'sheep-eye-right', 'sheep-ear-left', 'sheep-ear-right', 'sheep-tail',
    ]) expect(sheep.group.getObjectByName(name), name).toBeDefined();
    expect(countNamed(sheep.group, 'sheep-wool-tuft')).toBe(8);
    expect(countNamed(sheep.group, 'sheep-hoof')).toBe(4);
    expect(sheep.limbs).toHaveLength(4);

    expect(bird.group.name).toBe('wildlife-bird');
    for (const name of [
      'bird-body', 'bird-breast', 'bird-head', 'bird-beak', 'bird-eye-left',
      'bird-eye-right', 'bird-wing-left', 'bird-wing-right',
    ]) expect(bird.group.getObjectByName(name), name).toBeDefined();
    expect(countNamed(bird.group, 'bird-wing-coverts')).toBe(2);
    expect(countNamed(bird.group, 'bird-primary-feather')).toBe(6);
    expect(countNamed(bird.group, 'bird-tail-feather')).toBe(3);
    expect(bird.limbs).toHaveLength(2);
  });

  it('射线只命中最近的存活动物且死亡后不再挡弹', () => {
    const { wildlife } = createWildlife();
    const cow = wildlife.entities.find((entity) => entity.kind === 'cow');
    expect(cow).toBeDefined();
    if (!cow) return;
    const center = cow.group.position.clone().add(new THREE.Vector3(0, cow.centerY, 0));
    const origin = center.clone().add(new THREE.Vector3(0, 0.05, -7));
    const direction = center.clone().sub(origin).normalize();
    const hit = wildlife.raycast(origin, direction, 12);
    expect(hit?.entity).toBe(cow);
    expect(hit?.t).toBeGreaterThan(5);
    expect(hit?.t).toBeLessThan(8);

    expect(wildlife.damage(cow, cow.maxHp)).toBe(true);
    expect(cow.alive).toBe(false);
    expect(wildlife.raycast(origin, direction, 12)?.entity).not.toBe(cow);
  });

  it('五种动物都可死亡并能在重开对局时完整复位', () => {
    const { wildlife } = createWildlife();
    for (const kind of Object.keys(WILDLIFE_COUNTS) as WildlifeKind[]) {
      const entity = wildlife.entities.find((candidate) => candidate.kind === kind);
      expect(entity).toBeDefined();
      if (!entity) continue;
      expect(wildlife.damage(entity, entity.maxHp)).toBe(true);
      wildlife.update(0.25);
      expect(entity.alive).toBe(false);
      expect(entity.group.position.toArray().every(Number.isFinite)).toBe(true);
    }

    wildlife.reset();
    for (const kind of Object.keys(WILDLIFE_COUNTS) as WildlifeKind[]) {
      expect(wildlife.count(kind, true)).toBe(WILDLIFE_COUNTS[kind]);
    }
    for (const entity of wildlife.entities) {
      expect(entity.hp).toBe(entity.maxHp);
      expect(entity.group.position.distanceTo(entity.spawn)).toBeLessThan(0.001);
    }
  });

  it('雾松林宝箱由三只老虎守护且开启状态可重置', () => {
    const { world, wildlife } = createWildlife();
    const treasure = wildlife.treasure;
    expect(treasure.pos.x).toBeLessThan(-60);
    expect(treasure.pos.z).toBeLessThan(-190);
    expect(treasure.group.name).toBe('forest-treasure-chest');
    expect(treasure.opened).toBe(false);
    expect(world.bushes.every(
      (bush) => Math.hypot(treasure.pos.x - bush.x, treasure.pos.z - bush.z) >= bush.r + 1.55,
    )).toBe(true);
    expect(treasure.pos.y).toBeGreaterThan(WATER_Y + 4.5);
    const core = forestCoreMetrics(world, treasure.pos.x, treasure.pos.z);
    expect(core.nearbyTrees).toBeGreaterThanOrEqual(28);
    expect(core.coveredTreeSectors).toBeGreaterThanOrEqual(7);
    expect(core.dryLandSectors).toBe(8);
    expect(core.buildingDistance).toBeGreaterThanOrEqual(70);
    expect(core.roadDistance).toBeGreaterThanOrEqual(80);
    expect(core.lumberyardDistance).toBeGreaterThanOrEqual(120);
    expect(core.shorelineClearance).toBeGreaterThanOrEqual(44);
    expect(treasure.group.children.filter((child) => child.name === 'treasure-spark')).toHaveLength(12);
    expect(treasure.group.getObjectByName('treasure-lock-gem')).toBeDefined();
    expect(treasure.group.getObjectByName('treasure-golden-halo')).toBeDefined();
    const aura = treasure.group.getObjectByName('treasure-aura-light') as THREE.PointLight | undefined;
    expect(aura?.intensity).toBeGreaterThan(2);

    const tigers = wildlife.entities.filter((entity) => entity.kind === 'tiger');
    expect(tigers).toHaveLength(3);
    for (const tiger of tigers) {
      expect(tiger.group.name).toBe('forest-guardian-tiger');
      expect(tiger.group.getObjectByName('tiger-whiskers')).toBeDefined();
      expect(tiger.group.position.distanceTo(treasure.pos)).toBeGreaterThan(3.4);
      expect(tiger.group.position.distanceTo(treasure.pos)).toBeLessThan(7.5);
    }
    expect(wildlife.nearestClosedTreasure(
      treasure.pos.x,
      treasure.pos.y + 0.55,
      treasure.pos.z,
      2,
    )).toBe(treasure);

    expect(wildlife.openTreasure()).toBe(true);
    expect(wildlife.openTreasure()).toBe(false);
    wildlife.update(0.5);
    expect(treasure.lid.rotation.x).toBeLessThan(-0.5);
    expect(treasure.group.getObjectByName('forest-treasure-glow')?.visible).toBe(true);
    expect(treasure.group.children.filter((child) => child.name === 'treasure-plank')).toHaveLength(4);
    expect(treasure.group.getObjectByName('treasure-lock')).toBeDefined();
    expect(wildlife.nearestClosedTreasure(treasure.pos.x, treasure.pos.y, treasure.pos.z, 2)).toBeNull();

    wildlife.reset();
    expect(treasure.opened).toBe(false);
    expect(treasure.lid.rotation.x).toBe(0);
    expect(treasure.group.getObjectByName('forest-treasure-glow')?.visible).toBe(false);
  });

  it('老虎只在近距离按攻击冷却扑咬存活角色', () => {
    const { wildlife } = createWildlife();
    const tiger = wildlife.entities.find((entity) => entity.kind === 'tiger');
    expect(tiger).toBeDefined();
    if (!tiger) return;
    for (const other of wildlife.entities) {
      if (other.kind === 'tiger' && other !== tiger) other.alive = false;
    }
    const target = {
      alive: true,
      swimming: false,
      radius: 0.4,
      pos: tiger.group.position.clone().add(new THREE.Vector3(0, 0, 1.35)),
    };
    let attackCount = 0;
    let totalDamage = 0;
    wildlife.update(0.016, [target], (victim, damage, attacker) => {
      expect(victim).toBe(target);
      expect(attacker).toBe(tiger);
      attackCount++;
      totalDamage += damage;
    });
    expect(attackCount).toBe(1);
    expect(totalDamage).toBe(16);

    wildlife.update(0.8, [target], () => attackCount++);
    expect(attackCount).toBe(1);
    wildlife.update(0.7, [target], () => attackCount++);
    expect(attackCount).toBe(2);

    target.swimming = true;
    wildlife.update(2, [target], () => attackCount++);
    expect(attackCount).toBe(2);
  });

  it('长时间活动保持有限坐标且不会离开各自生态范围', () => {
    const { world, wildlife } = createWildlife();
    for (let step = 0; step < 1200; step++) wildlife.update(1 / 30);
    for (const entity of wildlife.entities) {
      const { x, y, z } = entity.group.position;
      expect([x, y, z].every(Number.isFinite)).toBe(true);
      if (entity.kind === 'fish') {
        expect(y).toBeLessThan(WATER_Y);
        expect(world.getHeight(x, z)).toBeLessThan(WATER_Y - 0.35);
      } else if (entity.kind === 'bird') {
        expect(Math.hypot(x - entity.anchor.x, z - entity.anchor.z)).toBeLessThanOrEqual(24);
      } else {
        expect(Math.hypot(x - entity.anchor.x, z - entity.anchor.z)).toBeLessThanOrEqual(17);
      }
    }
  });

  it('角色与牛羊保持实体间距且不会互相穿模', () => {
    const { wildlife } = createWildlife();
    const cow = wildlife.entities.find((entity) => entity.kind === 'cow');
    expect(cow).toBeDefined();
    if (!cow) return;
    const character = {
      alive: true,
      swimming: false,
      radius: 0.38,
      pos: cow.group.position.clone(),
    };
    for (let pass = 0; pass < 3; pass++) wildlife.resolveCharacterCollisions([character]);
    const distance = Math.hypot(
      character.pos.x - cow.group.position.x,
      character.pos.z - cow.group.position.z,
    );
    expect(distance).toBeGreaterThan(cow.radius * 0.7 + character.radius);
    expect(character.pos.toArray().every(Number.isFinite)).toBe(true);
    expect(cow.group.position.toArray().every(Number.isFinite)).toBe(true);
  });

  it('同一位置的陆生动物会自动分开', () => {
    const { wildlife } = createWildlife();
    const grazers = wildlife.entities.filter((entity) => entity.kind === 'cow' || entity.kind === 'sheep');
    const a = grazers[0];
    const b = grazers[1];
    expect(a && b).toBeDefined();
    if (!a || !b) return;
    b.group.position.copy(a.group.position);
    for (let pass = 0; pass < 4; pass++) wildlife.update(0);
    expect(Math.hypot(
      a.group.position.x - b.group.position.x,
      a.group.position.z - b.group.position.z,
    )).toBeGreaterThan(1.2);
  });

  it('牛羊不会穿过停放载具', () => {
    const { wildlife } = createWildlife();
    const cow = wildlife.entities.find((entity) => entity.kind === 'cow');
    expect(cow).toBeDefined();
    if (!cow) return;
    const vehicle = new Vehicle('car', cow.group.position.clone(), Math.PI / 5);
    const before = cow.group.position.clone();

    wildlife.resolveVehicleCollisions([vehicle]);

    const dx = cow.group.position.x - vehicle.pos.x;
    const dz = cow.group.position.z - vehicle.pos.z;
    const cos = Math.cos(vehicle.yaw);
    const sin = Math.sin(vehicle.yaw);
    const localX = dx * cos - dz * sin;
    const localZ = dx * sin + dz * cos;
    const half = VEHICLE_SPEC.car.half;
    const closestX = Math.max(-half[0], Math.min(half[0], localX));
    const closestZ = Math.max(-half[2], Math.min(half[2], localZ));
    expect(cow.group.position.distanceTo(before)).toBeGreaterThan(0);
    expect(Math.hypot(localX - closestX, localZ - closestZ)).toBeGreaterThanOrEqual(cow.radius * 0.7 - 0.0001);
  });

  it('近战锥形判定能找到最近的动物', () => {
    const { wildlife } = createWildlife();
    const sheep = wildlife.entities.find((entity) => entity.kind === 'sheep');
    expect(sheep).toBeDefined();
    if (!sheep) return;
    const originX = sheep.group.position.x;
    const originZ = sheep.group.position.z - 1.4;
    const target = wildlife.meleeTarget(originX, sheep.group.position.y, originZ, 0, 1, 2.2);
    expect(target?.entity).toBe(sheep);
    expect(target?.distance).toBeLessThan(1.4);
  });
});
