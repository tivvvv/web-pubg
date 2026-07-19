// ─────────────────────────────────────────────────────────────────────────────
// backpack.ts - 背包装备: 三级定义, 负重容量/重量计算, 地面与人物背部模型
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import type { AmmoType, LootKind } from './types';
import type { HealId } from './heals';

export type PackLevel = 1 | 2 | 3;

export interface PackDef {
  level: PackLevel;
  name: string;   // 一级背包...
  bonus: number;  // 额外负重
  color: number;  // 模型配色(按等级)
}

export const BASE_CAPACITY = 40;
export const PACKS: Record<PackLevel, PackDef> = {
  1: { level: 1, name: '一级背包', bonus: 60, color: 0x6f8159 },  // 灰绿
  2: { level: 2, name: '二级背包', bonus: 100, color: 0x9a7f56 }, // 黄褐
  3: { level: 3, name: '三级背包', bonus: 150, color: 0x2c2f26 }, // 深军绿
};

export type PackLootId = 'pack1' | 'pack2' | 'pack3';
const LOOT_TO_LEVEL: Partial<Record<LootKind, PackLevel>> = { pack1: 1, pack2: 2, pack3: 3 };

export function isPackKind(kind: LootKind): kind is PackLootId {
  return kind in LOOT_TO_LEVEL;
}

export function packLevelFromLoot(kind: LootKind): PackLevel | null {
  return LOOT_TO_LEVEL[kind] ?? null;
}

export function packLootKind(level: PackLevel): LootKind {
  return `pack${level}` as LootKind;
}

// ---- 负重 ----

// 单位重量: 每发子弹 0.5(不分弹种), 绷带 2, 饮料 3, 医疗包 8, 手雷 12, 烟雾弹 8
export const ROUND_WEIGHT = 0.5;
export const HEAL_WEIGHT: Record<HealId, number> = { bandage: 2, drink: 3, medkit: 8 };
export const THROW_WEIGHT = { frag: 12, smoke: 8 } as const;

// 结构化负重输入(避免与 character.ts 循环引用)
export interface CarryState {
  ammo: Record<AmmoType, number>;
  heals: Record<HealId, number>;
  throwables: Record<'frag' | 'smoke', number>;
}

export function carryCapacity(pack: { level: PackLevel } | null): number {
  return BASE_CAPACITY + (pack ? PACKS[pack.level].bonus : 0);
}

export function carryWeight(c: CarryState): number {
  const rounds = c.ammo.pistol + c.ammo.rifle + c.ammo.smg + c.ammo.sniper + c.ammo.shotgun;
  return (
    rounds * ROUND_WEIGHT +
    c.heals.bandage * HEAL_WEIGHT.bandage +
    c.heals.medkit * HEAL_WEIGHT.medkit +
    c.heals.drink * HEAL_WEIGHT.drink +
    c.throwables.frag * THROW_WEIGHT.frag +
    c.throwables.smoke * THROW_WEIGHT.smoke
  );
}

// ---- 模型(地面 loot 与人物背部挂载共用) ----

const GEO = {
  body: new THREE.BoxGeometry(0.34, 0.42, 0.18),
  flap: new THREE.BoxGeometry(0.36, 0.14, 0.2),
  pocket: new THREE.BoxGeometry(0.2, 0.16, 0.06),
  sidePocket: new THREE.BoxGeometry(0.06, 0.14, 0.12),
  strap: new THREE.BoxGeometry(0.05, 0.34, 0.03),
  buckle: new THREE.BoxGeometry(0.05, 0.04, 0.02),
  handle: new THREE.BoxGeometry(0.14, 0.035, 0.04),
};
const buckleMat = new THREE.MeshLambertMaterial({ color: 0x3a3f45 });
const packMats = new Map<number, THREE.MeshLambertMaterial>();
function packMat(level: PackLevel): THREE.MeshLambertMaterial {
  const color = PACKS[level].color;
  let m = packMats.get(color);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color });
    packMats.set(color, m);
  }
  return m;
}

// 背包: 主体 + 翻盖(双扣) + 顶提手 + 外袋(背面) + 侧袋 ×2 + 双背带(贴背侧); 体型随等级增大
export function buildPackModel(level: PackLevel): THREE.Group {
  const g = new THREE.Group();
  const mat = packMat(level);
  g.add(new THREE.Mesh(GEO.body, mat));
  const flap = new THREE.Mesh(GEO.flap, mat);
  flap.position.set(0, 0.24, 0);
  g.add(flap);
  // 翻盖扣具 ×2
  for (const sx of [-0.1, 0.1]) {
    const buckle = new THREE.Mesh(GEO.buckle, buckleMat);
    buckle.position.set(sx, 0.19, 0.1);
    g.add(buckle);
  }
  // 顶提手
  const handle = new THREE.Mesh(GEO.handle, buckleMat);
  handle.position.set(0, 0.33, -0.02);
  g.add(handle);
  const pocket = new THREE.Mesh(GEO.pocket, mat);
  pocket.position.set(0, -0.08, -0.11);
  g.add(pocket);
  // 侧袋 ×2
  for (const sx of [-0.2, 0.2]) {
    const sp = new THREE.Mesh(GEO.sidePocket, mat);
    sp.position.set(sx, -0.1, 0.02);
    g.add(sp);
  }
  for (const sx of [-0.1, 0.1]) {
    const strap = new THREE.Mesh(GEO.strap, mat);
    strap.position.set(sx, 0, 0.105);
    g.add(strap);
  }
  // 等级体型递进(锚点不变, 绕原点缩放)
  const s = [0, 0.85, 1.0, 1.18][level];
  g.scale.setScalar(s);
  return g;
}
