// 死亡盒: 集中保存阵亡角色的全部装备，避免大量独立掉落物挤在一起。
import * as THREE from 'three';
import type { Character } from './character';
import type { HealId } from './heals';
import { HEALS, HEAL_ORDER } from './heals';
import { HEAL_WEIGHT, ROUND_WEIGHT, THROW_WEIGHT, carryCapacity, carryWeight, type PackLevel } from './backpack';
import type { AmmoType, ArmorState, GunState, MeleeId, ThrowableId } from './types';
import { MELEE, THROWABLES } from './weapons';

export interface DeathCrateContents {
  guns: (GunState | null)[];
  melee: Exclude<MeleeId, 'fists'> | null;
  ammo: Record<AmmoType, number>;
  heals: Record<HealId, number>;
  throwables: Record<ThrowableId, number>;
  helmet: ArmorState | null;
  vest: ArmorState | null;
  pack: PackLevel | null;
}

export interface DeathCrate {
  group: THREE.Group;
  owner: string;
  contents: DeathCrateContents;
  active: boolean;
  phase: number;
}

function cloneGun(gun: GunState | null): GunState | null {
  if (!gun) return null;
  return {
    def: gun.def,
    mag: gun.mag,
    att: { sight: gun.att.sight, mag: gun.att.mag, muzzle: gun.att.muzzle },
  };
}

function buildCrate(): THREE.Group {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x4c4738, roughness: 0.92, metalness: 0.08 });
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0x242722, roughness: 0.75, metalness: 0.38 });
  const plateMat = new THREE.MeshStandardMaterial({ color: 0xb9954e, roughness: 0.55, metalness: 0.3 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.55, 0.82), bodyMat);
  body.position.y = 0.28;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);
  const lid = new THREE.Mesh(new THREE.BoxGeometry(1.24, 0.14, 0.86), edgeMat);
  lid.position.y = 0.62;
  lid.castShadow = true;
  group.add(lid);
  for (const x of [-0.43, 0.43]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.61, 0.88), edgeMat);
    band.position.set(x, 0.32, 0);
    group.add(band);
  }
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.18, 0.035), plateMat);
  plate.position.set(0, 0.36, 0.43);
  group.add(plate);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.72, 0.025, 6, 28),
    new THREE.MeshBasicMaterial({ color: 0xd5aa55, transparent: true, opacity: 0.6 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.035;
  group.add(ring);
  return group;
}

function copyContents(c: Character): DeathCrateContents {
  return {
    guns: c.guns.map(cloneGun),
    melee: c.melee.def.id === 'fists' ? null : c.melee.def.id,
    ammo: { ...c.ammo },
    heals: { ...c.heals },
    throwables: { ...c.throwables },
    helmet: c.helmet ? { ...c.helmet } : null,
    vest: c.vest ? { ...c.vest } : null,
    pack: c.pack?.level ?? null,
  };
}

export function deathCrateEmpty(crate: DeathCrate): boolean {
  const c = crate.contents;
  return c.guns.every((g) => g === null) && c.melee === null && c.pack === null && c.helmet === null && c.vest === null
    && Object.values(c.ammo).every((n) => n <= 0)
    && Object.values(c.heals).every((n) => n <= 0)
    && Object.values(c.throwables).every((n) => n <= 0);
}

// 自动拿取规则: 只换更优装备，枪位满时仅替换品级更低者，其余物资严格遵守负重和堆叠上限。
export function autoLootDeathCrate(c: Character, crate: DeathCrate): number {
  const bag = crate.contents;
  let taken = 0;
  const oldPack = c.pack?.level ?? null;
  if (bag.pack && bag.pack > (oldPack ?? 0)) {
    c.pack = { level: bag.pack };
    bag.pack = oldPack;
    taken++;
  }
  for (const kind of ['helmet', 'vest'] as const) {
    const incoming = bag[kind];
    const current = c[kind];
    if (!incoming) continue;
    if (!current || incoming.level > current.level || (incoming.level === current.level && incoming.durability > current.durability)) {
      c[kind] = { ...incoming };
      bag[kind] = current ? { ...current } : null;
      taken++;
    }
  }
  const meleeRank = { fists: 0, knife: 1, crowbar: 2, pan: 3 } as const;
  if (bag.melee && meleeRank[bag.melee] > meleeRank[c.melee.def.id]) {
    const old = c.melee.def.id === 'fists' ? null : c.melee.def.id;
    c.melee = { def: MELEE[bag.melee] };
    bag.melee = old;
    taken++;
  }
  const hadGun = c.hasGun();
  let firstGunSlot = -1;
  for (let i = 0; i < bag.guns.length; i++) {
    const gun = bag.guns[i];
    if (!gun) continue;
    let slot = gun.def.id === 'pistol' ? 2 : c.guns[0] ? (c.guns[1] ? -1 : 1) : 0;
    if (slot < 0) {
      const t0 = c.guns[0]?.def.tier ?? 99;
      const t1 = c.guns[1]?.def.tier ?? 99;
      const low = t0 <= t1 ? 0 : 1;
      if (gun.def.tier > (c.guns[low]?.def.tier ?? 99)) slot = low;
    }
    if (slot < 0 || (slot === 2 && c.guns[2] && gun.def.tier <= (c.guns[2]?.def.tier ?? 99))) continue;
    const old = c.guns[slot];
    c.guns[slot] = gun;
    bag.guns[i] = old;
    if (firstGunSlot < 0) firstGunSlot = slot;
    taken++;
  }
  if (!hadGun && firstGunSlot >= 0) c.curSlot = firstGunSlot;
  for (const t of ['pistol', 'rifle', 'smg', 'sniper', 'shotgun'] as const) {
    const afford = Math.max(0, Math.floor((carryCapacity(c.pack) - carryWeight(c) + 1e-6) / ROUND_WEIGHT));
    const n = Math.min(bag.ammo[t], afford);
    if (n <= 0) continue;
    c.ammo[t] += n;
    bag.ammo[t] -= n;
    taken += n;
  }
  for (const id of HEAL_ORDER) {
    const afford = Math.max(0, Math.floor((carryCapacity(c.pack) - carryWeight(c) + 1e-6) / HEAL_WEIGHT[id]));
    const n = Math.min(bag.heals[id], HEALS[id].max - c.heals[id], afford);
    if (n <= 0) continue;
    c.heals[id] += n;
    bag.heals[id] -= n;
    taken += n;
  }
  for (const id of ['frag', 'smoke'] as const) {
    const afford = Math.max(0, Math.floor((carryCapacity(c.pack) - carryWeight(c) + 1e-6) / THROW_WEIGHT[id]));
    const n = Math.min(bag.throwables[id], THROWABLES[id].max - c.throwables[id], afford);
    if (n <= 0) continue;
    c.throwables[id] += n;
    bag.throwables[id] -= n;
    taken += n;
  }
  return taken;
}

export class DeathCrateManager {
  readonly crates: DeathCrate[] = [];
  private readonly root = new THREE.Group();
  private time = 0;

  constructor(scene: THREE.Scene) {
    scene.add(this.root);
  }

  spawn(c: Character, groundY: number): DeathCrate {
    let crate = this.crates.find((it) => !it.active);
    if (!crate) {
      crate = { group: buildCrate(), owner: c.name, contents: copyContents(c), active: true, phase: 0 };
      this.crates.push(crate);
      this.root.add(crate.group);
    }
    crate.owner = c.name;
    crate.contents = copyContents(c);
    crate.active = true;
    crate.phase = Math.random() * Math.PI * 2;
    crate.group.position.set(c.pos.x, groundY + 0.03, c.pos.z);
    crate.group.rotation.y = Math.random() * Math.PI * 2;
    crate.group.visible = true;
    return crate;
  }

  nearest(x: number, y: number, z: number, maxDist: number): DeathCrate | null {
    let best: DeathCrate | null = null;
    let bestD = maxDist * maxDist;
    for (const crate of this.crates) {
      if (!crate.active) continue;
      const dx = crate.group.position.x - x;
      const dy = crate.group.position.y - y;
      const dz = crate.group.position.z - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD) {
        best = crate;
        bestD = d2;
      }
    }
    return best;
  }

  update(dt: number): void {
    this.time += dt;
    for (const crate of this.crates) {
      if (!crate.active) continue;
      const pulse = 1 + Math.sin(this.time * 2.4 + crate.phase) * 0.025;
      crate.group.scale.set(pulse, pulse, pulse);
    }
  }

  consumeIfEmpty(crate: DeathCrate): void {
    if (!deathCrateEmpty(crate)) return;
    crate.active = false;
    crate.group.visible = false;
  }

  clear(): void {
    for (const crate of this.crates) {
      crate.active = false;
      crate.group.visible = false;
    }
  }
}
