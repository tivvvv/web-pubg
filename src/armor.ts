// ─────────────────────────────────────────────────────────────────────────────
// armor.ts — 护具系统: 头盔/防弹衣三级定义、地面/人物模型、loot 类型映射
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import type { ArmorLootId, LootKind } from './types';

export type ArmorKind = 'helmet' | 'vest';
export type ArmorLevel = 1 | 2 | 3;

export interface ArmorDef {
  kind: ArmorKind;
  level: ArmorLevel;
  name: string;        // 一级头盔 / 三级防弹衣 …
  reduce: number;      // 对应部位减伤比例
  maxDurability: number;
  color: number;       // 模型与 HUD 配色(按等级)
}

const LEVEL_NAME = ['', '一级', '二级', '三级'] as const;
const LEVEL_COLOR: Record<ArmorLevel, number> = {
  1: 0x6f8159, // 灰绿
  2: 0x4d4a38, // 深迷彩
  3: 0x23262b, // 黑(带面甲)
};

function def(kind: ArmorKind, level: ArmorLevel, reduce: number, maxDurability: number): ArmorDef {
  return {
    kind, level, reduce, maxDurability,
    name: `${LEVEL_NAME[level]}${kind === 'helmet' ? '头盔' : '防弹衣'}`,
    color: LEVEL_COLOR[level],
  };
}

export const ARMORS: Record<ArmorKind, Record<ArmorLevel, ArmorDef>> = {
  helmet: { 1: def('helmet', 1, 0.30, 80), 2: def('helmet', 2, 0.40, 150), 3: def('helmet', 3, 0.55, 230) },
  vest: { 1: def('vest', 1, 0.30, 100), 2: def('vest', 2, 0.40, 200), 3: def('vest', 3, 0.55, 250) },
};

// ---- loot 类型映射 ----

const LOOT_TO_ARMOR: Partial<Record<LootKind, { kind: ArmorKind; level: ArmorLevel }>> = {
  helmet1: { kind: 'helmet', level: 1 },
  helmet2: { kind: 'helmet', level: 2 },
  helmet3: { kind: 'helmet', level: 3 },
  vest1: { kind: 'vest', level: 1 },
  vest2: { kind: 'vest', level: 2 },
  vest3: { kind: 'vest', level: 3 },
};

export function isArmorKind(kind: LootKind): kind is ArmorLootId {
  return kind in LOOT_TO_ARMOR;
}

export function armorFromLoot(kind: LootKind): { kind: ArmorKind; level: ArmorLevel } | null {
  return LOOT_TO_ARMOR[kind] ?? null;
}

export function armorLootKind(kind: ArmorKind, level: ArmorLevel): LootKind {
  return `${kind}${level}` as LootKind;
}

// ---- 模型(地面 loot 与人物装备共用; 共享几何/材质, 克隆零分配热路径) ----

const GEO = {
  dome: new THREE.SphereGeometry(0.21, 12, 7, 0, Math.PI * 2, 0, Math.PI / 2),
  brim: new THREE.CylinderGeometry(0.24, 0.255, 0.032, 12),
  visor: new THREE.BoxGeometry(0.22, 0.075, 0.03),
  plate: new THREE.BoxGeometry(0.4, 0.44, 0.09),
  strap: new THREE.BoxGeometry(0.11, 0.09, 0.36),
};
const VISOR_MAT = new THREE.MeshLambertMaterial({ color: 0x10141b });
const levelMats = new Map<number, THREE.MeshLambertMaterial>();
function armorMat(level: ArmorLevel): THREE.MeshLambertMaterial {
  const color = LEVEL_COLOR[level];
  let m = levelMats.get(color);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color });
    levelMats.set(color, m);
  }
  return m;
}

// 头盔: 半球盔体 + 帽檐; L3 正面加面甲
export function buildHelmetModel(level: ArmorLevel): THREE.Group {
  const g = new THREE.Group();
  const mat = armorMat(level);
  const dome = new THREE.Mesh(GEO.dome, mat);
  dome.scale.set(1, 0.82, 1);
  g.add(dome);
  const brim = new THREE.Mesh(GEO.brim, mat);
  g.add(brim);
  if (level === 3) {
    const visor = new THREE.Mesh(GEO.visor, VISOR_MAT);
    visor.position.set(0, 0.01, 0.2);
    g.add(visor);
  }
  return g;
}

// 防弹衣: 前后护板 + 肩带
export function buildVestModel(level: ArmorLevel): THREE.Group {
  const g = new THREE.Group();
  const mat = armorMat(level);
  const front = new THREE.Mesh(GEO.plate, mat);
  front.position.z = 0.155;
  g.add(front);
  const back = new THREE.Mesh(GEO.plate, mat);
  back.position.z = -0.155;
  g.add(back);
  for (const sx of [-0.13, 0.13]) {
    const strap = new THREE.Mesh(GEO.strap, mat);
    strap.position.set(sx, 0.26, 0);
    g.add(strap);
  }
  return g;
}
