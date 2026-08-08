// ─────────────────────────────────────────────────────────────────────────────
// buildings.ts - 数据驱动的建筑原型系统: 平房/双层/露台房/三层楼/谷仓/小卖部/大体育馆
// 组件化构建(墙段开洞/楼梯/护栏/楼板/屋顶), 可破坏门窗/平台/loot 点全部复用同一套
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import type { AabbCollider, DestructibleLike } from './types';
import { riverZAt, type World } from './world';
import { random } from './random';
import { applySurfaceAsset, type SurfaceAssetId } from './assets';
import { AssetUsageRegistry, buildingAssetPack, SURFACE_MATERIAL_PRESETS } from './assetcatalog';
import { regionAt, type RegionId } from './regions';

export interface LootSpot {
  x: number; y: number; z: number;
  premium: boolean; // 高级点位(二楼顶/体育馆/三楼), 偏高级枪
}

export type ArchId = 'cottage1' | 'cottage2' | 'terrace' | 'apartment' | 'barn' | 'shop' | 'gym';

export interface HousePlot {
  minX: number; minZ: number; maxX: number; maxZ: number; // 含 2m 外围安全边
  flatH: number;
  arch: ArchId;
  w: number; // 内宽(x)
  d: number; // 内深(z)
  storeys?: number; // 高层建筑覆盖默认层数
}

// 原型表: 尺寸范围与村庄放置权重(gym 特殊定点)
const ARCHS: Record<ArchId, { w: [number, number]; d: [number, number]; weight: number }> = {
  cottage1: { w: [8.2, 10.8], d: [7.4, 9.6], weight: 26 },
  cottage2: { w: [8.8, 11.6], d: [7.8, 10.5], weight: 22 },
  terrace: { w: [10.0, 12.2], d: [8.8, 10.8], weight: 12 },
  apartment: { w: [11.0, 14.0], d: [9.8, 12.0], weight: 8 },
  barn: { w: [10.0, 12.5], d: [8.8, 11.0], weight: 8 },
  shop: { w: [7.2, 9.0], d: [6.0, 7.5], weight: 12 },
  gym: { w: [40, 43], d: [25, 28], weight: 0 },
};
// 调色板: 墙面(白/米/浅红砖/淡蓝/灰绿/原色系), 屋顶(红瓦/灰/锈), 统一装饰色
const WALL_COLORS = [0xe8e4da, 0xd8cbb0, 0xc08a6e, 0xa8bcc8, 0x9aa88e, 0xc9b18a, 0xd3b9a0, 0xc7c3b5];
const ROOF_COLORS = [0xa05545, 0x8a8f96, 0x8a5f3c, 0x9a6a4f];
const FLOOR_C = 0xa3906e;
const FLOOR2_C = 0x96835f;
const RAIL_C = 0x77664c;
const DOOR_C = 0x7a5c38;
const PANE_C = 0xbfe0ea;
const TRIM_C = 0xefe6d0;  // 统一装饰: 窗框/门框/檐口
const FRAME_C = 0x5f5245; // 深色框边
const SHUTTER_C = 0x6a5a48; // 百叶窗板
const SKIRT_C = 0x6f6a5e; // 墙基裙(加深, 接地点缀)
const CRATE_C = 0x9a7f56;
const GUTTER_C = 0x545c5b;
const INTERIOR_WOOD_C = 0x6d5138;
const FABRIC_C = 0x7d836c;

// 坡屋面瓦层的纵深位置和高度。三组成对分布，保持屋面左右对称。
export const GABLE_ROOF_COURSES = Object.freeze([
  { z: 0.1, y: 0.31 }, { z: 0.9, y: 0.31 },
  { z: 0.25, y: 0.63 }, { z: 0.75, y: 0.63 },
  { z: 0.4, y: 0.94 }, { z: 0.6, y: 0.94 },
]);
export const GABLE_INFILL_LAYERS = 24;

export function gableRoofPitch(depth: number): number {
  return Math.atan2(1.08, Math.max(1, depth * 0.5 + 0.22));
}

export interface RegionalBuildingStyle {
  walls: readonly number[];
  roofs: readonly number[];
  accent: number;
  secondary: number;
  chimneyChance: number;
  acChance: number;
}

export const REGIONAL_BUILDING_STYLES: Readonly<Record<RegionId, RegionalBuildingStyle>> = {
  stonegate: {
    walls: [0xd7d2c8, 0xb9c3c6, 0xc6aa92], roofs: [0x787d82, 0x8b5b47],
    accent: 0x756e64, secondary: 0xb06b4f, chimneyChance: 0.34, acChance: 0.62,
  },
  ironring: {
    walls: [0xb7b9b2, 0x9fa7a5, 0xc3b9aa], roofs: [0x676d70, 0x80564a],
    accent: 0x9c493d, secondary: 0x515c62, chimneyChance: 0.12, acChance: 0.72,
  },
  sunfield: {
    walls: [0xd4c096, 0xc8a970, 0xbca27a], roofs: [0x995542, 0x795e44],
    accent: 0x765239, secondary: 0xc4a24f, chimneyChance: 0.58, acChance: 0.08,
  },
  mistwood: {
    walls: [0x9ba58f, 0x8f9a87, 0xb0aa91], roofs: [0x4f5a50, 0x665644],
    accent: 0x4f493e, secondary: 0x6f7c59, chimneyChance: 0.7, acChance: 0.04,
  },
  eagleridge: {
    walls: [0xbdbdb5, 0xa9aca8, 0xc9c3b4], roofs: [0x686d70, 0x7e6556],
    accent: 0x666b6b, secondary: 0xa84f42, chimneyChance: 0.22, acChance: 0.42,
  },
  tideharbor: {
    walls: [0xa9c0c2, 0xb8c8c1, 0xd0c4a5], roofs: [0x55747a, 0x82594a],
    accent: 0x3f6f79, secondary: 0xd0a957, chimneyChance: 0.28, acChance: 0.18,
  },
};

export function regionalBuildingStyle(region: RegionId): RegionalBuildingStyle {
  return REGIONAL_BUILDING_STYLES[region];
}

const WT = 0.26;            // 外墙厚
const WT2 = 0.14;           // 上层墙厚
const SLAB_T = 0.24;        // 楼板厚
const WALL_H = 2.9;         // 层高(地板面→墙顶)
const DOOR_W = 1.3, DOOR_H = 2.2;
const WIN_W = 1.15, WIN_SILL = 1.05, WIN_H = 1.05;
const STAIR_STEPS = 10, STAIR_W = 2.1;
const STAIR_LANDING = 1.6;         // 楼梯两端净空, 足够角色转身和交错通行
const STAIR_EDGE_OVERLAP = 0.015;  // 仅保留遮缝所需的轻微搭接, 避免楼板压进首末踏步
const STAIR_RAIL_END_CLEARANCE = 0.16; // 斜扶手两端退让楼板和落脚平台, 避免插入楼层
const STAIR_SIDE_CLEARANCE = 1.45; // 开放侧到室内隔墙的最小通道宽度
const APARTMENT_STAIR_WELL_MARGIN = 0.24; // 高楼梯井额外容纳角色半径和斜向移动
const APARTMENT_STAIR_END_MARGIN = 0.28;  // 首末踏步与楼板边缘保持可见净空
const STOREY_JOINT_OVERLAP = 0.14; // 上下层墙跨过楼板边带互相搭接, 楼梯井侧也不会漏光
const BOUND = 265;
const DOOR_SWING = (100 * Math.PI) / 180; // 开门转角 ~100°
const DOOR_TWEEN = 0.3;                   // 开关门动画时长(秒)

// 在单个实例化材质中增加墙面颗粒、底部积尘和朝上面的轻微提亮，不增加建筑绘制调用。
function enhanceStructureMaterial(mat: THREE.MeshStandardMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vStructureLocal;\nvarying vec3 vStructureWorld;\nvarying vec3 vStructureNormal;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vStructureLocal = position;\n  vStructureNormal = objectNormal;',
      )
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\n  vStructureWorld = worldPosition.xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vStructureLocal;\nvarying vec3 vStructureWorld;\nvarying vec3 vStructureNormal;',
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  float structureGrain = sin(vStructureWorld.x * 2.17 + vStructureWorld.y * 0.73)
    * cos(vStructureWorld.z * 1.93 - vStructureWorld.y * 0.51) * 0.5 + 0.5;
  float baseDust = 1.0 - smoothstep(-0.5, 0.34, vStructureLocal.y);
  float verticalFace = 1.0 - abs(normalize(vStructureNormal).y);
  float fineStreak = smoothstep(0.68, 0.98,
    sin(vStructureWorld.x * 0.71 + vStructureWorld.z * 0.53) * 0.5 + 0.5);
  float structureTone = 0.975 + structureGrain * 0.04;
  structureTone -= baseDust * verticalFace * 0.045;
  structureTone -= fineStreak * verticalFace * 0.018;
  structureTone += max(normalize(vStructureNormal).y, 0.0) * 0.025;
  diffuseColor.rgb *= structureTone;`,
      );
  };
  mat.customProgramCacheKey = () => 'building-surface-detail-v1';
}

// 门从操作者所在一侧向远离操作者的方向打开，避免门扇迎面扫过角色。
export function doorOpenAngleForActor(
  axis: 'x' | 'z',
  doorX: number,
  doorZ: number,
  actorX: number,
  actorZ: number,
  fallback: number,
  hinge: 1 | -1 = 1,
): number {
  const side = axis === 'x' ? actorZ - doorZ : actorX - doorX;
  if (Math.abs(side) < 0.08) return fallback;
  return (axis === 'x' ? Math.sign(side) : -Math.sign(side)) * hinge * DOOR_SWING;
}

export function doorColliderDisabled(alive: boolean, open: boolean, currentAngle: number): boolean {
  return !alive || open || Math.abs(currentAngle) > 0.12;
}

export function isMultiStoreyArch(arch: ArchId): boolean {
  return arch === 'cottage2' || arch === 'terrace' || arch === 'apartment';
}

export function buildingStoreys(plot: Pick<HousePlot, 'arch' | 'storeys'>): number {
  if (plot.arch === 'apartment') return Math.max(3, Math.floor(plot.storeys ?? 3));
  return plot.arch === 'cottage2' || plot.arch === 'terrace' ? 2 : 1;
}

export interface DoorLeafSegment {
  hingeX: number;
  hingeZ: number;
  endX: number;
  endZ: number;
}

/** 根据门框、铰链和当前转角计算门扇在地面的真实线段. */
export function doorLeafSegment(
  collider: AabbCollider,
  axis: 'x' | 'z',
  hinge: 1 | -1,
  angle: number,
): DoorLeafSegment {
  const width = axis === 'x'
    ? collider.maxX - collider.minX
    : collider.maxZ - collider.minZ;
  const hingeX = axis === 'x'
    ? (hinge === 1 ? collider.minX : collider.maxX)
    : (collider.minX + collider.maxX) * 0.5;
  const hingeZ = axis === 'z'
    ? (hinge === 1 ? collider.minZ : collider.maxZ)
    : (collider.minZ + collider.maxZ) * 0.5;
  const localX = axis === 'x' ? width * hinge : 0;
  const localZ = axis === 'z' ? width * hinge : 0;
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  return {
    hingeX,
    hingeZ,
    endX: hingeX + cos * localX + sin * localZ,
    endZ: hingeZ - sin * localX + cos * localZ,
  };
}

/** 将角色圆形占地推出旋转门扇, 返回是否发生了碰撞. */
export function resolveCircleAgainstDoorLeaf(
  point: { x: number; z: number },
  radius: number,
  leaf: DoorLeafSegment,
  halfThickness = 0.05,
): boolean {
  const sx = leaf.endX - leaf.hingeX;
  const sz = leaf.endZ - leaf.hingeZ;
  const lengthSq = sx * sx + sz * sz;
  if (lengthSq < 0.000001) return false;
  const projection = Math.max(0, Math.min(1,
    ((point.x - leaf.hingeX) * sx + (point.z - leaf.hingeZ) * sz) / lengthSq,
  ));
  const closestX = leaf.hingeX + sx * projection;
  const closestZ = leaf.hingeZ + sz * projection;
  const dx = point.x - closestX;
  const dz = point.z - closestZ;
  const minimumDistance = radius + halfThickness;
  const distanceSq = dx * dx + dz * dz;
  if (distanceSq >= minimumDistance * minimumDistance) return false;
  if (distanceSq > 0.000001) {
    const scale = minimumDistance / Math.sqrt(distanceSq);
    point.x = closestX + dx * scale;
    point.z = closestZ + dz * scale;
  } else {
    const length = Math.sqrt(lengthSq);
    point.x = closestX - (sz / length) * minimumDistance;
    point.z = closestZ + (sx / length) * minimumDistance;
  }
  return true;
}

export function stairRailX(x0: number, x1: number, side: 'min' | 'max'): number {
  return side === 'max' ? x1 : x0;
}

export interface StairHandrailTransform {
  centerY: number;
  centerZ: number;
  length: number;
  pitch: number;
}

export type ApartmentFloorLayout = 'lobby' | 'residence' | 'office' | 'lounge' | 'utility';

/** 高楼逐层功能分区。顶层固定为设备层，中间楼层循环但相邻层绝不相同。 */
export function apartmentFloorLayout(level: number, storeys: number): ApartmentFloorLayout {
  if (level <= 0) return 'lobby';
  if (level >= storeys - 1) return 'utility';
  return (['residence', 'office', 'lounge'] as const)[(level - 1) % 3] as ApartmentFloorLayout;
}

/** 计算贯穿整跑楼梯的斜扶手变换, 正反方向都保持与踏步坡度一致. */
export function stairHandrailTransform(
  zFrom: number,
  zTo: number,
  floorY: number,
  rise: number,
  steps = STAIR_STEPS,
): StairHandrailTransform {
  const run = zTo - zFrom;
  const totalRise = rise * steps;
  const fullLength = Math.hypot(run, totalRise);
  const endClearance = Math.min(STAIR_RAIL_END_CLEARANCE, fullLength * 0.12);
  return {
    centerY: floorY + rise * ((steps + 1) / 2) + 0.83,
    centerZ: (zFrom + zTo) / 2,
    length: Math.max(0.2, fullLength - endClearance * 2),
    pitch: -Math.sign(run || 1) * Math.atan2(totalRise, Math.abs(run)),
  };
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type BoxFn = (
  tag: 'wall' | 'floor' | 'roof',
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  c: number,
  o?: {
    collider?: boolean;
    platform?: boolean;
    detail?: boolean;
    visual?: boolean;
    rotateX?: number;
    rotateY?: number;
    rotateZ?: number;
    surface?: SurfaceAssetId;
  },
) => void;

interface Palette { wall: number; roof: number; chimney: boolean; ac: boolean }

interface Op {
  a0: number; a1: number; y0: number; y1: number;
  door?: boolean; doorless?: boolean; hingeEnd?: boolean;
}

export class Destructible implements DestructibleLike {
  alive = true;
  hp: number;
  readonly kind: 'door' | 'window';
  readonly maxHp: number;
  readonly mesh: THREE.Mesh;
  readonly collider: AabbCollider;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  // 门: 铰链开合(窗无此结构)
  group: THREE.Group | null = null;            // 含 pivot(门扇) + 铰链柱
  pivot: THREE.Group | null = null;            // 开门绕其 Y 轴旋转
  open = false;
  openAngle = 0;                               // 全开时的 pivot 转角(带方向)
  doorAxis: 'x' | 'z' | null = null;
  doorHinge: 1 | -1 = 1;
  constructor(
    kind: 'door' | 'window',
    maxHp: number,
    mesh: THREE.Mesh,
    collider: AabbCollider,
    cx: number, cy: number, cz: number,
  ) {
    this.kind = kind;
    this.maxHp = maxHp;
    this.hp = maxHp;
    this.mesh = mesh;
    this.collider = collider;
    this.cx = cx;
    this.cy = cy;
    this.cz = cz;
  }
  reset(intact: boolean): void {
    this.alive = intact;
    this.hp = intact ? this.maxHp : 0;
    this.mesh.visible = intact;
    this.collider.off = !intact;
    // 门复位为关闭
    this.open = false;
    if (this.pivot) this.pivot.rotation.y = 0;
  }
}

export class Buildings {
  plots: HousePlot[] = [];
  lootSpots: LootSpot[] = [];
  destructibles: Destructible[] = [];
  readonly assetUsage = new AssetUsageRegistry();
  root: THREE.Group | null = null;
  visualInstanceCount = 0;
  modelDetailInstanceCount = 0;
  europeanFacadeDetailCount = 0;
  readonly europeanFacadeDetailsByArch: Record<ArchId, number> = {
    cottage1: 0,
    cottage2: 0,
    terrace: 0,
    apartment: 0,
    barn: 0,
    shop: 0,
    gym: 0,
  };
  verticalSlicePlotIndex = -1;
  verticalSliceDetailCount = 0;

  // 门/窗几何体按墙的走向区分: AlongX 用于沿 X 延伸的墙(南/北墙), AlongZ 用于沿 Z 延伸的墙(东/西墙)
  private doorGeoAlongX = new THREE.BoxGeometry(DOOR_W, DOOR_H, 0.1);
  private doorGeoAlongZ = new THREE.BoxGeometry(0.1, DOOR_H, DOOR_W);
  private paneGeoAlongX = new THREE.BoxGeometry(WIN_W, WIN_H, 0.06);
  private paneGeoAlongZ = new THREE.BoxGeometry(0.06, WIN_H, WIN_W);
  private postGeoAlongX = new THREE.BoxGeometry(0.09, DOOR_H, WT + 0.06);
  private postGeoAlongZ = new THREE.BoxGeometry(WT + 0.06, DOOR_H, 0.09);
  private doorMat = new THREE.MeshStandardMaterial({ color: DOOR_C, roughness: 0.88 });
  private postMat = new THREE.MeshStandardMaterial({ color: 0x5e4629, roughness: 0.94 });
  private doorTrimMat = new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.92 }); // 门板拼缝
  private knobMat = new THREE.MeshStandardMaterial({ color: 0xb8a06a, roughness: 0.35, metalness: 0.45 }); // 门把手
  // 门扇细节共享几何(拼缝/把手板/把手珠, 按墙走向两套)
  private trimGeoX = new THREE.BoxGeometry(0.05, DOOR_H * 0.88, 0.02);
  private trimGeoZ = new THREE.BoxGeometry(0.02, DOOR_H * 0.88, 0.05);
  private railGeoX = new THREE.BoxGeometry(DOOR_W * 0.82, 0.07, 0.025);
  private railGeoZ = new THREE.BoxGeometry(0.025, 0.07, DOOR_W * 0.82);
  private handleGeoX = new THREE.BoxGeometry(0.1, 0.05, 0.05);
  private handleGeoZ = new THREE.BoxGeometry(0.05, 0.05, 0.1);
  private plateGeoX = new THREE.BoxGeometry(0.09, 0.16, 0.02);
  private plateGeoZ = new THREE.BoxGeometry(0.02, 0.16, 0.09);
  private paneMat = new THREE.MeshStandardMaterial({
    color: PANE_C,
    emissive: 0x18313b,
    emissiveIntensity: 0.32,
    transparent: true,
    opacity: 0.57,
    depthWrite: false,
    roughness: 0.14,
    metalness: 0.22,
    side: THREE.DoubleSide,
  });

  constructor() {
    applySurfaceAsset(this.doorMat, 'wood', 2.8, 0.9);
    applySurfaceAsset(this.postMat, 'wood', 3.4, 0.75);
    applySurfaceAsset(this.doorTrimMat, 'wood', 4.2, 0.7);
  }

  // ── 区域规划 (确定性种子; 城区/竞技场/农场/密林/山地/渔村定点) ──────────────
  plan(world: World): void {
    const rng = mulberry32(20240);
    const taken: { minX: number; minZ: number; maxX: number; maxZ: number }[] = [];
    // AABB 间净距 clear 米
    const boxOk = (minX: number, minZ: number, maxX: number, maxZ: number, clear: number) => {
      if (minX < -BOUND || maxX > BOUND || minZ < -BOUND || maxZ > BOUND) return false;
      for (const t of taken) {
        if (maxX + clear > t.minX && minX - clear < t.maxX && maxZ + clear > t.minZ && minZ - clear < t.maxZ) return false;
      }
      return true;
    };
    const footprintAt = (cx: number, cz: number, arch: ArchId, slopeTol: number, clear: number): HousePlot | null => {
      const spec = ARCHS[arch];
      const w = spec.w[0] + rng() * (spec.w[1] - spec.w[0]);
      const d = spec.d[0] + rng() * (spec.d[1] - spec.d[0]);
      const minX = cx - w / 2 - 2, maxX = cx + w / 2 + 2;
      const minZ = cz - d / 2 - 2, maxZ = cz + d / 2 + 2;
      if (!boxOk(minX, minZ, maxX, maxZ, clear)) return null;
      // 河道禁建(桥位另算)
      const rd = Math.abs(cz - riverZAt(cx));
      if (rd < 15 + d / 2) return null;
      // 平整高度: 内区五角均值
      const ix0 = cx - w / 2, ix1 = cx + w / 2, iz0 = cz - d / 2, iz1 = cz + d / 2;
      const hs = [
        world.getHeight(cx, cz),
        world.getHeight(ix0 + 0.5, iz0 + 0.5), world.getHeight(ix1 - 0.5, iz0 + 0.5),
        world.getHeight(ix0 + 0.5, iz1 - 0.5), world.getHeight(ix1 - 0.5, iz1 - 0.5),
      ];
      const avg = hs.reduce((a, b) => a + b, 0) / hs.length;
      const flatH = Math.min(10, Math.max(2.4, avg));
      if (hs.some((h) => Math.abs(h - flatH) > slopeTol)) return null; // 坡太陡
      return { minX, minZ, maxX, maxZ, flatH, arch, w, d };
    };
    const tryPlace = (arch: ArchId, cx: number, cz: number, maxR: number, slopeTol = 4.5, clear = 7): boolean => {
      for (let t = 0; t < 40; t++) {
        const a = rng() * Math.PI * 2;
        const d = rng() * maxR;
        const p = footprintAt(cx + Math.cos(a) * d, cz + Math.sin(a) * d, arch, slopeTol, clear);
        if (p) {
          this.plots.push(p);
          taken.push({ minX: p.minX, minZ: p.minZ, maxX: p.maxX, maxZ: p.maxZ });
          return true;
        }
      }
      return false;
    };

    // 中央城区 (-60,-20, r~90): 两栋高层地标 + 露台×3 小店×2 其余民居
    const townArchs: ArchId[] = [
      'apartment', 'apartment', 'terrace', 'terrace', 'terrace',
      'shop', 'shop', 'cottage2', 'cottage2', 'cottage1', 'cottage1', 'cottage2',
    ];
    for (const arch of townArchs) {
      // 双街布局: x≈-82 或 x≈-38 两排, z 散开
      const streetX = rng() < 0.5 ? -82 : -38;
      const placed = tryPlace(arch, streetX + (rng() * 2 - 1) * 14, -20 + (rng() * 2 - 1) * 60, 26, 4.5, 5);
      if (!placed) tryPlace(arch, -60, -20, 82, 4.8, 3.5);
    }
    // 城区最先生成的两栋公寓分别成为 7 层和 6 层地标，维持确定性位置和清晰天际线。
    this.plots.filter((plot) => plot.arch === 'apartment').slice(0, 2).forEach((plot, index) => {
      plot.storeys = index === 0 ? 7 : 6;
    });

    // 东部竞技场 (+180,-40): 体育馆地标 + 2 民居
    tryPlace('gym', 180, -40, 18, 5.5, 13);
    tryPlace('cottage1', 180 + 30, -40 + 22, 16, 4.5, 8);
    tryPlace('cottage2', 180 - 28, -40 - 20, 16, 4.5, 8);

    // 南部农场 (-40,+200, r~100): 谷仓×3 + 民居×2
    tryPlace('barn', -40, 200, 70);
    tryPlace('barn', -40, 200, 70);
    tryPlace('barn', -40, 200, 70);
    tryPlace('cottage1', -40, 200, 70);
    tryPlace('cottage2', -40, 200, 70);

    // 北境密林 (z<-150): 仅 1 谷仓 + 1 民居
    tryPlace('barn', 0, -170, 80);
    tryPlace('cottage1', 30, -180, 80);

    // 西部山地 (-220,+20): 1 民居(狙击高地)
    tryPlace('cottage1', -220, 20, 50, 6);

    // 东北渔村 (+200,-220): 3~4 民居
    tryPlace('cottage1', 200, -220, 45, 5);
    tryPlace('cottage2', 200, -220, 45, 5);
    tryPlace('cottage1', 200, -220, 45, 5);
    tryPlace('cottage2', 200, -220, 45, 5);
  }

  flattenTerrain(world: World): void {
    for (const p of this.plots) {
      world.flattenRect(p.minX, p.minZ, p.maxX, p.maxZ, p.flatH, 5);
    }
  }

  // ── 场景构建 ────────────────────────────────────────────────────────────
  build(scene: THREE.Scene, world: World): void {
    this.assetUsage.clear();
    interface Inst {
      tag: 'wall' | 'floor' | 'roof';
      x0: number; y0: number; z0: number; x1: number; y1: number; z1: number;
      c: THREE.Color;
      detail: boolean;
      rotateX: number;
      rotateY: number;
      rotateZ: number;
      surface: SurfaceAssetId;
    }
    const insts: Inst[] = [];
    const col = new THREE.Color();
    const box: BoxFn = (tag, x0, y0, z0, x1, y1, z1, color, opts = {}) => {
      col.setHex(color);
      const jitter = 0.94 + ((insts.length * 7919) % 13) / 100;
      if (opts.visual !== false) {
        insts.push({
          tag, x0, y0, z0, x1, y1, z1,
          c: col.clone().multiplyScalar(jitter),
          detail: opts.detail === true,
          rotateX: opts.rotateX ?? 0,
          rotateY: opts.rotateY ?? 0,
          rotateZ: opts.rotateZ ?? 0,
          surface: opts.surface ?? (tag === 'wall' ? 'plaster' : tag === 'floor' ? 'concrete' : 'roof'),
        });
      }
      if (opts.collider !== false) {
        world.addCollider({ kind: 'aabb', minX: x0, minY: y0, minZ: z0, maxX: x1, maxY: y1, maxZ: z1, tag });
      }
      if (opts.platform) {
        world.platforms.push({ minX: x0, minZ: z0, maxX: x1, maxZ: z1, top: y1 });
      }
    };

    this.verticalSlicePlotIndex = this.plots.reduce((best, plot, idx) => {
      const region = regionAt((plot.minX + plot.maxX) * 0.5, (plot.minZ + plot.maxZ) * 0.5)?.id;
      if (region !== 'stonegate' || (plot.arch !== 'cottage2' && plot.arch !== 'terrace')) return best;
      if (best < 0) return idx;
      const current = this.plots[best] as HousePlot;
      const currentDistance = Math.hypot(
        (current.minX + current.maxX) * 0.5 + 60,
        (current.minZ + current.maxZ) * 0.5 + 20,
      );
      const candidateDistance = Math.hypot(
        (plot.minX + plot.maxX) * 0.5 + 60,
        (plot.minZ + plot.maxZ) * 0.5 + 20,
      );
      return candidateDistance < currentDistance ? idx : best;
    }, -1);
    this.verticalSliceDetailCount = 0;
    this.europeanFacadeDetailCount = 0;
    for (const arch of Object.keys(this.europeanFacadeDetailsByArch) as ArchId[]) {
      this.europeanFacadeDetailsByArch[arch] = 0;
    }

    this.plots.forEach((plot, idx) => {
      const rng = mulberry32(idx * 97 + 11);
      const cx = (plot.minX + plot.maxX) * 0.5;
      const cz = (plot.minZ + plot.maxZ) * 0.5;
      const region = regionAt(cx, cz)?.id;
      const regionalStyle = region && region !== 'wilderness' ? regionalBuildingStyle(region) : null;
      for (const assetId of buildingAssetPack(plot.arch, region && region !== 'wilderness' ? region : null)) {
        this.assetUsage.add(assetId);
      }
      const featuredSlice = idx === this.verticalSlicePlotIndex;
      const palette: Palette = {
        wall: featuredSlice
          ? 0xd2bda7
          : regionalStyle
          ? regionalStyle.walls[Math.floor(rng() * regionalStyle.walls.length)] as number
          : WALL_COLORS[Math.floor(rng() * WALL_COLORS.length)] as number,
        roof: featuredSlice
          ? 0x76584c
          : regionalStyle
          ? regionalStyle.roofs[Math.floor(rng() * regionalStyle.roofs.length)] as number
          : ROOF_COLORS[Math.floor(rng() * ROOF_COLORS.length)] as number,
        chimney: rng() < (regionalStyle?.chimneyChance ?? 0.4),
        ac: rng() < (regionalStyle?.acChance ?? 0.3),
      };
      switch (plot.arch) {
        case 'cottage1': this.addCottage(world, plot, palette, box, false); break;
        case 'cottage2': this.addCottage(world, plot, palette, box, true); break;
        case 'terrace': this.addTerrace(world, plot, palette, box); break;
        case 'apartment': this.addApartment(world, plot, palette, box); break;
        case 'barn': this.addBarn(world, plot, palette, box); break;
        case 'shop': this.addShop(world, plot, palette, box); break;
        case 'gym': this.addGym(world, plot, palette, box); break;
      }
      const europeanDetails = this.addEuropeanFacade(plot, box, palette, idx);
      this.europeanFacadeDetailCount += europeanDetails;
      this.europeanFacadeDetailsByArch[plot.arch] += europeanDetails;
      if (plot.arch !== 'gym') this.addInteriorDetails(world, plot, box, idx);
      this.addYardCover(plot, box, idx);
      if (regionalStyle) this.addRegionalFacade(
        plot,
        box,
        featuredSlice
          ? { ...regionalStyle, accent: 0x94715f, secondary: 0xc29861 }
          : regionalStyle,
        idx,
      );
      if (region === 'stonegate') {
        const stonegateFacadeDetails = this.addStonegateFacadeDetails(
          plot, box, idx, idx === this.verticalSlicePlotIndex,
        );
        if (idx === this.verticalSlicePlotIndex) {
          this.verticalSliceDetailCount += stonegateFacadeDetails;
          this.verticalSliceDetailCount += this.addStonegateInteriorDetails(plot, box);
        }
      }
      this.addExteriorHardware(plot, box, idx);
    });

    this.sanitizeLootSpots(world);
    this.visualInstanceCount = insts.length;
    this.modelDetailInstanceCount = insts.filter((item) => item.detail).length;

    // 按表面资产合并实例。旧城砖、木作和布艺保留各自纹理，同时维持固定数量绘制调用。
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.root = new THREE.Group();
    for (const surface of [...new Set(insts.map((item) => item.surface))]) {
      const items = insts.filter((item) => item.surface === surface);
      if (items.length === 0) continue;
      const spec = SURFACE_MATERIAL_PRESETS[surface];
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: spec.roughness,
        metalness: spec.metalness,
      });
      enhanceStructureMaterial(mat);
      applySurfaceAsset(mat, surface, spec.scale, spec.strength);
      const mesh = new THREE.InstancedMesh(geo, mat, items.length);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      const t = new THREE.Vector3();
      items.forEach((b, i) => {
        t.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
        s.set(Math.max(0.02, b.x1 - b.x0), Math.max(0.02, b.y1 - b.y0), Math.max(0.02, b.z1 - b.z0));
        if (b.rotateX === 0 && b.rotateY === 0 && b.rotateZ === 0) q.identity();
        else q.setFromEuler(new THREE.Euler(b.rotateX, b.rotateY, b.rotateZ));
        m.compose(t, q, s);
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, b.c);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);
    }
    if (this.verticalSlicePlotIndex >= 0) {
      const plot = this.plots[this.verticalSlicePlotIndex] as HousePlot;
      const centerX = (plot.minX + plot.maxX) * 0.5;
      const centerZ = (plot.minZ + plot.maxZ) * 0.5;
      const f1 = plot.flatH + 0.28;
      const lampMaterial = new THREE.MeshStandardMaterial({
        color: 0xffd48a,
        emissive: 0xff9b3d,
        emissiveIntensity: 2.6,
        roughness: 0.34,
      });
      const lampGeometry = new THREE.SphereGeometry(0.09, 8, 6);
      for (const y of [f1 + 2.38, f1 + WALL_H + SLAB_T + 2.34]) {
        const lamp = new THREE.Mesh(lampGeometry, lampMaterial);
        lamp.position.set(centerX + 0.8, y, centerZ + 0.65);
        const light = new THREE.PointLight(0xffc27a, 5.2, 8.5, 1.8);
        light.position.copy(lamp.position);
        this.root.add(lamp, light);
      }
      const porchLamp = new THREE.Mesh(lampGeometry, lampMaterial);
      porchLamp.scale.setScalar(0.84);
      porchLamp.position.set(centerX + 0.98, f1 + 2.05, plot.minZ + 2 - 0.28);
      const porchLight = new THREE.PointLight(0xffbf73, 3.8, 6.2, 1.8);
      porchLight.position.copy(porchLamp.position);
      this.root.add(porchLamp, porchLight);
      this.modelDetailInstanceCount += 3;
      this.verticalSliceDetailCount++;
    }
    for (const d of this.destructibles) this.root.add(d.group ?? d.mesh);
    scene.add(this.root);
  }

  // 每局重开时恢复门窗: 窗全恢复; 门 30% 概率预破坏
  reset(): void {
    for (const d of this.destructibles) {
      d.reset(d.kind === 'window' ? true : random() >= 0.3);
    }
  }

  // ═══════════════ 组件构建器(全原型复用) ═══════════════

  // 沿轴放一面带洞口的墙: 整高段 + 窗台段 + 过梁段, 洞口挂门/窗可破坏物
  // interior: 室内方向符号(+1/-1, 垂直于墙指向屋内), 决定门向内开的方向
  private wallRun(
    world: World, box: BoxFn,
    axis: 'x' | 'z', fixed: number, a0: number, a1: number,
    y0: number, y1: number, ops: Op[], c: number, th: number, interior: 1 | -1,
  ): void {
    const addBoxAt = (s0: number, s1: number, t0: number, t1: number) => {
      if (s1 - s0 < 0.03 || t1 - t0 < 0.03) return;
      if (axis === 'x') box('wall', s0, t0, fixed - th / 2, s1, t1, fixed + th / 2, c);
      else box('wall', fixed - th / 2, t0, s0, fixed + th / 2, t1, s1, c);
    };
    const sorted = [...ops].sort((p, q) => p.a0 - q.a0);
    let cur = a0;
    for (const op of sorted) {
      addBoxAt(cur, op.a0, y0, y1);                 // 洞口左侧整高段
      if (!op.door) addBoxAt(op.a0, op.a1, y0, op.y0); // 窗台段 (门洞直通地板)
      addBoxAt(op.a0, op.a1, op.y1, y1);            // 过梁段
      cur = op.a1;
    }
    addBoxAt(cur, a1, y0, y1);
    for (const op of sorted) {
      const midA = (op.a0 + op.a1) / 2, midY = (op.y0 + op.y1) / 2;
      if (op.door) {
        if (!op.doorless) this.addDoor(
          world, box, axis, fixed, op.a0, op.a1, op.y0, op.y1, midY, interior, op.hingeEnd ? -1 : 1,
        );
      } else {
        this.addWindow(world, box, axis, fixed, op.a0, op.a1, op.y0, op.y1, midA, midY);
      }
    }
  }

  // 楼梯: 平台踏步(不进碰撞体), zFrom→zTo 逐级升高至 f1+steps*rise
  private stairs(
    box: BoxFn,
    x0: number,
    x1: number,
    zFrom: number,
    zTo: number,
    f1: number,
    rise: number,
    c: number,
    railSide: 'min' | 'max' = 'max',
  ): void {
    const run = (zTo - zFrom) / STAIR_STEPS;
    const railX = stairRailX(x0, x1, railSide);
    const handrail = stairHandrailTransform(zFrom, zTo, f1, rise);
    for (let i = 0; i < STAIR_STEPS; i++) {
      const z0 = Math.min(zFrom + i * run, zFrom + (i + 1) * run);
      const z1 = Math.max(zFrom + i * run, zFrom + (i + 1) * run);
      const top = f1 + rise * (i + 1);
      // 每级使用独立薄踏板, 释放梯下空间, 避免从侧面看成一整块错误的实心柱体。
      box('floor', x0, Math.max(f1, top - 0.17), z0, x1, top, z1, c, { collider: false, platform: true });
      // 薄立板把相邻踏步连成完整梯段，保留梯下净空同时避免踏步看起来悬空。
      const riserZ = zFrom + i * run;
      const prevTop = i === 0 ? f1 : f1 + rise * i;
      box(
        'wall', x0, prevTop, riserZ - 0.035, x1, top, riserZ + 0.035,
        c, { collider: false },
      );
      // 立柱从对应踏步生根, 顶部与整跑斜扶手重叠连接。
      if (i === 0 || i === 3 || i === 6 || i === STAIR_STEPS - 1) {
        const postZ = (z0 + z1) / 2;
        box('wall', railX - 0.055, top, postZ - 0.055, railX + 0.055, top + 0.88, postZ + 0.055, RAIL_C, { collider: false });
      }
    }
    // 单根连续斜杆取代逐级水平短杆, 消除断裂和悬空观感。
    box(
      'wall',
      railX - 0.055,
      handrail.centerY - 0.05,
      handrail.centerZ - handrail.length / 2,
      railX + 0.055,
      handrail.centerY + 0.05,
      handrail.centerZ + handrail.length / 2,
      RAIL_C,
      { collider: false, rotateX: handrail.pitch },
    );
  }

  // 入口台阶从真实地面生根，不使用悬空薄板；axis 表示门洞沿哪条轴延伸。
  private entranceStep(
    world: World,
    box: BoxFn,
    axis: 'x' | 'z',
    fixed: number,
    a0: number,
    a1: number,
    floorY: number,
    outward: 1 | -1,
    depth = 0.78,
  ): void {
    const mid = (a0 + a1) / 2;
    const sampleX = axis === 'x' ? mid : fixed + outward * depth * 0.7;
    const sampleZ = axis === 'x' ? fixed + outward * depth * 0.7 : mid;
    const ground = world.getHeight(sampleX, sampleZ);
    const top = floorY - 0.02;
    const bottom = Math.min(top - 0.12, ground - 0.05);
    if (axis === 'x') {
      const outer = fixed + outward * depth;
      box(
        'floor', a0 - 0.15, bottom, Math.min(fixed, outer), a1 + 0.15, top, Math.max(fixed, outer),
        TRIM_C, { collider: false, platform: true },
      );
    } else {
      const outer = fixed + outward * depth;
      box(
        'floor', Math.min(fixed, outer), bottom, a0 - 0.15, Math.max(fixed, outer), top, a1 + 0.15,
        TRIM_C, { collider: false, platform: true },
      );
    }
  }

  // 带楼梯井的楼板: 楼梯两端铺设完整落脚平台, 只在实际梯段范围内开洞。
  private stairSlab(
    box: BoxFn,
    ix0: number, ix1: number, iz0: number, iz1: number,
    openX0: number, openX1: number, holeZ0: number, holeZ1: number,
    ceilingY: number, floorY: number, c: number,
  ): void {
    const edge = WT / 2 + 0.02;
    const y0 = ceilingY - STOREY_JOINT_OVERLAP;
    if (openX0 > ix0 + 0.02) {
      box('floor', ix0 - edge, y0, iz0 - edge, openX0 + STOREY_JOINT_OVERLAP, floorY, iz1 + edge, c);
    }
    if (openX1 < ix1 - 0.02) {
      box('floor', openX1 - STOREY_JOINT_OVERLAP, y0, iz0 - edge, ix1 + edge, floorY, iz1 + edge, c);
    }
    box('floor', openX0 - edge, y0, iz0 - edge, openX1 + edge, floorY, holeZ0 + STAIR_EDGE_OVERLAP, c);
    box('floor', openX0 - edge, y0, holeZ1 - STAIR_EDGE_OVERLAP, openX1 + edge, floorY, iz1 + edge, c);
  }

  // 楼梯井护栏: 低矮挡脚边提供碰撞, 细立柱和双横杆负责视觉, 避免实心墙板挤压空间。
  private stairGuard(box: BoxFn, x: number, z0: number, z1: number, y: number): void {
    if (z1 <= z0) return;
    box('wall', x - 0.065, y, z0, x + 0.065, y + 0.13, z1, RAIL_C);
    for (const railY of [y + 0.48, y + 0.86]) {
      box('wall', x - 0.05, railY, z0, x + 0.05, railY + 0.09, z1, RAIL_C, { collider: false });
    }
    const spans = Math.max(1, Math.ceil((z1 - z0) / 1.35));
    for (let i = 0; i <= spans; i++) {
      const z = z0 + (z1 - z0) * (i / spans);
      box('wall', x - 0.055, y, z - 0.055, x + 0.055, y + 0.95, z + 0.055, RAIL_C, { collider: false });
    }
  }

  // 矮护栏(阻挡移动, 上方子弹可过)
  private rail(box: BoxFn, x0: number, z0: number, x1: number, z1: number, y: number, h: number): void {
    // 保留完整隐形阻挡体，视觉改为开放式石质瓶柱和双横杆。
    box('wall', x0, y, z0, x1, y + h, z1, RAIL_C, { visual: false });
    const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
    box('wall', x0, y, z0, x1, y + 0.18, z1, 0xa99b87, { collider: false, detail: true, surface: 'stone' });
    if (alongX) {
      for (const railY of [y + 0.45, y + h - 0.08]) {
        box('wall', x0, railY, z0 - 0.035, x1, railY + 0.08, z1 + 0.035,
          railY > y + 0.6 ? 0xa99b87 : RAIL_C, { collider: false, detail: true, surface: railY > y + 0.6 ? 'stone' : 'paintedMetal' });
      }
      const spans = Math.max(2, Math.ceil(Math.abs(x1 - x0) / 0.85));
      for (let i = 0; i <= spans; i++) {
        const x = x0 + (x1 - x0) * i / spans;
        box('wall', x - 0.045, y + 0.16, z0 - 0.045, x + 0.045, y + h - 0.04, z1 + 0.045,
          0xc5b8a0, { collider: false, detail: true, surface: 'stone' });
      }
    } else {
      for (const railY of [y + 0.45, y + h - 0.08]) {
        box('wall', x0 - 0.035, railY, z0, x1 + 0.035, railY + 0.08, z1,
          railY > y + 0.6 ? 0xa99b87 : RAIL_C, { collider: false, detail: true, surface: railY > y + 0.6 ? 'stone' : 'paintedMetal' });
      }
      const spans = Math.max(2, Math.ceil(Math.abs(z1 - z0) / 0.85));
      for (let i = 0; i <= spans; i++) {
        const z = z0 + (z1 - z0) * i / spans;
        box('wall', x0 - 0.045, y + 0.16, z - 0.045, x1 + 0.045, y + h - 0.04, z + 0.045,
          0xc5b8a0, { collider: false, detail: true, surface: 'stone' });
      }
    }
  }

  private addChair(box: BoxFn, x: number, z: number, floorY: number, back: 1 | -1): void {
    const opts = { collider: false, detail: true } as const;
    box('wall', x - 0.25, floorY + 0.4, z - 0.23, x + 0.25, floorY + 0.49, z + 0.23, INTERIOR_WOOD_C, opts);
    for (const dx of [-0.19, 0.19]) for (const dz of [-0.17, 0.17]) {
      box('wall', x + dx - 0.035, floorY, z + dz - 0.035, x + dx + 0.035, floorY + 0.4, z + dz + 0.035, INTERIOR_WOOD_C, opts);
    }
    const bz = z + back * 0.21;
    box('wall', x - 0.25, floorY + 0.48, bz - 0.035, x + 0.25, floorY + 0.98, bz + 0.035, INTERIOR_WOOD_C, opts);
    box('wall', x - 0.2, floorY + 0.68, bz - 0.055, x + 0.2, floorY + 0.75, bz + 0.055, 0x8d6f4c, opts);
  }

  private addCrateBands(
    box: BoxFn,
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
  ): void {
    const opts = { collider: false, detail: true } as const;
    const t = 0.045;
    const inset = 0.08;
    for (const y of [y0 + (y1 - y0) * 0.26, y0 + (y1 - y0) * 0.74]) {
      box('wall', x0 - t, y - t, z0 + inset, x1 + t, y + t, z0 + inset + t, FRAME_C, opts);
      box('wall', x0 - t, y - t, z1 - inset - t, x1 + t, y + t, z1 - inset, FRAME_C, opts);
    }
    for (const x of [x0 + inset, x1 - inset]) {
      box('wall', x - t, y0 + inset, z0 - t, x + t, y1 - inset, z0 + t, FRAME_C, opts);
      box('wall', x - t, y0 + inset, z1 - t, x + t, y1 - inset, z1 + t, FRAME_C, opts);
    }
  }

  // 房间隔断和家具都参与碰撞，既让室内更像正式空间，也形成可利用的近战掩体。
  private addInteriorDetails(world: World, plot: HousePlot, box: BoxFn, idx: number): void {
    const ix0 = plot.minX + 2, ix1 = plot.maxX - 2, iz0 = plot.minZ + 2, iz1 = plot.maxZ - 2;
    const d = iz1 - iz0;
    const f1 = plot.flatH + 0.28;
    const household = plot.arch === 'cottage1' || plot.arch === 'cottage2' || plot.arch === 'terrace' || plot.arch === 'apartment';
    const multistory = plot.arch === 'cottage2' || plot.arch === 'terrace' || plot.arch === 'apartment';
    let lootX = (ix0 + ix1) / 2;
    let lootZ = (iz0 + iz1) / 2;

    // 一层隔间为西侧楼梯保留完整通道，隔墙不再横穿踏步。
    if (household) {
      const splitZ = iz0 + d * 0.58;
      const wallX0 = multistory ? ix0 + 0.14 + STAIR_W + STAIR_SIDE_CLEARANCE : ix0;
      const doorX = wallX0 + (ix1 - wallX0) * 0.48;
      this.wallRun(world, box, 'x', splitZ, wallX0, ix1, f1, f1 + WALL_H - 0.28, [
        { a0: doorX - DOOR_W / 2, a1: doorX + DOOR_W / 2, y0: f1, y1: f1 + DOOR_H, door: true },
      ], 0xd2c6af, WT2, -1);
    }

    // 多层建筑的箱堆按楼梯井方向分开放置，避免压住上下楼出口。
    if (multistory && plot.arch !== 'apartment') {
      const floors = 1;
      for (let floor = 1; floor <= floors; floor++) {
        const fy = f1 + floor * (WALL_H + SLAB_T);
        const cx = ix1 - 1.15;
        const cz = iz0 + (floor === 1 ? 1.35 : 1.5);
        // 薄底座与楼板重叠，保证箱堆在所有楼层都有明确接触面和接触阴影。
        box('floor', cx - 0.5, fy - 0.025, cz - 0.5, cx + 0.5, fy + 0.055, cz + 0.5,
          0x625845, { collider: false, detail: true, surface: 'wood' });
        box('wall', cx - 0.45, fy, cz - 0.45, cx + 0.45, fy + 0.78, cz + 0.45, CRATE_C);
        this.addCrateBands(box, cx - 0.45, fy, cz - 0.45, cx + 0.45, fy + 0.78, cz + 0.45);
        if (floor === floors) {
          box('wall', cx - 0.28, fy + 0.78, cz - 0.28, cx + 0.36, fy + 1.34, cz + 0.36, CRATE_C);
          this.addCrateBands(box, cx - 0.28, fy + 0.78, cz - 0.28, cx + 0.36, fy + 1.34, cz + 0.36);
        }
      }
    }

    if (household) {
      // 餐桌固定在入口房的东北角，与门、楼梯和隔墙均保持通行距离。
      const tx = ix1 - 1.55;
      const tz = iz0 + 1.55;
      box('wall', tx - 0.72, f1 + 0.68, tz - 0.44, tx + 0.72, f1 + 0.8, tz + 0.44, 0x806548);
      for (const sx of [-0.57, 0.57]) for (const sz of [-0.31, 0.31]) {
        box('wall', tx + sx - 0.045, f1, tz + sz - 0.045, tx + sx + 0.045, f1 + 0.68, tz + sz + 0.045, 0x554334, { collider: false });
      }
      // 餐椅、地毯和桌面小物只做视觉层，不扩大家具碰撞范围。
      box('floor', tx - 1.05, f1 + 0.015, tz - 1.12, tx + 1.05, f1 + 0.035, tz + 1.12, FABRIC_C, { collider: false, detail: true });
      this.addChair(box, tx, tz - 0.86, f1, -1);
      this.addChair(box, tx, tz + 0.86, f1, 1);
      box('wall', tx - 0.12, f1 + 0.8, tz - 0.12, tx + 0.12, f1 + 1.02, tz + 0.12, 0x777d65, { collider: false, detail: true });
      // 南侧房间的置物架贴东墙布置，不再与餐桌或楼梯重叠。
      const shelfX = ix1 - 0.48;
      const shelfZ = iz1 - 1.35;
      box('wall', shelfX - 0.32, f1, shelfZ - 0.78, shelfX + 0.32, f1 + 1.75, shelfZ + 0.78, 0x71604c);
      for (const sy of [0.42, 0.92, 1.42]) {
        box('wall', shelfX - 0.4, f1 + sy, shelfZ - 0.84, shelfX + 0.4, f1 + sy + 0.06, shelfZ + 0.84, 0x9b815e, { collider: false });
      }
      // 平房偶数编号增加床铺；多层房西侧必须完整留给楼梯。
      if (plot.arch === 'cottage1' && idx % 2 === 0) {
        const bedZ = iz1 - 1.8;
        box('wall', ix0 + 0.65, f1, bedZ - 0.9, ix0 + 1.9, f1 + 0.48, bedZ + 0.9, 0x726957);
        box('wall', ix0 + 0.68, f1 + 0.48, bedZ - 0.88, ix0 + 1.87, f1 + 0.62, bedZ + 0.88, 0x9b8f73, { collider: false });
        box('wall', ix0 + 0.59, f1, bedZ - 0.94, ix0 + 0.72, f1 + 1.05, bedZ + 0.94, INTERIOR_WOOD_C, { collider: false, detail: true });
        box('wall', ix0 + 0.74, f1 + 0.62, bedZ - 0.66, ix0 + 1.08, f1 + 0.74, bedZ + 0.66, 0xd5cbb7, { collider: false, detail: true });
        box('wall', ix0 + 1.54, f1 + 0.62, bedZ - 0.88, ix0 + 1.78, f1 + 0.68, bedZ + 0.88, 0x6e765f, { collider: false, detail: true });
      }
      lootX = tx - 1.05;
      lootZ = tz + 0.85;
    } else if (plot.arch === 'shop') {
      // 商店保留原有柜台，只在后墙增加货架，避免重复家具穿插。
      const sx0 = ix1 - 2.35;
      box('wall', sx0, f1, iz1 - 0.5, ix1 - 0.45, f1 + 1.65, iz1 - 0.18, 0x71604c);
      for (const sy of [0.45, 0.95, 1.45]) {
        box('wall', sx0 - 0.06, f1 + sy, iz1 - 0.56, ix1 - 0.39, f1 + sy + 0.06, iz1 - 0.12, 0x9b815e, { collider: false });
      }
      for (let i = 0; i < 6; i++) {
        const px = sx0 + 0.16 + (i % 3) * 0.5;
        const py = f1 + (i < 3 ? 0.53 : 1.03);
        box('wall', px, py, iz1 - 0.62, px + 0.23, py + 0.28, iz1 - 0.3, i % 2 === 0 ? 0x9f7652 : 0x657b70, { collider: false, detail: true });
      }
      lootX = sx0 - 0.55;
      lootZ = iz1 - 1.0;
    } else if (plot.arch === 'barn') {
      // 谷仓西后侧为工具台，东后侧继续保留原有干草垛。
      box('wall', ix0 + 0.5, f1 + 0.7, iz1 - 0.7, ix0 + 2.75, f1 + 0.84, iz1 - 0.28, 0x806548);
      for (const x of [ix0 + 0.68, ix0 + 2.57]) {
        box('wall', x - 0.06, f1, iz1 - 0.58, x + 0.06, f1 + 0.7, iz1 - 0.4, 0x554334, { collider: false });
      }
      // 工具墙和长柄农具增强谷仓的功能辨识度。
      box('wall', ix0 + 0.52, f1 + 1.05, iz1 - 0.22, ix0 + 2.7, f1 + 2.0, iz1 - 0.14, 0x66533e, { collider: false, detail: true });
      for (let i = 0; i < 4; i++) {
        const x = ix0 + 0.82 + i * 0.5;
        box('wall', x - 0.035, f1 + 0.82, iz1 - 0.29, x + 0.035, f1 + 1.78, iz1 - 0.2, 0x4b4237, { collider: false, detail: true });
        box('wall', x - 0.18, f1 + 0.78, iz1 - 0.31, x + 0.18, f1 + 0.86, iz1 - 0.18, 0x6c6e65, { collider: false, detail: true });
      }
      lootX = ix0 + 3.35;
      lootZ = iz1 - 1.0;
    }
    // 家具旁追加一个拾取点，让新增房间真正参与搜刮路线。
    this.lootSpots.push({ x: lootX, y: f1, z: lootZ, premium: false });
  }

  // 家具和隔墙生成后统一校正拾取点，避免物资刷进实体或门板中。
  private sanitizeLootSpots(world: World): void {
    // 物资本体外还有 0.42m 光环，保留 0.3m 实体净距避免模型贴墙穿插。
    const radius = 0.3;
    const offsets: ReadonlyArray<readonly [number, number]> = [
      [0, 0], [0.75, 0], [-0.75, 0], [0, 0.75], [0, -0.75],
      [1.1, 1.1], [-1.1, 1.1], [1.1, -1.1], [-1.1, -1.1],
      [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5],
    ];
    const blocked = (x: number, y: number, z: number): boolean => world.aabbs.some((c) => {
      if (c.off || c.tag === 'floor' || c.tag === 'roof') return false;
      if (y + 0.8 < c.minY || y > c.maxY) return false;
      const dx = Math.max(c.minX - x, 0, x - c.maxX);
      const dz = Math.max(c.minZ - z, 0, z - c.maxZ);
      return dx * dx + dz * dz < radius * radius;
    });
    const accepted: LootSpot[] = [];
    for (const spot of this.lootSpots) {
      const plot = this.plots.find((p) => (
        spot.x > p.minX + 2 && spot.x < p.maxX - 2
        && spot.z > p.minZ + 2 && spot.z < p.maxZ - 2
      ));
      if (!plot) continue;
      for (const [dx, dz] of offsets) {
        const x = spot.x + dx;
        const z = spot.z + dz;
        if (x < plot.minX + 2.5 || x > plot.maxX - 2.5 || z < plot.minZ + 2.5 || z > plot.maxZ - 2.5) continue;
        if (blocked(x, spot.y, z)) continue;
        if (accepted.some((p) => Math.abs(p.y - spot.y) < 0.9 && Math.hypot(p.x - x, p.z - z) < 0.65)) continue;
        accepted.push({ ...spot, x, z });
        break;
      }
    }
    this.lootSpots = accepted;
  }

  // 院墙、围栏和外部箱堆为房屋之间补充连续掩体，并在入口方向留出明确缺口。
  private addYardCover(plot: HousePlot, box: BoxFn, idx: number): void {
    const y = plot.flatH;
    if (plot.arch === 'barn') {
      box('wall', plot.minX + 0.3, y, plot.maxZ - 0.55, plot.maxX - 0.3, y + 0.9, plot.maxZ - 0.35, 0x80633f);
      for (let x = plot.minX + 0.5; x < plot.maxX - 0.4; x += 2.2) {
        box('wall', x, y, plot.maxZ - 0.68, x + 0.12, y + 1.25, plot.maxZ - 0.22, 0x57432c, { collider: false });
      }
    } else if (idx % 3 === 0) {
      const c = plot.arch === 'apartment' ? 0x77746b : 0x8b806b;
      box('wall', plot.minX + 0.35, y, plot.maxZ - 0.55, plot.minX + (plot.maxX - plot.minX) * 0.43, y + 0.82, plot.maxZ - 0.3, c);
      box('wall', plot.minX + (plot.maxX - plot.minX) * 0.62, y, plot.maxZ - 0.55, plot.maxX - 0.35, y + 0.82, plot.maxZ - 0.3, c);
      box('wall', plot.maxX - 0.55, y, plot.minZ + 0.5, plot.maxX - 0.3, y + 0.82, plot.maxZ - 0.3, c);
    }
    // 外墙角箱堆，保持离正门至少 2m。
    const cx = plot.minX + 0.55;
    const cz = plot.minZ + 0.7;
    box('wall', cx, y, cz, cx + 0.9, y + 0.72, cz + 0.9, CRATE_C);
    this.addCrateBands(box, cx, y, cz, cx + 0.9, y + 0.72, cz + 0.9);
    if (idx % 2 === 1) {
      box('wall', cx + 0.18, y + 0.72, cz + 0.15, cx + 0.86, y + 1.32, cz + 0.83, CRATE_C);
      this.addCrateBands(box, cx + 0.18, y + 0.72, cz + 0.15, cx + 0.86, y + 1.32, cz + 0.83);
    }
  }

  // 全地图共享的欧式建筑语言。构件仅参与视觉实例，不改变房间、门窗、楼梯和导航碰撞。
  // 住宅采用灰泥、角石、檐口和老虎窗，公寓使用层间线脚和铁艺小阳台，农场建筑使用半木构。
  private addEuropeanFacade(plot: HousePlot, box: BoxFn, p: Palette, idx: number): number {
    const ix0 = plot.minX + 2;
    const ix1 = plot.maxX - 2;
    const iz0 = plot.minZ + 2;
    const iz1 = plot.maxZ - 2;
    const w = ix1 - ix0;
    const d = iz1 - iz0;
    const cx = (ix0 + ix1) * 0.5;
    const f1 = plot.flatH + 0.28;
    const storeys = buildingStoreys(plot);
    const wallTop = plot.arch === 'barn'
      ? f1 + 4.2
      : plot.arch === 'gym'
        ? f1 + 8.6
        : plot.arch === 'apartment'
          ? f1 + (storeys - 1) * (WALL_H + SLAB_T) + WALL_H
          : plot.arch === 'cottage2' || plot.arch === 'terrace'
            ? f1 + WALL_H * 2 + SLAB_T - 0.15
            : f1 + WALL_H;
    const stoneColor = idx % 3 === 0 ? 0xb8aa94 : idx % 3 === 1 ? 0xc4b9a4 : 0xa99e8d;
    const lightStone = idx % 2 === 0 ? 0xe0d6c2 : 0xd4c8b2;
    const iron = 0x343b3b;
    const timber = idx % 2 === 0 ? 0x604632 : 0x513b2e;
    const stone = { collider: false, detail: true, surface: 'stone' } as const;
    const plaster = { collider: false, detail: true, surface: 'plaster' } as const;
    const wood = { collider: false, detail: true, surface: 'wood' } as const;
    const metal = { collider: false, detail: true, surface: 'paintedMetal' } as const;
    const roof = { collider: false, detail: true, surface: 'roof' } as const;
    let count = 0;
    const add = (
      tag: 'wall' | 'floor' | 'roof',
      x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
      color: number,
      opts: NonNullable<Parameters<BoxFn>[8]> = stone,
    ): void => {
      box(tag, x0, y0, z0, x1, y1, z1, color, opts);
      count++;
    };

    // 石质墙脚、双层檐口和转角隅石形成所有原型一致的欧式比例基准。
    const plinthTop = f1 + (plot.arch === 'gym' ? 0.72 : 0.52);
    add('wall', ix0 - 0.09, f1 - 0.08, iz0 - 0.1, ix1 + 0.09, plinthTop, iz0 + 0.025, stoneColor, stone);
    add('wall', ix0 - 0.09, f1 - 0.08, iz1 - 0.025, ix1 + 0.09, plinthTop, iz1 + 0.1, stoneColor, stone);
    add('wall', ix0 - 0.1, f1 - 0.08, iz0, ix0 + 0.025, plinthTop, iz1, stoneColor, stone);
    add('wall', ix1 - 0.025, f1 - 0.08, iz0, ix1 + 0.1, plinthTop, iz1, stoneColor, stone);
    for (const inset of [0, 0.12]) {
      add('roof', ix0 - 0.22 - inset, wallTop - 0.08 + inset * 0.35, iz0 - 0.18 - inset,
        ix1 + 0.22 + inset, wallTop + 0.06 + inset * 0.35, iz0 + 0.02, lightStone, stone);
      add('roof', ix0 - 0.22 - inset, wallTop - 0.08 + inset * 0.35, iz1 - 0.02,
        ix1 + 0.22 + inset, wallTop + 0.06 + inset * 0.35, iz1 + 0.18 + inset, lightStone, stone);
    }

    const quoinFloors = plot.arch === 'barn' || plot.arch === 'gym' ? 1 : storeys;
    for (let floor = 0; floor < quoinFloors; floor++) {
      const base = f1 + floor * (WALL_H + SLAB_T) + 0.42;
      const available = Math.max(0.7, Math.min(WALL_H - 0.55, wallTop - base));
      for (let course = 0; course < 4; course++) {
        const y = base + available * course / 4;
        const wide = course % 2 === 0 ? 0.38 : 0.28;
        for (const x of [ix0, ix1]) {
          for (const z of [iz0, iz1]) {
            add('wall', x - wide * 0.5, y, z - 0.08, x + wide * 0.5, y + 0.24, z + 0.08, stoneColor, stone);
            add('wall', x - 0.08, y, z - wide * 0.5, x + 0.08, y + 0.24, z + wide * 0.5, stoneColor, stone);
          }
        }
      }
    }

    // 层间腰线沿四周连续闭合，远距离也能读出明确楼层尺度。
    for (let floor = 1; floor < storeys; floor++) {
      const y = f1 + floor * (WALL_H + SLAB_T) - 0.2;
      add('wall', ix0 - 0.13, y, iz0 - 0.1, ix1 + 0.13, y + 0.18, iz0 + 0.03, lightStone, stone);
      add('wall', ix0 - 0.13, y, iz1 - 0.03, ix1 + 0.13, y + 0.18, iz1 + 0.1, lightStone, stone);
      add('wall', ix0 - 0.1, y, iz0, ix0 + 0.03, y + 0.18, iz1, lightStone, stone);
      add('wall', ix1 - 0.03, y, iz0, ix1 + 0.1, y + 0.18, iz1, lightStone, stone);
    }

    if (plot.arch === 'cottage1' || plot.arch === 'cottage2') {
      // 门楣小山花和成对托臂把住宅入口从墙洞提升为正式门廊。
      for (const x of [cx - 0.92, cx + 0.92]) {
        add('wall', x - 0.09, f1, iz0 - 0.42, x + 0.09, f1 + 2.38, iz0 - 0.24, lightStone, stone);
        add('wall', x - 0.16, f1 + 2.22, iz0 - 0.5, x + 0.16, f1 + 2.42, iz0 - 0.18, stoneColor, stone);
      }
      for (let layer = 0; layer < 6; layer++) {
        const half = 1.15 * (1 - layer / 7);
        const y = f1 + 2.42 + layer * 0.1;
        add('wall', cx - half, y, iz0 - 0.39, cx + half, y + 0.09, iz0 - 0.19, p.roof, roof);
      }
      // 正立面老虎窗嵌入屋坡，底座与屋瓦重叠，避免出现悬浮盒体。
      const dormerZ = iz0 + d * 0.23;
      const dormerBase = wallTop + 0.32;
      add('wall', cx - 0.62, wallTop + 0.18, dormerZ - 0.05, cx + 0.62, dormerBase + 0.68, dormerZ + 0.5, p.wall, plaster);
      add('wall', cx - 0.29, dormerBase + 0.14, dormerZ - 0.09, cx + 0.29, dormerBase + 0.58, dormerZ - 0.02, 0x7491a0, metal);
      for (const x of [cx - 0.34, cx + 0.34]) {
        add('wall', x - 0.045, dormerBase + 0.08, dormerZ - 0.12, x + 0.045, dormerBase + 0.64, dormerZ + 0.01, lightStone, stone);
      }
      add('wall', cx - 0.38, dormerBase + 0.05, dormerZ - 0.13, cx + 0.38, dormerBase + 0.13, dormerZ + 0.02, lightStone, stone);
      add('wall', cx - 0.38, dormerBase + 0.61, dormerZ - 0.13, cx + 0.38, dormerBase + 0.69, dormerZ + 0.02, lightStone, stone);
      for (let layer = 0; layer < 5; layer++) {
        const half = 0.78 * (1 - layer / 6);
        add('roof', cx - half, dormerBase + 0.68 + layer * 0.095, dormerZ - 0.18,
          cx + half, dormerBase + 0.76 + layer * 0.095, dormerZ + 0.58, p.roof, roof);
      }
    } else if (plot.arch === 'terrace') {
      // 露台使用石质瓶柱节奏和深色铁艺横杆，保持原有狙击视野与通行碰撞。
      const zRoom = iz0 + d * 0.55;
      const f2 = f1 + WALL_H + SLAB_T;
      for (let i = 0; i <= 8; i++) {
        const x = ix0 + w * i / 8;
        add('wall', x - 0.055, f2 + 0.16, iz1 - 0.14, x + 0.055, f2 + 0.86, iz1 + 0.04, lightStone, stone);
      }
      for (const y of [f2 + 0.42, f2 + 0.86]) {
        add('wall', ix0, y, iz1 - 0.16, ix1, y + 0.08, iz1 + 0.06, iron, metal);
      }
      for (const x of [ix0, ix1]) {
        for (let i = 0; i <= 4; i++) {
          const z = zRoom + (iz1 - zRoom) * i / 4;
          add('wall', x - 0.07, f2 + 0.16, z - 0.055, x + 0.07, f2 + 0.86, z + 0.055, lightStone, stone);
        }
      }
    } else if (plot.arch === 'apartment') {
      // 城区公寓使用完整石质窗套、浅挑铁艺阳台和中央入口轴线，形成连续欧洲街墙而非高盒子。
      const windowCenters = [ix0 + w * 0.22 + WIN_W * 0.5, ix0 + w * 0.64 + WIN_W * 0.5];
      // 双扇入口采用外移巨柱和加深门廊，柱体不再压进 2.6m 门洞。
      const portalHalf = DOOR_W + 0.42;
      for (const x of [cx - portalHalf, cx + portalHalf]) {
        add('wall', x - 0.17, f1 + 0.04, iz0 - 0.42, x + 0.17, f1 + 2.55, iz0 - 0.08, lightStone, stone);
        add('wall', x - 0.3, f1 - 0.02, iz0 - 0.5, x + 0.3, f1 + 0.22, iz0 - 0.02, stoneColor, stone);
        add('wall', x - 0.29, f1 + 2.36, iz0 - 0.5, x + 0.29, f1 + 2.62, iz0 - 0.02, stoneColor, stone);
      }
      add('roof', cx - portalHalf - 0.34, f1 + 2.55, iz0 - 0.82,
        cx + portalHalf + 0.34, f1 + 2.72, iz0 + 0.02, stoneColor, stone);
      add('roof', cx - portalHalf - 0.16, f1 + 2.72, iz0 - 0.68,
        cx + portalHalf + 0.16, f1 + 2.84, iz0 - 0.04, lightStone, stone);
      // 黄铜壁灯与门牌使入口在雨夜也有明确视觉焦点。
      for (const x of [cx - portalHalf + 0.32, cx + portalHalf - 0.32]) {
        add('wall', x - 0.08, f1 + 1.72, iz0 - 0.55, x + 0.08, f1 + 2.03, iz0 - 0.39,
          0xc59745, { ...metal, surface: 'metal' });
        add('wall', x - 0.13, f1 + 1.8, iz0 - 0.62, x + 0.13, f1 + 1.96, iz0 - 0.5,
          0xf0d58d, { ...metal, surface: 'paintedMetal' });
      }
      for (let layer = 0; layer < 7; layer++) {
        const half = 1.18 * (1 - layer / 8);
        const y = f1 + 2.48 + layer * 0.09;
        add('wall', cx - half, y, iz0 - 0.31, cx + half, y + 0.085, iz0 - 0.03,
          layer % 2 === 0 ? p.roof : lightStone, layer % 2 === 0 ? roof : stone);
      }
      // 中央竖向壁柱把多层窗格组织成左右两翼，减弱整块平墙的盒状感。
      for (const x of [cx - 0.12, cx + 0.12]) {
        add('wall', x - 0.075, f1 + 3.05, iz0 - 0.12, x + 0.075, wallTop - 0.26, iz0 + 0.02, stoneColor, stone);
      }
      // 首层石材横纹与四条通高壁柱形成基座、主体、冠部的古典三段式比例。
      for (let course = 0; course < 7; course++) {
        const y = f1 + 0.34 + course * 0.34;
        for (const [x0, x1] of [[ix0 + 0.2, cx - portalHalf - 0.38], [cx + portalHalf + 0.38, ix1 - 0.2]] as const) {
          if (x1 <= x0) continue;
          add('wall', x0, y, iz0 - 0.12, x1, y + 0.08, iz0 + 0.01,
            course % 2 === 0 ? stoneColor : lightStone, stone);
        }
      }
      for (const x of [ix0 + 0.42, cx - w * 0.24, cx + w * 0.24, ix1 - 0.42]) {
        add('wall', x - 0.085, f1 + 2.95, iz0 - 0.13, x + 0.085, wallTop - 0.24, iz0 + 0.025,
          lightStone, stone);
        for (let level = 1; level < storeys; level++) {
          const baseY = f1 + level * (WALL_H + SLAB_T);
          add('wall', x - 0.15, baseY + 0.2, iz0 - 0.16, x + 0.15, baseY + 0.42, iz0 + 0.03,
            stoneColor, stone);
          add('wall', x - 0.15, baseY + 2.36, iz0 - 0.16, x + 0.15, baseY + 2.58, iz0 + 0.03,
            stoneColor, stone);
        }
      }
      for (let level = 1; level < storeys; level++) {
        const fy = f1 + level * (WALL_H + SLAB_T);
        for (const wx of windowCenters) {
          const frameHalf = WIN_W * 0.5 + 0.12;
          const frameBottom = fy + WIN_SILL - 0.1;
          const frameTop = fy + WIN_SILL + WIN_H + 0.12;
          add('wall', wx - frameHalf, frameBottom, iz0 - 0.14,
            wx - frameHalf + 0.11, frameTop, iz0 + 0.02, lightStone, stone);
          add('wall', wx + frameHalf - 0.11, frameBottom, iz0 - 0.14,
            wx + frameHalf, frameTop, iz0 + 0.02, lightStone, stone);
          add('wall', wx - frameHalf, frameBottom, iz0 - 0.16,
            wx + frameHalf, frameBottom + 0.13, iz0 + 0.02, stoneColor, stone);
          add('floor', wx - 0.76, fy + 0.82, iz0 - 0.44, wx + 0.76, fy + 0.94, iz0 + 0.02, stoneColor, stone);
          add('wall', wx - 0.76, fy + 1.74, iz0 - 0.48, wx + 0.76, fy + 1.82, iz0 - 0.4, iron, metal);
          for (let post = 0; post <= 5; post++) {
            const x = wx - 0.7 + post * 0.28;
            add('wall', x - 0.025, fy + 0.92, iz0 - 0.48, x + 0.025, fy + 1.78, iz0 - 0.4, iron, metal);
          }
          add('wall', wx - 0.72, fy + 2.13, iz0 - 0.12, wx + 0.72, fy + 2.27, iz0 + 0.02, lightStone, stone);
          add('wall', wx - 0.12, fy + 2.23, iz0 - 0.15, wx + 0.12, fy + 2.44, iz0 + 0.03, stoneColor, stone);
        }
      }
      const roofY = f1 + storeys * (WALL_H + SLAB_T);
      // 三层退台檐冠围绕可战斗屋顶外缘，不侵入屋顶走线。
      for (let course = 0; course < 3; course++) {
        const out = 0.32 - course * 0.08;
        const y = roofY + 0.86 + course * 0.2;
        add('roof', ix0 - out, y, iz0 - out, ix1 + out, y + 0.14, iz0 + 0.08, p.roof, roof);
        add('roof', ix0 - out, y, iz1 - 0.08, ix1 + out, y + 0.14, iz1 + out, p.roof, roof);
        add('roof', ix0 - out, y, iz0, ix0 + 0.08, y + 0.14, iz1, p.roof, roof);
        add('roof', ix1 - 0.08, y, iz0, ix1 + out, y + 0.14, iz1, p.roof, roof);
      }
      // 中央屋顶山花只贴在外立面，保留整片可战斗屋顶和女儿墙碰撞。
      for (let layer = 0; layer < 11; layer++) {
        const half = Math.min(w * 0.24, 2.85) * (1 - layer / 12);
        const y = roofY + 0.9 + layer * 0.13;
        add('wall', cx - half, y, iz0 - 0.31, cx + half, y + 0.12, iz0 + 0.02,
          layer % 2 === 0 ? p.roof : lightStone, layer % 2 === 0 ? roof : stone);
      }
      // 屋顶中央铜色徽章和两侧小尖顶强化两栋塔楼的城市地标感。
      add('wall', cx - 0.62, roofY + 1.2, iz0 - 0.38, cx + 0.62, roofY + 2.12, iz0 - 0.18,
        0x8c7044, metal);
      add('wall', cx - 0.42, roofY + 1.38, iz0 - 0.41, cx + 0.42, roofY + 1.94, iz0 - 0.15,
        0xd1b778, metal);
      for (const x of [ix0 + 1.15, ix1 - 1.15]) {
        for (let tier = 0; tier < 5; tier++) {
          const half = 0.48 * (1 - tier / 6);
          add('roof', x - half, roofY + 1.02 + tier * 0.16, iz0 - 0.25,
            x + half, roofY + 1.16 + tier * 0.16, iz0 + 0.28, tier % 2 === 0 ? p.roof : stoneColor, roof);
        }
      }
    } else if (plot.arch === 'barn') {
      // 半木构立柱、腰梁与交叉斜撑覆盖四面，木件贴墙而不挡大门和内部路线。
      for (const z of [iz0 - 0.14, iz1 + 0.14]) {
        for (const x of [ix0 + 0.34, ix0 + w * 0.33, ix0 + w * 0.67, ix1 - 0.34]) {
          add('wall', x - 0.09, f1 + 0.46, z - 0.06, x + 0.09, wallTop - 0.12, z + 0.06, timber, wood);
        }
        add('wall', ix0 + 0.2, f1 + 2.18, z - 0.07, ix1 - 0.2, f1 + 2.34, z + 0.07, timber, wood);
        for (const [section, direction] of [[0, 1], [2, -1]] as const) {
          const sectionX0 = ix0 + w * (section === 0 ? 0.04 : 0.7);
          const sectionX1 = ix0 + w * (section === 0 ? 0.3 : 0.96);
          const span = sectionX1 - sectionX0;
          const beamLength = Math.hypot(span, 2.45);
          const angle = direction * Math.atan2(2.45, span);
          const beamX = (sectionX0 + sectionX1) * 0.5;
          add('wall', beamX - beamLength / 2, f1 + 2.15 - 0.075, z - 0.075,
            beamX + beamLength / 2, f1 + 2.15 + 0.075, z + 0.075, timber,
            { ...wood, rotateZ: angle });
        }
      }
      for (const x of [ix0 - 0.14, ix1 + 0.14]) {
        for (const z of [iz0 + 0.34, iz0 + d * 0.5, iz1 - 0.34]) {
          add('wall', x - 0.06, f1 + 0.46, z - 0.09, x + 0.06, wallTop - 0.12, z + 0.09, timber, wood);
        }
        const beamLength = Math.hypot(d * 0.34, 2.3);
        for (const direction of [-1, 1]) {
          const beamZ = direction < 0 ? iz0 + d * 0.2 : iz1 - d * 0.2;
          add('wall', x - 0.075, f1 + 2.1 - 0.075, beamZ - beamLength / 2,
            x + 0.075, f1 + 2.1 + 0.075, beamZ + beamLength / 2, timber,
            { ...wood, rotateX: direction * Math.atan2(2.3, d * 0.34) });
        }
      }
    } else if (plot.arch === 'shop') {
      // 街角店铺增加分段布篷、木质招牌和橱窗基座，雨棚仍保持无碰撞。
      const awningX0 = cx - Math.min(2.25, w * 0.38);
      const awningX1 = cx + Math.min(2.25, w * 0.38);
      const strips = 8;
      for (let strip = 0; strip < strips; strip++) {
        const x0 = awningX0 + (awningX1 - awningX0) * strip / strips;
        const x1 = awningX0 + (awningX1 - awningX0) * (strip + 1) / strips;
        add('roof', x0, f1 + 2.67, iz0 - 1.42, x1, f1 + 2.76, iz0 - 0.06,
          strip % 2 === 0 ? 0x8f3f35 : 0xe5d6b8, { ...roof, rotateX: -0.08 });
      }
      add('wall', cx - 1.45, f1 + 2.88, iz0 - 0.16, cx + 1.45, f1 + 3.42, iz0 + 0.02, timber, wood);
      add('wall', cx - 1.3, f1 + 3.0, iz0 - 0.2, cx + 1.3, f1 + 3.3, iz0 - 0.14, 0xd8c39a, plaster);
      for (const x of [cx - 1.42, cx + 1.42]) {
        add('wall', x - 0.07, f1 + 0.48, iz0 - 0.15, x + 0.07, f1 + 2.55, iz0 + 0.02, lightStone, stone);
      }
    } else {
      // 竞技馆改造成欧洲古典公共大厅：巨柱、三段檐壁和中央山花形成主入口轴线。
      for (const ratio of [0.08, 0.34, 0.66, 0.92]) {
        const x = ix0 + w * ratio;
        add('wall', x - 0.18, f1 + 0.42, iz0 - 0.32, x + 0.18, wallTop - 0.46, iz0 - 0.08, lightStone, stone);
        add('wall', x - 0.3, f1 + 0.34, iz0 - 0.4, x + 0.3, f1 + 0.62, iz0, stoneColor, stone);
        add('wall', x - 0.3, wallTop - 0.62, iz0 - 0.4, x + 0.3, wallTop - 0.34, iz0, stoneColor, stone);
      }
      for (let band = 0; band < 3; band++) {
        add('wall', ix0 - 0.26 - band * 0.08, wallTop - 0.4 + band * 0.18, iz0 - 0.34,
          ix1 + 0.26 + band * 0.08, wallTop - 0.25 + band * 0.18, iz0 + 0.02, lightStone, stone);
      }
      for (let layer = 0; layer < 11; layer++) {
        const half = w * 0.28 * (1 - layer / 12);
        const y = wallTop + 0.14 + layer * 0.14;
        add('wall', cx - half, y, iz0 - 0.31, cx + half, y + 0.13, iz0 + 0.04,
          layer % 2 === 0 ? p.roof : lightStone, layer % 2 === 0 ? roof : stone);
      }
    }

    return count;
  }

  // 六区建筑共享结构规则，但用檐线、墙脚和屋顶设备形成远距离可辨认的区域视觉语言。
  // 所有构件均为薄装饰层，不改变既有门窗、室内净空和导航碰撞。
  private addRegionalFacade(
    plot: HousePlot,
    box: BoxFn,
    style: RegionalBuildingStyle,
    idx: number,
  ): void {
    const ix0 = plot.minX + 2;
    const ix1 = plot.maxX - 2;
    const iz0 = plot.minZ + 2;
    const iz1 = plot.maxZ - 2;
    const f1 = plot.flatH + 0.28;
    const storeys = buildingStoreys(plot);
    const top = f1 + storeys * (WALL_H + SLAB_T) - SLAB_T;
    const bandY = Math.max(f1 + 2.46, top - 0.34);
    const t = 0.055;
    const masonry = { collider: false, detail: true, surface: 'stone' } as const;
    const trim = { collider: false, detail: true, surface: 'paintedMetal' } as const;
    const paving = { collider: false, detail: true, surface: 'concrete' } as const;

    // 建筑四周增加窄硬化带和门前步道，消除墙体直接插进草地的临时场景感。
    const apronY0 = f1 - 0.27;
    const apronY1 = f1 - 0.19;
    const apronColor = style === REGIONAL_BUILDING_STYLES.sunfield ? 0xa99b75 :
      style === REGIONAL_BUILDING_STYLES.tideharbor ? 0x829596 : 0x8d8e87;
    box('floor', ix0 - 0.72, apronY0, iz0 - 0.72, ix1 + 0.72, apronY1, iz0, apronColor, paving);
    box('floor', ix0 - 0.72, apronY0, iz1, ix1 + 0.72, apronY1, iz1 + 0.72, apronColor, paving);
    box('floor', ix0 - 0.72, apronY0, iz0, ix0, apronY1, iz1, apronColor, paving);
    box('floor', ix1, apronY0, iz0, ix1 + 0.72, apronY1, iz1, apronColor, paving);
    const entranceX = (ix0 + ix1) * 0.5;
    box('floor', entranceX - 0.82, apronY0, plot.minZ + 0.32, entranceX + 0.82, apronY1, iz0, apronColor, paving);
    for (let step = 0; step < 3; step++) {
      const z = plot.minZ + 0.58 + step * Math.max(0.42, (iz0 - plot.minZ - 0.9) / 3);
      box('floor', entranceX - 0.68, apronY1, z, entranceX + 0.68, apronY1 + 0.025, z + 0.08, style.accent, paving);
    }

    // 连续墙脚、层间腰线和厚檐口把大平面拆成近中远三层，避免建筑只剩规则盒体。
    box('wall', ix0 - 0.07, f1 - 0.08, iz0 - 0.07, ix1 + 0.07, f1 + 0.42, iz0 + 0.02, style.accent, masonry);
    box('wall', ix0 - 0.07, f1 - 0.08, iz1 - 0.02, ix1 + 0.07, f1 + 0.42, iz1 + 0.07, style.accent, masonry);
    box('wall', ix0 - 0.07, f1 - 0.08, iz0, ix0 + 0.02, f1 + 0.42, iz1, style.accent, masonry);
    box('wall', ix1 - 0.02, f1 - 0.08, iz0, ix1 + 0.07, f1 + 0.42, iz1, style.accent, masonry);
    for (let floor = 1; floor < storeys; floor++) {
      const y = f1 + floor * (WALL_H + SLAB_T) - 0.14;
      box('wall', ix0 - 0.11, y, iz0 - 0.1, ix1 + 0.11, y + 0.18, iz0 + 0.03, style.accent, masonry);
      box('wall', ix0 - 0.11, y, iz1 - 0.03, ix1 + 0.11, y + 0.18, iz1 + 0.1, style.accent, masonry);
      box('wall', ix0 - 0.1, y, iz0, ix0 + 0.03, y + 0.18, iz1, style.accent, masonry);
      box('wall', ix1 - 0.03, y, iz0, ix1 + 0.1, y + 0.18, iz1, style.accent, masonry);
    }
    box('roof', ix0 - 0.22, top - 0.06, iz0 - 0.22, ix1 + 0.22, top + 0.1, iz0 + 0.04, style.accent, trim);
    box('roof', ix0 - 0.22, top - 0.06, iz1 - 0.04, ix1 + 0.22, top + 0.1, iz1 + 0.22, style.accent, trim);

    // 侧立面用竖向壁柱划分开间，让无窗墙也保留建筑尺度和承重节奏。
    for (const z of [iz0 + (iz1 - iz0) * 0.3, iz0 + (iz1 - iz0) * 0.7]) {
      box('wall', ix0 - 0.075, f1 + 0.42, z - 0.075, ix0 + 0.025, top - 0.12, z + 0.075, style.accent, masonry);
      box('wall', ix1 - 0.025, f1 + 0.42, z - 0.075, ix1 + 0.075, top - 0.12, z + 0.075, style.accent, masonry);
    }
    for (const x of [ix0 + (ix1 - ix0) * 0.28, ix0 + (ix1 - ix0) * 0.72]) {
      box('wall', x - 0.075, f1 + 0.42, iz0 - 0.075, x + 0.075, top - 0.12, iz0 + 0.025, style.accent, masonry);
      box('wall', x - 0.075, f1 + 0.42, iz1 - 0.025, x + 0.075, top - 0.12, iz1 + 0.075, style.accent, masonry);
    }

    box('wall', ix0, bandY, iz0 - t, ix1, bandY + 0.13, iz0, style.accent, { collider: false });
    box('wall', ix0, bandY, iz1, ix1, bandY + 0.13, iz1 + t, style.accent, { collider: false });
    box('wall', ix0 - t, bandY, iz0, ix0, bandY + 0.13, iz1, style.accent, { collider: false });
    box('wall', ix1, bandY, iz0, ix1 + t, bandY + 0.13, iz1, style.accent, { collider: false });

    // 墙角竖向收边把实例化墙块连成完整立面，也强化各区域主色。
    for (const x of [ix0 - t, ix1]) {
      for (const z of [iz0 - t, iz1]) {
        box('wall', x, f1 + 0.08, z, x + t, Math.min(top, f1 + 2.5), z + t, style.accent, { collider: false });
      }
    }

    if (plot.arch === 'shop' || plot.arch === 'apartment' || idx % 4 === 0) {
      const signW = Math.min(2.4, (ix1 - ix0) * 0.32);
      const signX = (ix0 + ix1) * 0.5;
      box(
        'wall', signX - signW / 2, f1 + 2.3, iz0 - 0.09,
        signX + signW / 2, f1 + 2.68, iz0 - 0.025,
        style.secondary, { collider: false },
      );
    }

    // 常用入口增加有厚度的雨棚和支架，形成明确的门前视觉焦点。
    if (plot.arch !== 'barn' && plot.arch !== 'gym' && (idx % 2 === 0 || plot.arch === 'shop')) {
      const center = (ix0 + ix1) * 0.5;
      const canopyY = f1 + 2.34;
      box('roof', center - 1.08, canopyY, iz0 - 0.72, center + 1.08, canopyY + 0.14, iz0 - 0.02, style.secondary, trim);
      for (const x of [center - 0.88, center + 0.88]) {
        box('wall', x - 0.045, f1 + 1.72, iz0 - 0.58, x + 0.045, canopyY, iz0 - 0.49, style.accent, trim);
        box('wall', x - 0.045, canopyY - 0.24, iz0 - 0.54, x + 0.045, canopyY, iz0 - 0.12, style.accent, trim);
      }
    }

    // 山脊屋顶使用错位双立杆接收器，避免普通建筑出现十字形剪影。
    if (style === REGIONAL_BUILDING_STYLES.eagleridge) {
      const ax = ix1 - 0.8;
      box('wall', ax - 0.035, top, iz1 - 0.7, ax + 0.035, top + 1.25, iz1 - 0.63, style.secondary, { collider: false });
      box('wall', ax - 0.42, top + 0.34, iz1 - 0.69, ax - 0.24, top + 1.02, iz1 - 0.64, style.secondary, { collider: false });
    } else if (style === REGIONAL_BUILDING_STYLES.tideharbor) {
      const awningY = f1 + 2.2;
      box('roof', ix0 + 0.8, awningY, iz0 - 0.48, ix1 - 0.8, awningY + 0.1, iz0 - 0.02, style.secondary, { collider: false });
    }
  }

  // 磐石城垂直切片: 砖石墙脚、门廊、雨棚、线缆和生活化立面形成独立的旧城语言.
  private addStonegateFacadeDetails(
    plot: HousePlot,
    box: BoxFn,
    idx: number,
    featured: boolean,
  ): number {
    if (plot.arch === 'gym' || plot.arch === 'barn') return 0;
    const ix0 = plot.minX + 2;
    const ix1 = plot.maxX - 2;
    const iz0 = plot.minZ + 2;
    const iz1 = plot.maxZ - 2;
    const f1 = plot.flatH + 0.28;
    const storeys = buildingStoreys(plot);
    const top = f1 + storeys * (WALL_H + SLAB_T) - SLAB_T;
    const brick = { collider: false, detail: true, surface: 'stonegateBrick' } as const;
    const stone = { collider: false, detail: true, surface: 'stone' } as const;
    const metal = { collider: false, detail: true, surface: 'paintedMetal' } as const;
    let count = 0;

    // 连续砖墙脚和压顶把墙体落到地面, 雨天也保留清晰的材质层次.
    box('wall', ix0, f1 - 0.02, iz0 - 0.035, ix1, f1 + 0.72, iz0, 0x9f7766, brick); count++;
    box('wall', ix0, f1 - 0.02, iz1, ix1, f1 + 0.72, iz1 + 0.035, 0x8d6d61, brick); count++;
    box('wall', ix0 - 0.035, f1 - 0.02, iz0, ix0, f1 + 0.72, iz1, 0x957164, brick); count++;
    box('wall', ix1, f1 - 0.02, iz0, ix1 + 0.035, f1 + 0.72, iz1, 0x8b695e, brick); count++;
    for (const z of [iz0 - 0.055, iz1 + 0.015]) {
      box('wall', ix0 - 0.04, f1 + 0.69, z, ix1 + 0.04, f1 + 0.79, z + 0.04, 0xc0b5a3, stone);
      count++;
    }
    for (const x of [ix0 - 0.055, ix1 + 0.015]) {
      box('wall', x, f1 + 0.69, iz0, x + 0.04, f1 + 0.79, iz1, 0xb5aa99, stone);
      count++;
    }

    // 砖石转角采用错层短块, 近看能读出真实砌筑节奏而不是一整条色带.
    for (let floor = 0; floor < storeys; floor++) {
      const base = f1 + floor * (WALL_H + SLAB_T);
      for (let row = 0; row < 5; row++) {
        const y = base + 0.86 + row * 0.36;
        const reach = row % 2 === 0 ? 0.36 : 0.24;
        box('wall', ix0 - 0.045, y, iz0 - 0.045, ix0 + reach, y + 0.16, iz0 + 0.02, 0xa07a68, brick);
        box('wall', ix1 - reach, y, iz0 - 0.045, ix1 + 0.045, y + 0.16, iz0 + 0.02, 0x967061, brick);
        count += 2;
      }
    }

    // 墙面电缆、接线盒和旧门牌让立面具有明确功能关系.
    const cableY = Math.min(top - 0.5, f1 + 2.54);
    box('wall', ix0 + 0.25, cableY, iz0 - 0.075, ix1 - 0.25, cableY + 0.045, iz0 - 0.025, 0x3f4545, metal); count++;
    const junctionX = idx % 2 === 0 ? ix0 + 0.72 : ix1 - 0.72;
    box('wall', junctionX - 0.13, cableY - 0.16, iz0 - 0.095, junctionX + 0.13, cableY + 0.15, iz0 - 0.02, 0x59615e, metal); count++;
    box('wall', junctionX - 0.035, f1 + 0.8, iz0 - 0.08, junctionX + 0.035, cableY - 0.12, iz0 - 0.025, 0x464d4c, metal); count++;

    if (!featured) return count;

    const center = (ix0 + ix1) * 0.5;
    // 重点双层楼的深门廊和分层雨棚成为街区垂直切片主视觉.
    box('wall', center - 0.88, f1 - 0.02, iz0 - 0.12, center - 0.68, f1 + 2.45, iz0 + 0.05, 0xa67c66, brick); count++;
    box('wall', center + 0.68, f1 - 0.02, iz0 - 0.12, center + 0.88, f1 + 2.45, iz0 + 0.05, 0x98705e, brick); count++;
    box('wall', center - 0.92, f1 + 2.28, iz0 - 0.14, center + 0.92, f1 + 2.48, iz0 + 0.06, 0xb08a72, brick); count++;
    box('roof', center - 1.28, f1 + 2.42, iz0 - 0.68, center + 1.28, f1 + 2.55, iz0 - 0.04, 0x6c716e, metal); count++;
    box('roof', center - 1.16, f1 + 2.55, iz0 - 0.61, center + 1.16, f1 + 2.62, iz0 - 0.08, 0xb06b4f, metal); count++;
    for (const x of [center - 1.08, center + 1.08]) {
      box('wall', x - 0.04, f1, iz0 - 0.58, x + 0.04, f1 + 2.43, iz0 - 0.5, 0x4d5554, metal);
      count++;
    }

    // 上层窗台花箱、侧挂招牌和屋面错位接收杆形成三级轮廓细节.
    const upperFloor = f1 + WALL_H + SLAB_T;
    const upperWindowX = ix0 + (ix1 - ix0) * 0.35 + WIN_W * 0.5;
    const upperWindowY0 = upperFloor + 0.9;
    // 窗洞外扩的石质侧壁、窗台和过梁形成真实凹进层次，避免玻璃直接贴在平墙上。
    box('wall', upperWindowX - WIN_W * 0.5 - 0.16, upperWindowY0 - 0.12, iz0 - 0.2,
      upperWindowX - WIN_W * 0.5 + 0.02, upperWindowY0 + WIN_H + 0.16, iz0 - 0.025,
      0xc3b6a2, stone); count++;
    box('wall', upperWindowX + WIN_W * 0.5 - 0.02, upperWindowY0 - 0.12, iz0 - 0.2,
      upperWindowX + WIN_W * 0.5 + 0.16, upperWindowY0 + WIN_H + 0.16, iz0 - 0.025,
      0xb8aa97, stone); count++;
    box('wall', upperWindowX - WIN_W * 0.5 - 0.16, upperWindowY0 + WIN_H,
      iz0 - 0.22, upperWindowX + WIN_W * 0.5 + 0.16, upperWindowY0 + WIN_H + 0.2,
      iz0 - 0.02, 0xc7baa5, stone); count++;
    box('wall', upperWindowX - WIN_W * 0.5 - 0.22, upperWindowY0 - 0.16,
      iz0 - 0.26, upperWindowX + WIN_W * 0.5 + 0.22, upperWindowY0,
      iz0 - 0.01, 0xb2a48f, stone); count++;

    // 小型法式阳台打破方盒轮廓，深度受控且不参与导航碰撞。
    const balconyX0 = upperWindowX - 1.34;
    const balconyX1 = upperWindowX + 1.34;
    const balconyZ0 = iz0 - 0.82;
    const balconyTop = upperFloor + 0.16;
    box('floor', balconyX0, upperFloor + 0.02, balconyZ0, balconyX1, balconyTop, iz0 + 0.02,
      0x8d7d69, { collider: false, detail: true, surface: 'stone' }); count++;
    for (const x of [balconyX0 + 0.06, balconyX1 - 0.06]) {
      box('wall', x - 0.035, balconyTop, balconyZ0, x + 0.035, balconyTop + 0.92, iz0 - 0.04,
        0x424a4b, metal); count++;
    }
    for (let i = 0; i <= 6; i++) {
      const x = balconyX0 + 0.12 + (balconyX1 - balconyX0 - 0.24) * i / 6;
      box('wall', x - 0.025, balconyTop + 0.06, balconyZ0 - 0.025, x + 0.025,
        balconyTop + 0.88, balconyZ0 + 0.025, 0x41494a, metal); count++;
    }
    box('wall', balconyX0 + 0.04, balconyTop + 0.82, balconyZ0 - 0.04,
      balconyX1 - 0.04, balconyTop + 0.92, balconyZ0 + 0.04, 0x51595a, metal); count++;
    for (const x of [balconyX0 + 0.42, balconyX1 - 0.42]) {
      box('wall', x - 0.09, upperFloor - 0.26, balconyZ0 + 0.12, x + 0.09, upperFloor + 0.03,
        iz0 - 0.06, 0x6b5947, { ...stone, surface: 'wood' }); count++;
    }

    for (const x of [ix0 + (ix1 - ix0) * 0.34, ix0 + (ix1 - ix0) * 0.68]) {
      box('wall', x - 0.52, upperFloor + 0.88, iz0 - 0.22, x + 0.52, upperFloor + 1.03, iz0 - 0.03, 0x6c533f, { ...brick, surface: 'wood' }); count++;
      for (let plant = -1; plant <= 1; plant++) {
        const px = x + plant * 0.28;
        box('wall', px - 0.08, upperFloor + 1.01, iz0 - 0.18, px + 0.08, upperFloor + 1.2 + (plant === 0 ? 0.1 : 0), iz0 - 0.02, 0x657653, { ...brick, surface: 'foliage' });
        count++;
      }
    }
    box('wall', ix1 + 0.08, f1 + 1.82, iz0 + 0.7, ix1 + 0.18, f1 + 2.72, iz0 + 0.78, 0x3e4647, metal); count++;
    box('wall', ix1 + 0.14, f1 + 1.92, iz0 + 0.62, ix1 + 0.23, f1 + 2.52, iz0 + 1.5, 0xcaa85f, { ...metal, surface: 'wood' }); count++;
    // 双层檐口、屋顶老虎窗和侧向烟囱让远景不再只是整齐矩形。
    box('roof', ix0 - 0.32, top - 0.1, iz0 - 0.38, ix1 + 0.32, top + 0.06, iz0 + 0.08,
      0x66534a, { collider: false, detail: true, surface: 'roof' }); count++;
    box('roof', ix0 - 0.22, top + 0.08, iz0 - 0.28, ix1 + 0.22, top + 0.16, iz0 + 0.02,
      0x9f745d, { collider: false, detail: true, surface: 'roof' }); count++;
    const dormerX = center + (ix1 - ix0) * 0.2;
    box('wall', dormerX - 0.72, top + 0.12, iz0 + 0.48, dormerX + 0.72, top + 1.12, iz0 + 1.48,
      0xbca996, { collider: false, detail: true, surface: 'plaster' }); count++;
    box('roof', dormerX - 0.86, top + 1.02, iz0 + 0.32, dormerX + 0.86, top + 1.18, iz0 + 1.58,
      0x735448, { collider: false, detail: true, surface: 'roof' }); count++;
    box('wall', dormerX - 0.34, top + 0.42, iz0 + 0.43, dormerX + 0.34, top + 0.92, iz0 + 0.49,
      0x78959d, { collider: false, detail: true, surface: 'paintedMetal' }); count++;
    box('wall', ix0 + 0.72, top - 0.08, iz1 - 1.42, ix0 + 1.34, top + 1.72, iz1 - 0.78,
      0x8f6c5d, { collider: false, detail: true, surface: 'stonegateBrick' }); count++;
    box('roof', ix0 + 0.62, top + 1.68, iz1 - 1.52, ix0 + 1.44, top + 1.86, iz1 - 0.68,
      0xb4a48f, { collider: false, detail: true, surface: 'stone' }); count++;
    const aerialX = ix1 - 1.1;
    box('roof', aerialX - 0.035, top, iz1 - 0.9, aerialX + 0.035, top + 1.4, iz1 - 0.83, 0x4d5554, metal); count++;
    box('roof', aerialX - 0.42, top + 0.42, iz1 - 0.89, aerialX - 0.24, top + 1.08, iz1 - 0.84, 0x4d5554, metal); count++;
    return count;
  }

  // 重点双层楼的室内使用成套木作、织物和功能家具, 不再只靠随机箱体填充空间.
  private addStonegateInteriorDetails(plot: HousePlot, box: BoxFn): number {
    const ix0 = plot.minX + 2;
    const ix1 = plot.maxX - 2;
    const iz0 = plot.minZ + 2;
    const iz1 = plot.maxZ - 2;
    const f1 = plot.flatH + 0.28;
    const upper = f1 + WALL_H + SLAB_T;
    const wood = { collider: false, detail: true, surface: 'wood' } as const;
    const fabric = { collider: false, detail: true, surface: 'fabric' } as const;
    let count = 0;

    for (const floorY of [f1, upper]) {
      // 连续踢脚线和顶角线明确房间尺度.
      box('wall', ix0 + 0.12, floorY + 0.05, iz0 + 0.12, ix1 - 0.12, floorY + 0.17, iz0 + 0.18, 0x604735, wood); count++;
      box('wall', ix0 + 0.12, floorY + 0.05, iz1 - 0.18, ix1 - 0.12, floorY + 0.17, iz1 - 0.12, 0x604735, wood); count++;
      box('wall', ix0 + 0.12, floorY + 0.05, iz0 + 0.18, ix0 + 0.18, floorY + 0.17, iz1 - 0.18, 0x604735, wood); count++;
      box('wall', ix1 - 0.18, floorY + 0.05, iz0 + 0.18, ix1 - 0.12, floorY + 0.17, iz1 - 0.18, 0x604735, wood); count++;
      // 吊灯线、灯罩和墙面装饰框.
      const cx = (ix0 + ix1) * 0.5 + 0.8;
      const cz = (iz0 + iz1) * 0.5 + 0.65;
      box('wall', cx - 0.018, floorY + 2.34, cz - 0.018, cx + 0.018, floorY + 2.78, cz + 0.018, 0x3f403c, { ...wood, surface: 'metal' }); count++;
      box('wall', cx - 0.19, floorY + 2.27, cz - 0.19, cx + 0.19, floorY + 2.4, cz + 0.19, 0xc99c5d, { ...wood, surface: 'paintedMetal' }); count++;
      box('wall', ix1 - 0.11, floorY + 1.08, cz - 0.48, ix1 - 0.04, floorY + 1.86, cz + 0.48, 0x6b513e, wood); count++;
      box('wall', ix1 - 0.13, floorY + 1.18, cz - 0.38, ix1 - 0.02, floorY + 1.76, cz + 0.38, floorY === f1 ? 0x81908a : 0xb08a67, fabric); count++;
      // 连续护墙板和顶梁形成清晰的上下材质分区，不再是一整面空白墙。
      for (const z of [iz0 + 0.42, iz1 - 0.42]) {
        box('wall', ix0 + 0.28, floorY + 0.22, z - 0.035, ix1 - 0.28, floorY + 0.82,
          z + 0.035, 0x8b755d, { ...wood, surface: 'wood' }); count++;
        box('wall', ix0 + 0.24, floorY + 0.8, z - 0.05, ix1 - 0.24, floorY + 0.9,
          z + 0.05, 0x594536, wood); count++;
      }
      for (const x of [ix0 + 1.1, ix1 - 1.1]) {
        box('roof', x - 0.08, floorY + 2.68, iz0 + 0.24, x + 0.08, floorY + 2.82,
          iz1 - 0.24, 0x5c4736, wood); count++;
      }
    }

    // 二层卧室远离楼梯井, 床和矮柜提供真实碰撞与搜刮掩体.
    const bedX0 = ix1 - 2.05;
    const bedX1 = ix1 - 0.55;
    const bedZ0 = iz1 - 2.55;
    const bedZ1 = iz1 - 0.55;
    box('wall', bedX0, upper, bedZ0, bedX1, upper + 0.42, bedZ1, 0x5f4938, { detail: true, surface: 'wood' }); count++;
    box('wall', bedX0 + 0.05, upper + 0.42, bedZ0 + 0.06, bedX1 - 0.05, upper + 0.58, bedZ1 - 0.06, 0x8e947d, fabric); count++;
    box('wall', bedX0 + 0.08, upper + 0.58, bedZ0 + 0.12, bedX1 - 0.08, upper + 0.72, bedZ0 + 0.62, 0xd4c7ad, fabric); count++;
    box('wall', bedX0 - 0.08, upper, bedZ1 - 0.15, bedX1 + 0.08, upper + 1.18, bedZ1, 0x694d39, wood); count++;
    box('floor', ix0 + 2.15, upper + 0.018, iz1 - 2.5, ix1 - 2.25, upper + 0.038, iz1 - 0.55, 0x765e58, fabric); count++;

    // 一层厨房台面贴后墙, 保持入口、餐桌和楼梯通道完全开放.
    const counterX0 = ix0 + 2.35;
    const counterX1 = Math.min(ix1 - 2.35, counterX0 + 2.15);
    box('wall', counterX0, f1, iz1 - 0.58, counterX1, f1 + 0.82, iz1 - 0.16, 0x7b6650, { detail: true, surface: 'wood' }); count++;
    box('wall', counterX0 - 0.04, f1 + 0.82, iz1 - 0.64, counterX1 + 0.04, f1 + 0.94, iz1 - 0.12, 0xb6aa92, { detail: true, surface: 'stone' }); count++;
    for (let i = 1; i < 3; i++) {
      const x = counterX0 + (counterX1 - counterX0) * i / 3;
      box('wall', x - 0.025, f1 + 0.08, iz1 - 0.66, x + 0.025, f1 + 0.74, iz1 - 0.1, 0x4e3d31, wood); count++;
    }
    // 灶台、金属水槽、吊柜和调味瓶把厨房从一条柜体变成可读功能区。
    const stoveX = counterX0 + 0.48;
    box('wall', stoveX - 0.34, f1 + 0.93, iz1 - 0.6, stoveX + 0.34, f1 + 0.99,
      iz1 - 0.18, 0x343a3b, { ...wood, surface: 'metal' }); count++;
    for (const x of [stoveX - 0.18, stoveX + 0.18]) {
      box('wall', x - 0.08, f1 + 0.99, iz1 - 0.5, x + 0.08, f1 + 1.03,
        iz1 - 0.3, 0x161b1c, { ...wood, surface: 'metal' }); count++;
    }
    const sinkX = counterX1 - 0.42;
    box('wall', sinkX - 0.3, f1 + 0.94, iz1 - 0.58, sinkX + 0.3, f1 + 1.01,
      iz1 - 0.2, 0x778384, { ...wood, surface: 'metal' }); count++;
    box('wall', sinkX - 0.025, f1 + 1.01, iz1 - 0.3, sinkX + 0.025, f1 + 1.34,
      iz1 - 0.23, 0x596263, { ...wood, surface: 'metal' }); count++;
    for (let i = 0; i < 3; i++) {
      const x = counterX0 + 0.28 + i * 0.58;
      box('wall', x - 0.22, f1 + 1.48, iz1 - 0.34, x + 0.22, f1 + 2.14,
        iz1 - 0.13, i === 1 ? 0x7b684f : 0x6d5945, wood); count++;
      box('wall', x - 0.12, f1 + 1.62, iz1 - 0.39, x + 0.12, f1 + 1.74,
        iz1 - 0.29, 0xb28d58, { ...wood, surface: 'paintedMetal' }); count++;
    }

    // 餐区增加餐具、长凳和墙面挂画，控制碰撞仍由原餐桌承担。
    const diningX = ix1 - 1.55;
    const diningZ = iz0 + 1.55;
    for (const x of [diningX - 0.3, diningX + 0.3]) {
      box('wall', x - 0.12, f1 + 0.82, diningZ - 0.12, x + 0.12, f1 + 0.86,
        diningZ + 0.12, 0xd8d1bd, { ...fabric, surface: 'stone' }); count++;
      box('wall', x - 0.035, f1 + 0.86, diningZ - 0.035, x + 0.035, f1 + 1.04,
        diningZ + 0.035, x < diningX ? 0x8f493d : 0x617b55, { ...fabric, surface: 'paintedMetal' }); count++;
    }
    box('wall', diningX - 0.78, f1 + 0.36, iz0 + 0.42, diningX + 0.78, f1 + 0.76,
      iz0 + 0.82, 0x66503d, { collider: false, detail: true, surface: 'wood' }); count++;
    box('wall', diningX - 0.68, f1 + 0.76, iz0 + 0.64, diningX + 0.68, f1 + 1.24,
      iz0 + 0.78, 0x76624e, wood); count++;
    box('wall', ix1 - 0.12, f1 + 1.08, diningZ - 0.62, ix1 - 0.04, f1 + 1.9,
      diningZ + 0.62, 0x604939, wood); count++;
    box('wall', ix1 - 0.14, f1 + 1.18, diningZ - 0.5, ix1 - 0.02, f1 + 1.8,
      diningZ + 0.5, 0x6f897f, fabric); count++;

    // 二层增加床头柜、衣柜和床边灯，形成完整卧室而不是孤立床垫。
    box('wall', bedX0 - 0.72, upper, bedZ1 - 0.78, bedX0 - 0.18, upper + 0.62,
      bedZ1 - 0.2, 0x684f3c, { detail: true, surface: 'wood' }); count++;
    box('wall', bedX0 - 0.62, upper + 0.62, bedZ1 - 0.68, bedX0 - 0.28, upper + 0.84,
      bedZ1 - 0.3, 0xc39458, { collider: false, detail: true, surface: 'paintedMetal' }); count++;
    box('wall', ix0 + 2.35, upper, iz1 - 0.66, ix0 + 3.55, upper + 2.18,
      iz1 - 0.18, 0x6d5946, { detail: true, surface: 'wood' }); count++;
    for (const x of [ix0 + 2.72, ix0 + 3.18]) {
      box('wall', x - 0.025, upper + 0.3, iz1 - 0.7, x + 0.025, upper + 1.96,
        iz1 - 0.14, 0x47392f, wood); count++;
    }
    return count;
  }

  // 檐沟、落水管、墙面线盒和基础通风口补齐建筑外立面的功能构件。
  // 这些细件全部合并进既有实例网格且不参与碰撞，不改变门窗和屋顶通行。
  private addExteriorHardware(plot: HousePlot, box: BoxFn, idx: number): void {
    const ix0 = plot.minX + 2;
    const ix1 = plot.maxX - 2;
    const iz0 = plot.minZ + 2;
    const iz1 = plot.maxZ - 2;
    const f1 = plot.flatH + 0.28;
    const d = iz1 - iz0;
    const roofBase = (() => {
      if (plot.arch === 'barn') return f1 + 4.2;
      if (plot.arch === 'gym') return f1 + 8.6;
      if (plot.arch === 'apartment') {
        const storeys = buildingStoreys(plot);
        return f1 + WALL_H * storeys + SLAB_T * (storeys - 1);
      }
      if (plot.arch === 'cottage2' || plot.arch === 'terrace') return f1 + WALL_H * 2 + SLAB_T - 0.15;
      return f1 + WALL_H;
    })();
    const farZ = plot.arch === 'terrace' ? iz0 + d * 0.55 + 0.1 : iz1;
    const opts = { collider: false, detail: true } as const;

    // 双侧檐沟和前立面落水管。
    box('roof', ix0 - 0.24, roofBase + 0.08, iz0 - 0.25, ix1 + 0.24, roofBase + 0.18, iz0 - 0.12, GUTTER_C, opts);
    box('roof', ix0 - 0.24, roofBase + 0.08, farZ + 0.12, ix1 + 0.24, roofBase + 0.18, farZ + 0.25, GUTTER_C, opts);
    const pipeX = idx % 2 === 0 ? ix0 + 0.16 : ix1 - 0.16;
    const pipeZ = iz0 - 0.18;
    box('roof', pipeX - 0.055, f1 - 0.16, pipeZ - 0.055, pipeX + 0.055, roofBase + 0.13, pipeZ + 0.055, GUTTER_C, opts);
    box('roof', pipeX - 0.055, f1 - 0.18, pipeZ - 0.32, pipeX + 0.055, f1 - 0.05, pipeZ + 0.02, GUTTER_C, opts);
    for (const t of [0.22, 0.52, 0.82]) {
      const y = f1 + (roofBase - f1) * t;
      box('roof', pipeX - 0.1, y - 0.025, iz0 - 0.21, pipeX + 0.1, y + 0.025, iz0 - 0.08, FRAME_C, opts);
    }

    // 基础通风口避开居中的正门，侧墙线盒只在一半建筑出现，保持变化。
    for (const x of [ix0 + 1.05, ix1 - 1.05]) {
      box('wall', x - 0.26, f1 + 0.18, iz0 - 0.17, x + 0.26, f1 + 0.42, iz0 - 0.115, 0x4e5654, opts);
      for (let i = 0; i < 3; i++) {
        const yy = f1 + 0.23 + i * 0.065;
        box('wall', x - 0.21, yy, iz0 - 0.19, x + 0.21, yy + 0.018, iz0 - 0.1, 0x2f3534, opts);
      }
    }
    if (idx % 2 === 0 && plot.arch !== 'gym') {
      const meterZ = iz0 + Math.min(1.35, d * 0.24);
      box('wall', ix1 + 0.075, f1 + 1.02, meterZ - 0.22, ix1 + 0.19, f1 + 1.48, meterZ + 0.22, 0x747d79, opts);
      box('wall', ix1 + 0.09, f1 + 0.2, meterZ - 0.035, ix1 + 0.15, f1 + 1.03, meterZ + 0.035, GUTTER_C, opts);
    }
  }

  // 真双坡屋面使用旋转薄板表现，隐藏的六级碰撞阶梯让站立高度贴近斜面。
  private gableRoof(
    box: BoxFn,
    ix0: number,
    iz0: number,
    ix1: number,
    iz1: number,
    yBase: number,
    c: number,
    wallC: number,
  ): void {
    const dz = iz1 - iz0;
    const zm = (iz0 + iz1) / 2;
    const rise = 1.08;
    const overhang = 0.22;
    const halfRun = dz * 0.5 + overhang;
    const panelLength = Math.hypot(halfRun, rise);
    const pitch = gableRoofPitch(dz);
    const northCenterZ = (iz0 - overhang + zm) * 0.5;
    const southCenterZ = (zm + iz1 + overhang) * 0.5;
    const panelCenterY = yBase + rise * 0.5 + 0.06;

    // 用细分山墙封住水平墙顶与双坡屋面之间的三角区域.
    // 细分盒完全藏在屋面包边内, 从室内和侧立面都不会再透出天空.
    const gableLayers = GABLE_INFILL_LAYERS;
    const layerH = rise / gableLayers;
    const endThickness = WT * 0.9;
    for (let i = 0; i < gableLayers; i++) {
      const halfSpan = dz * 0.5 * (1 - i / gableLayers) + 0.025;
      const y0 = yBase + i * layerH - 0.015;
      const y1 = yBase + (i + 1) * layerH + 0.02;
      box(
        'wall', ix0 - endThickness * 0.5, y0, zm - halfSpan,
        ix0 + endThickness * 0.5, y1, zm + halfSpan,
        wallC, { collider: false, detail: true },
      );
      box(
        'wall', ix1 - endThickness * 0.5, y0, zm - halfSpan,
        ix1 + endThickness * 0.5, y1, zm + halfSpan,
        wallC, { collider: false, detail: true },
      );
    }

    // 十二级隐藏碰撞体让加高屋面的站立高度仍然贴合斜面。
    const collisionSteps = 12;
    for (let side = 0; side < 2; side++) {
      for (let i = 0; i < collisionSteps; i++) {
        const near = dz * 0.5 * (i / collisionSteps);
        const far = dz * 0.5 * ((i + 1) / collisionSteps);
        const z0 = side === 0 ? iz0 + near : iz1 - far;
        const z1 = side === 0 ? iz0 + far : iz1 - near;
        const top = yBase + rise * ((i + 0.5) / collisionSteps);
        box('roof', ix0 - 0.18, yBase - 0.04, z0, ix1 + 0.18, top, z1, c, { visual: false });
      }
    }

    const panelOptsNorth = { collider: false, detail: true, rotateX: -pitch } as const;
    const panelOptsSouth = { collider: false, detail: true, rotateX: pitch } as const;
    box(
      'roof', ix0 - overhang, panelCenterY - 0.06, northCenterZ - panelLength / 2,
      ix1 + overhang, panelCenterY + 0.06, northCenterZ + panelLength / 2,
      c, panelOptsNorth,
    );
    box(
      'roof', ix0 - overhang, panelCenterY - 0.06, southCenterZ - panelLength / 2,
      ix1 + overhang, panelCenterY + 0.06, southCenterZ + panelLength / 2,
      c, panelOptsSouth,
    );
    box('roof', ix0 - 0.08, yBase + rise, zm - 0.15, ix1 + 0.08, yBase + rise + 0.12, zm + 0.15, FRAME_C, { collider: false, detail: true });
    // 成对瓦层压条打破大块水平屋面的塑料感，同时保留原屋顶平台碰撞。
    for (const course of GABLE_ROOF_COURSES) {
      const z = iz0 + dz * course.z;
      const rotateX = course.z < 0.5 ? -pitch : pitch;
      box(
        'roof', ix0 - 0.14, yBase + course.y, z - 0.045,
        ix1 + 0.14, yBase + course.y + 0.055, z + 0.045,
        FRAME_C, { collider: false, detail: true, rotateX },
      );
    }
    // 山墙两端以同角度深色封边，远处轮廓连续且没有矩形挡板。
    for (const x of [ix0 - 0.22, ix1 + 0.12]) {
      box('roof', x, panelCenterY - 0.075, northCenterZ - panelLength / 2, x + 0.1, panelCenterY + 0.075, northCenterZ + panelLength / 2, FRAME_C, panelOptsNorth);
      box('roof', x, panelCenterY - 0.075, southCenterZ - panelLength / 2, x + 0.1, panelCenterY + 0.075, southCenterZ + panelLength / 2, FRAME_C, panelOptsSouth);
    }
  }

  // 墙基裙(一周, 纯装饰)
  private skirt(box: BoxFn, ix0: number, iz0: number, ix1: number, iz1: number, yBase: number): void {
    const t = 0.06;
    box('wall', ix0 - t, yBase, iz0 - t, ix1 + t, yBase + 0.32, iz0, SKIRT_C, { collider: false });
    box('wall', ix0 - t, yBase, iz1, ix1 + t, yBase + 0.32, iz1 + t, SKIRT_C, { collider: false });
    box('wall', ix0 - t, yBase, iz0, ix0, yBase + 0.32, iz1, SKIRT_C, { collider: false });
    box('wall', ix1, yBase, iz0, ix1 + t, yBase + 0.32, iz1, SKIRT_C, { collider: false });
  }

  // 烟囱 / 空调盒(纯装饰)
  private extras(box: BoxFn, p: Palette, ix0: number, iz0: number, ix1: number, roofY: number, w: number): void {
    if (p.chimney) {
      box('wall', ix0 + w * 0.72, roofY, iz0 + 0.5, ix0 + w * 0.72 + 0.36, roofY + 0.95, iz0 + 0.86, 0x7a6a58, { collider: false });
    }
    if (p.ac) {
      box('wall', ix1 + 0.02, roofY - 1.6, iz0 + 1.1, ix1 + 0.3, roofY - 1.28, iz0 + 1.5, 0xb8bcc0, { collider: false });
    }
    // 屋顶通风帽、检修箱和宽楼的储水箱，形成更丰富的天际线。
    box('wall', ix0 + w * 0.28, roofY, iz0 + 0.65, ix0 + w * 0.28 + 0.28, roofY + 0.42, iz0 + 0.93, 0x737b79, { collider: false });
    box('wall', ix0 + w * 0.44, roofY, iz0 + 0.78, ix0 + w * 0.44 + 0.42, roofY + 0.28, iz0 + 1.18, 0x909795, { collider: false });
    if (w > 8) {
      box('wall', ix0 + w * 0.58, roofY, iz0 + 0.55, ix0 + w * 0.58 + 0.82, roofY + 0.72, iz0 + 1.35, 0x667579, { collider: false });
    }
  }

  // 门 + 门框(装饰框边)
  private addDoor(
    world: World, box: BoxFn, axis: 'x' | 'z', fixed: number,
    a0: number, a1: number, y0: number, y1: number, midY: number,
    interior: 1 | -1,
    hinge: 1 | -1,
  ): void {
    // 门框: 两侧柱 + 顶楣(纯装饰)
    const ft = 0.1;
    if (axis === 'x') {
      box('wall', a0 - 0.06, y0, fixed - ft, a0 + 0.02, y1 + 0.06, fixed + ft, FRAME_C, { collider: false });
      box('wall', a1 - 0.02, y0, fixed - ft, a1 + 0.06, y1 + 0.06, fixed + ft, FRAME_C, { collider: false });
      box('wall', a0 - 0.06, y1, fixed - ft, a1 + 0.06, y1 + 0.08, fixed + ft, FRAME_C, { collider: false });
    } else {
      box('wall', fixed - ft, y0, a0 - 0.06, fixed + ft, y1 + 0.06, a0 + 0.02, FRAME_C, { collider: false });
      box('wall', fixed - ft, y0, a1 - 0.02, fixed + ft, y1 + 0.06, a1 + 0.06, FRAME_C, { collider: false });
      box('wall', fixed - ft, y1, a0 - 0.06, fixed + ft, y1 + 0.08, a1 + 0.06, FRAME_C, { collider: false });
    }
    const t = 0.1;
    const c: AabbCollider = axis === 'x'
      ? { kind: 'aabb', minX: a0, minY: y0, minZ: fixed - t / 2, maxX: a1, maxY: y1, maxZ: fixed + t / 2, tag: 'door' }
      : { kind: 'aabb', minX: fixed - t / 2, minY: y0, minZ: a0, maxX: fixed + t / 2, maxY: y1, maxZ: a1, tag: 'door' };
    world.addCollider(c);
    // 铰链结构: group 定位在指定铰链边, pivot 承载门扇, 开门 = pivot 绕 Y 旋转
    const group = new THREE.Group();
    const hingeAt = hinge === 1 ? a0 : a1;
    group.position.set(axis === 'x' ? hingeAt : fixed, y0, axis === 'x' ? fixed : hingeAt);
    const pivot = new THREE.Group();
    const mesh = new THREE.Mesh(axis === 'x' ? this.doorGeoAlongX : this.doorGeoAlongZ, this.doorMat);
    const width = a1 - a0;
    const height = y1 - y0;
    mesh.position.set(axis === 'x' ? width * hinge / 2 : 0, height / 2, axis === 'x' ? 0 : width * hinge / 2);
    mesh.scale.set(axis === 'x' ? width / DOOR_W : 1, height / DOOR_H, axis === 'z' ? width / DOOR_W : 1);
    mesh.castShadow = true;
    // 门板细节(挂在门扇网格下, 破坏隐藏/铰链旋转自动跟随): 竖拼缝 ×2 + 把手
    {
      const trimGeo = axis === 'x' ? this.trimGeoX : this.trimGeoZ;
      const handleGeo = axis === 'x' ? this.handleGeoX : this.handleGeoZ;
      const plateGeo = axis === 'x' ? this.plateGeoX : this.plateGeoZ;
      for (const off of [-DOOR_W / 6, DOOR_W / 6]) {
        const seam = new THREE.Mesh(trimGeo, this.doorTrimMat);
        seam.position.set(axis === 'x' ? off : 0.056, -0.05, axis === 'x' ? 0.056 : off);
        mesh.add(seam);
      }
      // 横档把门板分成上下三块，近距离不再只是一整块平面。
      const railGeo = axis === 'x' ? this.railGeoX : this.railGeoZ;
      for (const offY of [-DOOR_H * 0.27, DOOR_H * 0.22]) {
        const rail = new THREE.Mesh(railGeo, this.doorTrimMat);
        rail.position.set(axis === 'x' ? 0 : 0.056, offY, axis === 'x' ? 0.056 : 0);
        mesh.add(rail);
      }
      // 把手在远离铰链侧(局部坐标铰链在 -DOOR_W/2 侧)
      const hx = (DOOR_W / 2 - 0.18) * hinge;
      const plate = new THREE.Mesh(plateGeo, this.doorTrimMat);
      plate.position.set(axis === 'x' ? hx : 0.056, -0.12, axis === 'x' ? 0.056 : hx);
      mesh.add(plate);
      const knob = new THREE.Mesh(handleGeo, this.knobMat);
      knob.position.set(axis === 'x' ? hx : 0.08, -0.12, axis === 'x' ? 0.08 : hx);
      mesh.add(knob);
    }
    pivot.add(mesh);
    // 铰链柱: 门被炸毁后仍留在原地
    const post = new THREE.Mesh(axis === 'x' ? this.postGeoAlongX : this.postGeoAlongZ, this.postMat);
    post.position.y = height / 2;
    post.scale.y = height / DOOR_H;
    post.castShadow = true;
    group.add(pivot);
    group.add(post);
    const d = new Destructible('door', 80, mesh, c, (c.minX + c.maxX) / 2, midY, (c.minZ + c.maxZ) / 2);
    d.group = group;
    d.pivot = pivot;
    d.doorAxis = axis;
    d.doorHinge = hinge;
    // 开门朝屋内: 沿 X 走向的墙取 -interior, 沿 Z 走向取 +interior
    d.openAngle = (axis === 'x' ? -interior : interior) * hinge * DOOR_SWING;
    c.destruct = d;
    this.destructibles.push(d);
  }

  // 窗 + 窗框嵌条(装饰)
  private addWindow(
    world: World, box: BoxFn, axis: 'x' | 'z', fixed: number,
    a0: number, a1: number, y0: number, y1: number, midA: number, midY: number,
  ): void {
    // 窗框: 上下左右四条细边 + 十字窗格(纯装饰)
    const ft = 0.09;
    if (axis === 'x') {
      box('wall', a0 - 0.03, y0 - 0.03, fixed - ft, a1 + 0.03, y0 + 0.03, fixed + ft, FRAME_C, { collider: false });
      box('wall', a0 - 0.03, y1 - 0.03, fixed - ft, a1 + 0.03, y1 + 0.03, fixed + ft, FRAME_C, { collider: false });
      box('wall', a0 - 0.03, y0, fixed - ft, a0 + 0.03, y1, fixed + ft, FRAME_C, { collider: false });
      box('wall', a1 - 0.03, y0, fixed - ft, a1 + 0.03, y1, fixed + ft, FRAME_C, { collider: false });
      box('wall', midA - 0.025, y0 + 0.04, fixed - ft, midA + 0.025, y1 - 0.04, fixed + ft, FRAME_C, { collider: false, detail: true });
      box('wall', a0 + 0.04, midY - 0.025, fixed - ft, a1 - 0.04, midY + 0.025, fixed + ft, FRAME_C, { collider: false, detail: true });
    } else {
      box('wall', fixed - ft, y0 - 0.03, a0 - 0.03, fixed + ft, y0 + 0.03, a1 + 0.03, FRAME_C, { collider: false });
      box('wall', fixed - ft, y1 - 0.03, a0 - 0.03, fixed + ft, y1 + 0.03, a1 + 0.03, FRAME_C, { collider: false });
      box('wall', fixed - ft, y0, a0 - 0.03, fixed + ft, y1, a0 + 0.03, FRAME_C, { collider: false });
      box('wall', fixed - ft, y0, a1 - 0.03, fixed + ft, y1, a1 + 0.03, FRAME_C, { collider: false });
      box('wall', fixed - ft, y0 + 0.04, midA - 0.025, fixed + ft, y1 - 0.04, midA + 0.025, FRAME_C, { collider: false, detail: true });
      box('wall', fixed - ft, midY - 0.025, a0 + 0.04, fixed + ft, midY + 0.025, a1 - 0.04, FRAME_C, { collider: false, detail: true });
    }
    const t = 0.06;
    // 窗台挑檐 + 部分窗户百叶板(纯装饰, 位置确定性抽样)
    const st = 0.16;
    const withShutters = Math.floor(Math.abs(a0 * 7 + fixed * 3)) % 3 === 0;
    if (axis === 'x') {
      box('wall', a0 - 0.12, y0 - 0.08, fixed - st, a1 + 0.12, y0, fixed + st, TRIM_C, { collider: false });
      if (withShutters) {
        box('wall', a0 - 0.34, y0, fixed - 0.04, a0 - 0.06, y1, fixed + 0.04, SHUTTER_C, { collider: false, detail: true });
        box('wall', a1 + 0.06, y0, fixed - 0.04, a1 + 0.34, y1, fixed + 0.04, SHUTTER_C, { collider: false, detail: true });
        for (const y of [y0 + 0.25, midY, y1 - 0.25]) {
          box('wall', a0 - 0.37, y - 0.025, fixed - 0.075, a0 - 0.03, y + 0.025, fixed + 0.075, FRAME_C, { collider: false, detail: true });
          box('wall', a1 + 0.03, y - 0.025, fixed - 0.075, a1 + 0.37, y + 0.025, fixed + 0.075, FRAME_C, { collider: false, detail: true });
        }
      }
    } else {
      box('wall', fixed - st, y0 - 0.08, a0 - 0.12, fixed + st, y0, a1 + 0.12, TRIM_C, { collider: false });
      if (withShutters) {
        box('wall', fixed - 0.04, y0, a0 - 0.34, fixed + 0.04, y1, a0 - 0.06, SHUTTER_C, { collider: false, detail: true });
        box('wall', fixed - 0.04, y0, a1 + 0.06, fixed + 0.04, y1, a1 + 0.34, SHUTTER_C, { collider: false, detail: true });
        for (const y of [y0 + 0.25, midY, y1 - 0.25]) {
          box('wall', fixed - 0.075, y - 0.025, a0 - 0.37, fixed + 0.075, y + 0.025, a0 - 0.03, FRAME_C, { collider: false, detail: true });
          box('wall', fixed - 0.075, y - 0.025, a1 + 0.03, fixed + 0.075, y + 0.025, a1 + 0.37, FRAME_C, { collider: false, detail: true });
        }
      }
    }
    const c: AabbCollider = axis === 'x'
      ? { kind: 'aabb', minX: a0, minY: y0, minZ: fixed - t / 2, maxX: a1, maxY: y1, maxZ: fixed + t / 2, tag: 'window' }
      : { kind: 'aabb', minX: fixed - t / 2, minY: y0, minZ: a0, maxX: fixed + t / 2, maxY: y1, maxZ: a1, tag: 'window' };
    world.addCollider(c);
    const mesh = new THREE.Mesh(axis === 'x' ? this.paneGeoAlongX : this.paneGeoAlongZ, this.paneMat);
    mesh.position.set(axis === 'x' ? midA : fixed, midY, axis === 'x' ? fixed : midA);
    const d = new Destructible('window', 30, mesh, c, (c.minX + c.maxX) / 2, midY, (c.minZ + c.maxZ) / 2);
    c.destruct = d;
    this.destructibles.push(d);
  }

  // ═══════════════ 原型: 平房/双层(原两种, 加艺术细节) ═══════════════
  private addCottage(world: World, plot: HousePlot, p: Palette, box: BoxFn, two: boolean): void {
    const ix0 = plot.minX + 2, ix1 = plot.maxX - 2, iz0 = plot.minZ + 2, iz1 = plot.maxZ - 2;
    const w = ix1 - ix0, d = iz1 - iz0;
    const f1 = plot.flatH + 0.28;
    const idx = this.plots.indexOf(plot);
    box('floor', ix0, f1 - 0.28, iz0, ix1, f1, iz1, FLOOR_C);
    const wt1 = f1 + WALL_H;

    const doorA0 = ix0 + w / 2 - DOOR_W / 2;
    const northOps: Op[] = [{ a0: doorA0, a1: doorA0 + DOOR_W, y0: f1, y1: f1 + DOOR_H, door: true }];
    const southOps: Op[] = [];
    if (w > 8 && (idx * 13) % 5 === 0) {
      const s0 = ix0 + w * 0.22;
      southOps.push({ a0: s0, a1: s0 + DOOR_W, y0: f1, y1: f1 + DOOR_H, door: true });
    } else {
      const s0 = ix0 + w / 2 - WIN_W / 2;
      southOps.push({ a0: s0, a1: s0 + WIN_W, y0: f1 + WIN_SILL, y1: f1 + WIN_SILL + WIN_H });
    }
    const win = (a0: number): Op => ({ a0, a1: a0 + WIN_W, y0: f1 + WIN_SILL, y1: f1 + WIN_SILL + WIN_H });
    const buried = f1 - 0.9;
    const lowerWallTop = wt1 + STOREY_JOINT_OVERLAP;
    this.wallRun(world, box, 'x', iz0, ix0, ix1, buried, lowerWallTop, northOps, p.wall, WT, 1);
    this.wallRun(world, box, 'x', iz1, ix0, ix1, buried, lowerWallTop, southOps, p.wall, WT, -1);
    // 西墙紧邻楼梯井，多层房取消低窗，避免踏步横穿窗洞。
    this.wallRun(world, box, 'z', ix0, iz0, iz1, buried, lowerWallTop, two ? [] : [win(iz0 + d * 0.3)], p.wall, WT, 1);
    this.wallRun(world, box, 'z', ix1, iz0, iz1, buried, lowerWallTop, [win(iz0 + d * 0.62)], p.wall, WT, -1);
    this.skirt(box, ix0, iz0, ix1, iz1, f1 - 0.28);
    // 转角壁柱(部分房屋, 纯装饰)
    if (idx % 2 === 0) {
      for (const [cx, cz] of [[ix0, iz0], [ix1, iz0], [ix0, iz1], [ix1, iz1]] as const) {
        box('wall', cx - 0.09, buried, cz - 0.09, cx + 0.09, wt1, cz + 0.09, TRIM_C, { collider: false });
      }
    }
    this.entranceStep(world, box, 'x', iz0, doorA0, doorA0 + DOOR_W, f1, -1);
    const southDoor = southOps.find((op) => op.door);
    if (southDoor) this.entranceStep(world, box, 'x', iz1, southDoor.a0, southDoor.a1, f1, 1);
    this.lootSpots.push(
      { x: ix0 + w * 0.25, y: f1, z: iz0 + d * 0.35, premium: false },
      { x: ix1 - w * 0.2, y: f1, z: iz1 - d * 0.25, premium: false },
    );

    if (!two) {
      this.gableRoof(box, ix0, iz0, ix1, iz1, wt1, p.roof, p.wall);
      this.extras(box, p, ix0, iz0, ix1, wt1 + 0.2, w);
      return;
    }

    // ── 双层 ──
    const f2 = wt1 + SLAB_T;
    const rise = (f2 - f1) / STAIR_STEPS;
    const stairX0 = ix0 + 0.14, stairX1 = stairX0 + STAIR_W;
    const holeZ0 = iz0 + STAIR_LANDING - APARTMENT_STAIR_END_MARGIN;
    const holeZ1 = iz1 - STAIR_LANDING + APARTMENT_STAIR_END_MARGIN;
    this.stairs(box, stairX0, stairX1, holeZ1, holeZ0, f1, rise, FLOOR2_C);
    this.stairSlab(box, ix0, ix1, iz0, iz1, ix0, stairX1, holeZ0, holeZ1, wt1, f2, FLOOR2_C);
    this.lootSpots.push(
      { x: ix0 + w * 0.5, y: f2, z: iz0 + d * 0.3, premium: true },
      { x: ix1 - w * 0.22, y: f2, z: iz1 - d * 0.2, premium: true },
    );
    this.stairGuard(box, stairX1, holeZ0, holeZ1, f2);
    const uwt = f2 + WALL_H - 0.15;
    const win2 = (a0: number): Op => ({ a0, a1: a0 + WIN_W, y0: f2 + 0.9, y1: f2 + 0.9 + WIN_H });
    const upperWallBottom = f2 - STOREY_JOINT_OVERLAP;
    this.wallRun(world, box, 'x', iz0, ix0, ix1, upperWallBottom, uwt + STOREY_JOINT_OVERLAP, [win2(ix0 + w * 0.35)], p.wall, WT2, 1);
    this.wallRun(world, box, 'x', iz1, ix0, ix1, upperWallBottom, uwt + STOREY_JOINT_OVERLAP, [win2(ix0 + w * 0.55)], p.wall, WT2, -1);
    this.wallRun(world, box, 'z', ix0, iz0, iz1, upperWallBottom, uwt + STOREY_JOINT_OVERLAP, [win2(iz0 + d * 0.4)], p.wall, WT2, 1);
    this.wallRun(world, box, 'z', ix1, iz0, iz1, upperWallBottom, uwt + STOREY_JOINT_OVERLAP, [win2(iz0 + d * 0.55)], p.wall, WT2, -1);
    this.gableRoof(box, ix0, iz0, ix1, iz1, uwt, p.roof, p.wall);
    this.extras(box, p, ix0, iz0, ix1, uwt + 0.2, w);
  }

  // ═══════════════ 原型: 露台房(二层带露天平台, 狙击点) ═══════════════
  private addTerrace(world: World, plot: HousePlot, p: Palette, box: BoxFn): void {
    const ix0 = plot.minX + 2, ix1 = plot.maxX - 2, iz0 = plot.minZ + 2, iz1 = plot.maxZ - 2;
    const w = ix1 - ix0, d = iz1 - iz0;
    const f1 = plot.flatH + 0.28;
    box('floor', ix0, f1 - 0.28, iz0, ix1, f1, iz1, FLOOR_C);
    const wt1 = f1 + WALL_H;

    const doorA0 = ix0 + w / 2 - DOOR_W / 2;
    const win = (a0: number): Op => ({ a0, a1: a0 + WIN_W, y0: f1 + WIN_SILL, y1: f1 + WIN_SILL + WIN_H });
    const buried = f1 - 0.9;
    const lowerWallTop = wt1 + STOREY_JOINT_OVERLAP;
    this.wallRun(world, box, 'x', iz0, ix0, ix1, buried, lowerWallTop, [{ a0: doorA0, a1: doorA0 + DOOR_W, y0: f1, y1: f1 + DOOR_H, door: true }], p.wall, WT, 1);
    this.wallRun(world, box, 'x', iz1, ix0, ix1, buried, lowerWallTop, [win(ix0 + w * 0.3), win(ix0 + w * 0.62)], p.wall, WT, -1);
    this.wallRun(world, box, 'z', ix0, iz0, iz1, buried, lowerWallTop, [], p.wall, WT, 1);
    this.wallRun(world, box, 'z', ix1, iz0, iz1, buried, lowerWallTop, [win(iz0 + d * 0.55)], p.wall, WT, -1);
    this.skirt(box, ix0, iz0, ix1, iz1, f1 - 0.28);
    this.entranceStep(world, box, 'x', iz0, doorA0, doorA0 + DOOR_W, f1, -1);
    this.lootSpots.push(
      { x: ix0 + w * 0.25, y: f1, z: iz0 + d * 0.35, premium: false },
      { x: ix1 - w * 0.2, y: f1, z: iz1 - d * 0.3, premium: false },
    );

    // 楼梯 1F→2F(西墙), 一层顶板全覆盖 = 露台地面
    const f2 = wt1 + SLAB_T;
    const rise = (f2 - f1) / STAIR_STEPS;
    const stairX0 = ix0 + 0.14, stairX1 = stairX0 + STAIR_W;
    const holeZ0 = iz0 + STAIR_LANDING;
    const holeZ1 = iz1 - STAIR_LANDING;
    this.stairs(box, stairX0, stairX1, holeZ1, holeZ0, f1, rise, FLOOR2_C);
    this.stairSlab(box, ix0, ix1, iz0, iz1, ix0, stairX1, holeZ0, holeZ1, wt1, f2, FLOOR2_C);
    this.stairGuard(box, stairX1, holeZ0, holeZ1, f2);

    // 二层房间占北 55%: 房间南墙(zRoom)开门通向露台
    const zRoom = iz0 + d * 0.55;
    const uwt = f2 + WALL_H - 0.15;
    const win2 = (a0: number): Op => ({ a0, a1: a0 + WIN_W, y0: f2 + 0.9, y1: f2 + 0.9 + WIN_H });
    // 房间北墙(外墙延伸) + 东西墙(北段) + 房间南墙(带门)
    const upperWallBottom = f2 - STOREY_JOINT_OVERLAP;
    this.wallRun(world, box, 'x', iz0, ix0, ix1, upperWallBottom, uwt + STOREY_JOINT_OVERLAP, [win2(ix0 + w * 0.4)], p.wall, WT2, 1);
    const roomDoorA0 = ix0 + w * 0.55;
    this.wallRun(world, box, 'x', zRoom, ix0, ix1, upperWallBottom, uwt + STOREY_JOINT_OVERLAP, [{ a0: roomDoorA0, a1: roomDoorA0 + DOOR_W, y0: f2, y1: f2 + DOOR_H, door: true }], p.wall, WT2, -1);
    this.wallRun(world, box, 'z', ix0, iz0, zRoom, upperWallBottom, uwt + STOREY_JOINT_OVERLAP, [win2(iz0 + d * 0.25)], p.wall, WT2, 1);
    this.wallRun(world, box, 'z', ix1, iz0, zRoom, upperWallBottom, uwt + STOREY_JOINT_OVERLAP, [win2(iz0 + d * 0.3)], p.wall, WT2, -1);
    // 房间顶(小坡屋顶)
    this.gableRoof(box, ix0, iz0, ix1, zRoom + 0.1, uwt, p.roof, p.wall);

    // 露台护栏(南缘 + 东西南段, 矮碰撞)
    this.rail(box, ix0, iz1 - 0.08, ix1, iz1, f2, 0.95);
    this.rail(box, ix0, zRoom, ix0 + 0.08, iz1, f2, 0.95);
    this.rail(box, ix1 - 0.08, zRoom, ix1, iz1, f2, 0.95);
    this.lootSpots.push(
      { x: ix0 + w * 0.5, y: f2, z: iz0 + d * 0.25, premium: true },
      { x: ix0 + w * 0.5, y: f2, z: zRoom + d * 0.2, premium: true }, // 露台狙击位
    );
    this.extras(box, p, ix0, iz0, ix1, uwt + 0.2, w);
  }

  // ═══════════════ 原型: 城区高层楼(交替楼梯, 可抵达屋顶) ═══════════════
  private addApartment(world: World, plot: HousePlot, p: Palette, box: BoxFn): void {
    const ix0 = plot.minX + 2, ix1 = plot.maxX - 2, iz0 = plot.minZ + 2, iz1 = plot.maxZ - 2;
    const w = ix1 - ix0, d = iz1 - iz0;
    const f1 = plot.flatH + 0.28;
    const storeys = buildingStoreys(plot);
    const storeyStep = WALL_H + SLAB_T;
    box('floor', ix0, f1 - 0.28, iz0, ix1, f1, iz1, FLOOR_C);
    const win = (a0: number, fy: number): Op => ({ a0, a1: a0 + WIN_W, y0: fy + WIN_SILL, y1: fy + WIN_SILL + WIN_H });
    const buried = f1 - 0.9;
    // 高层入口使用真正的双扇门。普通住宅的单扇宽度会让打开后的门板横扫
    // 整条入口动线，角色从门框侧面经过时容易被夹住。
    const doorA0 = ix0 + w / 2 - DOOR_W;
    this.skirt(box, ix0, iz0, ix1, iz1, f1 - 0.28);
    this.entranceStep(world, box, 'x', iz0, doorA0, doorA0 + DOOR_W * 2, f1, -1, 1.0);

    const holeZ0 = iz0 + STAIR_LANDING;
    const holeZ1 = iz1 - STAIR_LANDING;
    for (let level = 0; level < storeys; level++) {
      const fy = f1 + level * storeyStep;
      const wallBottom = level === 0 ? buried : fy - STOREY_JOINT_OVERLAP;
      const wallTop = fy + WALL_H + (level < storeys - 1 ? STOREY_JOINT_OVERLAP : 0);
      const wallThickness = level === 0 ? WT : WT2;
      const stairOnWest = level % 2 === 0;
      const frontOpenings: Op[] = level === 0
        ? [
            { a0: doorA0, a1: doorA0 + DOOR_W, y0: fy, y1: fy + DOOR_H, door: true },
            {
              a0: doorA0 + DOOR_W,
              a1: doorA0 + DOOR_W * 2,
              y0: fy,
              y1: fy + DOOR_H,
              door: true,
              hingeEnd: true,
            },
          ]
        : [win(ix0 + w * 0.22, fy), win(ix0 + w * 0.64, fy)];
      this.wallRun(world, box, 'x', iz0, ix0, ix1, wallBottom, wallTop, frontOpenings, p.wall, wallThickness, 1);
      this.wallRun(world, box, 'x', iz1, ix0, ix1, wallBottom, wallTop,
        [win(ix0 + w * 0.2, fy), win(ix0 + w * 0.62, fy)], p.wall, wallThickness, -1);
      this.wallRun(world, box, 'z', ix0, iz0, iz1, wallBottom, wallTop,
        stairOnWest ? [] : [win(iz0 + d * 0.42, fy)], p.wall, wallThickness, 1);
      this.wallRun(world, box, 'z', ix1, iz0, iz1, wallBottom, wallTop,
        stairOnWest ? [win(iz0 + d * 0.42, fy)] : [], p.wall, wallThickness, -1);

      // 每层按功能使用不同隔墙和动线，不侵入两侧交替楼梯井。
      if (level > 0) {
        const splitX0 = ix0 + STAIR_W + STAIR_SIDE_CLEARANCE;
        const splitX1 = ix1 - STAIR_W - STAIR_SIDE_CLEARANCE;
        const roomWidth = splitX1 - splitX0;
        const layout = apartmentFloorLayout(level, storeys);
        const roomMidX = (splitX0 + splitX1) * 0.5;
        const roomMidZ = iz0 + d * 0.56;
        if (roomWidth > DOOR_W + 0.9 && layout === 'residence') {
          const innerDoor = roomMidX - DOOR_W / 2;
          this.wallRun(world, box, 'x', roomMidZ, splitX0, splitX1, fy, fy + WALL_H - 0.22, [
            { a0: innerDoor, a1: innerDoor + DOOR_W, y0: fy, y1: fy + DOOR_H, door: true, doorless: true },
          ], 0xc8c0b3, WT2, -1);
          // 卧室床、床头板和衣柜。
          box('wall', splitX0 + 0.35, fy, iz1 - 2.15, splitX0 + 1.75, fy + 0.46, iz1 - 0.7, 0x756b5a);
          box('wall', splitX0 + 0.38, fy + 0.46, iz1 - 2.1, splitX0 + 1.72, fy + 0.59, iz1 - 0.75,
            0xa79a81, { collider: false, detail: true, surface: 'fabric' });
          box('wall', splitX1 - 0.62, fy, iz1 - 1.8, splitX1 - 0.2, fy + 1.82, iz1 - 0.5, 0x685744);
        } else if (roomWidth > DOOR_W + 0.9 && layout === 'office') {
          const officeDoorZ = roomMidZ - DOOR_W / 2;
          this.wallRun(world, box, 'z', roomMidX, iz0 + 1.25, iz1 - 1.0, fy, fy + WALL_H - 0.22, [
            { a0: officeDoorZ, a1: officeDoorZ + DOOR_W, y0: fy, y1: fy + DOOR_H, door: true, doorless: true },
          ], 0xaaaead, WT2, 1);
          // 两组错位办公桌形成中距离掩体。
          for (const [x, z, turn] of [
            [splitX0 + 1.0, iz0 + d * 0.34, 1],
            [splitX1 - 1.0, iz1 - d * 0.25, -1],
          ] as const) {
            box('wall', x - 0.72, fy + 0.7, z - 0.36, x + 0.72, fy + 0.82, z + 0.36, 0x765d43);
            this.addChair(box, x, z + turn * 0.72, fy, turn);
            box('wall', x - 0.3, fy + 0.82, z - 0.08, x + 0.3, fy + 1.18, z + 0.08,
              0x303a3d, { collider: false, detail: true, surface: 'paintedMetal' });
          }
        } else if (layout === 'lounge') {
          // 开放公共层用矮隔断、沙发和茶几，保留环形走位。
          box('wall', splitX0 + 0.4, fy, roomMidZ - 0.1, roomMidX - 0.65, fy + 1.02, roomMidZ + 0.1, 0xa59a88);
          box('wall', roomMidX + 0.65, fy, roomMidZ - 0.1, splitX1 - 0.4, fy + 1.02, roomMidZ + 0.1, 0xa59a88);
          box('wall', roomMidX - 1.35, fy, iz1 - 1.45, roomMidX + 1.35, fy + 0.72, iz1 - 0.75, 0x586b68);
          box('wall', roomMidX - 0.7, fy + 0.42, iz1 - 2.35, roomMidX + 0.7, fy + 0.58, iz1 - 1.65, 0x806548);
          box('floor', roomMidX - 1.55, fy + 0.02, iz1 - 2.65, roomMidX + 1.55, fy + 0.04, iz1 - 0.55,
            0x6f554d, { collider: false, detail: true, surface: 'fabric' });
        } else if (layout === 'utility') {
          // 顶层设备间使用双门洞和成排柜体，与居住楼层明显区分。
          const gap = 0.7;
          this.wallRun(world, box, 'x', iz0 + d * 0.48, splitX0, splitX1, fy, fy + WALL_H - 0.18, [
            { a0: roomMidX - gap - DOOR_W, a1: roomMidX - gap, y0: fy, y1: fy + DOOR_H, door: true, doorless: true },
            { a0: roomMidX + gap, a1: roomMidX + gap + DOOR_W, y0: fy, y1: fy + DOOR_H, door: true, doorless: true },
          ], 0x8e9694, WT2, -1);
          for (let locker = 0; locker < 3; locker++) {
            const x = splitX0 + 0.35 + locker * Math.max(0.75, (roomWidth - 1.4) / 3);
            box('wall', x, fy, iz1 - 0.85, x + 0.55, fy + 1.72, iz1 - 0.3, 0x5c696a);
            for (let vent = 0; vent < 3; vent++) {
              box('wall', x + 0.1, fy + 0.45 + vent * 0.28, iz1 - 0.87, x + 0.45, fy + 0.5 + vent * 0.28, iz1 - 0.84,
                0x303738, { collider: false, detail: true, surface: 'metal' });
            }
          }
        }
      }

      const premium = level >= storeys - 2;
      this.lootSpots.push(
        { x: ix0 + w * 0.43, y: fy, z: iz0 + d * 0.28, premium },
        { x: ix1 - w * 0.35, y: fy, z: iz1 - d * 0.25, premium },
      );

      // 每层楼梯交替靠西/东墙布置，最后一跑直接抵达可战斗屋顶。
      const nextFloor = fy + storeyStep;
      const rise = storeyStep / STAIR_STEPS;
      if (stairOnWest) {
        const sx0 = ix0 + 0.14, sx1 = sx0 + STAIR_W;
        this.stairs(box, sx0, sx1, holeZ1, holeZ0, fy, rise, FLOOR2_C);
        this.stairSlab(box, ix0, ix1, iz0, iz1, ix0, sx1 + APARTMENT_STAIR_WELL_MARGIN,
          holeZ0, holeZ1, fy + WALL_H, nextFloor, FLOOR2_C);
        this.stairGuard(box, sx1, holeZ0, holeZ1, nextFloor);
      } else {
        const sx1 = ix1 - 0.14, sx0 = sx1 - STAIR_W;
        this.stairs(box, sx0, sx1, holeZ0, holeZ1, fy, rise, FLOOR2_C, 'min');
        this.stairSlab(box, ix0, ix1, iz0, iz1, sx0 - APARTMENT_STAIR_WELL_MARGIN, ix1,
          holeZ0, holeZ1, fy + WALL_H, nextFloor, FLOOR2_C);
        this.stairGuard(box, sx0, holeZ0, holeZ1, nextFloor);
      }

      // 浅阳台和竖向立面构件打破高盒子轮廓，同时保持室内与导航碰撞不变。
      if (level > 0 && level % 2 === 1) {
        const balconyX0 = ix0 + w * 0.28;
        const balconyX1 = ix1 - w * 0.18;
        box('floor', balconyX0, fy + 0.03, iz1, balconyX1, fy + 0.16, iz1 + 0.62,
          0x85837d, { collider: false, detail: true, surface: 'concrete' });
        // 开放式护栏和墙侧托臂取代整块实心板，远看不再像悬浮黑箱。
        for (const railY of [fy + 0.48, fy + 0.9]) {
          box('wall', balconyX0, railY, iz1 + 0.53, balconyX1, railY + 0.08, iz1 + 0.61,
            RAIL_C, { collider: false, detail: true, surface: 'paintedMetal' });
        }
        const balconyPosts = 4;
        for (let post = 0; post <= balconyPosts; post++) {
          const x = balconyX0 + (balconyX1 - balconyX0) * post / balconyPosts;
          box('wall', x - 0.035, fy + 0.14, iz1 + 0.53, x + 0.035, fy + 0.96, iz1 + 0.61,
            RAIL_C, { collider: false, detail: true, surface: 'paintedMetal' });
        }
        for (const x of [balconyX0 + 0.3, balconyX1 - 0.3]) {
          box('wall', x - 0.07, fy - 0.34, iz1 + 0.04, x + 0.07, fy + 0.16, iz1 + 0.18,
            0x66615a, { collider: false, detail: true, surface: 'metal' });
          box('wall', x - 0.07, fy - 0.08, iz1 + 0.12, x + 0.07, fy + 0.1, iz1 + 0.57,
            0x66615a, { collider: false, detail: true, surface: 'metal' });
        }
      }
    }

    const roofY = f1 + storeys * storeyStep;
    const parapet = 0.92;
    box('wall', ix0 - 0.08, roofY, iz0 - 0.08, ix1 + 0.08, roofY + parapet, iz0 + 0.12, p.roof);
    box('wall', ix0 - 0.08, roofY, iz1 - 0.12, ix1 + 0.08, roofY + parapet, iz1 + 0.08, p.roof);
    box('wall', ix0 - 0.08, roofY, iz0, ix0 + 0.12, roofY + parapet, iz1, p.roof);
    box('wall', ix1 - 0.12, roofY, iz0, ix1 + 0.08, roofY + parapet, iz1, p.roof);
    this.lootSpots.push({ x: ix0 + w * 0.52, y: roofY, z: iz1 - 1.25, premium: true });

    if (storeys >= 7) {
      // 7 层塔楼使用居中的设备冠部和错位接收板，避免通信构件形成十字剪影。
      const coreX = (ix0 + ix1) * 0.5;
      box('wall', coreX - 1.25, roofY, iz0 + 0.7, coreX + 1.25, roofY + 1.5, iz0 + 2.55,
        0x777d7c, { detail: true, surface: 'concrete' });
      box('roof', coreX - 1.42, roofY + 1.5, iz0 + 0.55, coreX + 1.42, roofY + 1.68, iz0 + 2.7,
        p.roof, { collider: false, detail: true, surface: 'roof' });
      box('wall', coreX - 0.06, roofY + 1.68, iz0 + 1.55, coreX + 0.06, roofY + 4.25, iz0 + 1.67,
        0x4a5456, { collider: false, detail: true, surface: 'metal' });
      for (const [offsetX, y] of [[-0.46, roofY + 2.35], [0.24, roofY + 3.02]] as const) {
        box('wall', coreX + offsetX, y, iz0 + 1.58, coreX + offsetX + 0.2, y + 0.62, iz0 + 1.64,
          0x4a5456, { collider: false, detail: true, surface: 'metal' });
      }
    } else {
      // 6 层住宅楼采用偏置水箱和屋顶棚架，与通信塔形成不同的阶梯式轮廓。
      const tankX = ix1 - 2.05;
      box('wall', tankX - 0.85, roofY + 0.5, iz0 + 0.7, tankX + 0.85, roofY + 1.48, iz0 + 2.2,
        0x697b7e, { collider: false, detail: true, surface: 'paintedMetal' });
      for (const x of [ix0 + 0.85, ix0 + 3.25]) {
        box('wall', x - 0.08, roofY, iz1 - 2.4, x + 0.08, roofY + 2.0, iz1 - 2.24,
          0x5c6464, { collider: false, detail: true, surface: 'metal' });
      }
      box('roof', ix0 + 0.68, roofY + 1.9, iz1 - 2.55, ix0 + 3.42, roofY + 2.06, iz1 - 0.55,
        p.roof, { collider: false, detail: true, surface: 'roof' });
    }
    this.extras(box, p, ix0, iz0, ix1, roofY + 0.18, w);
  }

  // ═══════════════ 原型: 谷仓(高大单空间, 大门洞) ═══════════════
  private addBarn(world: World, plot: HousePlot, p: Palette, box: BoxFn): void {
    const ix0 = plot.minX + 2, ix1 = plot.maxX - 2, iz0 = plot.minZ + 2, iz1 = plot.maxZ - 2;
    const w = ix1 - ix0, d = iz1 - iz0;
    const f1 = plot.flatH + 0.28;
    const wallTop = f1 + 4.2; // 高墙
    box('floor', ix0, f1 - 0.28, iz0, ix1, f1, iz1, FLOOR_C);
    const buried = f1 - 0.9;
    const openA0 = ix0 + w / 2 - 1.3;
    // 北面 2.6m 大门洞(无门扇), 高窗透气
    this.wallRun(world, box, 'x', iz0, ix0, ix1, buried, wallTop, [
      { a0: openA0, a1: openA0 + 2.6, y0: f1, y1: f1 + 3.2, door: true, doorless: true },
      { a0: ix0 + w * 0.2, a1: ix0 + w * 0.2 + 0.9, y0: f1 + 3.4, y1: f1 + 4.0 },
    ], p.wall, WT, 1);
    this.wallRun(world, box, 'x', iz1, ix0, ix1, buried, wallTop, [{ a0: ix0 + w * 0.45, a1: ix0 + w * 0.45 + 0.9, y0: f1 + 3.4, y1: f1 + 4.0 }], p.wall, WT, -1);
    this.wallRun(world, box, 'z', ix0, iz0, iz1, buried, wallTop, [], p.wall, WT, 1);
    this.wallRun(world, box, 'z', ix1, iz0, iz1, buried, wallTop, [], p.wall, WT, -1);
    this.skirt(box, ix0, iz0, ix1, iz1, f1 - 0.28);
    this.entranceStep(world, box, 'x', iz0, openA0, openA0 + 2.6, f1, -1, 0.9);
    // 内部: 干草垛(可站上)
    box('wall', ix0 + w * 0.6, f1, iz1 - d * 0.35, ix0 + w * 0.9, f1 + 0.55, iz1 - d * 0.1, 0xc2a54e);
    box('wall', ix0 + w * 0.68, f1 + 0.55, iz1 - d * 0.32, ix0 + w * 0.86, f1 + 1.0, iz1 - d * 0.14, 0xc2a54e);
    // 欧式谷仓使用真实双坡瓦顶，替代原先层叠平台式屋盖。
    this.gableRoof(box, ix0, iz0, ix1, iz1, wallTop, p.roof, p.wall);
    this.lootSpots.push(
      { x: ix0 + w * 0.25, y: f1, z: iz0 + d * 0.4, premium: false },
      { x: ix1 - w * 0.25, y: f1, z: iz1 - d * 0.3, premium: false },
    );
    this.extras(box, p, ix0, iz0, ix1, wallTop + 0.48, w);
  }

  // ═══════════════ 原型: 小卖部(单间, 开放门面+雨棚) ═══════════════
  private addShop(world: World, plot: HousePlot, p: Palette, box: BoxFn): void {
    const ix0 = plot.minX + 2, ix1 = plot.maxX - 2, iz0 = plot.minZ + 2, iz1 = plot.maxZ - 2;
    const w = ix1 - ix0, d = iz1 - iz0;
    const f1 = plot.flatH + 0.28;
    box('floor', ix0, f1 - 0.28, iz0, ix1, f1, iz1, FLOOR_C);
    const wt1 = f1 + WALL_H;
    const openA0 = ix0 + w / 2 - 1.2;
    const win = (a0: number): Op => ({ a0, a1: a0 + WIN_W, y0: f1 + WIN_SILL, y1: f1 + WIN_SILL + WIN_H });
    const buried = f1 - 0.9;
    this.wallRun(world, box, 'x', iz0, ix0, ix1, buried, wt1, [
      { a0: openA0, a1: openA0 + 2.4, y0: f1, y1: f1 + 2.4, door: true, doorless: true },
    ], p.wall, WT, 1);
    this.wallRun(world, box, 'x', iz1, ix0, ix1, buried, wt1, [win(ix0 + w / 2 - WIN_W / 2)], p.wall, WT, -1);
    this.wallRun(world, box, 'z', ix0, iz0, iz1, buried, wt1, [win(iz0 + d * 0.45)], p.wall, WT, 1);
    this.wallRun(world, box, 'z', ix1, iz0, iz1, buried, wt1, [], p.wall, WT, -1);
    this.skirt(box, ix0, iz0, ix1, iz1, f1 - 0.28);
    this.entranceStep(world, box, 'x', iz0, openA0, openA0 + 2.4, f1, -1, 0.9);
    // 雨棚 + 柜台
    box('roof', openA0 - 0.5, f1 + 2.5, iz0 - 1.3, openA0 + 2.9, f1 + 2.66, iz0 + 0.1, p.roof, { collider: false });
    box('wall', openA0 - 0.45, f1, iz0 - 1.25, openA0 - 0.3, f1 + 2.5, iz0 - 1.1, TRIM_C);
    box('wall', openA0 + 2.75, f1, iz0 - 1.25, openA0 + 2.9, f1 + 2.5, iz0 - 1.1, TRIM_C);
    box('wall', ix0 + w * 0.2, f1, iz0 + d * 0.42, ix0 + w * 0.8, f1 + 0.95, iz0 + d * 0.52, RAIL_C);
    this.gableRoof(box, ix0, iz0, ix1, iz1, wt1, p.roof, p.wall);
    this.lootSpots.push(
      { x: ix0 + w * 0.5, y: f1, z: iz0 + d * 0.7, premium: false },
      { x: ix1 - w * 0.25, y: f1, z: iz1 - d * 0.25, premium: false },
    );
  }

  // ═══════════════ 原型: 大体育馆(~40×25, 开阔大厅/高窗/看台/高级物资) ═══════════════
  private addGym(world: World, plot: HousePlot, p: Palette, box: BoxFn): void {
    const ix0 = plot.minX + 2, ix1 = plot.maxX - 2, iz0 = plot.minZ + 2, iz1 = plot.maxZ - 2;
    const w = ix1 - ix0, d = iz1 - iz0;
    const f1 = plot.flatH + 0.28;
    const wallTop = f1 + 8.6;
    const GWT = 0.35; // 体育馆墙厚
    box('floor', ix0, f1 - 0.28, iz0, ix1, f1, iz1, 0xa8a294);
    const buried = f1 - 0.9;
    const hiWin = (a0: number): Op => ({ a0, a1: a0 + 1.3, y0: f1 + 5.4, y1: f1 + 6.6 });
    // 北墙: 中央双开门(2×1.2 门扇) + 高窗×3
    const doorA0 = ix0 + w / 2 - DOOR_W;
    this.wallRun(world, box, 'x', iz0, ix0, ix1, buried, wallTop, [
      hiWin(ix0 + w * 0.18),
      { a0: doorA0, a1: doorA0 + DOOR_W, y0: f1, y1: f1 + DOOR_H, door: true },
      { a0: doorA0 + DOOR_W, a1: doorA0 + DOOR_W * 2, y0: f1, y1: f1 + DOOR_H, door: true, hingeEnd: true },
      hiWin(ix0 + w * 0.74),
    ], p.wall, GWT, 1);
    // 南墙: 3m 无门大洞 + 高窗×2
    this.wallRun(world, box, 'x', iz1, ix0, ix1, buried, wallTop, [
      hiWin(ix0 + w * 0.22),
      { a0: ix0 + w / 2 - 1.5, a1: ix0 + w / 2 + 1.5, y0: f1, y1: f1 + 3.4, door: true, doorless: true },
      hiWin(ix0 + w * 0.72),
    ], p.wall, GWT, -1);
    // 东西墙: 各一扇小门 + 高窗×2
    this.wallRun(world, box, 'z', ix0, iz0, iz1, buried, wallTop, [
      hiWin(iz0 + d * 0.25),
      { a0: iz0 + d * 0.5 - DOOR_W / 2, a1: iz0 + d * 0.5 + DOOR_W / 2, y0: f1, y1: f1 + DOOR_H, door: true },
      hiWin(iz0 + d * 0.72),
    ], p.wall, GWT, 1);
    this.wallRun(world, box, 'z', ix1, iz0, iz1, buried, wallTop, [
      hiWin(iz0 + d * 0.28),
      { a0: iz0 + d * 0.55, a1: iz0 + d * 0.55 + DOOR_W, y0: f1, y1: f1 + DOOR_H, door: true },
      hiWin(iz0 + d * 0.75),
    ], p.wall, GWT, -1);
    this.skirt(box, ix0, iz0, ix1, iz1, f1 - 0.28);
    this.entranceStep(world, box, 'x', iz0, doorA0, doorA0 + DOOR_W * 2, f1, -1, 1.0);
    this.entranceStep(world, box, 'x', iz1, ix0 + w / 2 - 1.5, ix0 + w / 2 + 1.5, f1, 1, 1.0);
    this.entranceStep(world, box, 'z', ix0, iz0 + d * 0.5 - DOOR_W / 2, iz0 + d * 0.5 + DOOR_W / 2, f1, -1);
    this.entranceStep(world, box, 'z', ix1, iz0 + d * 0.55, iz0 + d * 0.55 + DOOR_W, f1, 1);

    // 壁柱(外墙装饰, 每 ~4m)
    for (let x = ix0 + 2; x < ix1 - 1; x += 4.2) {
      box('wall', x - 0.17, buried, iz0 - GWT / 2 - 0.1, x + 0.17, wallTop, iz0 - GWT / 2 + 0.06, TRIM_C, { collider: false });
      box('wall', x - 0.17, buried, iz1 - GWT / 2 + 0.06, x + 0.17, wallTop, iz1 + GWT / 2 + 0.1, TRIM_C, { collider: false });
    }
    for (let z = iz0 + 2; z < iz1 - 1; z += 4.2) {
      box('wall', ix0 - GWT / 2 - 0.1, buried, z - 0.17, ix0 - GWT / 2 + 0.06, wallTop, z + 0.17, TRIM_C, { collider: false });
      box('wall', ix1 - GWT / 2 + 0.06, buried, z - 0.17, ix1 + GWT / 2 + 0.1, wallTop, z + 0.17, TRIM_C, { collider: false });
    }

    // 入口雨棚(北门) + 双柱
    box('roof', doorA0 - 0.8, f1 + 3.3, iz0 - 2.3, doorA0 + DOOR_W * 2 + 0.8, f1 + 3.48, iz0 + 0.1, p.roof);
    box('wall', doorA0 - 0.65, f1, iz0 - 2.15, doorA0 - 0.5, f1 + 3.3, iz0 - 2.0, TRIM_C);
    box('wall', doorA0 + DOOR_W * 2 + 0.5, f1, iz0 - 2.15, doorA0 + DOOR_W * 2 + 0.65, f1 + 3.3, iz0 - 2.0, TRIM_C);

    // 屋顶: 边缘板 + 中央抬升脊(长向 60% × 深向 60%)
    box('roof', ix0 - 0.3, wallTop, iz0 - 0.3, ix1 + 0.3, wallTop + 0.28, iz1 + 0.3, p.roof);
    box('roof', ix0 + w * 0.2, wallTop + 0.28, iz0 + d * 0.2, ix1 - w * 0.2, wallTop + 1.55, iz1 - d * 0.2, p.roof);
    // 侧墙与抬升段之间的竖带(遮缝)
    box('wall', ix0 + w * 0.2, wallTop + 0.28, iz0 + d * 0.2, ix1 - w * 0.2, wallTop + 1.55, iz0 + d * 0.24, p.roof);
    box('wall', ix0 + w * 0.2, wallTop + 0.28, iz1 - d * 0.24, ix1 - w * 0.2, wallTop + 1.55, iz1 - d * 0.2, p.roof);

    // 看台(南侧三级平台, 可行走)
    const blX0 = ix0 + w * 0.55, blX1 = ix0 + w * 0.92;
    box('floor', blX0, f1, iz1 - 1.3, blX1, f1 + 0.45, iz1 - 0.2, 0x8f8a80, { collider: false, platform: true });
    box('floor', blX0, f1, iz1 - 2.4, blX1, f1 + 0.9, iz1 - 1.3, 0x8f8a80, { collider: false, platform: true });
    box('floor', blX0, f1, iz1 - 3.5, blX1, f1 + 1.35, iz1 - 2.4, 0x8f8a80, { collider: false, platform: true });

    // 散装箱体(场内掩体) + 箱体箍带
    const rng = mulberry32(777);
    for (let i = 0; i < 8; i++) {
      const s = 0.8 + rng() * 0.5;
      const cx = ix0 + 3 + rng() * (w - 6);
      const cz = iz0 + 3 + rng() * (d * 0.55);
      box('wall', cx, f1, cz, cx + s, f1 + s, cz + s, CRATE_C);
      box('wall', cx - 0.02, f1 + s - 0.07, cz + s * 0.3, cx + s + 0.02, f1 + s + 0.02, cz + s * 0.7, 0x6a5a42, { collider: false });
    }
    // 大厅顶部横梁(沿短向, 5 根)
    for (let i = 0; i < 5; i++) {
      const bx = ix0 + w * (0.14 + i * 0.18);
      box('wall', bx - 0.18, wallTop - 0.7, iz0 + 0.3, bx + 0.18, wallTop - 0.3, iz1 - 0.3, 0x5a4a38, { collider: false });
    }
    // 墙面色幅(南北墙点缀) + 入口门牌
    const BANNERS = [0xa03a30, 0x3a6ea5, 0xc2a54e];
    for (let i = 0; i < 3; i++) {
      const bx = ix0 + w * (0.25 + i * 0.25);
      const c = BANNERS[i] as number;
      box('wall', bx - 0.8, f1 + 3.2, iz0 + GWT / 2, bx + 0.8, f1 + 6.2, iz0 + GWT / 2 + 0.06, c, { collider: false });
      box('wall', bx - 0.8, f1 + 3.2, iz1 - GWT / 2 - 0.06, bx + 0.8, f1 + 6.2, iz1 - GWT / 2, c, { collider: false });
    }
    // 入口门牌(北门雨棚上方)
    box('wall', doorA0 - 0.6, f1 + 3.7, iz0 - 0.3, doorA0 + DOOR_W * 2 + 0.6, f1 + 4.4, iz0 + GWT / 2, 0xd8cba8, { collider: false });
    box('wall', doorA0 - 0.45, f1 + 3.85, iz0 - 0.34, doorA0 + DOOR_W * 2 + 0.45, f1 + 4.25, iz0 + GWT / 2 + 0.04, 0x8a4a3a, { collider: false });

    // loot: 大厅 4 普通 + 看台/中区 4 高级
    this.lootSpots.push(
      { x: ix0 + w * 0.15, y: f1, z: iz0 + d * 0.2, premium: false },
      { x: ix0 + w * 0.45, y: f1, z: iz0 + d * 0.3, premium: false },
      { x: ix1 - w * 0.15, y: f1, z: iz0 + d * 0.5, premium: false },
      { x: ix0 + w * 0.3, y: f1, z: iz1 - d * 0.15, premium: false },
      { x: ix0 + w * 0.6, y: f1, z: iz0 + d * 0.35, premium: true },
      { x: ix1 - w * 0.2, y: f1, z: iz0 + d * 0.25, premium: true },
      { x: ix0 + w * 0.75, y: f1 + 1.35, z: iz1 - 2.9, premium: true }, // 看台顶
      { x: ix0 + w * 0.5, y: f1, z: iz0 + d * 0.55, premium: true },
    );
  }

  // 开/关门(游戏层包装发声); 关门只在门完好时允许
  setDoorOpen(d: Destructible, open: boolean, actorX?: number, actorZ?: number): boolean {
    if (d.kind !== 'door' || !d.alive || d.open === open) return false;
    if (open && d.doorAxis && Number.isFinite(actorX) && Number.isFinite(actorZ)) {
      d.openAngle = doorOpenAngleForActor(
        d.doorAxis, d.cx, d.cz, actorX as number, actorZ as number, d.openAngle, d.doorHinge,
      );
    }
    d.open = open;
    // 开门立即放行；关门则等门扇接近门框后才恢复碰撞，避免动画期间出现空气墙。
    d.collider.off = doorColliderDisabled(d.alive, open, d.pivot?.rotation.y ?? 0);
    return true;
  }

  // 已离开门框的旋转门扇仍保持实体碰撞, 防止角色和机器人穿过门板模型.
  resolveDoorCollisions(point: THREE.Vector3, radius: number): boolean {
    let hit = false;
    for (const door of this.destructibles) {
      if (
        door.kind !== 'door' || !door.alive || !door.pivot || !door.doorAxis ||
        !door.collider.off ||
        point.y >= door.collider.maxY - 0.02 || point.y + 1.7 <= door.collider.minY
      ) continue;
      const leaf = doorLeafSegment(
        door.collider,
        door.doorAxis,
        door.doorHinge,
        door.pivot.rotation.y,
      );
      if (resolveCircleAgainstDoorLeaf(point, radius, leaf)) hit = true;
    }
    return hit;
  }

  // 门扇开关动画: ~0.3s 内旋到目标角
  update(dt: number): void {
    const speed = DOOR_SWING / DOOR_TWEEN;
    for (const d of this.destructibles) {
      if (d.kind !== 'door' || !d.pivot) continue;
      const target = d.open && d.alive ? d.openAngle : 0;
      const cur = d.pivot.rotation.y;
      if (cur === target) continue;
      const delta = target - cur;
      const step = Math.min(speed * dt, Math.abs(delta));
      d.pivot.rotation.y = cur + Math.sign(delta) * step;
      d.collider.off = doorColliderDisabled(d.alive, d.open, d.pivot.rotation.y);
    }
  }
}
