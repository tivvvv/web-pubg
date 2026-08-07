// ─────────────────────────────────────────────────────────────────────────────
// weaponmodels.ts - 程序化低多边形武器模型(three.js 基本体拼装, 共享几何/材质)
// 约定: 原点 = 握把顶端(右手持握点), 枪管朝 +Z, 上为 +Y; 步枪全长约 0.9m
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { GunAttachments, MeleeId, ThrowableId, WeaponId } from './types';
import { applySurfaceAsset } from './assets';

export type WeaponModelId = WeaponId | Exclude<MeleeId, 'fists'> | ThrowableId;

export interface WeaponModel {
  group: THREE.Group;
  muzzle: THREE.Object3D; // 枪口尖端(曳光/火光起点)
  mag: THREE.Object3D | null; // 弹匣部件(换弹动画隐藏/重现)
}

// 枪口火光缩放(狙击更大, 手枪更小, 霰弹最大)
export const MUZZLE_SCALE: Record<WeaponId, number> = {
  pistol: 0.65, smg: 0.85, rifle: 1.0, akm: 1.12, lmg: 1.24, dmr: 1.18, sniper: 1.5, shotgun: 1.35,
};

// 枪械相对角色统一放大，近景轮廓和持枪比例更接近真实尺寸；近战与投掷物保持原尺寸。
export const FIREARM_MODEL_SCALE = 1.12;
const FIREARM_MODEL_IDS: ReadonlySet<string> = new Set([
  'pistol', 'smg', 'rifle', 'akm', 'lmg', 'dmr', 'sniper', 'shotgun',
]);

// 共享几何: 圆角盒替代锋利方块, 枪管和球面提高分段数但仍由所有原型共享。
const BOX = new RoundedBoxGeometry(1, 1, 1, 2, 0.055);
const CYL = new THREE.CylinderGeometry(1, 1, 1, 16, 2);
const SPH = new THREE.SphereGeometry(1, 16, 12);
const MUZZLE_RING = new THREE.TorusGeometry(1, 0.16, 8, 20);
const TRIGGER_GUARD = new THREE.TorusGeometry(1, 0.12, 7, 18, Math.PI);

// 共享材质: 深金属 / 亮金属 / 聚合物 / 木色家具
const MAT_DK = new THREE.MeshStandardMaterial({
  color: 0x343b43, emissive: 0x10151a, emissiveIntensity: 0.22, roughness: 0.34, metalness: 0.72,
}); // 深金属(机匣/枪管)
const MAT_LT = new THREE.MeshStandardMaterial({ color: 0xaeb8c2, roughness: 0.26, metalness: 0.86 }); // 亮金属(刃口/导轨/枪口)
const MAT_PO = new THREE.MeshStandardMaterial({ color: 0x464d55, roughness: 0.8, metalness: 0.04 }); // 聚合物(护木/枪托/握把)
const MAT_TN = new THREE.MeshStandardMaterial({ color: 0x9a7a52, roughness: 0.82, metalness: 0.02 }); // 木色/沙色家具
const MAT_BLACK = new THREE.MeshStandardMaterial({ color: 0x090b0d, roughness: 0.58, metalness: 0.62 });
const MAT_RUBBER = new THREE.MeshStandardMaterial({ color: 0x171a1d, roughness: 0.94, metalness: 0.01 });
const MAT_WOOD_DARK = new THREE.MeshStandardMaterial({ color: 0x63452f, roughness: 0.9, metalness: 0.01 });
const MAT_BRASS = new THREE.MeshStandardMaterial({ color: 0xc59a45, roughness: 0.34, metalness: 0.72 });
const MAT_FG = new THREE.MeshStandardMaterial({ color: 0x39543a, roughness: 0.68, metalness: 0.18 }); // 手雷墨绿
const MAT_BD = new THREE.MeshStandardMaterial({ color: 0xc8503c, roughness: 0.62, metalness: 0.12 }); // 烟雾弹色带
const MAT_LENS = new THREE.MeshStandardMaterial({
  color: 0x77b9c8,
  emissive: 0x153943,
  emissiveIntensity: 0.24,
  roughness: 0.08,
  metalness: 0.12,
  transparent: true,
  opacity: 0.72,
});
const MAT_RETICLE = new THREE.MeshBasicMaterial({ color: 0xff4d35 });
applySurfaceAsset(MAT_DK, 'metal', 5.5, 1);
applySurfaceAsset(MAT_LT, 'metal', 7.5, 0.85);
applySurfaceAsset(MAT_PO, 'fabric', 4, 0.5);
applySurfaceAsset(MAT_TN, 'wood', 4.8, 0.85);
applySurfaceAsset(MAT_WOOD_DARK, 'wood', 5.4, 0.92);
applySurfaceAsset(MAT_RUBBER, 'fabric', 5.2, 0.34);
applySurfaceAsset(MAT_FG, 'metal', 5, 0.45);
applySurfaceAsset(MAT_BD, 'metal', 5, 0.45);

function b(
  parent: THREE.Group, mat: THREE.Material,
  sx: number, sy: number, sz: number,
  x: number, y: number, z: number,
  rx = 0, ry = 0, rz = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(BOX, mat);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = true;
  parent.add(m);
  return m;
}

// 沿 Z 轴的圆柱(枪管/瞄准镜管)
function cz(parent: THREE.Group, mat: THREE.Material, r: number, len: number, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(CYL, mat);
  m.scale.set(r, len, r);
  m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
  return m;
}

// 沿 X 轴的圆柱(栓柄)
function cx(parent: THREE.Group, mat: THREE.Material, r: number, len: number, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(CYL, mat);
  m.scale.set(r, len, r);
  m.rotation.z = Math.PI / 2;
  m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
  return m;
}

type DetailTransform = readonly [
  sx: number, sy: number, sz: number,
  x: number, y: number, z: number,
  rx?: number, ry?: number, rz?: number,
];

// 重复小零件使用单个 InstancedMesh, 在提高局部密度的同时避免显著增加 draw call。
function detailInstances(
  parent: THREE.Group,
  geometry: THREE.BufferGeometry,
  mat: THREE.Material,
  transforms: readonly DetailTransform[],
  name: string,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, mat, transforms.length);
  mesh.name = name;
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  transforms.forEach(([sx, sy, sz, x, y, z, rx = 0, ry = 0, rz = 0], index) => {
    position.set(x, y, z);
    rotation.setFromEuler(new THREE.Euler(rx, ry, rz));
    scale.set(sx, sy, sz);
    matrix.compose(position, rotation, scale);
    mesh.setMatrixAt(index, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  mesh.computeBoundingSphere();
  parent.add(mesh);
  return mesh;
}

function railTeeth(parent: THREE.Group, y: number, zStart: number, count: number, spacing: number, width: number): void {
  detailInstances(
    parent,
    BOX,
    MAT_LT,
    Array.from({ length: count }, (_, index) => (
      [width, 0.007, 0.012, 0, y, zStart + index * spacing] as DetailTransform
    )),
    'rail-teeth',
  );
}

function sideVents(parent: THREE.Group, x: number, y: number, zStart: number, count: number, spacing: number): void {
  detailInstances(
    parent,
    BOX,
    MAT_BLACK,
    Array.from({ length: count * 2 }, (_, index) => {
      const side = index % 2 === 0 ? -1 : 1;
      const row = Math.floor(index / 2);
      return [0.005, 0.018, 0.035, x * side, y, zStart + row * spacing] as DetailTransform;
    }),
    'handguard-vents',
  );
}

function receiverPins(parent: THREE.Group, x: number, y: number, positions: readonly number[]): void {
  detailInstances(
    parent,
    CYL,
    MAT_LT,
    positions.flatMap((z) => ([
      [0.006, 0.008, 0.006, x, y, z, 0, 0, Math.PI / 2] as DetailTransform,
      [0.006, 0.008, 0.006, -x, y, z, 0, 0, Math.PI / 2] as DetailTransform,
    ])),
    'receiver-pins',
  );
}

function triggerGuard(parent: THREE.Group, y: number, z: number, scale = 0.035): void {
  const guard = new THREE.Mesh(TRIGGER_GUARD, MAT_DK);
  guard.name = 'trigger-guard';
  guard.scale.set(scale, scale, scale);
  guard.rotation.y = Math.PI / 2;
  guard.rotation.z = Math.PI;
  guard.position.set(0, y, z);
  guard.castShadow = true;
  parent.add(guard);
}

// 双侧机匣铭牌、加工刻线和选择器点，近景形成高光断面，远景仍只占一个 draw call。
function receiverMarkings(
  parent: THREE.Group,
  halfWidth: number,
  y: number,
  z: number,
  length = 0.075,
): void {
  const marks: DetailTransform[] = [];
  for (const side of [-1, 1]) {
    marks.push([0.003, 0.004, length, halfWidth * side, y, z]);
    marks.push([0.003, 0.004, length * 0.58, halfWidth * side, y - 0.012, z + 0.008]);
    marks.push([0.003, 0.004, length * 0.32, halfWidth * side, y - 0.024, z + 0.016]);
  }
  detailInstances(parent, BOX, MAT_LT, marks, 'receiver-markings');
  for (const side of [-1, 1]) {
    const selector = new THREE.Mesh(SPH, MAT_BRASS);
    selector.name = 'selector-indicator';
    selector.scale.set(0.006, 0.006, 0.006);
    selector.position.set(halfWidth * side, y - 0.034, z - length * 0.15);
    selector.castShadow = true;
    parent.add(selector);
  }
}

function muzzleFinish(parent: THREE.Group, x: number, y: number, z: number, radius: number): void {
  const ring = new THREE.Mesh(MUZZLE_RING, MAT_LT);
  ring.name = 'muzzle-crown';
  ring.scale.setScalar(radius);
  ring.position.set(x, y, z - 0.001);
  ring.castShadow = true;
  parent.add(ring);
  const bore = cz(parent, MAT_BLACK, radius * 0.66, 0.008, x, y, z + 0.002);
  bore.name = 'muzzle-bore';
}

function markFirearmQuality(group: THREE.Group, id: WeaponId): void {
  group.name = `weapon-${id}`;
  group.userData.weaponId = id;
  group.userData.assetQuality = 'firearm-v4';
}

function muzzleAt(g: THREE.Group, x: number, y: number, z: number): THREE.Object3D {
  const o = new THREE.Object3D();
  o.name = 'muzzle';
  o.position.set(x, y, z);
  g.add(o);
  return o;
}

// ── M416 突击步枪 (~0.9m): 机匣/导轨护木/枪管+制退器/弯弹匣/伸缩托/前后瞄 ──
function buildRifle(): WeaponModel {
  const g = new THREE.Group();
  b(g, MAT_DK, 0.055, 0.075, 0.3, 0, 0.02, 0.1);            // 机匣
  b(g, MAT_DK, 0.05, 0.015, 0.3, 0, 0.065, 0.1);            // 上机匣
  b(g, MAT_LT, 0.052, 0.006, 0.035, 0, 0.075, 0.02);        // 导轨 ×3
  b(g, MAT_LT, 0.052, 0.006, 0.035, 0, 0.075, 0.1);
  b(g, MAT_LT, 0.052, 0.006, 0.035, 0, 0.075, 0.18);
  b(g, MAT_PO, 0.05, 0.06, 0.22, 0, 0.02, 0.36);            // 护木
  b(g, MAT_LT, 0.052, 0.005, 0.04, 0, 0.052, 0.3);          // 护木导轨 ×2
  b(g, MAT_LT, 0.052, 0.005, 0.04, 0, 0.052, 0.42);
  cz(g, MAT_DK, 0.011, 0.2, 0, 0.025, 0.55);                // 枪管
  cz(g, MAT_LT, 0.017, 0.06, 0, 0.025, 0.665);              // 制退器
  b(g, MAT_DK, 0.019, 0.014, 0.004, 0.012, 0.025, 0.671);   // 制退器散热孔 ×2
  b(g, MAT_DK, 0.019, 0.014, 0.004, -0.012, 0.025, 0.655);
  b(g, MAT_PO, 0.024, 0.06, 0.03, 0, -0.02, 0.34);          // 前握把
  const mag = b(g, MAT_TN, 0.032, 0.1, 0.055, 0, -0.075, 0.065, 0.25); // 弯弹匣上段
  mag.name = 'mag';
  b(g, MAT_TN, 0.03, 0.08, 0.05, 0, -0.145, 0.042, 0.45);   // 弯弹匣下段
  b(g, MAT_DK, 0.03, 0.03, 0.14, 0, 0.035, -0.14);          // 托芯
  b(g, MAT_PO, 0.042, 0.085, 0.05, 0, 0.01, -0.235);        // 伸缩枪托
  b(g, MAT_DK, 0.045, 0.09, 0.012, 0, 0.008, -0.263);       // 托底板
  b(g, MAT_PO, 0.032, 0.085, 0.045, 0, -0.055, -0.015, 0.3); // 握把
  b(g, MAT_LT, 0.008, 0.03, 0.008, 0, 0.072, 0.46);         // 前准星
  b(g, MAT_DK, 0.03, 0.02, 0.02, 0, 0.077, -0.04);          // 后照门
  // ---- 小零件: 拉机柄/抛壳窗/弹匣释放/扳机+护圈/快慢机 ----
  b(g, MAT_LT, 0.014, 0.012, 0.05, 0, 0.078, -0.07);        // 拉机柄
  b(g, MAT_LT, 0.004, 0.022, 0.07, 0.0285, 0.03, 0.1);      // 抛壳窗
  b(g, MAT_LT, 0.006, 0.014, 0.02, 0.0285, -0.028, 0.045);  // 弹匣释放钮
  b(g, MAT_DK, 0.006, 0.026, 0.008, 0, -0.045, 0.028);      // 扳机
  b(g, MAT_DK, 0.008, 0.006, 0.07, 0, -0.062, 0.02);        // 扳机护圈底
  b(g, MAT_LT, 0.004, 0.02, 0.012, -0.0285, 0.005, -0.02);  // 快慢机拨杆
  railTeeth(g, 0.084, -0.09, 13, 0.043, 0.057);
  sideVents(g, 0.052, 0.018, 0.29, 5, 0.045);
  receiverPins(g, 0.031, 0.018, [-0.045, 0.055, 0.16]);
  receiverMarkings(g, 0.056, 0.042, 0.115, 0.082);
  triggerGuard(g, -0.042, 0.025, 0.032);
  detailInstances(g, BOX, MAT_RUBBER, [
    [0.012, 0.018, 0.12, -0.03, 0.045, -0.17, 0, 0.18, 0],
    [0.012, 0.018, 0.12, 0.03, 0.045, -0.17, 0, -0.18, 0],
    [0.048, 0.096, 0.008, 0, 0.008, -0.272],
  ], 'stock-detail');
  muzzleFinish(g, 0, 0.025, 0.7, 0.017);
  markFirearmQuality(g, 'rifle');
  return { group: g, muzzle: muzzleAt(g, 0, 0.025, 0.7), mag };
}

// ── M249 轻机枪: 长重枪管、箱式弹盒、提把和展开两脚架 ──
function buildLmg(): WeaponModel {
  const g = new THREE.Group();
  b(g, MAT_DK, 0.065, 0.09, 0.32, 0, 0.025, 0.08);
  b(g, MAT_LT, 0.058, 0.012, 0.3, 0, 0.083, 0.08);
  b(g, MAT_PO, 0.065, 0.07, 0.3, 0, 0.01, 0.38);
  b(g, MAT_DK, 0.01, 0.022, 0.22, -0.052, 0.02, 0.37);
  b(g, MAT_DK, 0.01, 0.022, 0.22, 0.052, 0.02, 0.37);
  cz(g, MAT_DK, 0.014, 0.34, 0, 0.032, 0.7);
  cz(g, MAT_LT, 0.022, 0.065, 0, 0.032, 0.9);
  const mag = b(g, MAT_FG, 0.095, 0.12, 0.12, 0, -0.105, 0.12);
  mag.name = 'mag';
  b(g, MAT_DK, 0.1, 0.014, 0.125, 0, -0.035, 0.12);
  b(g, MAT_PO, 0.052, 0.09, 0.3, 0, 0.015, -0.23);
  b(g, MAT_DK, 0.056, 0.105, 0.022, 0, 0.005, -0.395);
  b(g, MAT_PO, 0.035, 0.09, 0.05, 0, -0.055, -0.03, 0.28);
  // 提把和两脚架让地面轮廓易于识别。
  b(g, MAT_LT, 0.01, 0.065, 0.15, 0, 0.145, 0.2, -0.25);
  b(g, MAT_DK, 0.012, 0.012, 0.19, -0.055, -0.055, 0.57, 0.42);
  b(g, MAT_DK, 0.012, 0.012, 0.19, 0.055, -0.055, 0.57, 0.42);
  b(g, MAT_LT, 0.009, 0.035, 0.009, 0, 0.095, 0.63);
  railTeeth(g, 0.102, -0.06, 15, 0.046, 0.064);
  sideVents(g, 0.066, 0.025, 0.26, 7, 0.052);
  receiverPins(g, 0.039, 0.025, [-0.04, 0.07, 0.18]);
  receiverMarkings(g, 0.066, 0.045, 0.1, 0.09);
  triggerGuard(g, -0.048, -0.015, 0.036);
  detailInstances(g, CYL, MAT_BRASS, Array.from({ length: 8 }, (_, index) => (
    [0.008, 0.026, 0.008, 0.074, -0.032 - index * 0.009, 0.035 + index * 0.018, 0, 0, Math.PI / 2] as DetailTransform
  )), 'ammo-belt');
  detailInstances(g, BOX, MAT_RUBBER, [
    [0.062, 0.112, 0.01, 0, 0.005, -0.408],
    [0.03, 0.012, 0.045, -0.055, -0.07, 0.68, 0.35],
    [0.03, 0.012, 0.045, 0.055, -0.07, 0.68, 0.35],
  ], 'lmg-rubber-parts');
  muzzleFinish(g, 0, 0.032, 0.94, 0.022);
  markFirearmQuality(g, 'lmg');
  return { group: g, muzzle: muzzleAt(g, 0, 0.032, 0.94), mag };
}

// ── AKM: 木质护木与枪托、弯曲弹匣，轮廓和 M416 明显区分 ──
function buildAkm(): WeaponModel {
  const g = new THREE.Group();
  b(g, MAT_DK, 0.058, 0.075, 0.3, 0, 0.02, 0.08);
  b(g, MAT_LT, 0.052, 0.018, 0.23, 0, 0.072, 0.09);
  b(g, MAT_TN, 0.057, 0.065, 0.25, 0, 0.015, 0.37);
  cz(g, MAT_DK, 0.012, 0.24, 0, 0.03, 0.61);
  cz(g, MAT_LT, 0.018, 0.065, 0, 0.03, 0.76);
  const mag = b(g, MAT_DK, 0.036, 0.12, 0.06, 0, -0.09, 0.08, 0.34);
  mag.name = 'mag';
  b(g, MAT_DK, 0.033, 0.08, 0.052, 0, -0.17, 0.035, 0.56);
  b(g, MAT_TN, 0.048, 0.075, 0.27, 0, 0.015, -0.22, -0.08);
  b(g, MAT_TN, 0.05, 0.09, 0.04, 0, 0.005, -0.38);
  b(g, MAT_TN, 0.034, 0.09, 0.045, 0, -0.055, -0.02, 0.3);
  b(g, MAT_LT, 0.008, 0.035, 0.008, 0, 0.085, 0.54);
  b(g, MAT_DK, 0.028, 0.02, 0.018, 0, 0.083, -0.02);
  b(g, MAT_WOOD_DARK, 0.059, 0.025, 0.22, 0, 0.065, 0.34); // 上护木
  cz(g, MAT_DK, 0.014, 0.29, 0, 0.082, 0.42);              // 导气管
  sideVents(g, 0.059, 0.025, 0.29, 4, 0.055);
  receiverPins(g, 0.034, 0.022, [-0.04, 0.07, 0.17]);
  receiverMarkings(g, 0.059, 0.04, 0.08, 0.08);
  triggerGuard(g, -0.045, 0.005, 0.034);
  detailInstances(g, BOX, MAT_WOOD_DARK, [
    [0.051, 0.018, 0.16, 0, 0.052, -0.24, 0.08],
    [0.054, 0.098, 0.012, 0, 0.005, -0.402],
  ], 'akm-stock-detail');
  b(g, MAT_LT, 0.006, 0.045, 0.085, 0.034, 0.042, 0.105, 0, 0, -0.18); // 拉机柄
  muzzleFinish(g, 0, 0.03, 0.8, 0.018);
  markFirearmQuality(g, 'akm');
  return { group: g, muzzle: muzzleAt(g, 0, 0.03, 0.8), mag };
}

// ── Mini14: 细长枪管、木质枪身和短直弹匣 ──
function buildDmr(): WeaponModel {
  const g = new THREE.Group();
  b(g, MAT_DK, 0.048, 0.068, 0.28, 0, 0.025, 0.08);
  b(g, MAT_TN, 0.05, 0.055, 0.34, 0, 0.005, 0.19);
  cz(g, MAT_DK, 0.009, 0.42, 0, 0.038, 0.53);
  cz(g, MAT_LT, 0.013, 0.04, 0, 0.038, 0.75);
  const mag = b(g, MAT_DK, 0.028, 0.075, 0.045, 0, -0.065, 0.04);
  mag.name = 'mag';
  b(g, MAT_TN, 0.045, 0.07, 0.3, 0, 0.02, -0.22);
  b(g, MAT_DK, 0.047, 0.085, 0.018, 0, 0.01, -0.39);
  b(g, MAT_DK, 0.026, 0.017, 0.018, 0, 0.09, -0.02);
  b(g, MAT_LT, 0.007, 0.03, 0.007, 0, 0.088, 0.6);
  railTeeth(g, 0.092, -0.08, 10, 0.048, 0.049);
  receiverPins(g, 0.029, 0.02, [-0.045, 0.055, 0.15]);
  receiverMarkings(g, 0.049, 0.04, 0.075, 0.072);
  triggerGuard(g, -0.044, -0.005, 0.032);
  detailInstances(g, BOX, MAT_WOOD_DARK, [
    [0.047, 0.018, 0.19, 0, 0.052, 0.2],
    [0.048, 0.024, 0.18, 0, 0.065, -0.22],
    [0.052, 0.09, 0.009, 0, 0.01, -0.402],
  ], 'dmr-furniture-detail');
  b(g, MAT_LT, 0.004, 0.022, 0.08, 0.026, 0.035, 0.08); // 抛壳窗
  muzzleFinish(g, 0, 0.038, 0.78, 0.013);
  markFirearmQuality(g, 'dmr');
  return { group: g, muzzle: muzzleAt(g, 0, 0.038, 0.78), mag };
}

// ── UMP 冲锋枪 (~0.62m): 方机匣/短枪管/直弹匣/侧折叠托, 明显短于步枪 ──
function buildSmg(): WeaponModel {
  const g = new THREE.Group();
  b(g, MAT_DK, 0.055, 0.095, 0.26, 0, 0.02, 0.06);          // 方机匣
  b(g, MAT_DK, 0.045, 0.012, 0.24, 0, 0.075, 0.05);         // 顶导轨
  cz(g, MAT_DK, 0.012, 0.1, 0, 0.03, 0.225);                // 短枪管
  cz(g, MAT_LT, 0.016, 0.03, 0, 0.03, 0.28);                // 枪口帽
  const mag = b(g, MAT_PO, 0.028, 0.15, 0.042, 0, -0.1, 0.04); // 直弹匣
  mag.name = 'mag';
  b(g, MAT_LT, 0.012, 0.015, 0.16, 0.032, 0.05, -0.1);      // 折叠托上杆
  b(g, MAT_LT, 0.012, 0.015, 0.16, 0.032, 0.02, -0.1);      // 折叠托下杆
  b(g, MAT_PO, 0.02, 0.06, 0.03, 0.032, 0.035, -0.19);      // 托垫
  b(g, MAT_PO, 0.032, 0.08, 0.045, 0, -0.05, -0.03, 0.25);  // 握把
  b(g, MAT_LT, 0.008, 0.02, 0.008, 0, 0.086, 0.16);         // 前瞄
  b(g, MAT_DK, 0.025, 0.015, 0.015, 0, 0.086, -0.05);       // 后瞄
  // ---- 小零件: 拉机柄/抛壳窗/扳机+护圈 ----
  b(g, MAT_LT, 0.012, 0.014, 0.04, 0.024, 0.062, -0.02);    // 侧拉机柄
  b(g, MAT_LT, 0.004, 0.02, 0.055, 0.0285, 0.035, 0.06);    // 抛壳窗
  b(g, MAT_DK, 0.006, 0.024, 0.008, 0, -0.042, 0.005);      // 扳机
  b(g, MAT_DK, 0.008, 0.006, 0.06, 0, -0.058, -0.005);      // 扳机护圈底
  railTeeth(g, 0.09, -0.075, 9, 0.035, 0.052);
  sideVents(g, 0.056, 0.025, 0.09, 4, 0.04);
  receiverPins(g, 0.031, 0.018, [-0.045, 0.055, 0.135]);
  receiverMarkings(g, 0.056, 0.045, 0.06, 0.068);
  triggerGuard(g, -0.04, -0.002, 0.031);
  detailInstances(g, BOX, MAT_RUBBER, [
    [0.009, 0.012, 0.17, -0.036, 0.058, -0.1],
    [0.009, 0.012, 0.17, 0.036, 0.015, -0.1],
    [0.046, 0.07, 0.009, 0.032, 0.035, -0.205],
  ], 'folding-stock-detail');
  detailInstances(g, BOX, MAT_BLACK, Array.from({ length: 5 }, (_, index) => (
    [0.03, 0.008, 0.008, 0, -0.085 - index * 0.022, 0.042] as DetailTransform
  )), 'magazine-ribs');
  muzzleFinish(g, 0, 0.03, 0.3, 0.016);
  markFirearmQuality(g, 'smg');
  return { group: g, muzzle: muzzleAt(g, 0, 0.03, 0.3), mag };
}

// ── AWM 狙击枪 (~1.2m): 长凹槽枪管/顶部大镜管/栓柄/拇指孔枪托/折叠两脚架 ──
function buildSniper(): WeaponModel {
  const g = new THREE.Group();
  b(g, MAT_DK, 0.055, 0.085, 0.24, 0, 0.02, 0.06);          // 机匣
  cz(g, MAT_DK, 0.013, 0.52, 0, 0.03, 0.44);                // 长枪管
  cz(g, MAT_LT, 0.017, 0.025, 0, 0.03, 0.3);                // 凹槽节套 ×2
  cz(g, MAT_LT, 0.017, 0.025, 0, 0.03, 0.55);
  b(g, MAT_LT, 0.03, 0.035, 0.07, 0, 0.03, 0.72);           // 制退器
  cz(g, MAT_DK, 0.024, 0.2, 0, 0.105, 0.06);                // 瞄准镜管
  cz(g, MAT_DK, 0.032, 0.05, 0, 0.105, 0.175);              // 物镜钟
  cz(g, MAT_DK, 0.03, 0.045, 0, 0.105, -0.055);             // 目镜钟
  b(g, MAT_LT, 0.012, 0.026, 0.03, 0, 0.076, 0.1);          // 镜架 ×2
  b(g, MAT_LT, 0.012, 0.026, 0.03, 0, 0.076, -0.01);
  cx(g, MAT_LT, 0.008, 0.06, 0.05, 0.03, 0);                // 栓柄
  b(g, MAT_LT, 0.02, 0.02, 0.02, 0.082, 0.03, 0);           // 栓球
  // 瞄准镜调节旋钮(高低/风偏) + 贴腮板
  cx(g, MAT_LT, 0.014, 0.02, 0, 0.135, 0.06);               // 高低旋钮
  cx(g, MAT_LT, 0.012, 0.02, 0.028, 0.105, 0.06);           // 风偏旋钮
  b(g, MAT_PO, 0.04, 0.02, 0.09, 0, 0.075, -0.2);           // 贴腮板
  b(g, MAT_DK, 0.006, 0.026, 0.008, 0, -0.048, -0.01);      // 扳机
  b(g, MAT_DK, 0.008, 0.006, 0.07, 0, -0.065, -0.02);       // 扳机护圈底
  b(g, MAT_TN, 0.045, 0.035, 0.2, 0, 0.045, -0.22);         // 枪托上板
  b(g, MAT_TN, 0.045, 0.045, 0.2, 0, -0.035, -0.22);        // 枪托下板(中间镂空=拇指孔)
  b(g, MAT_PO, 0.048, 0.11, 0.025, 0, 0.005, -0.325);       // 托底板
  b(g, MAT_DK, 0.008, 0.012, 0.16, 0.02, -0.005, 0.5, 0.08); // 折叠两脚架(贴枪管)
  b(g, MAT_DK, 0.008, 0.012, 0.16, -0.02, -0.005, 0.5, 0.08);
  const mag = b(g, MAT_DK, 0.035, 0.07, 0.09, 0, -0.045, 0.09);
  mag.name = 'mag';
  b(g, MAT_PO, 0.032, 0.07, 0.045, 0, -0.05, -0.06, 0.3);   // 握把
  railTeeth(g, 0.09, -0.1, 11, 0.04, 0.054);
  receiverPins(g, 0.032, 0.02, [-0.04, 0.055, 0.14]);
  receiverMarkings(g, 0.056, 0.042, 0.07, 0.065);
  triggerGuard(g, -0.05, -0.015, 0.034);
  detailInstances(g, CYL, MAT_LT, [
    [0.016, 0.012, 0.016, 0, 0.03, 0.34, Math.PI / 2],
    [0.016, 0.012, 0.016, 0, 0.03, 0.44, Math.PI / 2],
    [0.016, 0.012, 0.016, 0, 0.03, 0.54, Math.PI / 2],
  ], 'barrel-fluting-collars');
  detailInstances(g, BOX, MAT_RUBBER, [
    [0.052, 0.12, 0.012, 0, 0.005, -0.338],
    [0.044, 0.026, 0.12, 0, 0.082, -0.21],
    [0.028, 0.012, 0.038, -0.03, -0.075, 0.57, 0.22],
    [0.028, 0.012, 0.038, 0.03, -0.075, 0.57, 0.22],
  ], 'sniper-stock-bipod-detail');
  for (const z of [-0.057, 0.177]) {
    const lens = cz(g, MAT_LENS, z < 0 ? 0.024 : 0.026, 0.006, 0, 0.105, z);
    lens.name = 'integrated-scope-lens';
  }
  muzzleFinish(g, 0, 0.03, 0.76, 0.021);
  markFirearmQuality(g, 'sniper');
  return { group: g, muzzle: muzzleAt(g, 0, 0.03, 0.76), mag };
}

// ── P92 手枪 (~0.23m): 套筒+防滑纹/底把/握把/扳机护圈/小瞄具 ──
function buildPistol(): WeaponModel {
  const g = new THREE.Group();
  b(g, MAT_DK, 0.04, 0.045, 0.2, 0, 0.035, 0.02);           // 套筒
  b(g, MAT_LT, 0.042, 0.006, 0.008, 0, 0.045, -0.03);       // 防滑纹 ×3
  b(g, MAT_LT, 0.042, 0.006, 0.008, 0, 0.045, -0.015);
  b(g, MAT_LT, 0.042, 0.006, 0.008, 0, 0.045, 0);
  b(g, MAT_PO, 0.036, 0.035, 0.17, 0, 0.005, 0.01);         // 底把
  b(g, MAT_TN, 0.036, 0.085, 0.048, 0, -0.05, -0.035, 0.22); // 握把
  b(g, MAT_LT, 0.008, 0.008, 0.055, 0, -0.022, 0.045);      // 扳机护圈
  b(g, MAT_LT, 0.008, 0.02, 0.008, 0, -0.012, 0.02);
  b(g, MAT_LT, 0.006, 0.012, 0.006, 0, 0.063, 0.1);         // 前瞄
  b(g, MAT_DK, 0.02, 0.01, 0.012, 0, 0.063, -0.065);        // 后瞄
  b(g, MAT_LT, 0.004, 0.008, 0.028, 0.021, 0.045, -0.045);  // 空仓挂机杆
  b(g, MAT_LT, 0.006, 0.014, 0.018, 0.02, 0.0, -0.03);      // 弹匣释放钮
  b(g, MAT_DK, 0.016, 0.022, 0.012, 0, 0.035, -0.095);      // 击锤
  b(g, MAT_DK, 0.006, 0.02, 0.008, 0, -0.018, 0.02);        // 扳机
  cz(g, MAT_DK, 0.011, 0.025, 0, 0.032, 0.115);             // 枪口
  const mag = b(g, MAT_LT, 0.034, 0.012, 0.05, 0, -0.096, -0.048, 0.22); // 弹匣底板
  mag.name = 'mag';
  triggerGuard(g, -0.022, 0.03, 0.024);
  detailInstances(g, BOX, MAT_RUBBER, Array.from({ length: 5 }, (_, index) => (
    [0.039, 0.008, 0.008, 0, -0.035 - index * 0.018, -0.035 + index * 0.004, 0, 0, 0.22] as DetailTransform
  )), 'grip-checkering');
  detailInstances(g, BOX, MAT_LT, [
    [0.025, 0.006, 0.018, 0, -0.02, 0.085],
    [0.025, 0.006, 0.018, 0, -0.028, 0.11],
    [0.005, 0.017, 0.055, 0.039, 0.035, 0.025],
  ], 'pistol-slide-frame-detail');
  receiverPins(g, 0.038, 0, [-0.045, 0.025]);
  receiverMarkings(g, 0.041, 0.043, 0.018, 0.045);
  muzzleFinish(g, 0, 0.032, 0.13, 0.014);
  markFirearmQuality(g, 'pistol');
  return { group: g, muzzle: muzzleAt(g, 0, 0.032, 0.13), mag };
}

// ── 砍刀 (~0.55m): 宽刃微弯刀身/亮刃口/护手/缠绳柄 ──
function buildKnife(): WeaponModel {
  const g = new THREE.Group();
  b(g, MAT_LT, 0.004, 0.075, 0.3, 0, 0, 0.2);               // 刀身
  b(g, MAT_LT, 0.004, 0.06, 0.14, 0, 0.014, 0.375, -0.1);   // 微弯刀尖
  b(g, MAT_DK, 0.005, 0.02, 0.44, 0, 0.03, 0.22);           // 深色刀背(衬出亮刃)
  b(g, MAT_DK, 0.09, 0.02, 0.03, 0, 0, -0.02);              // 护手
  cz(g, MAT_PO, 0.017, 0.13, 0, 0, -0.095);                 // 缠绳柄
  b(g, MAT_TN, 0.04, 0.04, 0.012, 0, 0, -0.06);             // 缠绳结 ×2
  b(g, MAT_TN, 0.04, 0.04, 0.012, 0, 0, -0.13);
  return { group: g, muzzle: muzzleAt(g, 0, 0, 0.45), mag: null };
}

function buildPan(): WeaponModel {
  const g = new THREE.Group();
  const pan = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.17, 0.055, 14), MAT_DK);
  pan.rotation.x = Math.PI / 2;
  pan.position.z = 0.2;
  pan.castShadow = true;
  g.add(pan);
  b(g, MAT_LT, 0.018, 0.025, 0.34, 0, 0, -0.02);
  b(g, MAT_PO, 0.035, 0.04, 0.12, 0, 0, -0.24);
  return { group: g, muzzle: muzzleAt(g, 0, 0, 0.36), mag: null };
}

function buildCrowbar(): WeaponModel {
  const g = new THREE.Group();
  b(g, MAT_BD, 0.022, 0.022, 0.62, 0, 0, 0.12);
  b(g, MAT_BD, 0.022, 0.022, 0.18, 0, 0.045, 0.48, -0.5);
  b(g, MAT_LT, 0.028, 0.012, 0.11, 0, 0.09, 0.55, -0.5);
  return { group: g, muzzle: muzzleAt(g, 0, 0.11, 0.62), mag: null };
}

// ── 手雷: 微扁球体 + 菠萝刻槽 + 银色压柄 + 引信座 + 拉环 ──
function buildFrag(): WeaponModel {
  const g = new THREE.Group();
  const body = new THREE.Mesh(SPH, MAT_FG);
  body.scale.set(0.052, 0.06, 0.052);
  body.castShadow = true;
  g.add(body);
  // 菠萝刻槽(暗色细环: 2 横 1 竖)
  const grooveMat = new THREE.MeshLambertMaterial({ color: 0x2a3d2c });
  const mkGroove = (y: number, rz: number): THREE.Mesh => {
    const m = new THREE.Mesh(CYL, grooveMat);
    m.scale.set(0.054, 0.006, 0.054);
    m.position.y = y;
    m.rotation.z = rz;
    g.add(m);
    return m;
  };
  mkGroove(0.022, 0);
  mkGroove(-0.02, 0);
  const vGroove = new THREE.Mesh(CYL, grooveMat);
  vGroove.scale.set(0.054, 0.006, 0.054);
  vGroove.rotation.x = Math.PI / 2;
  g.add(vGroove);
  cz(g, MAT_DK, 0.015, 0.03, 0, 0.066, 0);                 // 引信座
  b(g, MAT_LT, 0.012, 0.02, 0.075, 0.045, 0.048, 0, 0.45); // 压柄
  // 拉环(细方环)
  b(g, MAT_LT, 0.006, 0.03, 0.006, -0.032, 0.075, 0);
  b(g, MAT_LT, 0.006, 0.03, 0.006, -0.012, 0.075, 0);
  b(g, MAT_LT, 0.026, 0.006, 0.006, -0.022, 0.09, 0);
  return { group: g, muzzle: muzzleAt(g, 0, 0.1, 0), mag: null };
}

// ── 烟雾弹: 加大罐体 + 红色识别带 + 顶盖 + 保险销 + 压柄 ──
function buildSmoke(): WeaponModel {
  const g = new THREE.Group();
  cz(g, MAT_LT, 0.06, 0.16, 0, 0, 0);         // 加大罐体
  cz(g, MAT_BD, 0.062, 0.045, 0, 0.03, 0);    // 色带
  cz(g, MAT_DK, 0.024, 0.025, 0, 0.085, 0);   // 顶盖
  b(g, MAT_DK, 0.014, 0.02, 0.06, 0.052, 0.075, 0, 0.4); // 压柄
  cx(g, MAT_DK, 0.012, 0.035, -0.026, 0.092, 0); // 保险销
  b(g, MAT_DK, 0.006, 0.02, 0.006, -0.036, 0.1, 0); // 销环
  return { group: g, muzzle: muzzleAt(g, 0, 0.1, 0), mag: null };
}

// ── 闪光弹: 浅灰短罐体 + 蓝色识别带，避免与烟雾弹混淆 ──
function buildFlash(): WeaponModel {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xd9ddd7, roughness: 0.48, metalness: 0.42 });
  const bandMat = new THREE.MeshStandardMaterial({ color: 0x4ca7d8, roughness: 0.55, metalness: 0.18 });
  cz(g, bodyMat, 0.052, 0.135, 0, 0, 0);
  cz(g, bandMat, 0.054, 0.035, 0, 0.015, 0);
  cz(g, MAT_DK, 0.022, 0.024, 0, 0.078, 0);
  b(g, MAT_DK, 0.013, 0.018, 0.058, 0.046, 0.069, 0, 0.42);
  cx(g, MAT_LT, 0.009, 0.035, -0.025, 0.088, 0);
  return { group: g, muzzle: muzzleAt(g, 0, 0.1, 0), mag: null };
}

// ── S686 双管霰弹枪 (~0.75m): 并排双管/木制枪托+护木/中折铰链/珠形准星 ──
function buildShotgun(): WeaponModel {
  const g = new THREE.Group();
  // 机匣(铰链块) + 顶部锁扣
  b(g, MAT_DK, 0.06, 0.075, 0.16, 0, 0.02, -0.02);
  b(g, MAT_LT, 0.02, 0.02, 0.05, 0, 0.068, -0.06);           // 开锁拨杆
  // 并排双管(左右各一) + 上下层板
  cz(g, MAT_DK, 0.013, 0.52, -0.018, 0.035, 0.32);
  cz(g, MAT_DK, 0.013, 0.52, 0.018, 0.035, 0.32);
  b(g, MAT_DK, 0.05, 0.008, 0.52, 0, 0.048, 0.32);           // 管间上肋条
  // 木制护木(前段包裹双管) + 木纹深色下托
  b(g, MAT_TN, 0.058, 0.055, 0.24, 0, 0.012, 0.3);
  b(g, MAT_DK, 0.008, 0.02, 0.5, 0, -0.012, 0.32);           // 管下衬
  // 中折铰链暗示(管尾与机匣之间的亮环)
  cz(g, MAT_LT, 0.021, 0.02, -0.018, 0.035, 0.06);
  cz(g, MAT_LT, 0.021, 0.02, 0.018, 0.035, 0.06);
  // 珠形准星
  b(g, MAT_LT, 0.007, 0.014, 0.007, 0, 0.062, 0.56);
  // 木制枪托(后收细) + 托底板
  b(g, MAT_TN, 0.052, 0.075, 0.24, 0, 0.005, -0.22);
  b(g, MAT_TN, 0.045, 0.09, 0.06, 0, -0.01, -0.36);
  b(g, MAT_DK, 0.047, 0.1, 0.014, 0, -0.01, -0.395);         // 托底板
  b(g, MAT_DK, 0.006, 0.026, 0.008, 0, -0.042, 0.01);        // 扳机
  b(g, MAT_DK, 0.008, 0.006, 0.06, 0, -0.058, -0.01);        // 扳机护圈底
  triggerGuard(g, -0.043, -0.005, 0.034);
  detailInstances(g, BOX, MAT_WOOD_DARK, [
    [0.06, 0.016, 0.2, 0, 0.043, 0.3],
    [0.049, 0.02, 0.15, 0, 0.058, -0.22],
    [0.052, 0.108, 0.009, 0, -0.01, -0.404],
  ], 'shotgun-wood-detail');
  detailInstances(g, BOX, MAT_BLACK, Array.from({ length: 8 }, (_, index) => {
    const side = index % 2 === 0 ? -1 : 1;
    const row = Math.floor(index / 2);
    return [0.004, 0.01, 0.038, side * 0.03, 0.014, 0.245 + row * 0.048] as DetailTransform;
  }), 'fore-end-checkering');
  receiverPins(g, 0.038, 0.02, [-0.055, 0.015]);
  receiverMarkings(g, 0.061, 0.04, -0.015, 0.062);
  muzzleFinish(g, -0.018, 0.035, 0.59, 0.013);
  muzzleFinish(g, 0.018, 0.035, 0.59, 0.013);
  markFirearmQuality(g, 'shotgun');
  return { group: g, muzzle: muzzleAt(g, 0, 0.035, 0.59), mag: null };
}

// 原型缓存: 每型只建一次, 之后一律 clone(true)(共享几何/材质)
const protos = new Map<WeaponModelId, WeaponModel>();
function proto(id: WeaponModelId): WeaponModel {
  let p = protos.get(id);
  if (!p) {
    switch (id) {
      case 'rifle': p = buildRifle(); break;
      case 'akm': p = buildAkm(); break;
      case 'lmg': p = buildLmg(); break;
      case 'smg': p = buildSmg(); break;
      case 'dmr': p = buildDmr(); break;
      case 'sniper': p = buildSniper(); break;
      case 'shotgun': p = buildShotgun(); break;
      case 'pistol': p = buildPistol(); break;
      case 'knife': p = buildKnife(); break;
      case 'pan': p = buildPan(); break;
      case 'crowbar': p = buildCrowbar(); break;
      case 'frag': p = buildFrag(); break;
      case 'smoke': p = buildSmoke(); break;
      case 'flash': p = buildFlash(); break;
    }
    protos.set(id, p);
  }
  return p;
}

// 克隆一份可用模型; muzzle/mag 通过命名在克隆体上找回
export function buildWeaponModel(id: WeaponModelId): WeaponModel {
  const p = proto(id);
  const group = p.group.clone(true);
  if (FIREARM_MODEL_IDS.has(id)) group.scale.setScalar(FIREARM_MODEL_SCALE);
  const muzzle = group.getObjectByName('muzzle') as THREE.Object3D;
  const mag = (group.getObjectByName('mag') as THREE.Object3D | undefined) ?? null;
  return { group, muzzle, mag };
}

// ── 配件可视化: 在克隆武器模型上挂瞄具/枪口/扩容弹匣(共享几何/材质) ──
const ATT_GEO = {
  dotBase: new RoundedBoxGeometry(0.03, 0.035, 0.05, 2, 0.004),
  dotGlass: new RoundedBoxGeometry(0.036, 0.034, 0.004, 2, 0.0015),
  dotHood: new THREE.TorusGeometry(0.024, 0.004, 8, 16),
  dotKnob: new THREE.CylinderGeometry(0.006, 0.006, 0.012, 12),
  reticle: new THREE.SphereGeometry(0.0025, 8, 6),
  scopeTube: new THREE.CylinderGeometry(0.016, 0.016, 0.09, 16, 2),
  scopeBell: new THREE.CylinderGeometry(0.024, 0.02, 0.03, 16, 2),
  scopeLens: new THREE.CylinderGeometry(0.018, 0.018, 0.003, 18),
  scopeTurret: new THREE.CylinderGeometry(0.006, 0.006, 0.015, 12),
  scopeRing: new THREE.TorusGeometry(0.017, 0.0025, 7, 16),
  scopeBase: new RoundedBoxGeometry(0.014, 0.02, 0.05, 2, 0.0025),
  suppressor: new THREE.CylinderGeometry(0.02, 0.02, 0.15, 18, 3),
  suppressorBand: new THREE.TorusGeometry(0.021, 0.0025, 7, 18),
  suppressorEnd: new THREE.TorusGeometry(0.018, 0.003, 7, 18),
  comp: new RoundedBoxGeometry(0.034, 0.034, 0.06, 2, 0.004),
  compPort: new RoundedBoxGeometry(0.036, 0.012, 0.013, 2, 0.002),
  magPlate: new RoundedBoxGeometry(1, 1, 1, 2, 0.08),
  magRib: new RoundedBoxGeometry(1, 1, 1, 2, 0.08),
};
export function attachWeaponMods(group: THREE.Group, att: GunAttachments): void {
  // 地面 loot 外面还有 holder 包装层, 实际配件应挂到枪模型根节点上
  const muzzleNode = group.getObjectByName('muzzle');
  const weaponGroup = (muzzleNode?.parent as THREE.Group | null) ?? group;
  // 瞄具(机匣顶部)
  if (att.sight) {
    const base = new THREE.Mesh(ATT_GEO.scopeBase, MAT_PO);
    base.position.set(0, 0.082, 0.02);
    weaponGroup.add(base);
    if (att.sight === 'reddot') {
      const dot = new THREE.Mesh(ATT_GEO.dotBase, MAT_DK);
      dot.name = 'reddot-housing';
      dot.position.set(0, 0.108, 0.02);
      weaponGroup.add(dot);
      const hood = new THREE.Mesh(ATT_GEO.dotHood, MAT_DK);
      hood.name = 'reddot-hood';
      hood.position.set(0, 0.126, 0.035);
      weaponGroup.add(hood);
      const glass = new THREE.Mesh(ATT_GEO.dotGlass, MAT_LENS);
      glass.name = 'optic-lens';
      glass.position.set(0, 0.126, 0.036);
      weaponGroup.add(glass);
      const reticle = new THREE.Mesh(ATT_GEO.reticle, MAT_RETICLE);
      reticle.name = 'reddot-reticle';
      reticle.position.set(0, 0.126, 0.039);
      weaponGroup.add(reticle);
      for (const side of [-1, 1]) {
        const guard = new THREE.Mesh(BOX, MAT_RUBBER);
        guard.name = 'reddot-guard';
        guard.scale.set(0.007, 0.038, 0.05);
        guard.position.set(side * 0.022, 0.112, 0.02);
        guard.castShadow = true;
        weaponGroup.add(guard);
      }
      const knob = new THREE.Mesh(ATT_GEO.dotKnob, MAT_LT);
      knob.name = 'reddot-knob';
      knob.rotation.z = Math.PI / 2;
      knob.position.set(0.022, 0.108, 0.015);
      knob.castShadow = true;
      weaponGroup.add(knob);
    } else {
      const tube = new THREE.Mesh(ATT_GEO.scopeTube, MAT_DK);
      tube.name = 'scope-tube';
      tube.rotation.x = Math.PI / 2;
      tube.position.set(0, 0.112, 0.02);
      weaponGroup.add(tube);
      const bell = new THREE.Mesh(ATT_GEO.scopeBell, MAT_DK);
      bell.name = 'scope-bell';
      bell.rotation.x = Math.PI / 2;
      bell.position.set(0, 0.112, 0.068);
      weaponGroup.add(bell);
      for (const z of [-0.032, 0.032]) {
        const foot = new THREE.Mesh(ATT_GEO.scopeBase, MAT_LT);
        foot.name = 'scope-mount';
        foot.position.set(0, 0.094, z);
        weaponGroup.add(foot);
      }
      for (const z of [-0.028, 0.084]) {
        const lens = new THREE.Mesh(ATT_GEO.scopeLens, MAT_LENS);
        lens.name = 'optic-lens';
        lens.rotation.x = Math.PI / 2;
        lens.position.set(0, 0.112, z);
        weaponGroup.add(lens);
      }
      const turret = new THREE.Mesh(ATT_GEO.scopeTurret, MAT_LT);
      turret.name = 'scope-turret';
      turret.position.set(0, 0.143, 0.018);
      weaponGroup.add(turret);
      for (const z of [-0.016, 0.052]) {
        const ring = new THREE.Mesh(ATT_GEO.scopeRing, z < 0 ? MAT_RUBBER : MAT_LT);
        ring.name = 'scope-detail-ring';
        ring.position.set(0, 0.112, z);
        ring.castShadow = true;
        weaponGroup.add(ring);
      }
      const sideTurret = new THREE.Mesh(ATT_GEO.scopeTurret, MAT_LT);
      sideTurret.name = 'scope-side-turret';
      sideTurret.rotation.z = Math.PI / 2;
      sideTurret.position.set(0.022, 0.112, 0.018);
      sideTurret.castShadow = true;
      weaponGroup.add(sideTurret);
    }
  }
  // 枪口(消音器/补偿器, 挂 muzzle 节点后段)
  if (att.muzzle && muzzleNode) {
    const muzzleZ = muzzleNode.position.z;
    if (att.muzzle === 'suppressor') {
      const sup = new THREE.Mesh(ATT_GEO.suppressor, MAT_DK);
      sup.name = 'suppressor-body';
      sup.rotation.x = Math.PI / 2;
      sup.position.set(muzzleNode.position.x, muzzleNode.position.y, muzzleZ + 0.068);
      weaponGroup.add(sup);
      for (const z of [muzzleZ + 0.02, muzzleZ + 0.115]) {
        const band = new THREE.Mesh(ATT_GEO.suppressorBand, MAT_LT);
        band.name = 'suppressor-band';
        band.position.set(muzzleNode.position.x, muzzleNode.position.y, z);
        weaponGroup.add(band);
      }
      const cap = new THREE.Mesh(ATT_GEO.suppressorEnd, MAT_LT);
      cap.name = 'suppressor-end-cap';
      cap.position.set(muzzleNode.position.x, muzzleNode.position.y, muzzleZ + 0.143);
      cap.castShadow = true;
      weaponGroup.add(cap);
      const bore = cz(weaponGroup, MAT_BLACK, 0.011, 0.005, muzzleNode.position.x, muzzleNode.position.y, muzzleZ + 0.145);
      bore.name = 'suppressor-bore';
      muzzleNode.position.z = muzzleZ + 0.14;
    } else {
      const comp = new THREE.Mesh(ATT_GEO.comp, MAT_LT);
      comp.name = 'compensator-body';
      comp.position.set(muzzleNode.position.x, muzzleNode.position.y, muzzleZ + 0.026);
      weaponGroup.add(comp);
      for (const z of [muzzleZ + 0.012, muzzleZ + 0.036]) {
        const port = new THREE.Mesh(ATT_GEO.compPort, MAT_DK);
        port.name = 'compensator-port';
        port.position.set(muzzleNode.position.x, muzzleNode.position.y + 0.014, z);
        weaponGroup.add(port);
      }
      const crown = new THREE.Mesh(MUZZLE_RING, MAT_BLACK);
      crown.name = 'compensator-crown';
      crown.scale.setScalar(0.015);
      crown.position.set(muzzleNode.position.x, muzzleNode.position.y, muzzleZ + 0.057);
      crown.castShadow = true;
      weaponGroup.add(crown);
      muzzleNode.position.z = muzzleZ + 0.052;
    }
  }
  // 扩容弹匣(加长弹匣节点)
  if (att.mag === 'extmag') {
    const magNode = weaponGroup.getObjectByName('mag');
    if (magNode) {
      magNode.scale.y *= 1.45;
      const base = new THREE.Mesh(ATT_GEO.magPlate, MAT_RUBBER);
      base.name = 'extmag-baseplate';
      base.scale.set(magNode.scale.x * 1.22, 0.014, magNode.scale.z * 1.2);
      base.position.set(
        magNode.position.x,
        magNode.position.y - magNode.scale.y * 0.52,
        magNode.position.z,
      );
      base.castShadow = true;
      weaponGroup.add(base);
      for (let index = 0; index < 3; index++) {
        const rib = new THREE.Mesh(ATT_GEO.magRib, MAT_BLACK);
        rib.name = 'extmag-rib';
        rib.scale.set(magNode.scale.x * 1.12, 0.007, magNode.scale.z * 1.08);
        rib.position.set(
          magNode.position.x,
          magNode.position.y - magNode.scale.y * (0.12 + index * 0.18),
          magNode.position.z,
        );
        rib.rotation.copy(magNode.rotation);
        rib.castShadow = true;
        weaponGroup.add(rib);
      }
    }
  }
  weaponGroup.traverse((object) => {
    if (object instanceof THREE.Mesh) object.castShadow = true;
  });
}
