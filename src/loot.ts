// 战利品: 漂浮旋转发光物; 枪械需按 F 拾取, 弹药/医疗包走近自动拾取
import * as THREE from 'three';
import type { LootKind, WeaponId } from './types';
import { rand } from './utils';
import { AMMO_PACK, WEAPONS } from './weapons';
import { buildWeaponModel } from './weaponmodels';
import { WATER_Y, type World } from './world';

export interface LootItem {
  kind: LootKind;
  group: THREE.Group;
  active: boolean;
  baseY: number;
  phase: number;
  mag: number;   // 枪械: 已装弹数(-1 = 非武器)
  ammo: number;  // 枪械: 附带备弹
}

const LOOT_CAP = 150;

// 共享几何/材质
const GEO = {
  ammo: new THREE.BoxGeometry(0.26, 0.18, 0.2),
  medBody: new THREE.BoxGeometry(0.34, 0.12, 0.26),
  crossV: new THREE.BoxGeometry(0.06, 0.03, 0.18),
  crossH: new THREE.BoxGeometry(0.18, 0.03, 0.06),
  ring: new THREE.TorusGeometry(0.42, 0.025, 6, 24),
};
const MAT = {
  ammo: new THREE.MeshBasicMaterial({ color: 0x7be06a }),
  medkit: new THREE.MeshBasicMaterial({ color: 0xf2f2f2 }),
  cross: new THREE.MeshBasicMaterial({ color: 0xe33e3e }),
};
// 每种类型的光环颜色(沿用旧配色编码)
const RING_MAT: Record<LootKind, THREE.MeshBasicMaterial> = {
  rifle: new THREE.MeshBasicMaterial({ color: 0xff7a29, transparent: true, opacity: 0.5 }),
  smg: new THREE.MeshBasicMaterial({ color: 0x37e0d8, transparent: true, opacity: 0.5 }),
  sniper: new THREE.MeshBasicMaterial({ color: 0xc05cff, transparent: true, opacity: 0.5 }),
  pistol: new THREE.MeshBasicMaterial({ color: 0xffd24d, transparent: true, opacity: 0.5 }),
  knife: new THREE.MeshBasicMaterial({ color: 0xdfe6ee, transparent: true, opacity: 0.5 }),
  ammo: new THREE.MeshBasicMaterial({ color: 0x7be06a, transparent: true, opacity: 0.5 }),
  medkit: new THREE.MeshBasicMaterial({ color: 0xf2f2f2, transparent: true, opacity: 0.5 }),
  frag: new THREE.MeshBasicMaterial({ color: 0x86c03c, transparent: true, opacity: 0.5 }),
  smoke: new THREE.MeshBasicMaterial({ color: 0xd7dde3, transparent: true, opacity: 0.5 }),
};

function buildLootMesh(kind: LootKind): THREE.Group {
  const g = new THREE.Group();
  const holder = new THREE.Group(); // 自旋部分
  g.add(holder);
  if (isWeaponKind(kind)) {
    // 真枪模型: 斜躺姿态, 可直接辨认枪型
    const wm = buildWeaponModel(kind);
    wm.group.rotation.set(-0.32, 0, 0.55);
    wm.group.position.y = 0.05;
    holder.add(wm.group);
  } else if (kind === 'frag' || kind === 'smoke') {
    // 投掷物模型
    const wm = buildWeaponModel(kind);
    wm.group.rotation.set(-0.3, 0, 0.5);
    wm.group.position.y = 0.02;
    holder.add(wm.group);
  } else if (kind === 'ammo') {
    holder.add(new THREE.Mesh(GEO.ammo, MAT.ammo));
  } else {
    holder.add(new THREE.Mesh(GEO.medBody, MAT.medkit));
    const cv = new THREE.Mesh(GEO.crossV, MAT.cross);
    cv.position.y = 0.075;
    holder.add(cv);
    const ch = new THREE.Mesh(GEO.crossH, MAT.cross);
    ch.position.y = 0.075;
    holder.add(ch);
  }
  const ring = new THREE.Mesh(GEO.ring, RING_MAT[kind]);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.55;
  g.add(ring);
  g.userData.holder = holder;
  return g;
}

export function isWeaponKind(kind: LootKind): kind is WeaponId | 'knife' {
  return kind === 'rifle' || kind === 'smg' || kind === 'sniper' || kind === 'pistol' || kind === 'knife';
}

export class LootManager {
  readonly items: LootItem[] = [];
  private root = new THREE.Group();
  private time = 0;

  constructor(scene: THREE.Scene) {
    scene.add(this.root);
  }

  // 初始散布 ~122 个: 先摆室内点位(房屋生成时给出), 再野外补齐
  populate(world: World): void {
    this.clear();
    let count = 0;
    // 室内点位(一层普通表, 二层 premium 高级枪表)
    for (const s of world.buildings.lootSpots) {
      if (count >= LOOT_CAP) break;
      if (Math.random() < 0.12) continue; // 少量留空, 避免每栋必刷
      this.spawn(this.rollKind(s.premium ? 'premium' : 'indoor'), s.x, s.y, s.z);
      count++;
    }
    // 野外散布补齐
    for (let t = 0; t < 1200 && count < 122; t++) {
      const x = rand(-320, 320);
      const z = rand(-320, 320);
      if (!world.pointFree(x, z, 0.4, WATER_Y + 0.5, 14)) continue;
      this.spawn(this.rollKind('wild'), x, world.getHeight(x, z), z);
      count++;
    }
  }

  private rollKind(table: 'wild' | 'indoor' | 'premium'): LootKind {
    const r = Math.random();
    if (table === 'premium') {
      // 二楼: 偏高级枪
      if (r < 0.3) return 'rifle';
      if (r < 0.55) return 'sniper';
      if (r < 0.7) return 'smg';
      if (r < 0.76) return 'frag';
      if (r < 0.81) return 'smoke';
      if (r < 0.92) return 'ammo';
      return 'medkit';
    }
    if (table === 'indoor') {
      if (r < 0.16) return 'rifle';
      if (r < 0.29) return 'smg';
      if (r < 0.35) return 'sniper';
      if (r < 0.43) return 'pistol';
      if (r < 0.5) return 'knife';
      if (r < 0.55) return 'frag';
      if (r < 0.6) return 'smoke';
      if (r < 0.78) return 'ammo';
      return 'medkit';
    }
    if (r < 0.09) return 'rifle';
    if (r < 0.18) return 'smg';
    if (r < 0.23) return 'sniper';
    if (r < 0.3) return 'pistol';
    if (r < 0.36) return 'knife';
    if (r < 0.42) return 'frag';
    if (r < 0.47) return 'smoke';
    if (r < 0.68) return 'ammo';
    return 'medkit';
  }

  // mag/ammo 仅对枪械有意义; 默认满弹匣 + 少量备弹
  spawn(kind: LootKind, x: number, groundY: number, z: number, mag = -1, ammo = 0): LootItem | null {
    let item = this.items.find((i) => !i.active);
    if (!item) {
      if (this.items.length >= LOOT_CAP) return null;
      item = { kind, group: buildLootMesh(kind), active: false, baseY: 0, phase: 0, mag: -1, ammo: 0 };
      this.items.push(item);
      this.root.add(item.group);
    } else {
      // 复用: 重建不同 kind 的网格
      this.root.remove(item.group);
      item.group = buildLootMesh(kind);
      this.root.add(item.group);
      item.kind = kind;
    }
    if (kind === 'rifle' || kind === 'smg' || kind === 'sniper' || kind === 'pistol') {
      const def = WEAPONS[kind];
      item.mag = mag >= 0 ? mag : def.magSize;
      item.ammo = ammo > 0 ? ammo : Math.max(1, Math.floor(AMMO_PACK[def.ammo] * 0.6));
    } else {
      item.mag = -1;
      // 投掷物掉落用 ammo 字段携带堆叠数(死亡掉落时为 >1 的 stack)
      item.ammo = (kind === 'frag' || kind === 'smoke') ? Math.max(1, ammo) : 0;
    }
    item.active = true;
    item.baseY = groundY + 1.0;
    item.phase = Math.random() * Math.PI * 2;
    item.group.position.set(x, item.baseY, z);
    item.group.visible = true;
    return item;
  }

  update(dt: number): void {
    this.time += dt;
    for (const it of this.items) {
      if (!it.active) continue;
      const holder = it.group.userData.holder as THREE.Group;
      holder.rotation.y += dt * 1.6;
      it.group.position.y = it.baseY + Math.sin(this.time * 2 + it.phase) * 0.12;
    }
  }

  // 最近的可用拾取物(全部类型)
  nearest(x: number, y: number, z: number, maxDist: number): LootItem | null {
    let best: LootItem | null = null;
    let bestD = maxDist * maxDist;
    for (const it of this.items) {
      if (!it.active) continue;
      const dx = it.group.position.x - x;
      const dy = it.group.position.y - y - 1;
      const dz = it.group.position.z - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD) {
        bestD = d2;
        best = it;
      }
    }
    return best;
  }

  // 最近的武器/近战(按 F 拾取候选)
  nearestWeapon(x: number, y: number, z: number, maxDist: number): LootItem | null {
    let best: LootItem | null = null;
    let bestD = maxDist * maxDist;
    for (const it of this.items) {
      if (!it.active || !isWeaponKind(it.kind)) continue;
      const dx = it.group.position.x - x;
      const dy = it.group.position.y - y - 1;
      const dz = it.group.position.z - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD) {
        bestD = d2;
        best = it;
      }
    }
    return best;
  }

  consume(it: LootItem): void {
    it.active = false;
    it.group.visible = false;
  }

  clear(): void {
    for (const it of this.items) {
      it.active = false;
      it.group.visible = false;
    }
  }
}
