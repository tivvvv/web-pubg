// 战利品: 漂浮旋转发光物; 枪械/护具/背包需按 F 拾取, 弹药/恢复品走近自动拾取
import * as THREE from 'three';
import type { AmmoType, LootKind, WeaponId } from './types';
import { rand } from './utils';
import { AMMO_BOX, AMMO_CLASS_COLOR, AMMO_LOOT_KIND, WEAPONS } from './weapons';
import { armorFromLoot, buildHelmetModel, buildVestModel, isArmorKind } from './armor';
import { buildPackModel, isPackKind, packLevelFromLoot } from './backpack';
import { buildWeaponModel } from './weaponmodels';
import { WATER_Y, riverZAt, type World } from './world';

export interface LootItem {
  kind: LootKind;
  group: THREE.Group;
  active: boolean;
  baseY: number;
  phase: number;
  mag: number;   // 枪械: 已装弹数(-1 = 非武器)
  ammo: number;  // 枪械: 附带备弹; 弹药包: 剩余弹量; 叠放物: 数量; 护具: 耐久
  outdoor: boolean; // 野外锚点刷新(枪支/独立弹药), 用于统计与调试
}

const LOOT_CAP = 240; // 室内配对 + 野外补齐 + 野外武器/弹药 + 空投内容物

// 共享几何/材质
const GEO = {
  ammo: new THREE.BoxGeometry(0.26, 0.18, 0.2),
  ammoBand: new THREE.BoxGeometry(0.28, 0.07, 0.22),
  ammoLid: new THREE.BoxGeometry(0.29, 0.03, 0.23),
  latch: new THREE.BoxGeometry(0.05, 0.045, 0.025),
  stripe: new THREE.BoxGeometry(0.22, 0.014, 0.03),
  medBody: new THREE.BoxGeometry(0.34, 0.12, 0.26),
  medLid: new THREE.BoxGeometry(0.35, 0.045, 0.27),
  medHandle: new THREE.BoxGeometry(0.12, 0.03, 0.04),
  crossV: new THREE.BoxGeometry(0.06, 0.03, 0.18),
  crossH: new THREE.BoxGeometry(0.18, 0.03, 0.06),
  bandageRoll: new THREE.CylinderGeometry(0.09, 0.09, 0.22, 10),
  bandageTail: new THREE.BoxGeometry(0.02, 0.008, 0.16),
  drinkCan: new THREE.CylinderGeometry(0.07, 0.07, 0.2, 10),
  drinkLid: new THREE.CylinderGeometry(0.065, 0.065, 0.012, 10),
  drinkBand: new THREE.CylinderGeometry(0.073, 0.073, 0.1, 10),
  pullTab: new THREE.BoxGeometry(0.03, 0.008, 0.05),
  ring: new THREE.TorusGeometry(0.42, 0.025, 6, 24),
};
const MAT = {
  ammoBody: new THREE.MeshBasicMaterial({ color: 0x4a4a42 }),
  medkit: new THREE.MeshBasicMaterial({ color: 0xf2f2f2 }),
  cross: new THREE.MeshBasicMaterial({ color: 0xe33e3e }),
  bandage: new THREE.MeshBasicMaterial({ color: 0xf5f0e2 }),
  drink: new THREE.MeshBasicMaterial({ color: 0x3fc98e }),
  silver: new THREE.MeshBasicMaterial({ color: 0xb9c1c9 }),
  dark: new THREE.MeshBasicMaterial({ color: 0x3a3a34 }),
  label: new THREE.MeshBasicMaterial({ color: 0x35cfff }),
};
// 弹药色带材质(按枪种配色, 与武器光环同色)
const BAND_MAT = new Map<AmmoType, THREE.MeshBasicMaterial>();
function bandMat(t: AmmoType): THREE.MeshBasicMaterial {
  let m = BAND_MAT.get(t);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color: AMMO_CLASS_COLOR[t] });
    BAND_MAT.set(t, m);
  }
  return m;
}
// 每种类型的光环颜色(沿用旧配色编码)
const RING_MAT: Record<LootKind, THREE.MeshBasicMaterial> = {
  rifle: new THREE.MeshBasicMaterial({ color: 0xff7a29, transparent: true, opacity: 0.5 }),
  smg: new THREE.MeshBasicMaterial({ color: 0x37e0d8, transparent: true, opacity: 0.5 }),
  sniper: new THREE.MeshBasicMaterial({ color: 0xc05cff, transparent: true, opacity: 0.5 }),
  pistol: new THREE.MeshBasicMaterial({ color: 0xffd24d, transparent: true, opacity: 0.5 }),
  knife: new THREE.MeshBasicMaterial({ color: 0xdfe6ee, transparent: true, opacity: 0.5 }),
  ammoRifle: new THREE.MeshBasicMaterial({ color: 0x7be06a, transparent: true, opacity: 0.5 }),
  ammoSmg: new THREE.MeshBasicMaterial({ color: 0x7be06a, transparent: true, opacity: 0.5 }),
  ammoSniper: new THREE.MeshBasicMaterial({ color: 0x7be06a, transparent: true, opacity: 0.5 }),
  ammoPistol: new THREE.MeshBasicMaterial({ color: 0x7be06a, transparent: true, opacity: 0.5 }),
  ammoShotgun: new THREE.MeshBasicMaterial({ color: 0x7be06a, transparent: true, opacity: 0.5 }),
  shotgun: new THREE.MeshBasicMaterial({ color: 0xe05a3a, transparent: true, opacity: 0.5 }),
  // 恢复品: 绿色系光环
  bandage: new THREE.MeshBasicMaterial({ color: 0xbfe6b0, transparent: true, opacity: 0.5 }),
  medkit: new THREE.MeshBasicMaterial({ color: 0x6fd88a, transparent: true, opacity: 0.5 }),
  drink: new THREE.MeshBasicMaterial({ color: 0x5ee0c0, transparent: true, opacity: 0.5 }),
  frag: new THREE.MeshBasicMaterial({ color: 0x86c03c, transparent: true, opacity: 0.5 }),
  smoke: new THREE.MeshBasicMaterial({ color: 0xd7dde3, transparent: true, opacity: 0.5 }),
  // 护具: 蓝白色系光环
  helmet1: new THREE.MeshBasicMaterial({ color: 0x8fc8ff, transparent: true, opacity: 0.5 }),
  helmet2: new THREE.MeshBasicMaterial({ color: 0x8fc8ff, transparent: true, opacity: 0.5 }),
  helmet3: new THREE.MeshBasicMaterial({ color: 0x8fc8ff, transparent: true, opacity: 0.5 }),
  vest1: new THREE.MeshBasicMaterial({ color: 0x5aa8f0, transparent: true, opacity: 0.5 }),
  vest2: new THREE.MeshBasicMaterial({ color: 0x5aa8f0, transparent: true, opacity: 0.5 }),
  vest3: new THREE.MeshBasicMaterial({ color: 0x5aa8f0, transparent: true, opacity: 0.5 }),
  // 背包: 黄褐色系光环
  pack1: new THREE.MeshBasicMaterial({ color: 0xd8b878, transparent: true, opacity: 0.5 }),
  pack2: new THREE.MeshBasicMaterial({ color: 0xd8b878, transparent: true, opacity: 0.5 }),
  pack3: new THREE.MeshBasicMaterial({ color: 0xd8b878, transparent: true, opacity: 0.5 }),
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
  } else if (isArmorKind(kind)) {
    // 护具模型: 头盔/防弹衣, 按等级配色
    const info = armorFromLoot(kind);
    if (info) {
      const am = info.kind === 'helmet' ? buildHelmetModel(info.level) : buildVestModel(info.level);
      am.rotation.set(-0.25, 0, 0.35);
      am.position.y = info.kind === 'helmet' ? -0.05 : 0.1;
      holder.add(am);
    }
  } else if (isPackKind(kind)) {
    // 背包模型: 按等级配色, 直立微倾
    const level = packLevelFromLoot(kind);
    if (level) {
      const pm = buildPackModel(level);
      pm.rotation.set(-0.15, 0, 0.2);
      holder.add(pm);
    }
  } else if (kind === 'bandage') {
    // 绷带卷(放倒的白色小卷) + 红十字绑带 + 散开的卷尾
    const m = new THREE.Mesh(GEO.bandageRoll, MAT.bandage);
    m.rotation.z = Math.PI / 2;
    holder.add(m);
    const strap = new THREE.Mesh(GEO.stripe, MAT.cross);
    strap.scale.set(0.5, 1, 3.2);
    strap.position.y = 0.002;
    holder.add(strap);
    const tail = new THREE.Mesh(GEO.bandageTail, MAT.bandage);
    tail.position.set(0.1, -0.075, 0.1);
    tail.rotation.y = 0.5;
    holder.add(tail);
  } else if (kind === 'drink') {
    // 饮料罐: 罐体 + 亮标签带 + 顶盖 + 拉环
    holder.add(new THREE.Mesh(GEO.drinkCan, MAT.drink));
    const band = new THREE.Mesh(GEO.drinkBand, MAT.label);
    band.position.y = -0.02;
    holder.add(band);
    const lid = new THREE.Mesh(GEO.drinkLid, MAT.silver);
    lid.position.y = 0.103;
    holder.add(lid);
    const tab = new THREE.Mesh(GEO.pullTab, MAT.dark);
    tab.position.set(0, 0.112, 0.015);
    holder.add(tab);
  } else if (kind === 'ammoRifle' || kind === 'ammoSmg' || kind === 'ammoSniper' || kind === 'ammoPistol' || kind === 'ammoShotgun') {
    // 分类弹药盒: 深灰盒体 + 枪种色带 + 盖 + 锁扣 + 口径识别条
    const t = kind === 'ammoRifle' ? 'rifle' : kind === 'ammoSmg' ? 'smg' : kind === 'ammoSniper' ? 'sniper' : kind === 'ammoShotgun' ? 'shotgun' : 'pistol';
    holder.add(new THREE.Mesh(GEO.ammo, MAT.ammoBody));
    holder.add(new THREE.Mesh(GEO.ammoBand, bandMat(t)));
    const lid = new THREE.Mesh(GEO.ammoLid, MAT.dark);
    lid.position.y = 0.105;
    holder.add(lid);
    const stripe = new THREE.Mesh(GEO.stripe, bandMat(t));
    stripe.position.y = 0.122;
    holder.add(stripe);
    const latch = new THREE.Mesh(GEO.latch, MAT.silver);
    latch.position.set(0, 0.02, 0.115);
    holder.add(latch);
  } else {
    // 医疗箱: 白盒 + 盖缝 + 顶部红十字 + 提手 + 前锁扣
    holder.add(new THREE.Mesh(GEO.medBody, MAT.medkit));
    const lid = new THREE.Mesh(GEO.medLid, MAT.medkit);
    lid.position.y = 0.06;
    holder.add(lid);
    const seam = new THREE.Mesh(GEO.medLid, MAT.dark);
    seam.scale.set(1.01, 0.2, 1.01);
    seam.position.y = 0.038;
    holder.add(seam);
    const cv = new THREE.Mesh(GEO.crossV, MAT.cross);
    cv.position.y = 0.085;
    holder.add(cv);
    const ch = new THREE.Mesh(GEO.crossH, MAT.cross);
    ch.position.y = 0.085;
    holder.add(ch);
    const handle = new THREE.Mesh(GEO.medHandle, MAT.dark);
    handle.position.set(0, 0.1, -0.06);
    holder.add(handle);
    const latch = new THREE.Mesh(GEO.latch, MAT.silver);
    latch.position.set(0, 0.01, 0.135);
    holder.add(latch);
  }
  const ring = new THREE.Mesh(GEO.ring, RING_MAT[kind]);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.55;
  g.add(ring);
  g.userData.holder = holder;
  return g;
}

export function isWeaponKind(kind: LootKind): kind is WeaponId | 'knife' {
  return kind === 'rifle' || kind === 'smg' || kind === 'sniper' || kind === 'pistol' || kind === 'shotgun' || kind === 'knife';
}

export class LootManager {
  readonly items: LootItem[] = [];
  private root = new THREE.Group();
  private time = 0;

  constructor(scene: THREE.Scene) {
    scene.add(this.root);
  }

  // 初始散布: 先摆室内点位(房屋生成时给出), 再野外补齐; 武器按比例配一盒匹配弹药
  populate(world: World): void {
    this.clear();
    let count = 0;
    // 室内点位(一层普通表, 二层 premium 高级枪表)
    for (const s of world.buildings.lootSpots) {
      if (count >= LOOT_CAP) break;
      if (Math.random() < 0.12) continue; // 少量留空, 避免每栋必刷
      const kind = this.rollKind(s.premium ? 'premium' : 'indoor');
      this.spawn(kind, s.x, s.y, s.z);
      count++;
      count += this.pairAmmo(world, kind, s.x, s.y, s.z, 0.8);
    }
    // 野外散布补齐
    for (let t = 0; t < 1200 && count < 138; t++) {
      const x = rand(-320, 320);
      const z = rand(-320, 320);
      if (!world.pointFree(x, z, 0.4, WATER_Y + 0.5, 14)) continue;
      const kind = this.rollKind('wild');
      const y = world.getHeight(x, z);
      this.spawn(kind, x, y, z);
      count++;
      count += this.pairAmmo(world, kind, x, y, z, 0.6);
    }
    // 野外武器/弹药锚点(纯补充, 不挤占室内与野外通用刷量)
    count += this.spawnOutdoorGuns(world);
  }

  // 地面武器按概率在 1~2m 内配一盒匹配弹药(返回生成数)
  // sampleTerrain: 野外配对时弹药按自身落点地形取高(坡地不埋不浮)
  private pairAmmo(world: World, kind: LootKind, x: number, y: number, z: number, chance: number, sampleTerrain = false): number {
    if (!isWeaponKind(kind) || kind === 'knife') return 0;
    if (Math.random() >= chance) return 0;
    const a = Math.random() * Math.PI * 2;
    const d = 0.8 + Math.random() * 1.2;
    const ax = x + Math.cos(a) * d;
    const az = z + Math.sin(a) * d;
    const it = this.spawn(AMMO_LOOT_KIND[WEAPONS[kind].ammo], ax, sampleTerrain ? world.getHeight(ax, az) : y, az);
    return it ? 1 : 0;
  }

  // 野外枪支稀有度: 手枪/冲锋枪常见, 步枪少见, 狙击稀有, 霰弹补充近战位
  private rollOutdoorGun(): LootKind {
    const r = Math.random();
    if (r < 0.28) return 'pistol';
    if (r < 0.52) return 'smg';
    if (r < 0.68) return 'shotgun';
    if (r < 0.88) return 'rifle';
    return 'sniper';
  }

  // 野外锚点候选: 村边/桥两端/搁浅渔船/岩石草垛旁/树丛/山顶
  private outdoorAnchors(world: World): { x: number; z: number }[] {
    const pts: { x: number; z: number }[] = [];
    // 村边(地块外 5~12m)
    for (const p of world.buildings.plots) {
      for (let k = 0; k < 2; k++) {
        const side = (Math.random() * 4) | 0;
        const m = rand(5, 12);
        if (side === 0) pts.push({ x: p.minX - m, z: rand(p.minZ, p.maxZ) });
        else if (side === 1) pts.push({ x: p.maxX + m, z: rand(p.minZ, p.maxZ) });
        else if (side === 2) pts.push({ x: rand(p.minX, p.maxX), z: p.minZ - m });
        else pts.push({ x: rand(p.minX, p.maxX), z: p.maxZ + m });
      }
    }
    // 桥两端(双桥 x=-50 / 170)
    for (const bx of [-50, 170]) {
      const rz = riverZAt(bx);
      pts.push({ x: bx + rand(-2.5, 2.5), z: rz - rand(15.5, 19) });
      pts.push({ x: bx + rand(-2.5, 2.5), z: rz + rand(15.5, 19) });
    }
    // 搁浅渔船旁
    for (const b of world.boatPts) {
      pts.push({ x: b.x + rand(-3, 3), z: b.z + rand(-3, 3) });
    }
    // 岩石/草垛旁(岩柱碰撞体, 半径外 1~2.5m)
    const rocks = world.cyls.filter((c) => c.tag === 'rock');
    for (let k = 0; k < 8 && rocks.length > 0; k++) {
      const c = rocks[(Math.random() * rocks.length) | 0] as (typeof rocks)[number];
      const a = Math.random() * Math.PI * 2;
      pts.push({ x: c.x + Math.cos(a) * (c.r + rand(1, 2.5)), z: c.z + Math.sin(a) * (c.r + rand(1, 2.5)) });
    }
    // 树丛(12m 内 ≥3 棵树)
    let clusters = 0;
    for (let t = 0; t < 80 && clusters < 6; t++) {
      const x = rand(-320, 320);
      const z = rand(-320, 320);
      let n = 0;
      for (const c of world.cyls) {
        if (c.tag !== 'tree') continue;
        const dx = x - c.x;
        const dz = z - c.z;
        if (dx * dx + dz * dz < 144) {
          n++;
          if (n >= 3) break;
        }
      }
      if (n >= 3) {
        pts.push({ x, z });
        clusters++;
      }
    }
    // 山顶(高于四周 8m 邻点)
    let hills = 0;
    for (let t = 0; t < 80 && hills < 4; t++) {
      const x = rand(-300, 300);
      const z = rand(-300, 300);
      const h = world.getHeight(x, z);
      if (h < 7.5) continue;
      if (world.getHeight(x + 8, z) > h || world.getHeight(x - 8, z) > h ||
        world.getHeight(x, z + 8) > h || world.getHeight(x, z - 8) > h) continue;
      pts.push({ x, z });
      hills++;
    }
    return pts;
  }

  // 野外武器生成: ~16 把枪(50% 配一盒匹配弹药) + 10 个独立弹药包
  private spawnOutdoorGuns(world: World): number {
    const anchors = this.outdoorAnchors(world);
    // 洗牌
    for (let i = anchors.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = anchors[i] as { x: number; z: number };
      anchors[i] = anchors[j] as { x: number; z: number };
      anchors[j] = t;
    }
    const used: { x: number; z: number }[] = [];
    // 锚点可用性: 不在水里/房里/碰撞体上, 与已放点及既有战利品保持距离
    const anchorOk = (a: { x: number; z: number }, gap: number): boolean => {
      if (!world.pointFree(a.x, a.z, 0.5, WATER_Y + 0.3, 14)) return false;
      if (world.inPlot(a.x, a.z, 1.5)) return false;
      for (const u of used) {
        const dx = a.x - u.x;
        const dz = a.z - u.z;
        if (dx * dx + dz * dz < gap * gap) return false;
      }
      for (const it of this.items) {
        if (!it.active) continue;
        const dx = a.x - it.group.position.x;
        const dz = a.z - it.group.position.z;
        if (dx * dx + dz * dz < 4) return false;
      }
      return true;
    };
    let spawned = 0;
    let guns = 0;
    for (const a of anchors) {
      if (guns >= 16) break;
      if (!anchorOk(a, 6)) continue;
      const kind = this.rollOutdoorGun();
      const y = world.getHeight(a.x, a.z);
      const it = this.spawn(kind, a.x, y, a.z);
      if (!it) break;
      it.outdoor = true;
      used.push(a);
      guns++;
      spawned++;
      spawned += this.pairAmmo(world, kind, a.x, y, a.z, 0.5, true);
    }
    let packs = 0;
    for (const a of anchors) {
      if (packs >= 10) break;
      if (!anchorOk(a, 2)) continue;
      const kind = this.rollAmmo();
      const y = world.getHeight(a.x, a.z);
      const it = this.spawn(kind, a.x, y, a.z);
      if (!it) break;
      it.outdoor = true;
      used.push(a);
      packs++;
      spawned++;
    }
    return spawned;
  }

  // 弹药包按类型子掷: 步枪弹/冲锋枪弹偏多, 霰弹少量
  private rollAmmo(): LootKind {
    const r = Math.random();
    if (r < 0.3) return 'ammoRifle';
    if (r < 0.58) return 'ammoSmg';
    if (r < 0.78) return 'ammoPistol';
    if (r < 0.92) return 'ammoShotgun';
    return 'ammoSniper';
  }

  private rollKind(table: 'wild' | 'indoor' | 'premium'): LootKind {
    const r = Math.random();
    if (table === 'premium') {
      // 二楼: 偏高级枪, 三级甲只在这里像样地刷
      if (r < 0.26) return 'rifle';
      if (r < 0.46) return 'sniper';
      if (r < 0.56) return 'shotgun';
      if (r < 0.66) return 'smg';
      if (r < 0.7) return 'frag';
      if (r < 0.74) return 'smoke';
      if (r < 0.77) return 'helmet3';
      if (r < 0.8) return 'vest3';
      if (r < 0.83) return 'helmet2';
      if (r < 0.86) return 'vest2';
      if (r < 0.9) return this.rollAmmo();
      if (r < 0.93) return 'pack2';
      if (r < 0.96) return 'pack3'; // 三级背包主要在高级房
      if (r < 0.98) return 'bandage';
      if (r < 0.99) return 'drink';
      return 'medkit'; // 高级房才有像样概率
    }
    if (table === 'indoor') {
      if (r < 0.15) return 'rifle';
      if (r < 0.26) return 'smg';
      if (r < 0.35) return 'shotgun';
      if (r < 0.4) return 'sniper';
      if (r < 0.47) return 'pistol';
      if (r < 0.52) return 'knife';
      if (r < 0.56) return 'frag';
      if (r < 0.6) return 'smoke';
      if (r < 0.65) return 'helmet1';
      if (r < 0.7) return 'vest1';
      if (r < 0.72) return 'helmet2';
      if (r < 0.74) return 'vest2';
      if (r < 0.85) return this.rollAmmo();
      if (r < 0.9) return 'pack1';
      if (r < 0.92) return 'pack2';
      if (r < 0.97) return 'bandage';
      if (r < 0.99) return 'drink';
      return 'medkit';
    }
    if (r < 0.07) return 'rifle';
    if (r < 0.14) return 'smg';
    if (r < 0.21) return 'shotgun';
    if (r < 0.25) return 'sniper';
    if (r < 0.31) return 'pistol';
    if (r < 0.37) return 'knife';
    if (r < 0.42) return 'frag';
    if (r < 0.47) return 'smoke';
    if (r < 0.53) return 'helmet1';
    if (r < 0.59) return 'vest1';
    if (r < 0.61) return 'helmet2';
    if (r < 0.63) return 'vest2';
    if (r < 0.8) return this.rollAmmo();
    if (r < 0.85) return 'pack1';
    if (r < 0.87) return 'pack2';
    if (r < 0.94) return 'bandage';
    if (r < 0.98) return 'drink';
    return 'medkit';
  }

  // mag/ammo 仅对枪械有意义; 默认满弹匣 + 少量备弹
  spawn(kind: LootKind, x: number, groundY: number, z: number, mag = -1, ammo = 0): LootItem | null {
    let item = this.items.find((i) => !i.active);
    if (!item) {
      if (this.items.length >= LOOT_CAP) return null;
      item = { kind, group: buildLootMesh(kind), active: false, baseY: 0, phase: 0, mag: -1, ammo: 0, outdoor: false };
      this.items.push(item);
      this.root.add(item.group);
    } else {
      // 复用: 重建不同 kind 的网格
      this.root.remove(item.group);
      item.group = buildLootMesh(kind);
      this.root.add(item.group);
      item.kind = kind;
    }
    if (kind === 'rifle' || kind === 'smg' || kind === 'sniper' || kind === 'pistol' || kind === 'shotgun') {
      item.mag = Math.max(0, mag); // 地面武器默认空弹匣; 死亡掉落携带剩余弹匣
      item.ammo = Math.max(0, ammo);
    } else if (kind === 'frag' || kind === 'smoke') {
      item.mag = -1;
      // 投掷物掉落用 ammo 字段携带堆叠数(死亡掉落时为 >1 的 stack)
      item.ammo = Math.max(1, ammo);
    } else if (kind === 'ammoRifle' || kind === 'ammoSmg' || kind === 'ammoSniper' || kind === 'ammoPistol' || kind === 'ammoShotgun') {
      item.mag = -1;
      const t = kind === 'ammoRifle' ? 'rifle' : kind === 'ammoSmg' ? 'smg' : kind === 'ammoSniper' ? 'sniper' : kind === 'ammoShotgun' ? 'shotgun' : 'pistol';
      item.ammo = ammo > 0 ? ammo : AMMO_BOX[t]; // 弹药包: ammo 字段为剩余弹量
    } else {
      item.mag = -1;
      // 护具用 ammo 字段携带剩余耐久(0 = 满耐久新刷)
      item.ammo = Math.max(0, ammo);
    }
    item.active = true;
    item.outdoor = false;
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

  // 最近的 F 拾取物(武器 + 护具 + 背包), 玩家提示用
  nearestFPickup(x: number, y: number, z: number, maxDist: number): LootItem | null {
    let best: LootItem | null = null;
    let bestD = maxDist * maxDist;
    for (const it of this.items) {
      if (!it.active || (!isWeaponKind(it.kind) && !isArmorKind(it.kind) && !isPackKind(it.kind))) continue;
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

  // 最近的护具(bot 寻宝用)
  nearestArmor(x: number, y: number, z: number, maxDist: number): LootItem | null {
    let best: LootItem | null = null;
    let bestD = maxDist * maxDist;
    for (const it of this.items) {
      if (!it.active || !isArmorKind(it.kind)) continue;
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

  // 最近的匹配类型弹药包(bot 寻弹用)
  nearestAmmoOfType(x: number, y: number, z: number, maxDist: number, t: AmmoType): LootItem | null {
    const kind = AMMO_LOOT_KIND[t];
    let best: LootItem | null = null;
    let bestD = maxDist * maxDist;
    for (const it of this.items) {
      if (!it.active || it.kind !== kind) continue;
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
