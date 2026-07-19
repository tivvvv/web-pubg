// ─────────────────────────────────────────────────────────────────────────────
// armor.ts - 护具系统: 头盔/防弹衣三级定义, 地面/人物模型, loot 类型映射
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import type { ArmorLootId, LootKind } from './types';

export type ArmorKind = 'helmet' | 'vest';
export type ArmorLevel = 1 | 2 | 3;

export interface ArmorDef {
  kind: ArmorKind;
  level: ArmorLevel;
  name: string;        // 一级头盔 / 三级防弹衣...
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
  brimWide: new THREE.CylinderGeometry(0.265, 0.28, 0.028, 12),
  earSide: new THREE.BoxGeometry(0.05, 0.14, 0.16),
  chinStrap: new THREE.BoxGeometry(0.05, 0.12, 0.02),
  visor: new THREE.BoxGeometry(0.22, 0.075, 0.03),
  visorFrame: new THREE.BoxGeometry(0.24, 0.1, 0.015),
  plate: new THREE.BoxGeometry(0.4, 0.44, 0.09),
  strap: new THREE.BoxGeometry(0.11, 0.09, 0.36),
  sideStrap: new THREE.BoxGeometry(0.05, 0.12, 0.32),
  groinGuard: new THREE.BoxGeometry(0.34, 0.16, 0.07),
  shoulderGuard: new THREE.BoxGeometry(0.16, 0.06, 0.2),
};
const VISOR_MAT = new THREE.MeshLambertMaterial({ color: 0x10141b });
const STRAP_DARK = new THREE.MeshLambertMaterial({ color: 0x2a2d33 });
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

// 头盔: L1 轻便半盔; L2 全战斗盔(宽檐+护耳+下颌带); L3 重型 + 面甲框/面甲
export function buildHelmetModel(level: ArmorLevel): THREE.Group {
  const g = new THREE.Group();
  const mat = armorMat(level);
  const dome = new THREE.Mesh(GEO.dome, mat);
  dome.scale.set(1, 0.82, 1);
  g.add(dome);
  if (level === 1) {
    // 轻便锅盔: 盔体 + 窄檐
    const brim = new THREE.Mesh(GEO.brim, mat);
    g.add(brim);
  } else {
    // L2/L3 战斗盔: 加厚盔体 + 宽檐 + 护耳 + 下颌带
    const brim = new THREE.Mesh(GEO.brimWide, mat);
    g.add(brim);
    for (const sx of [-0.19, 0.19]) {
      const ear = new THREE.Mesh(GEO.earSide, mat);
      ear.position.set(sx, -0.05, 0.02);
      g.add(ear);
    }
    const chin = new THREE.Mesh(GEO.chinStrap, STRAP_DARK);
    chin.position.set(0, -0.12, 0.14);
    g.add(chin);
    if (level === 3) {
      // 面甲框 + 深色面甲
      const frame = new THREE.Mesh(GEO.visorFrame, mat);
      frame.position.set(0, 0.02, 0.205);
      g.add(frame);
      const visor = new THREE.Mesh(GEO.visor, VISOR_MAT);
      visor.position.set(0, 0.01, 0.21);
      g.add(visor);
    }
  }
  return g;
}

// 防弹衣: 前后护板 + 肩带 + 侧围带; L3 加护裆/护肩(更壮)
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
  // 侧围带(连接前后板)
  for (const sx of [-0.21, 0.21]) {
    const side = new THREE.Mesh(GEO.sideStrap, STRAP_DARK);
    side.position.set(sx, -0.1, 0);
    g.add(side);
  }
  if (level >= 2) {
    // L2+: 侧板加厚感(前后板略扩)
    front.scale.set(1.06, 1.05, 1);
    back.scale.set(1.06, 1.05, 1);
  }
  if (level === 3) {
    const groin = new THREE.Mesh(GEO.groinGuard, mat);
    groin.position.set(0, -0.29, 0.14);
    g.add(groin);
    for (const sx of [-0.17, 0.17]) {
      const sg = new THREE.Mesh(GEO.shoulderGuard, mat);
      sg.position.set(sx, 0.31, 0.02);
      g.add(sg);
    }
  }
  return g;
}
